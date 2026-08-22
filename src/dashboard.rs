use crate::config::PanelKind;
use crate::state::{AppError, AppState, CurrentUser};
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};
use std::sync::Arc;

const CHART_CAP: i64 = 500;
const TABLE_CAP: i64 = 50;
const SPARK_CAP: i64 = 100;

async fn read_only_rows_on(
    state: &AppState,
    source: Option<&str>,
    sql: &str,
    cap: i64,
    env: &crate::vars::Resolved,
) -> Result<Vec<Value>, String> {
    let pool = state.pool_for(source);
    let (sql, binds) =
        crate::interp::interpolate_for(sql, &env.types, &env.values, pool.dialect())?;
    let rows = crate::db::config_query_rows(pool, &sql, &binds, cap, 5000)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

/// The variable names a set of panels actually reads. A control that changes
/// nothing on the page you are looking at is worse than no control.
fn referenced_vars(
    panels: &[crate::config::PanelConfig],
    page_refresh: Option<&str>,
) -> Vec<String> {
    let mut out = std::collections::BTreeSet::new();
    let per_panel = panels.iter().map(|w| {
        w.sql
            .iter()
            .chain(w.compare_sql.iter())
            .chain(w.spark.iter())
            .chain(w.expr.iter())
            .chain(w.range.iter())
            .chain(w.step.iter())
            .chain(w.filter.values())
            .cloned()
            .chain(w.query.clone())
            .collect::<Vec<_>>()
    });
    let page = std::iter::once(
        page_refresh
            .map(str::to_string)
            .into_iter()
            .collect::<Vec<_>>(),
    );
    for texts in per_panel.chain(page) {
        for t in texts {
            let mut rest = t.as_str();
            while let Some(open) = rest.find("{{") {
                let Some(close) = rest[open + 2..].find("}}") else {
                    break;
                };
                out.insert(rest[open + 2..open + 2 + close].trim().to_string());
                rest = &rest[open + 2 + close + 2..];
            }
        }
    }
    out.into_iter().collect()
}

/// Filter then fold a listing's rows. Both are no-ops unless the panel asks
/// for them, so a plain `source` panel still renders the rows as they came.
fn shape_rows(
    rows: Vec<Value>,
    w: &crate::config::PanelConfig,
    env: &crate::vars::Resolved,
) -> Result<Vec<Value>, String> {
    let pairs: std::collections::BTreeMap<String, String> = w
        .filter
        .iter()
        .map(|(k, v)| (k.clone(), crate::interp::substitute(v, &env.values)))
        .collect();
    let rows = crate::agg::filter(rows, &pairs);
    let specs: Vec<&String> = w.value.iter().chain(w.agg.iter()).collect();
    if specs.is_empty() && w.group_by.is_none() {
        return Ok(rows);
    }
    let aggs = specs
        .iter()
        .map(|s| crate::agg::parse(s))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(crate::agg::fold(&rows, w.group_by.as_deref(), &aggs))
}

/// A panel's rows, from whichever origin it declares: inline `sql`, a named
/// `query` (which carries its own source), or an http `source`. `table` panels
/// never reach here — the browser fetches the configured list itself.
async fn panel_rows(
    state: &AppState,
    user: &CurrentUser,
    w: &crate::config::PanelConfig,
    cap: i64,
    env: &crate::vars::Resolved,
) -> Result<Vec<Value>, String> {
    if let Some(name) = &w.query {
        let cfg = state.cfg();
        let q = cfg
            .queries
            .get(name)
            .ok_or_else(|| format!("unknown query \"{name}\""))?;
        if !user.may(&q.roles, crate::state::Access::AdminOnly) {
            return Err(format!("query \"{name}\" not allowed for your role"));
        }
        let (sql, source) = (q.sql.clone(), q.source.clone());
        return read_only_rows_on(state, source.as_deref(), &sql, cap, env).await;
    }
    if let Some(alias) = &w.source {
        if is_grafana(state, alias) {
            let q = grafana_query(
                w,
                w.expr.as_deref().ok_or("grafana panel has no expr")?,
                w.kind == PanelKind::Stat,
                cap,
                env,
            )?;
            return crate::grafana::rows(state, user, alias, &q)
                .await
                .map_err(|e| e.1);
        }
        let rows = crate::plugins::source_rows(
            state,
            user,
            alias,
            w.path.as_deref().unwrap_or(""),
            w.rows_at.as_deref(),
        )
        .await
        .map_err(|e| e.1)?;
        return shape_rows(rows, w, env);
    }
    let sql = w.sql.as_ref().ok_or("panel has no sql, query or source")?;
    read_only_rows_on(state, w.source.as_deref(), sql, cap, env).await
}

fn is_grafana(state: &AppState, alias: &str) -> bool {
    state
        .cfg()
        .sources
        .get(alias)
        .is_some_and(|s| s.is_grafana())
}

/// A grafana panel's query: `expr` with the page's variables substituted, over
/// the panel's `range`/`step`; a stat reads the value now.
fn grafana_query(
    w: &crate::config::PanelConfig,
    expr: &str,
    instant: bool,
    cap: i64,
    env: &crate::vars::Resolved,
) -> Result<crate::grafana::Query, String> {
    let range = match &w.range {
        Some(r) => crate::grafana::parse_duration(&crate::interp::substitute(r, &env.values))?,
        None => crate::grafana::default_range(),
    };
    let step = w
        .step
        .as_deref()
        .map(|s| crate::grafana::parse_duration(&crate::interp::substitute(s, &env.values)))
        .transpose()?;
    Ok(crate::grafana::Query {
        ds: w.ds.clone().ok_or("grafana panel has no ds")?,
        expr: crate::interp::substitute(expr, &env.values),
        range,
        step,
        instant,
        limit: cap.max(1) as usize,
    })
}

fn first_number(row: &Value) -> Option<f64> {
    let obj = row.as_object()?;
    obj.values().find_map(|v| v.as_f64())
}

fn scalar(rows: &[Value]) -> Option<f64> {
    rows.first().and_then(first_number)
}

/// One point of a sparkline series: the row's `v` column, or the first numeric
/// value that is not the leading (ordering) column.
fn series_point(row: &Value) -> Option<f64> {
    let obj = row.as_object()?;
    if let Some(v) = obj.get("v").and_then(|v| v.as_f64()) {
        return Some(v);
    }
    if obj.len() > 1 {
        if let Some(v) = obj.values().skip(1).find_map(|v| v.as_f64()) {
            return Some(v);
        }
    }
    obj.values().find_map(|v| v.as_f64())
}

fn spark_series(rows: &[Value]) -> Vec<f64> {
    rows.iter().filter_map(series_point).collect()
}

fn alert_of(v: f64, above: Option<f64>, below: Option<f64>) -> Value {
    match (above, below) {
        (Some(a), _) if v > a => json!("critical"),
        (_, Some(b)) if v < b => json!("critical"),
        _ => Value::Null,
    }
}

/// Execute one widget's read-only query (if any) and render it to the client JSON
/// the dashboard grid consumes. `None` for a stat/chart/table missing its `sql`
/// (the caller skips those in the grid); the config editor's preview surfaces the
/// requirement instead. Shared by the live dashboard and the editor preview.
pub async fn render_panel(
    state: &AppState,
    user: &CurrentUser,
    w: &crate::config::PanelConfig,
    id: &str,
    env: &crate::vars::Resolved,
    loc: &crate::i18n::Loc,
) -> Option<Value> {
    let widget = match w.kind {
        PanelKind::Iframe => json!({
            "id": id, "type": "iframe", "label": loc.t(w.label.clone()), "url": w.url,
        }),
        PanelKind::Stat => {
            if w.sql.is_none() && w.query.is_none() && w.source.is_none() {
                return None;
            }
            match panel_rows(state, user, w, 1, env).await {
                Ok(rows) => {
                    let value = scalar(&rows);
                    let compare = match &w.compare_sql {
                        Some(cs) => match read_only_rows_on(state, w.source.as_deref(), cs, 1, env).await {
                            Ok(crows) => scalar(&crows).map(|v| {
                                json!({ "value": v, "label": w.compare_label.clone().map(|l| loc.t(l)).unwrap_or_else(|| "prev".into()) })
                            }),
                            Err(_) => None,
                        },
                        None => None,
                    };
                    let spark = match &w.spark {
                        Some(sq) => {
                            let srows = match w.source.as_deref().filter(|a| is_grafana(state, a)) {
                                Some(alias) => match grafana_query(w, sq, false, SPARK_CAP, env) {
                                    Ok(q) => crate::grafana::rows(state, user, alias, &q)
                                        .await
                                        .map_err(|e| e.1),
                                    Err(e) => Err(e),
                                },
                                None => {
                                    read_only_rows_on(
                                        state,
                                        w.source.as_deref(),
                                        sq,
                                        SPARK_CAP,
                                        env,
                                    )
                                    .await
                                }
                            };
                            match srows {
                                Ok(srows) => {
                                    let s = spark_series(&srows);
                                    (s.len() > 1).then_some(s)
                                }
                                Err(_) => None,
                            }
                        }
                        None => None,
                    };
                    json!({
                        "id": id, "type": "stat", "label": loc.t(w.label.clone()),
                        "value": value,
                        "format": w.format.clone().unwrap_or_else(|| "number".into()),
                        "compare": compare,
                        "spark": spark,
                        "good_when": w.good_when.clone().unwrap_or_else(|| "up".into()),
                        "alert": value.map(|v| alert_of(v, w.alert_above, w.alert_below)).unwrap_or(Value::Null),
                    })
                }
                Err(e) => {
                    json!({ "id": id, "type": "stat", "label": loc.t(w.label.clone()), "value": Value::Null, "error": e })
                }
            }
        }
        PanelKind::Chart => {
            if w.sql.is_none() && w.query.is_none() && w.source.is_none() {
                return None;
            }
            match panel_rows(state, user, w, CHART_CAP, env).await {
                Ok(rows) => {
                    let points: Vec<Value> = rows
                        .iter()
                        .filter_map(|r| {
                            let obj = r.as_object()?;
                            let t = obj
                                .get("t")
                                .cloned()
                                .or_else(|| obj.values().next().cloned())?;
                            let v = match obj.get("v") {
                                Some(Value::Null) => Value::Null,
                                Some(v) if v.is_number() => v.clone(),
                                _ => json!(obj.values().skip(1).find_map(|v| v.as_f64())?),
                            };
                            Some(json!({ "t": t, "v": v }))
                        })
                        .collect();
                    let series = crate::grafana::series_of(&rows);
                    let points = match series.first() {
                        Some(first) if series.len() > 1 => {
                            first["points"].as_array().cloned().unwrap_or(points)
                        }
                        _ => points,
                    };
                    json!({
                        "id": id, "type": "chart", "label": loc.t(w.label.clone()),
                        "kind": w.chart.clone().unwrap_or_else(|| "line".into()),
                        "points": points,
                        "series": (series.len() > 1).then_some(series),
                        "format": w.format.clone().unwrap_or_else(|| "number".into()),
                    })
                }
                Err(e) => {
                    json!({ "id": id, "type": "chart", "label": loc.t(w.label.clone()), "points": [], "error": e })
                }
            }
        }
        PanelKind::Table if w.table.is_some() => {
            let slug = w.table.clone().unwrap();
            state.readable_table(user, &slug).ok()?;
            json!({
                "id": id, "type": "table", "label": loc.t(w.label.clone()),
                "table": slug, "sort": w.sort, "pp": w.pp,
            })
        }
        PanelKind::Table => {
            if w.sql.is_none() && w.query.is_none() && w.source.is_none() {
                return None;
            }
            // `max` is how many rows travel; `pp` is how many show at once.
            let cap = w
                .max
                .map(|n| n as i64)
                .unwrap_or(TABLE_CAP)
                .clamp(1, 20_000);
            match panel_rows(state, user, w, cap, env).await {
                Ok(mut rows) => {
                    // Showing part of a listing must never read as the whole of
                    // it: carry the real total so the panel can say so.
                    let total = rows.len();
                    rows.truncate(cap as usize);
                    let truncated = total > rows.len();
                    let columns: Vec<String> = rows
                        .first()
                        .and_then(|r| r.as_object())
                        .map(|o| o.keys().cloned().collect())
                        .unwrap_or_default();
                    let pk = w
                        .link
                        .as_ref()
                        .and_then(|t| state.resolve_table(t))
                        .and_then(|t| t.pk.clone());
                    let cols = (!w.columns.is_empty()).then(|| {
                        w.columns
                            .iter()
                            .map(|c| {
                                json!({
                                    "key": c.key, "label": c.label.clone().map(|l| loc.t(l)), "format": c.format,
                                    "align": c.align, "max": c.max,
                                    "badge": (!c.badge.is_empty()).then(|| c.badge.clone()),
                                    "display": c.display, "tone": c.tone,
                                    "wrap": c.wrap,
                                })
                            })
                            .collect::<Vec<_>>()
                    });
                    json!({
                        "id": id, "type": "table", "label": loc.t(w.label.clone()),
                        "link": w.link, "columns": columns, "cols": cols, "rows": rows, "pk": pk,
                        "pp": w.pp, "search": w.search, "expand": w.expand,
                        "filter_by": (!w.filter_by.is_empty()).then(|| w.filter_by.clone()),
                        "total": truncated.then_some(total),
                    })
                }
                Err(e) => {
                    json!({ "id": id, "type": "table", "label": loc.t(w.label.clone()), "rows": [], "columns": [], "error": e })
                }
            }
        }
    };
    let mut widget = widget;
    if let Some(obj) = widget.as_object_mut() {
        if let Some(v) = w.w {
            obj.insert("w".into(), json!(v));
        }
        if let Some(v) = w.h {
            obj.insert("h".into(), json!(v));
        }
        if let Some(c) = &w.category {
            obj.insert("category".into(), json!(loc.t(c.clone())));
        }
    }
    Some(widget)
}

/// Panels of one page render side by side (a few at a time — a page of thirty
/// tiles must not open thirty connections at once), in declared order.
const PANEL_CONCURRENCY: usize = 6;

async fn render_panels(
    state: &AppState,
    panels: &[crate::config::PanelConfig],
    user: &CurrentUser,
    env: &crate::vars::Resolved,
    loc: &crate::i18n::Loc,
) -> Vec<Value> {
    let allowed: Vec<(String, &crate::config::PanelConfig)> = panels
        .iter()
        .enumerate()
        .filter(|(_, w)| user.may(&w.roles, crate::state::Access::Everyone))
        .map(|(i, w)| (format!("w{i}"), w))
        .collect();
    let mut widgets = Vec::with_capacity(allowed.len());
    for chunk in allowed.chunks(PANEL_CONCURRENCY) {
        let rendered = futures::future::join_all(
            chunk
                .iter()
                .map(|(id, w)| render_panel(state, user, w, id, env, loc)),
        )
        .await;
        widgets.extend(rendered.into_iter().flatten());
    }
    widgets
}

pub async fn dashboard_handler(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    user: CurrentUser,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, AppError> {
    let env = crate::vars::resolve(&state, &user, &params).await?;
    let cfg = state.cfg();
    let loc = crate::i18n::Loc::for_request(&headers, &state);
    let widgets = render_panels(&state, &cfg.dashboard.widgets, &user, &env, &loc).await;
    Ok(Json(json!({
        "widgets": widgets,
        "columns": cfg.dashboard.columns,
        "refresh_secs": crate::config::refresh_secs(cfg.dashboard.refresh.as_deref().map(|r| crate::interp::substitute(r, &env.values)).as_deref()),
        "variables": referenced_vars(&cfg.dashboard.widgets, cfg.dashboard.refresh.as_deref()),
    })))
}

pub async fn page_widgets_handler(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    user: CurrentUser,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, AppError> {
    let env = crate::vars::resolve(&state, &user, &params).await?;
    let cfg = state.cfg();
    let loc = crate::i18n::Loc::for_request(&headers, &state);
    let page = cfg
        .pages
        .iter()
        .find(|p| p.id() == id)
        .ok_or_else(|| AppError::not_found("unknown declarative page"))?;
    if !user.may(&page.roles, crate::state::Access::Everyone) {
        return Err(AppError::forbidden("no access to this page"));
    }
    let widgets = render_panels(&state, &page.widgets, &user, &env, &loc).await;
    Ok(Json(json!({
        "label": loc.pick(&page.labels, page.label.clone()), "widgets": widgets, "columns": page.columns,
        "refresh_secs": crate::config::refresh_secs(page.refresh.as_deref().map(|r| crate::interp::substitute(r, &env.values)).as_deref()),
        "variables": referenced_vars(&page.widgets, page.refresh.as_deref()),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::configedit::test_support::{state_with_tables, tmp_dir};

    fn admin() -> CurrentUser {
        CurrentUser {
            email: "a@b.c".into(),
            role: "admin".into(),
        }
    }

    #[tokio::test]
    async fn render_panel_emits_grid_span_and_category() {
        let state = state_with_tables(Some(tmp_dir()), &["bots"]);
        let w: crate::config::PanelConfig = hcl::from_str(
            "type = \"iframe\"\nlabel = \"Docs\"\nurl = \"https://x.io\"\nw = 2\nh = 2\ncategory = \"Links\"\n",
        )
        .unwrap();
        let rendered = render_panel(
            &state,
            &admin(),
            &w,
            "w0",
            &Default::default(),
            &Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(rendered["type"], json!("iframe"));
        assert_eq!(rendered["w"], json!(2));
        assert_eq!(rendered["h"], json!(2));
        assert_eq!(rendered["category"], json!("Links"));

        let bare: crate::config::PanelConfig =
            hcl::from_str("type = \"iframe\"\nlabel = \"Docs\"\nurl = \"https://x.io\"\n").unwrap();
        let rendered = render_panel(
            &state,
            &admin(),
            &bare,
            "w0",
            &Default::default(),
            &Default::default(),
        )
        .await
        .unwrap();
        assert!(rendered.get("w").is_none(), "absent span not emitted");
        assert!(
            rendered.get("category").is_none(),
            "absent category not emitted"
        );
    }

    #[test]
    fn spark_series_reads_ordered_values() {
        let rows = vec![
            json!({ "t": "2026-01-01", "v": 3.0 }),
            json!({ "t": "2026-01-02", "v": 5.0 }),
            json!({ "t": "2026-01-03", "v": 4.0 }),
        ];
        assert_eq!(spark_series(&rows), vec![3.0, 5.0, 4.0]);

        let no_v = vec![
            json!({ "bucket": "a", "n": 7.0 }),
            json!({ "bucket": "b", "n": 9.0 }),
        ];
        assert_eq!(spark_series(&no_v), vec![7.0, 9.0]);
    }

    #[test]
    fn stat_good_when_round_trips_and_defaults() {
        let w: crate::config::PanelConfig = hcl::from_str(
            "type = \"stat\"\nlabel = \"Errors\"\nsql = \"SELECT 1 AS v\"\nspark = \"SELECT 1 AS v\"\ngood_when = \"down\"\n",
        )
        .unwrap();
        assert_eq!(w.good_when.as_deref(), Some("down"));
        assert_eq!(w.spark.as_deref(), Some("SELECT 1 AS v"));
        let out = hcl::to_string(&w).unwrap();
        let w2: crate::config::PanelConfig = hcl::from_str(&out).unwrap();
        assert_eq!(
            serde_json::to_value(&w).unwrap(),
            serde_json::to_value(&w2).unwrap(),
            "spark + good_when survive a serialize round-trip",
        );

        let bare: crate::config::PanelConfig =
            hcl::from_str("type = \"stat\"\nlabel = \"Bots\"\nsql = \"SELECT 1 AS v\"\n").unwrap();
        assert!(bare.good_when.is_none(), "good_when omitted when unset");
        assert!(bare.spark.is_none(), "spark omitted when unset");
    }
}
