use crate::meta::{fk_label_col, humanize, search_columns, table_config};
use crate::sqlval::{ident, Binds};
use crate::state::{AppError, AppState, CurrentUser};
use axum::extract::{Query, State};
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

const PER_TABLE: i64 = 5;
const TOTAL_CAP: usize = 40;
const BUDGET: Duration = Duration::from_secs(8);

fn json_str(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(x)) => Some(x.clone()),
        Some(Value::Null) | None => None,
        Some(other) => Some(other.to_string()),
    }
}

pub async fn search_handler(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    user: CurrentUser,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, AppError> {
    let loc = crate::i18n::Loc::for_request(&headers, &state);
    let q = params
        .get("q")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let Some(q) = q else {
        return Ok(Json(json!({ "results": [] })));
    };
    let started = Instant::now();
    let mut results: Vec<Value> = Vec::new();
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    // "42" or a UUID jumps straight to that row (indexed pk hit, ranked first).
    let pkish = q.chars().all(|c| c.is_ascii_digit())
        || (q.len() == 36 && q.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));

    for table in state.visible_tables(&user) {
        if results.len() >= TOTAL_CAP || started.elapsed() > BUDGET {
            break;
        }
        let Ok(dbt) = state.readable_table(&user, &table) else {
            continue;
        };
        let Some(pk) = dbt.pk.clone() else { continue };
        let cfg = table_config(&state, &table);
        let masked = state.masked_columns(&user, &table);
        let cols: Vec<String> = search_columns(dbt, &cfg)
            .into_iter()
            .filter(|c| !masked.contains(c))
            .collect();
        if cols.is_empty() {
            continue;
        }
        let title_col = fk_label_col(dbt);
        let title_col = if masked.contains(&title_col) {
            pk.clone()
        } else {
            title_col
        };

        let pool = state.pool_of(dbt);
        let dialect = pool.dialect();
        if pkish {
            let mut b = Binds::for_dialect(dialect);
            let n = b.ph(Some(q.clone()));
            let mut w = format!("{} = {n}", crate::sqlval::text_cast(dialect, &ident(&pk)));
            if let Some(rf) = state.row_filter(&user, &table) {
                w = format!("{w} AND ({rf})");
            }
            let sql = format!(
                "SELECT {} AS pk, {} AS title FROM {} t WHERE {w} LIMIT 1",
                crate::sqlval::text_cast(dialect, &ident(&pk)),
                crate::sqlval::text_cast(dialect, &ident(&title_col)),
                state.qualified_of(dbt),
            );
            let hit = crate::db::read_only_json_rows(pool, &sql, &b, 2000)
                .await
                .map_err(|e| tracing::warn!("pk search on {table} failed: {e}"))
                .ok()
                .and_then(|rows| rows.into_iter().next())
                .map(|m| (json_str(m.get("pk")), json_str(m.get("title"))));
            if let Some((Some(pkv), titlev)) = hit {
                if seen.insert((table.clone(), pkv.clone())) {
                    let label = loc.pick(
                        &cfg.labels,
                        cfg.label.clone().unwrap_or_else(|| humanize(&table)),
                    );
                    results.push(
                        json!({ "table": table, "label": label, "pk": pkv, "title": titlev }),
                    );
                }
            }
        }

        let mut binds = Binds::for_dialect(dialect);
        let ors: Vec<String> = cols
            .iter()
            .map(|c| {
                let n = binds.ph(Some(format!("%{q}%")));
                crate::sqlval::ilike_clause(dialect, &ident(c), &n)
            })
            .collect();
        let mut where_sql = format!("({})", ors.join(" OR "));
        if let Some(rf) = state.row_filter(&user, &table) {
            where_sql = format!("{where_sql} AND ({rf})");
        }
        let sql = format!(
            "SELECT {} AS pk, {} AS title FROM {} t WHERE {where_sql} LIMIT {PER_TABLE}",
            crate::sqlval::text_cast(dialect, &ident(&pk)),
            crate::sqlval::text_cast(dialect, &ident(&title_col)),
            state.qualified_of(dbt),
        );

        let hits: Vec<(Option<String>, Option<String>)> =
            crate::db::read_only_json_rows(pool, &sql, &binds, 2000)
                .await
                .map_err(|e| tracing::warn!("search on {table} failed: {e}"))
                .map(|rows| {
                    rows.into_iter()
                        .map(|m| (json_str(m.get("pk")), json_str(m.get("title"))))
                        .collect()
                })
                .unwrap_or_default();

        let label = loc.pick(
            &cfg.labels,
            cfg.label.clone().unwrap_or_else(|| humanize(&table)),
        );
        for (pkv, titlev) in hits {
            if results.len() >= TOTAL_CAP {
                break;
            }
            let Some(pkv) = pkv else { continue };
            if !seen.insert((table.clone(), pkv.clone())) {
                continue;
            }
            results.push(json!({
                "table": table,
                "label": label,
                "pk": pkv,
                "title": titlev,
            }));
        }
    }

    Ok(Json(json!({ "results": results })))
}
