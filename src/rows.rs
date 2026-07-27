use crate::introspect::{DbColumn, DbTable, Kind};
use crate::meta::{fk_label_col, resolve_inlines, search_columns, table_config, ResolvedInline};
use crate::sqlval::{ident, pk_predicate, present_row, value_expr, Binds};
use crate::state::{AppError, AppState, CurrentUser};
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::Response;
use axum::Json;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;

const MAX_PP: u32 = 500;
const INLINE_CAP: i64 = 50;
const APPROX_THRESHOLD: i64 = 500_000;

fn table_of<'a>(
    state: &'a AppState,
    user: &CurrentUser,
    table: &str,
) -> Result<&'a DbTable, AppError> {
    state.readable_table(user, table)
}

fn binary_cols(dbt: &DbTable) -> Vec<String> {
    dbt.columns
        .iter()
        .filter(|c| c.kind == Kind::Binary)
        .map(|c| c.name.clone())
        .collect()
}

struct ListQuery {
    where_sql: String,
    binds: Binds,
    order_sql: String,
}

/// The ORDER BY expression for a computed (`sql`) field: its `sort_by` real
/// column, else its expression when `sortable`. `None` = a display-only computed
/// field (or an unknown column), which the caller rejects. A `sort_by` target the
/// user has masked is refused — otherwise ordering would leak a hidden value.
fn computed_sort_expr(
    dbt: &DbTable,
    cfg: &crate::config::TableConfig,
    masked: &[String],
    col: &str,
) -> Option<String> {
    let f = cfg.fields.get(col)?;
    let sql = f.sql.as_ref()?;
    if let Some(sb) = &f.sort_by {
        if masked.contains(sb) {
            return None;
        }
        return dbt.column(sb).map(|c| ident(&c.name));
    }
    f.sortable.then(|| format!("({sql})"))
}

fn build_list_query(
    state: &AppState,
    user: &CurrentUser,
    key: &str,
    dbt: &DbTable,
    params: &HashMap<String, String>,
) -> Result<ListQuery, AppError> {
    let cfg = table_config(state, key);
    let masked = state.masked_columns(user, key);
    let mut clauses: Vec<String> = Vec::new();
    let mut binds = Binds::for_dialect(state.pool_of(dbt).dialect());

    if let Some(q) = params.get("q").filter(|q| !q.is_empty()) {
        let cols: Vec<String> = search_columns(dbt, &cfg)
            .into_iter()
            .filter(|c| !masked.contains(c))
            .collect();
        if !cols.is_empty() {
            let ors: Vec<String> = cols
                .iter()
                .map(|c| {
                    let n = binds.ph(Some(format!("%{q}%")));
                    crate::sqlval::ilike_clause(binds.dialect(), &ident(c), &n)
                })
                .collect();
            clauses.push(format!("({})", ors.join(" OR ")));
        }
    }

    for (key, raw) in params {
        let Some(keyname) = key.strip_prefix("f_") else {
            continue;
        };
        let (name, op) = split_op(keyname);
        if op.is_none() {
            if let Some(def) = cfg.list.filter_defs.get(name) {
                if raw == "1" || raw == "true" {
                    clauses.push(format!("({})", def.sql));
                }
                continue;
            }
        }
        // Any real column filters (Notion-style); the configured list only
        // curates which are featured. Masked columns are gated below.
        if !cfg.list.filters.contains(&name.to_string()) && dbt.column(name).is_none() {
            return Err(AppError::bad(format!("unknown filter {name}")));
        }
        if masked.contains(&name.to_string()) {
            return Err(AppError::forbidden(format!("cannot filter on {name}")));
        }
        let col = dbt
            .column(name)
            .ok_or_else(|| AppError::bad(format!("unknown filter {name}")))?;
        match op {
            None => bare_filter_clause(col, name, raw, &mut binds, &mut clauses)?,
            Some(op) => operator_clause(col, name, op, raw, &mut binds, &mut clauses)?,
        }
    }

    if let Some(rf) = state.row_filter(user, key) {
        clauses.push(format!("({rf})"));
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };

    let sort_raw = params
        .get("sort")
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| crate::meta::default_sort(dbt, &cfg));
    let mut terms = Vec::new();
    for tok in sort_raw.split(',') {
        let tok = tok.trim();
        if tok.is_empty() {
            continue;
        }
        let (col, dir) = match tok.strip_prefix('-') {
            Some(c) => (c, "DESC"),
            None => (tok, "ASC"),
        };
        if masked.contains(&col.to_string()) {
            return Err(AppError::forbidden(format!("cannot sort on {col}")));
        }
        let expr = match dbt.column(col) {
            Some(sort_col) => ident(&sort_col.name),
            None => computed_sort_expr(dbt, &cfg, &masked, col)
                .ok_or_else(|| AppError::bad(format!("unknown sort column {col}")))?,
        };
        terms.push(crate::sqlval::order_term(binds.dialect(), &expr, dir));
    }
    let order_sql = if terms.is_empty() {
        String::new()
    } else {
        format!("ORDER BY {}", terms.join(", "))
    };

    Ok(ListQuery {
        where_sql,
        binds,
        order_sql,
    })
}

const FILTER_OPS: &[&str] = &[
    "gte", "lte", "gt", "lt", "ne", "contains", "in", "between", "isnull",
];

fn split_op(key: &str) -> (&str, Option<&'static str>) {
    for op in FILTER_OPS {
        let suffix = format!("__{op}");
        if let Some(base) = key.strip_suffix(&suffix) {
            if !base.is_empty() {
                return (base, Some(op));
            }
        }
    }
    (key, None)
}

fn bare_filter_clause(
    col: &crate::introspect::DbColumn,
    name: &str,
    raw: &str,
    binds: &mut Binds,
    clauses: &mut Vec<String>,
) -> Result<(), AppError> {
    if raw == "__null__" {
        clauses.push(format!("{} IS NULL", ident(name)));
        return Ok(());
    }
    let dialect = binds.dialect();
    match col.kind {
        Kind::Bool => {
            let val = match dialect {
                crate::db::Dialect::Pg => raw.to_string(),
                crate::db::Dialect::MySql | crate::db::Dialect::ClickHouse => match raw {
                    "true" | "1" => "1".into(),
                    "false" | "0" => "0".into(),
                    other => return Err(AppError::bad(format!("bad boolean filter {other}"))),
                },
            };
            let p = binds.typed(Some(val), "boolean");
            clauses.push(format!("{} = {p}", ident(name)));
        }
        Kind::Datetime | Kind::Date => {
            let expr = ident(name);
            let (today, ago): (&str, fn(u32) -> String) = match dialect {
                crate::db::Dialect::Pg => ("date_trunc('day', now())", |d| {
                    format!("now() - interval '{d} days'")
                }),
                crate::db::Dialect::MySql => ("CAST(CURDATE() AS DATETIME)", |d| {
                    format!("NOW() - INTERVAL {d} DAY")
                }),
                crate::db::Dialect::ClickHouse => ("toStartOfDay(now())", |d| {
                    format!("now() - INTERVAL {d} DAY")
                }),
            };
            match raw {
                "today" => clauses.push(format!("{expr} >= {today}")),
                "7d" => clauses.push(format!("{expr} >= {}", ago(7))),
                "30d" => clauses.push(format!("{expr} >= {}", ago(30))),
                "90d" => clauses.push(format!("{expr} >= {}", ago(90))),
                other => {
                    let (from, to) = other
                        .split_once("..")
                        .ok_or_else(|| AppError::bad(format!("bad date filter {other}")))?;
                    if !from.is_empty() {
                        let p = binds.typed(Some(from.to_string()), "timestamptz");
                        clauses.push(format!("{expr} >= {p}"));
                    }
                    if !to.is_empty() {
                        let p = binds.typed(Some(to.to_string()), "timestamptz");
                        clauses.push(format!("{expr} < {p}"));
                    }
                }
            }
        }
        _ => {
            let n = binds.ph(Some(raw.to_string()));
            let lhs = crate::sqlval::text_cast(dialect, &ident(name));
            clauses.push(format!("{lhs} = {n}"));
        }
    }
    Ok(())
}

fn operator_clause(
    col: &crate::introspect::DbColumn,
    name: &str,
    op: &str,
    raw: &str,
    binds: &mut Binds,
    clauses: &mut Vec<String>,
) -> Result<(), AppError> {
    let cast = crate::sqlval::cast_of(col);
    match op {
        "isnull" => match raw {
            "1" | "true" => clauses.push(format!("{} IS NULL", ident(name))),
            "0" | "false" => clauses.push(format!("{} IS NOT NULL", ident(name))),
            other => return Err(AppError::bad(format!("isnull expects 0 or 1, got {other}"))),
        },
        "contains" => {
            let n = binds.ph(Some(format!("%{raw}%")));
            let clause = crate::sqlval::ilike_clause(binds.dialect(), &ident(name), &n);
            clauses.push(clause);
        }
        "in" => {
            let parts: Vec<&str> = raw
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            if parts.is_empty() {
                return Err(AppError::bad(format!(
                    "{name}__in needs at least one value"
                )));
            }
            let placeholders: Vec<String> = parts
                .iter()
                .map(|p| binds.typed(Some(p.to_string()), &cast))
                .collect();
            clauses.push(format!("{} IN ({})", ident(name), placeholders.join(", ")));
        }
        "between" => {
            let (a, b) = raw
                .split_once("..")
                .ok_or_else(|| AppError::bad(format!("{name}__between expects a..b")))?;
            if a.is_empty() || b.is_empty() {
                return Err(AppError::bad(format!("{name}__between needs both bounds")));
            }
            let pa = binds.typed(Some(a.to_string()), &cast);
            let pb = binds.typed(Some(b.to_string()), &cast);
            clauses.push(format!("{} BETWEEN {pa} AND {pb}", ident(name)));
        }
        cmp => {
            let sqlop = match cmp {
                "gt" => ">",
                "gte" => ">=",
                "lt" => "<",
                "lte" => "<=",
                "ne" => "<>",
                _ => return Err(AppError::bad(format!("unknown operator {cmp}"))),
            };
            let p = binds.typed(Some(raw.to_string()), &cast);
            clauses.push(format!("{} {sqlop} {p}", ident(name)));
        }
    }
    Ok(())
}

/// `<col>__label` companions for the list projection: one correlated lookup per
/// FK whose target the caller may view (same rules as options_handler — target
/// configured + viewable + row-filtered), skipping masked columns and targets
/// with no name-ish label column. Cross-source FKs can't be joined and are skipped.
fn fk_label_pairs(state: &AppState, user: &CurrentUser, key: &str, dbt: &DbTable) -> Vec<String> {
    let masked = state.masked_columns(user, key);
    let mut out = Vec::new();
    for c in &dbt.columns {
        let Some((ft, fc)) = &c.fk else { continue };
        if masked.contains(&c.name) {
            continue;
        }
        let Ok(child) = state.readable_table(user, ft) else {
            continue;
        };
        if child.source != dbt.source {
            continue;
        }
        let label = fk_label_col(child);
        if Some(&label) == child.pk.as_ref() {
            continue;
        }
        let mut sub = format!(
            "SELECT {} FROM {} f WHERE f.{} = t.{}",
            crate::sqlval::text_cast(
                state.pool_of(dbt).dialect(),
                &format!("f.{}", ident(&label))
            ),
            state.qualified_of(child),
            ident(fc),
            ident(&c.name)
        );
        if let Some(rf) = state.row_filter(user, ft) {
            sub = format!("{sub} AND ({rf})");
        }
        out.push(format!(
            "({sub} LIMIT 1) AS {}",
            ident(&format!("{}__label", c.name))
        ));
    }
    out
}

async fn fetch_rows(
    state: &AppState,
    user: &CurrentUser,
    key: &str,
    dbt: &DbTable,
    lq: &ListQuery,
    limit: i64,
    offset: i64,
) -> Result<Vec<Value>, AppError> {
    let mut items =
        crate::meta::select_items_for(dbt, &table_config(state, key), state.pool_of(dbt).dialect());
    items.extend(fk_label_pairs(state, user, key, dbt));
    let sql = format!(
        "SELECT {} FROM {} t {} {} LIMIT {limit} OFFSET {offset}",
        items.join(", "),
        state.qualified_of(dbt),
        lq.where_sql,
        lq.order_sql,
    );
    let rows = crate::db::fetch_json_rows(state.pool_of(dbt), &sql, &lq.binds).await?;
    let masked = state.masked_columns(user, key);
    let bins = binary_cols(dbt);
    let mut out = Vec::with_capacity(rows.len());
    for m in rows {
        let mut v = Value::Object(m);
        present_row(&mut v, &masked, &bins);
        out.push(v);
    }
    Ok(out)
}

pub async fn list_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(table): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, AppError> {
    let dbt = table_of(&state, &user, &table)?;
    let lq = build_list_query(&state, &user, &table, dbt, &params)?;
    let page: u32 = params
        .get("page")
        .and_then(|p| p.parse().ok())
        .unwrap_or(1)
        .max(1);
    let pp: u32 = params
        .get("pp")
        .and_then(|p| p.parse().ok())
        .unwrap_or_else(|| {
            table_config(&state, &table)
                .list
                .per_page
                .or(state.cfg().cartapel.per_page)
                .unwrap_or(100)
        })
        .clamp(1, MAX_PP);

    let exact_count = || async {
        let count_sql = format!(
            "SELECT count(*) AS n FROM {} t {}",
            state.qualified_of(dbt),
            lq.where_sql
        );
        crate::db::fetch_json_rows(state.pool_of(dbt), &count_sql, &lq.binds)
            .await
            .map(|rows| {
                rows.first()
                    .and_then(|m| m.get("n"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            })
    };
    let approx_req = params
        .get("approx")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    let (total, approx) = if lq.where_sql.is_empty() {
        let est: i64 = crate::db::estimate_rows(state.pool_of(dbt), dbt).await?;
        if approx_req || est > APPROX_THRESHOLD {
            (est, true)
        } else {
            (exact_count().await?, false)
        }
    } else {
        (exact_count().await?, false)
    };
    let rows = fetch_rows(
        &state,
        &user,
        &table,
        dbt,
        &lq,
        pp as i64,
        (page as i64 - 1) * pp as i64,
    )
    .await?;
    Ok(Json(
        json!({ "rows": rows, "total": total, "page": page, "pp": pp, "approx": approx }),
    ))
}

async fn fetch_one(
    state: &AppState,
    user: &CurrentUser,
    key: &str,
    dbt: &DbTable,
    pk: &str,
) -> Result<Value, AppError> {
    let pk_col = dbt
        .pk
        .as_ref()
        .and_then(|p| dbt.column(p))
        .ok_or_else(|| AppError::bad("table has no primary key"))?;
    let pool = state.pool_of(dbt);
    let mut binds = Binds::for_dialect(pool.dialect());
    let mut where_sql = pk_predicate(pk_col, pk, &mut binds)?;
    if let Some(rf) = state.row_filter(user, key) {
        where_sql = format!("{where_sql} AND ({rf})");
    }
    let items = crate::meta::select_items_for(dbt, &table_config(state, key), pool.dialect());
    let sql = format!(
        "SELECT {} FROM {} t WHERE {where_sql}",
        items.join(", "),
        state.qualified_of(dbt)
    );
    let m = crate::db::fetch_json_rows(pool, &sql, &binds)
        .await?
        .into_iter()
        .next()
        .ok_or(sqlx::Error::RowNotFound)?;
    let mut v = Value::Object(m);
    present_row(&mut v, &state.masked_columns(user, key), &binary_cols(dbt));
    Ok(v)
}

fn inline_offset(page: u32) -> i64 {
    (page.max(1) as i64 - 1) * INLINE_CAP
}

fn inline_json(ri: &ResolvedInline, rows: Vec<Value>, total: i64) -> Value {
    json!({
        "table": ri.child,
        "label": ri.label,
        "fk_col": ri.fk_col,
        "columns": ri.columns,
        "can_create": ri.can_create,
        "can_delete": ri.can_delete,
        "rows": rows,
        "total": total,
        "cap": INLINE_CAP,
    })
}

/// A page of an inline's child rows, filtered to `fk_col = pk`, with the child
/// table's `row_filter` and `masked_columns` re-applied exactly as the detail
/// page does. Returns the rows plus the total matching count.
async fn fetch_inline_page(
    state: &AppState,
    user: &CurrentUser,
    key: &str,
    child_t: &DbTable,
    fk_c: &DbColumn,
    pk: &str,
    page: u32,
) -> Result<(Vec<Value>, i64), AppError> {
    let pool = state.pool_of(child_t);
    let mut binds = Binds::for_dialect(pool.dialect());
    let p = binds.typed(Some(pk.to_string()), &fk_c.udt);
    let mut where_sql = format!("{} = {p}", ident(&fk_c.name));
    if let Some(rf) = state.row_filter(user, key) {
        where_sql = format!("{where_sql} AND ({rf})");
    }
    let order = child_t
        .pk
        .as_ref()
        .map(|p| format!("ORDER BY {} DESC", ident(p)))
        .unwrap_or_default();
    let mut items =
        crate::meta::select_items_for(child_t, &table_config(state, key), pool.dialect());
    items.extend(fk_label_pairs(state, user, key, child_t));
    let sql = format!(
        "SELECT {}, count(*) OVER () AS __cartapel_total FROM {} t WHERE {where_sql} {order} LIMIT {INLINE_CAP} OFFSET {}",
        items.join(", "),
        state.qualified_of(child_t),
        inline_offset(page),
    );
    let rows = crate::db::fetch_json_rows(pool, &sql, &binds).await?;
    let total = rows
        .first()
        .and_then(|m| m.get("__cartapel_total"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let masked = state.masked_columns(user, key);
    let bins = binary_cols(child_t);
    let mut out = Vec::with_capacity(rows.len());
    for mut m in rows {
        m.shift_remove("__cartapel_total");
        let mut v = Value::Object(m);
        present_row(&mut v, &masked, &bins);
        out.push(v);
    }
    Ok((out, total))
}

/// Resolve a child table the caller named against the parent's CONFIGURED
/// inlines. A child that is not a declared inline of `parent` is rejected — the
/// endpoint never accepts an arbitrary table name.
fn resolve_configured_inline(
    state: &AppState,
    user: &CurrentUser,
    parent: &str,
    child: &str,
) -> Result<ResolvedInline, AppError> {
    resolve_inlines(state, user, parent)
        .into_iter()
        .find(|r| r.child == child)
        .ok_or_else(|| AppError::not_found(format!("{child} is not an inline of {parent}")))
}

/// Detail-page-only FK label enrichment — kept OUT of fetch_one so audit
/// before/after snapshots never carry display companions.
async fn attach_fk_labels(
    state: &AppState,
    user: &CurrentUser,
    key: &str,
    dbt: &DbTable,
    pk: &str,
    row: &mut Value,
) -> Result<(), AppError> {
    let pairs = fk_label_pairs(state, user, key, dbt);
    let Some(pk_col) = dbt.pk.as_ref().and_then(|p| dbt.column(p)) else {
        return Ok(());
    };
    if pairs.is_empty() {
        return Ok(());
    }
    let pool = state.pool_of(dbt);
    let mut binds = Binds::for_dialect(pool.dialect());
    let where_sql = pk_predicate(pk_col, pk, &mut binds)?;
    let sql = format!(
        "SELECT {} FROM {} t WHERE {where_sql}",
        pairs.join(", "),
        state.qualified_of(dbt)
    );
    let extra = crate::db::fetch_json_rows(pool, &sql, &binds)
        .await?
        .into_iter()
        .next()
        .ok_or(sqlx::Error::RowNotFound)?;
    if let Some(obj) = row.as_object_mut() {
        for (k, v) in extra {
            obj.insert(k, v);
        }
    }
    Ok(())
}

pub async fn detail_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, pk)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let dbt = table_of(&state, &user, &table)?;
    let mut row = fetch_one(&state, &user, &table, dbt, &pk).await?;
    attach_fk_labels(&state, &user, &table, dbt, &pk, &mut row).await?;

    let mut inlines = Vec::new();
    for ri in resolve_inlines(&state, &user, &table) {
        let Ok(child_t) = table_of(&state, &user, &ri.child) else {
            continue;
        };
        let Some(fk_c) = child_t.column(&ri.fk_col) else {
            continue;
        };
        let (rows, total) =
            fetch_inline_page(&state, &user, &ri.child, child_t, fk_c, &pk, 1).await?;
        inlines.push(inline_json(&ri, rows, total));
    }
    Ok(Json(json!({ "row": row, "inlines": inlines })))
}

pub async fn inline_page_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, pk, child)): Path<(String, String, String)>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, AppError> {
    let dbt = table_of(&state, &user, &table)?;
    let ri = resolve_configured_inline(&state, &user, &table, &child)?;
    fetch_one(&state, &user, &table, dbt, &pk).await?;
    let child_t = table_of(&state, &user, &ri.child)?;
    let fk_c = child_t
        .column(&ri.fk_col)
        .ok_or_else(|| AppError::bad(format!("inline {child} has no column {}", ri.fk_col)))?;
    let page: u32 = params
        .get("page")
        .and_then(|p| p.parse().ok())
        .unwrap_or(1)
        .max(1);
    let (rows, total) =
        fetch_inline_page(&state, &user, &ri.child, child_t, fk_c, &pk, page).await?;
    let mut out = inline_json(&ri, rows, total);
    out.as_object_mut()
        .unwrap()
        .insert("page".into(), json!(page));
    Ok(Json(out))
}

pub(crate) fn editable_set(
    state: &AppState,
    user: &CurrentUser,
    key: &str,
    dbt: &DbTable,
    body: &Value,
    creating: bool,
) -> Result<Vec<(String, Value)>, AppError> {
    let cfg = table_config(state, key);
    let masked = state.masked_columns(user, key);
    let editable = state.editable_columns(user, key);
    let set = body
        .get("set")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::bad("body must be {\"set\": {...}}"))?;
    if set.is_empty() {
        return Err(AppError::bad("nothing to set"));
    }
    let mut out = Vec::new();
    for (k, v) in set {
        let col = dbt
            .column(k)
            .ok_or_else(|| AppError::bad(format!("unknown column {k}")))?;
        let is_pk = Some(k) == dbt.pk.as_ref();
        if masked.contains(k)
            || cfg.edit.readonly.contains(k)
            || cfg.fields.get(k).map(|f| f.readonly).unwrap_or(false)
            || (is_pk && !creating)
            || editable.as_ref().is_some_and(|wl| !wl.contains(k))
        {
            return Err(AppError::bad(format!("{k} is read-only")));
        }
        out.push((col.name.clone(), v.clone()));
    }
    Ok(out)
}

pub async fn update_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, pk)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    apply_update(&state, &user, &table, &pk, &body, "update", None).await
}

/// The single row-update path — reverts ride it so they obey the same rules as
/// edits. `guard` cols must still hold the given values when the UPDATE lands
/// (else 409). On tables the guard is checked under SELECT … FOR UPDATE in the
/// same tx as the write; views can't be row-locked, so there the guard rides
/// inside the UPDATE's WHERE — either way, never check-then-act.
async fn apply_update(
    state: &AppState,
    user: &CurrentUser,
    table: &str,
    pk: &str,
    body: &Value,
    action: &str,
    guard: Option<&Map<String, Value>>,
) -> Result<Json<Value>, AppError> {
    let dbt = table_of(state, user, table)?;
    if !state.table_perms(user, table).update {
        return Err(AppError::forbidden("no write access"));
    }
    if let Some(g) = guard {
        for col in g.keys() {
            if dbt.column(col).is_none() {
                return Err(AppError::bad(format!("unknown column {col}")));
            }
        }
    }
    let pk_col = dbt.pk.as_ref().and_then(|p| dbt.column(p)).unwrap();
    let pool = state.pool_of(dbt);
    let dialect = pool.dialect();
    // Writes return the row without computed fields (parity with the old
    // RETURNING to_jsonb), and the lock-select must not evaluate computed
    // expressions (FOR UPDATE rejects window functions).
    let items = crate::meta::select_items_for(dbt, &Default::default(), dialect).join(", ");
    let row_scope = |binds: &mut Binds| -> Result<String, AppError> {
        let mut w = pk_predicate(pk_col, pk, binds)?;
        if let Some(rf) = state.row_filter(user, table) {
            w = format!("{w} AND ({rf})");
        }
        Ok(w)
    };

    let mut tx = pool.begin_tx().await?;

    let mut binds = Binds::for_dialect(dialect);
    let where_sql = row_scope(&mut binds)?;
    let lock = if dbt.is_view { "" } else { " FOR UPDATE" };
    let sql = format!(
        "SELECT {items} FROM {} t WHERE {where_sql}{lock}",
        state.qualified_of(dbt)
    );
    let before_raw = tx
        .fetch_json_rows(&sql, &binds)
        .await?
        .into_iter()
        .next()
        .ok_or(sqlx::Error::RowNotFound)?;
    if let Some(g) = guard {
        for (col, val) in g {
            if before_raw.get(col).unwrap_or(&Value::Null) != val {
                return Err(AppError::conflict(
                    "the row has changed since this edit — refresh and review before reverting",
                ));
            }
        }
    }
    let mut before = Value::Object(before_raw);
    present_row(
        &mut before,
        &state.masked_columns(user, table),
        &binary_cols(dbt),
    );
    let changes = editable_set(state, user, table, dbt, body, false)?;

    let mut binds = Binds::for_dialect(dialect);
    let mut sets = Vec::new();
    for (col_name, val) in &changes {
        let col = dbt.column(col_name).unwrap();
        let expr = value_expr(col, val, &mut binds)?;
        sets.push(format!("{} = {expr}", ident(col_name)));
    }
    let mut where_sql = row_scope(&mut binds)?;
    if dbt.is_view {
        if let Some(g) = guard {
            if dialect != crate::db::Dialect::Pg {
                return Err(AppError::bad("reverts on MySQL views are not supported"));
            }
            for (col, val) in g {
                let k = binds.ph(Some(col.clone()));
                let v = binds.ph(Some(val.to_string()));
                where_sql = format!(
                    "{where_sql} AND to_jsonb(t.*)->({k}::text) IS NOT DISTINCT FROM {v}::jsonb"
                );
            }
        }
    }
    let sql = format!(
        "UPDATE {} t SET {} WHERE {where_sql}",
        state.qualified_of(dbt),
        sets.join(", ")
    );
    if tx.execute(&sql, &binds).await?.rows_affected == 0 {
        if guard.is_some() {
            return Err(AppError::conflict(
                "the row has changed since this edit — refresh and review before reverting",
            ));
        }
        return Err(sqlx::Error::RowNotFound.into());
    }

    let mut binds = Binds::for_dialect(dialect);
    let where_sql = pk_predicate(pk_col, pk, &mut binds)?;
    let sql = format!(
        "SELECT {items} FROM {} t WHERE {where_sql}",
        state.qualified_of(dbt)
    );
    let after_raw = tx
        .fetch_json_rows(&sql, &binds)
        .await?
        .into_iter()
        .next()
        .ok_or(sqlx::Error::RowNotFound)?;
    tx.commit().await?;

    let mut after = Value::Object(after_raw);
    present_row(
        &mut after,
        &state.masked_columns(user, table),
        &binary_cols(dbt),
    );

    let mut diff = Map::new();
    for (col, _) in &changes {
        diff.insert(
            col.clone(),
            json!({ "from": before.get(col), "to": after.get(col) }),
        );
    }
    let audit_id = state.store.audit(
        &user.email,
        table,
        Some(pk),
        action,
        Some(&Value::Object(diff)),
    );
    Ok(Json(json!({ "row": after, "audit_id": audit_id })))
}

/// Admin-only (the audit log it replays is admin-only to read); 409 when the
/// row moved on since the audited edit.
pub async fn revert_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, pk, audit_id)): Path<(String, String, i64)>,
) -> Result<Json<Value>, AppError> {
    crate::configedit::admin_only(&user)?;
    let dbt = table_of(&state, &user, &table)?;
    if !state.table_perms(&user, &table).update {
        return Err(AppError::forbidden("no write access"));
    }
    let entry = state
        .store
        .audit_entry(audit_id)?
        .ok_or_else(|| AppError::not_found("audit entry not found"))?;
    if entry.table != table || entry.pk.as_deref() != Some(&pk) {
        return Err(AppError::bad("audit entry does not belong to this row"));
    }
    if !matches!(entry.action.as_str(), "update" | "revert") {
        return Err(AppError::bad("only field edits can be reverted"));
    }
    let diff = entry
        .changes
        .as_ref()
        .and_then(Value::as_object)
        .filter(|d| !d.is_empty())
        .ok_or_else(|| AppError::bad("audit entry has no revertable changes"))?;

    // Pre-check names the drifted column; the atomic backstop is the WHERE guard.
    let current = fetch_one(&state, &user, &table, dbt, &pk).await?;
    let mut set = Map::new();
    let mut guard = Map::new();
    for (col, change) in diff {
        let from = change.get("from").cloned().unwrap_or(Value::Null);
        let to = change.get("to").cloned().unwrap_or(Value::Null);
        if current.get(col.as_str()).cloned().unwrap_or(Value::Null) != to {
            return Err(AppError::conflict(format!(
                "{col} has changed since this edit — refresh and review before reverting"
            )));
        }
        set.insert(col.clone(), from);
        guard.insert(col.clone(), to);
    }
    apply_update(
        &state,
        &user,
        &table,
        &pk,
        &json!({ "set": set }),
        "revert",
        Some(&guard),
    )
    .await
}

const MAX_BULK_PKS: usize = 5000;

pub async fn bulk_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(table): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let dbt = table_of(&state, &user, &table)?;
    if !state.table_perms(&user, &table).update {
        return Err(AppError::forbidden("no write access"));
    }
    let pks: Vec<String> = body
        .get("pks")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::bad("body must be {\"pks\": [...], \"set\": {...}}"))?
        .iter()
        .map(|v| match v {
            Value::String(s) => Ok(s.clone()),
            Value::Number(n) => Ok(n.to_string()),
            _ => Err(AppError::bad("pks entries must be scalar")),
        })
        .collect::<Result<Vec<String>, AppError>>()?;
    if pks.is_empty() || pks.len() > MAX_BULK_PKS {
        return Err(AppError::bad(format!("pks must be 1..{MAX_BULK_PKS}")));
    }
    let changes = editable_set(&state, &user, &table, dbt, &body, false)?;
    let pk_col = dbt
        .pk
        .as_ref()
        .and_then(|p| dbt.column(p))
        .ok_or_else(|| AppError::bad("table has no primary key"))?;

    let pool = state.pool_of(dbt);
    let mut binds = Binds::for_dialect(pool.dialect());
    let mut sets = Vec::new();
    for (col_name, val) in &changes {
        let col = dbt.column(col_name).unwrap();
        let expr = value_expr(col, val, &mut binds)?;
        sets.push(format!("{} = {expr}", ident(col_name)));
    }
    let mut placeholders = Vec::with_capacity(pks.len());
    for pk in &pks {
        let n = binds.ph(Some(pk.clone()));
        placeholders.push(n);
    }
    let mut where_sql = format!(
        "{} IN ({})",
        crate::sqlval::pk_in_lhs(pool.dialect(), &ident(&pk_col.name)),
        placeholders.join(", ")
    );
    if let Some(rf) = state.row_filter(&user, &table) {
        where_sql = format!("{where_sql} AND ({rf})");
    }
    let sql = format!(
        "UPDATE {} t SET {} WHERE {where_sql}",
        state.qualified_of(dbt),
        sets.join(", ")
    );
    let affected = crate::db::execute(pool, &sql, &binds).await?.rows_affected;

    let diff: Map<String, Value> = changes
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    state.store.audit(
        &user.email,
        &table,
        None,
        "bulk",
        Some(&json!({ "pks_count": pks.len(), "set": Value::Object(diff) })),
    );
    Ok(Json(json!({ "affected": affected })))
}

pub async fn create_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(table): Path<String>,
    Json(body): Json<Value>,
) -> Result<(axum::http::StatusCode, Json<Value>), AppError> {
    let dbt = table_of(&state, &user, &table)?;
    if !state.table_perms(&user, &table).create {
        return Err(AppError::forbidden("no create access"));
    }
    let pool = state.pool_of(dbt);
    let dialect = pool.dialect();
    let changes = editable_set(&state, &user, &table, dbt, &body, true)?;
    let mut binds = Binds::for_dialect(dialect);
    let mut cols = Vec::new();
    let mut exprs = Vec::new();
    for (col_name, val) in &changes {
        let col = dbt.column(col_name).unwrap();
        exprs.push(value_expr(col, val, &mut binds)?);
        cols.push(ident(col_name));
    }
    let items = crate::meta::select_items_for(dbt, &Default::default(), dialect).join(", ");
    let after_raw = match dialect {
        crate::db::Dialect::ClickHouse => {
            return Err(AppError::bad("ClickHouse sources are read-only"));
        }
        crate::db::Dialect::Pg => {
            let sql = format!(
                "INSERT INTO {} AS t ({}) VALUES ({}) RETURNING {items}",
                state.qualified_of(dbt),
                cols.join(", "),
                exprs.join(", ")
            );
            crate::db::fetch_json_rows(pool, &sql, &binds)
                .await?
                .into_iter()
                .next()
                .ok_or(sqlx::Error::RowNotFound)?
        }
        crate::db::Dialect::MySql => {
            let pk_col = dbt
                .pk
                .as_ref()
                .and_then(|p| dbt.column(p))
                .ok_or_else(|| AppError::bad("creating rows needs a primary key"))?;
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                state.qualified_of(dbt),
                cols.join(", "),
                exprs.join(", ")
            );
            let mut tx = pool.begin_tx().await?;
            let res = tx.execute(&sql, &binds).await?;
            // last_insert_id wins when the server generated one — a submitted
            // "0"/"" on an auto-increment column is a generation request, and
            // MySQL reports 0 when the client supplied the value itself.
            let pk_val = res
                .last_insert_id
                .filter(|id| *id > 0)
                .map(|id| id.to_string())
                .or_else(|| {
                    changes
                        .iter()
                        .find(|(c, _)| c == &pk_col.name)
                        .map(|(_, v)| match v {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                })
                .ok_or_else(|| AppError::bad("could not determine the new row's primary key"))?;
            let mut binds = Binds::for_dialect(dialect);
            let where_sql = pk_predicate(pk_col, &pk_val, &mut binds)?;
            let sql = format!(
                "SELECT {items} FROM {} t WHERE {where_sql}",
                state.qualified_of(dbt)
            );
            let row = tx
                .fetch_json_rows(&sql, &binds)
                .await?
                .into_iter()
                .next()
                .ok_or(sqlx::Error::RowNotFound)?;
            tx.commit().await?;
            row
        }
    };
    let mut after = Value::Object(after_raw);
    present_row(
        &mut after,
        &state.masked_columns(&user, &table),
        &binary_cols(dbt),
    );
    let pk_str = dbt.pk.as_ref().and_then(|p| after.get(p)).map(|v| match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    });
    state.store.audit(
        &user.email,
        &table,
        pk_str.as_deref(),
        "create",
        Some(&json!({ "row": after })),
    );
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "row": after })),
    ))
}

pub async fn delete_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, pk)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let dbt = table_of(&state, &user, &table)?;
    if !state.table_perms(&user, &table).delete {
        return Err(AppError::forbidden("no delete access"));
    }
    let before = fetch_one(&state, &user, &table, dbt, &pk).await?;
    let pk_col = dbt.pk.as_ref().and_then(|p| dbt.column(p)).unwrap();
    let pool = state.pool_of(dbt);
    let mut binds = Binds::for_dialect(pool.dialect());
    let mut where_sql = pk_predicate(pk_col, &pk, &mut binds)?;
    if let Some(rf) = state.row_filter(&user, &table) {
        where_sql = format!("{where_sql} AND ({rf})");
    }
    let sql = format!("DELETE FROM {} WHERE {where_sql}", state.qualified_of(dbt));
    if crate::db::execute(pool, &sql, &binds).await?.rows_affected == 0 {
        return Err(sqlx::Error::RowNotFound.into());
    }
    state.store.audit(
        &user.email,
        &table,
        Some(&pk),
        "delete",
        Some(&json!({ "row": before })),
    );
    Ok(Json(json!({})))
}

/// One short product-language reason per rejected import row, keyed off the
/// database's own constraint code (Postgres SQLSTATE or MySQL errno).
fn import_reject_message(row: &usize, e: &sqlx::Error) -> String {
    let sqlx::Error::Database(db) = e else {
        return "row rejected".into();
    };
    tracing::warn!("import row {row} rejected: {}", db.message());
    let my = db
        .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
        .map(|e| e.number());
    match (db.code().as_deref(), my) {
        (Some("23505"), _) | (_, Some(1062)) => "duplicate key".into(),
        (Some("23503"), _) | (_, Some(1452)) => "referenced row not found".into(),
        (Some("23502"), _) | (_, Some(1048 | 1364)) => "missing required value".into(),
        (Some("23514"), _) | (_, Some(3819 | 4025)) => "value violates a constraint".into(),
        (Some("22P02" | "22007" | "22008"), _) | (_, Some(1292 | 1366 | 1406 | 1264)) => {
            "invalid value format".into()
        }
        _ => "row rejected".into(),
    }
}

const MAX_IMPORT_ROWS: usize = 10_000;
const MAX_IMPORT_BYTES: usize = 8 * 1024 * 1024;

fn parse_csv(data: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut pending = false;
    let mut chars = data.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' => {
                    in_quotes = true;
                    pending = true;
                }
                ',' => {
                    row.push(std::mem::take(&mut field));
                    pending = true;
                }
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    if !(row.len() == 1 && row[0].is_empty()) {
                        rows.push(std::mem::take(&mut row));
                    } else {
                        row.clear();
                    }
                    pending = false;
                }
                '\r' => {}
                _ => {
                    field.push(c);
                    pending = true;
                }
            }
        }
    }
    if pending || !field.is_empty() {
        row.push(field);
        if !(row.len() == 1 && row[0].is_empty()) {
            rows.push(row);
        }
    }
    rows
}

fn coerce_csv_cell(col: &crate::introspect::DbColumn, raw: &str) -> Value {
    if raw.is_empty() {
        return Value::Null;
    }
    match col.kind {
        Kind::Json | Kind::Array => {
            serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
        }
        _ => Value::String(raw.to_string()),
    }
}

#[allow(clippy::too_many_arguments)]
/// How one import row reports insert-vs-update: Postgres answers inside the
/// statement (`RETURNING xmax = 0`); MySQL answers through `rows_affected`
/// (1 = inserted, 2 = updated — an unchanged upsert also reports 1 and is
/// counted as inserted, the closest honest reading the protocol allows).
enum ImportStmt {
    Returning(String, Binds),
    Affected(String, Binds),
}

#[allow(clippy::too_many_arguments)]
fn build_import_row(
    state: &AppState,
    user: &CurrentUser,
    dbt: &DbTable,
    cfg: &crate::config::TableConfig,
    masked: &[String],
    editable: Option<&[String]>,
    table: &str,
    rec: &Map<String, Value>,
    upsert: bool,
    pk_name: Option<&str>,
) -> Result<ImportStmt, String> {
    if rec.is_empty() {
        return Err("empty row".into());
    }
    let dialect = state.pool_of(dbt).dialect();
    let mut binds = Binds::for_dialect(dialect);
    let mut cols = Vec::new();
    let mut exprs = Vec::new();
    let mut nonpk: Vec<String> = Vec::new();
    for (k, v) in rec {
        let col = dbt.column(k).ok_or_else(|| format!("unknown column {k}"))?;
        let is_pk = Some(k) == dbt.pk.as_ref();
        if masked.contains(k)
            || cfg.edit.readonly.contains(k)
            || cfg.fields.get(k).map(|f| f.readonly).unwrap_or(false)
            || editable.is_some_and(|wl| !wl.contains(k))
        {
            return Err(format!("{k} is read-only"));
        }
        let expr = value_expr(col, v, &mut binds).map_err(|e| e.1)?;
        cols.push(ident(&col.name));
        exprs.push(expr);
        if !is_pk {
            nonpk.push(col.name.clone());
        }
    }
    if upsert {
        let pk = pk_name.ok_or_else(|| "table has no primary key".to_string())?;
        if !rec.contains_key(pk) {
            return Err(format!("upsert row missing primary key {pk}"));
        }
        if nonpk.is_empty() {
            return Err("upsert row has only the primary key".into());
        }
    }
    match dialect {
        crate::db::Dialect::ClickHouse => Err("ClickHouse sources are read-only".into()),
        crate::db::Dialect::Pg => {
            let mut sql = format!(
                "INSERT INTO {} AS t ({}) VALUES ({})",
                state.qualified_of(dbt),
                cols.join(", "),
                exprs.join(", ")
            );
            if upsert {
                let assigns: Vec<String> = nonpk
                    .iter()
                    .map(|c| format!("{0} = EXCLUDED.{0}", ident(c)))
                    .collect();
                sql.push_str(&format!(
                    " ON CONFLICT ({}) DO UPDATE SET {}",
                    ident(pk_name.unwrap()),
                    assigns.join(", ")
                ));
                if let Some(rf) = state.row_filter(user, table) {
                    sql.push_str(&format!(" WHERE ({rf})"));
                }
                sql.push_str(" RETURNING (xmax = 0) AS inserted");
            } else {
                sql.push_str(" RETURNING true AS inserted");
            }
            Ok(ImportStmt::Returning(sql, binds))
        }
        crate::db::Dialect::MySql => {
            let mut sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                state.qualified_of(dbt),
                cols.join(", "),
                exprs.join(", ")
            );
            if upsert {
                // ON DUPLICATE KEY UPDATE takes no WHERE, so a row filter can't
                // scope which rows an upsert may touch — refuse rather than
                // silently widen the user's write surface.
                if state.row_filter(user, table).is_some() {
                    return Err("upsert is not available on MySQL tables with a row filter".into());
                }
                // …and it fires on ANY unique key, so with a second unique key
                // an import row could silently rewrite an unrelated row.
                if dbt.extra_unique {
                    return Err(
                        "upsert is not available on MySQL tables with unique keys besides the primary key"
                            .into(),
                    );
                }
                let assigns: Vec<String> = nonpk
                    .iter()
                    .map(|c| format!("{0} = VALUES({0})", ident(c)))
                    .collect();
                sql.push_str(&format!(" ON DUPLICATE KEY UPDATE {}", assigns.join(", ")));
            }
            Ok(ImportStmt::Affected(sql, binds))
        }
    }
}

pub async fn import_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(table): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let dbt = table_of(&state, &user, &table)?;
    let perms = state.table_perms(&user, &table);
    if !perms.create {
        return Err(AppError::forbidden("no create access"));
    }
    let format = body.get("format").and_then(Value::as_str).unwrap_or("csv");
    let mode = body.get("mode").and_then(Value::as_str).unwrap_or("insert");
    let upsert = match mode {
        "insert" => false,
        "upsert" => true,
        other => {
            return Err(AppError::bad(format!(
                "mode must be insert or upsert, got {other}"
            )))
        }
    };
    if upsert && !perms.update {
        return Err(AppError::forbidden("no write access for upsert"));
    }
    let data = body
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::bad("body must include a data string"))?;
    if data.len() > MAX_IMPORT_BYTES {
        return Err(AppError::bad("import data too large"));
    }

    let mut errors: Vec<Value> = Vec::new();
    let mut records: Vec<(usize, Map<String, Value>)> = Vec::new();
    match format {
        "csv" => {
            let table_rows = parse_csv(data);
            let mut iter = table_rows.iter();
            let header = iter
                .next()
                .ok_or_else(|| AppError::bad("csv has no header row"))?;
            for (i, line) in iter.enumerate() {
                let mut map = Map::new();
                for (idx, name) in header.iter().enumerate() {
                    let raw = line.get(idx).map(String::as_str).unwrap_or("");
                    let val = dbt
                        .column(name)
                        .map(|c| coerce_csv_cell(c, raw))
                        .unwrap_or_else(|| Value::String(raw.to_string()));
                    map.insert(name.clone(), val);
                }
                records.push((i, map));
            }
        }
        "json" => {
            let parsed: Value = serde_json::from_str(data)
                .map_err(|e| AppError::bad(format!("invalid json: {e}")))?;
            let arr = parsed
                .as_array()
                .ok_or_else(|| AppError::bad("json import must be an array of objects"))?;
            for (i, item) in arr.iter().enumerate() {
                match item.as_object() {
                    Some(o) => records.push((i, o.clone())),
                    None => errors.push(json!({ "row": i, "message": "item is not an object" })),
                }
            }
        }
        other => {
            return Err(AppError::bad(format!(
                "format must be csv or json, got {other}"
            )))
        }
    }
    if records.len() > MAX_IMPORT_ROWS {
        return Err(AppError::bad(format!(
            "import exceeds {MAX_IMPORT_ROWS} rows"
        )));
    }

    let cfg = table_config(&state, &table);
    let masked = state.masked_columns(&user, &table);
    let editable = state.editable_columns(&user, &table);
    let pk_name = dbt.pk.clone();

    let mut inserted = 0u64;
    let mut updated = 0u64;
    let mut tx = state.pool_of(dbt).begin_tx().await?;
    for (i, rec) in &records {
        let built = build_import_row(
            &state,
            &user,
            dbt,
            &cfg,
            &masked,
            editable.as_deref(),
            &table,
            rec,
            upsert,
            pk_name.as_deref(),
        );
        let stmt = match built {
            Ok(x) => x,
            Err(msg) => {
                errors.push(json!({ "row": i, "message": msg }));
                continue;
            }
        };
        tx.raw("SAVEPOINT cartapel_import").await?;
        let outcome = match &stmt {
            ImportStmt::Returning(sql, binds) => tx.fetch_json_rows(sql, binds).await.map(|rows| {
                rows.first()
                    .map(|m| m.get("inserted") == Some(&Value::Bool(true)))
            }),
            ImportStmt::Affected(sql, binds) => tx
                .execute(sql, binds)
                .await
                .map(|r| Some(r.rows_affected != 2)),
        };
        match outcome {
            Ok(Some(was_insert)) => {
                tx.raw("RELEASE SAVEPOINT cartapel_import").await?;
                if was_insert {
                    inserted += 1;
                } else {
                    updated += 1;
                }
            }
            Ok(None) => {
                tx.raw("RELEASE SAVEPOINT cartapel_import").await?;
                errors.push(json!({ "row": i, "message": "row exists but not permitted" }));
            }
            Err(e) => {
                tx.raw("ROLLBACK TO SAVEPOINT cartapel_import").await?;
                errors.push(json!({ "row": i, "message": import_reject_message(i, &e) }));
            }
        }
    }
    tx.commit().await?;

    let skipped = errors.len();
    state.store.audit(
        &user.email,
        &table,
        None,
        "import",
        Some(&json!({ "inserted": inserted, "updated": updated, "mode": mode })),
    );
    Ok(Json(json!({
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
    })))
}

const EXPORT_CAP: i64 = 100_000;

fn csv_cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Object(m) => match m.get("__bytes__") {
            Some(b) => format!("<{b} bytes>"),
            None => serde_json::to_string(v).unwrap_or_default(),
        },
        Value::Array(_) => serde_json::to_string(v).unwrap_or_default(),
    }
}

fn csv_escape(s: &str) -> String {
    let neutralized;
    let s = match s.as_bytes().first() {
        Some(b'=' | b'+' | b'-' | b'@' | b'\t' | b'\r') => {
            neutralized = format!("'{s}");
            neutralized.as_str()
        }
        _ => s,
    };
    if s.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

pub fn rows_to_csv(cols: &[String], rows: &[Value]) -> String {
    let mut out = String::new();
    out.push_str(
        &cols
            .iter()
            .map(|c| csv_escape(c))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push('\n');
    for row in rows {
        let line: Vec<String> = cols
            .iter()
            .map(|c| csv_escape(&csv_cell(row.get(c).unwrap_or(&Value::Null))))
            .collect();
        out.push_str(&line.join(","));
        out.push('\n');
    }
    out
}

pub async fn export_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(table): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, AppError> {
    let dbt = table_of(&state, &user, &table)?;
    let cfg = table_config(&state, &table);
    let lq = build_list_query(&state, &user, &table, dbt, &params)?;
    let mut rows = fetch_rows(&state, &user, &table, dbt, &lq, EXPORT_CAP + 1, 0).await?;
    let truncated = rows.len() as i64 > EXPORT_CAP;
    if truncated {
        rows.truncate(EXPORT_CAP as usize);
        tracing::warn!(table = %table, cap = EXPORT_CAP, "export truncated");
    }
    let cols = crate::meta::list_columns(dbt, &cfg);
    let format = params.get("format").map(String::as_str).unwrap_or("csv");
    let (body, content_type, ext) = match format {
        "json" => (
            serde_json::to_string(&rows).unwrap_or_else(|_| "[]".into()),
            "application/json; charset=utf-8",
            "json",
        ),
        _ => (rows_to_csv(&cols, &rows), "text/csv; charset=utf-8", "csv"),
    };
    let filename = format!("{}.{ext}", table.replace(['"', '\\', '/'], ""));
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .header("X-Cartapel-Truncated", truncated.to_string())
        .body(Body::from(body))
        .map_err(|e| AppError::internal(e.to_string()))
}

pub async fn row_audit_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, pk)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    if !user.is_admin() {
        return Err(AppError::forbidden("audit log is admin-only"));
    }
    table_of(&state, &user, &table)?;
    Ok(Json(state.store.audit_for_row(&table, &pk)?))
}

pub async fn options_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, col)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, AppError> {
    let dbt = table_of(&state, &user, &table)?;
    let column = dbt
        .column(&col)
        .ok_or_else(|| AppError::bad(format!("unknown column {col}")))?;
    let (f_table, f_col) = column
        .fk
        .clone()
        .ok_or_else(|| AppError::bad(format!("{col} is not a foreign key")))?;
    let child = table_of(&state, &user, &f_table)?;
    let label = fk_label_col(child);
    let pool = state.pool_of(child);
    let dialect = pool.dialect();
    let mut binds = Binds::for_dialect(dialect);
    let mut clauses: Vec<String> = Vec::new();
    if let Some(q) = params.get("q").filter(|q| !q.is_empty()) {
        let n = binds.ph(Some(format!("%{q}%")));
        clauses.push(crate::sqlval::ilike_clause(dialect, &ident(&label), &n));
    }
    if let Some(rf) = state.row_filter(&user, &f_table) {
        clauses.push(format!("({rf})"));
    }
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let sql = format!(
        "SELECT {} AS value, {} AS label FROM {} {} ORDER BY 2 LIMIT 20",
        crate::sqlval::text_cast(dialect, &ident(&f_col)),
        crate::sqlval::text_cast(dialect, &ident(&label)),
        state.qualified_of(child),
        where_sql
    );
    let rows = crate::db::fetch_json_rows(pool, &sql, &binds).await?;
    let out: Vec<Value> = rows
        .into_iter()
        .map(|m| {
            json!({
                "value": m.get("value").cloned().unwrap_or(Value::Null),
                "label": m.get("label").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(Json(Value::Array(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::introspect::DbColumn;

    fn col(name: &str, udt: &str, kind: Kind) -> DbColumn {
        DbColumn {
            name: name.into(),
            udt: udt.into(),
            elem_udt: None,
            kind,
            nullable: true,
            has_default: false,
            fk: None,
        }
    }

    #[test]
    fn split_op_recognizes_suffixes() {
        assert_eq!(split_op("asset_class"), ("asset_class", None));
        assert_eq!(split_op("price"), ("price", None));
        assert_eq!(split_op("price__gt"), ("price", Some("gt")));
        assert_eq!(split_op("price__gte"), ("price", Some("gte")));
        assert_eq!(
            split_op("created_at__between"),
            ("created_at", Some("between"))
        );
        assert_eq!(split_op("name__contains"), ("name", Some("contains")));
        assert_eq!(split_op("id__in"), ("id", Some("in")));
        assert_eq!(
            split_op("deleted_at__isnull"),
            ("deleted_at", Some("isnull"))
        );
        // suffix with empty base is not an operator
        assert_eq!(split_op("__gt"), ("__gt", None));
    }

    fn clause_for(c: &DbColumn, op: &str, raw: &str) -> (String, Vec<Option<String>>) {
        let mut binds = Binds::for_dialect(crate::db::Dialect::Pg);
        let mut clauses = Vec::new();
        operator_clause(c, &c.name, op, raw, &mut binds, &mut clauses).unwrap();
        (clauses.join(" AND "), binds.values)
    }

    #[test]
    fn operator_clauses_bind_and_cast() {
        let price = col("price", "numeric", Kind::Float);
        let (sql, binds) = clause_for(&price, "gt", "10");
        assert_eq!(sql, "\"price\" > $1::numeric");
        assert_eq!(binds, vec![Some("10".to_string())]);

        let (sql, binds) = clause_for(&price, "between", "1..5");
        assert_eq!(sql, "\"price\" BETWEEN $1::numeric AND $2::numeric");
        assert_eq!(binds, vec![Some("1".to_string()), Some("5".to_string())]);

        let id = col("id", "int8", Kind::Int);
        let (sql, binds) = clause_for(&id, "in", "1, 2 ,3");
        assert_eq!(sql, "\"id\" IN ($1::int8, $2::int8, $3::int8)");
        assert_eq!(binds.len(), 3);

        let name = col("name", "text", Kind::Text);
        let (sql, binds) = clause_for(&name, "contains", "btc");
        assert_eq!(sql, "\"name\"::text ILIKE $1");
        assert_eq!(binds, vec![Some("%btc%".to_string())]);

        let (sql, binds) = clause_for(&name, "isnull", "1");
        assert_eq!(sql, "\"name\" IS NULL");
        assert!(binds.is_empty());
        let (sql, _) = clause_for(&name, "isnull", "0");
        assert_eq!(sql, "\"name\" IS NOT NULL");

        let (sql, _) = clause_for(&id, "ne", "7");
        assert_eq!(sql, "\"id\" <> $1::int8");
    }

    #[test]
    fn operator_clauses_reject_bad_input() {
        let price = col("price", "numeric", Kind::Float);
        let mut b = Binds::for_dialect(crate::db::Dialect::Pg);
        let mut c = Vec::new();
        assert!(operator_clause(&price, "price", "between", "1..", &mut b, &mut c).is_err());
        assert!(operator_clause(&price, "price", "between", "nope", &mut b, &mut c).is_err());
        assert!(operator_clause(&price, "price", "isnull", "maybe", &mut b, &mut c).is_err());
        assert!(operator_clause(&price, "price", "in", " , ", &mut b, &mut c).is_err());
    }

    #[test]
    fn csv_shaping_masks_bytes_and_json() {
        let cols = vec![
            "id".to_string(),
            "secret".to_string(),
            "blob".to_string(),
            "meta".to_string(),
        ];
        let rows = vec![json!({
            "id": 7,
            "secret": "a3f\u{2026}",
            "blob": {"__bytes__": 1234},
            "meta": {"a": 1},
        })];
        let csv = rows_to_csv(&cols, &rows);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "id,secret,blob,meta");
        assert_eq!(lines[1], "7,a3f\u{2026},<1234 bytes>,\"{\"\"a\"\":1}\"");
    }

    #[test]
    fn parse_csv_handles_quoting_and_newlines() {
        let data = "id,name\n1,alice\n2,\"bob, jr\"\n3,\"line\nbreak\"\n4,\"quote\"\"inside\"\n";
        let rows = parse_csv(data);
        assert_eq!(rows[0], vec!["id", "name"]);
        assert_eq!(rows[1], vec!["1", "alice"]);
        assert_eq!(rows[2], vec!["2", "bob, jr"]);
        assert_eq!(rows[3], vec!["3", "line\nbreak"]);
        assert_eq!(rows[4], vec!["4", "quote\"inside"]);
        assert_eq!(rows.len(), 5);
    }

    #[test]
    fn parse_csv_no_trailing_newline_and_skips_blank_lines() {
        let rows = parse_csv("a,b\n\n1,2");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], vec!["a", "b"]);
        assert_eq!(rows[1], vec!["1", "2"]);
        // trailing empty field preserved
        let rows = parse_csv("a,b\n1,");
        assert_eq!(rows[1], vec!["1", ""]);
    }

    #[test]
    fn coerce_csv_cell_types() {
        let text = col("name", "text", Kind::Text);
        assert_eq!(coerce_csv_cell(&text, "hi"), json!("hi"));
        // empty becomes null (round-trips with export)
        assert_eq!(coerce_csv_cell(&text, ""), Value::Null);
        // numbers stay text (value_expr casts to the column type)
        let n = col("qty", "int8", Kind::Int);
        assert_eq!(coerce_csv_cell(&n, "5"), json!("5"));
        // json cells parse; malformed falls back to a string
        let j = col("meta", "jsonb", Kind::Json);
        assert_eq!(coerce_csv_cell(&j, "{\"a\":1}"), json!({"a": 1}));
        assert_eq!(coerce_csv_cell(&j, "notjson"), json!("notjson"));
    }

    #[test]
    fn csv_escapes_separators() {
        let cols = vec!["v".to_string()];
        let rows = vec![json!({ "v": "a,b\"c" })];
        let csv = rows_to_csv(&cols, &rows);
        assert_eq!(csv.lines().nth(1).unwrap(), "\"a,b\"\"c\"");
    }

    use crate::config::{ConfigDir, InlineSpec, RoleConfig, TableConfig, TableFrom};
    use crate::introspect::{DbTable, Schema};
    use crate::state::{AppState, CurrentUser};
    use crate::store::Store;

    fn tcol(name: &str) -> DbColumn {
        col(name, "text", Kind::Text)
    }

    fn inline_schema() -> Schema {
        let mut schema = Schema::default();
        schema.tables.insert(
            "bots".into(),
            DbTable {
                name: "bots".into(),
                schema: "public".into(),
                source: String::new(),
                is_view: false,
                extra_unique: false,
                pk: Some("id".into()),
                columns: vec![col("id", "int8", Kind::Int), tcol("owner_email")],
            },
        );
        schema.tables.insert(
            "bot_signals".into(),
            DbTable {
                name: "bot_signals".into(),
                schema: "public".into(),
                source: String::new(),
                is_view: false,
                extra_unique: false,
                pk: Some("id".into()),
                columns: vec![
                    col("id", "int8", Kind::Int),
                    col("bot_id", "int8", Kind::Int),
                    tcol("kind"),
                    tcol("secret"),
                ],
            },
        );
        schema.tables.insert(
            "instruments".into(),
            DbTable {
                name: "instruments".into(),
                schema: "public".into(),
                source: String::new(),
                is_view: false,
                extra_unique: false,
                pk: Some("symbol".into()),
                columns: vec![tcol("symbol")],
            },
        );
        schema
    }

    fn inline_cfg() -> ConfigDir {
        let mut cfg = ConfigDir::default();
        let mut bots = TableConfig::default();
        bots.relations.inlines = vec![InlineSpec::Full {
            table: "bot_signals".into(),
            fk_col: Some("bot_id".into()),
            label: None,
            columns: vec!["kind".into()],
            can_create: None,
            can_delete: None,
        }];
        cfg.tables.insert("bots".into(), bots);
        cfg.tables
            .insert("bot_signals".into(), TableConfig::default());
        cfg.tables
            .insert("instruments".into(), TableConfig::default());
        cfg
    }

    /// A table whose `from { table }` renames the physical table must resolve to
    /// that physical table for SQL, yet stay keyed by its config slug for
    /// perms/masking/config — otherwise a rename silently drops row-filters/masks
    /// (a data leak) and cross-wires two admin tables sharing one physical table.
    #[tokio::test]
    async fn from_table_rename_resolves_physical_but_keeps_config_by_slug() {
        let mut cfg = inline_cfg();
        let active = TableConfig {
            from: TableFrom {
                source: None,
                schema: Some("public".into()),
                table: Some("bots".into()),
            },
            label: Some("Active bots".into()),
            ..Default::default()
        };
        cfg.tables.insert("active_bots".into(), active);
        let state = inline_state(cfg);

        let dbt = state
            .resolve_table("active_bots")
            .expect("slug resolves to physical table");
        assert_eq!(dbt.name, "bots", "SQL target is the physical table");
        assert_eq!(state.qualified_of(dbt), "\"public\".\"bots\"");
        assert_eq!(
            table_config(&state, "active_bots").label.as_deref(),
            Some("Active bots")
        );
        assert!(
            table_config(&state, "bots").label.is_none(),
            "config stays keyed by slug, not physical name"
        );
    }

    /// A `from { schema }` pin that names a schema the table is not in must fail
    /// closed (resolve to None → 404), never fall through to a same-named table.
    #[tokio::test]
    async fn from_schema_mismatch_fails_closed() {
        let mut cfg = inline_cfg();
        let bad = TableConfig {
            from: TableFrom {
                source: None,
                schema: Some("nope".into()),
                table: Some("bots".into()),
            },
            ..Default::default()
        };
        cfg.tables.insert("bad".into(), bad);
        let state = inline_state(cfg);
        assert!(
            state.resolve_table("bad").is_none(),
            "wrong schema pin must not resolve"
        );
    }

    #[test]
    fn computed_sort_expr_honors_sortable_and_sort_by() {
        use crate::config::{FieldConfig, TableConfig};
        let dbt = DbTable {
            name: "co".into(),
            schema: "public".into(),
            source: String::new(),
            is_view: false,
            extra_unique: false,
            pk: Some("id".into()),
            columns: vec![
                col("id", "int8", Kind::Int),
                col("market_cap", "float8", Kind::Float),
            ],
        };
        let mut cfg = TableConfig::default();
        cfg.fields.insert(
            "pe".into(),
            FieldConfig {
                sql: Some("price / eps".into()),
                sortable: true,
                ..Default::default()
            },
        );
        cfg.fields.insert(
            "pe_by".into(),
            FieldConfig {
                sql: Some("price / eps".into()),
                sort_by: Some("market_cap".into()),
                ..Default::default()
            },
        );
        cfg.fields.insert(
            "pe_ro".into(),
            FieldConfig {
                sql: Some("price / eps".into()),
                ..Default::default()
            },
        );

        let none: &[String] = &[];
        assert_eq!(
            computed_sort_expr(&dbt, &cfg, none, "pe").as_deref(),
            Some("(price / eps)")
        );
        assert_eq!(
            computed_sort_expr(&dbt, &cfg, none, "pe_by"),
            Some(ident("market_cap"))
        );
        assert!(
            computed_sort_expr(&dbt, &cfg, none, "pe_ro").is_none(),
            "display-only computed is not sortable"
        );
        assert!(computed_sort_expr(&dbt, &cfg, none, "unknown").is_none());
        let masked = vec!["market_cap".to_string()];
        assert!(
            computed_sort_expr(&dbt, &cfg, &masked, "pe_by").is_none(),
            "sort_by a masked column is refused (no ordering leak)"
        );
    }

    fn inline_state(cfg: ConfigDir) -> Arc<AppState> {
        let pg = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://x")
            .unwrap();
        Arc::new(AppState {
            pools: Default::default(),
            dbs: Default::default(),
            pg: crate::db::DbPool::Pg(pg),
            schema: "public".into(),
            db: inline_schema(),
            cfg: arc_swap::ArcSwap::from_pointee(cfg),
            config_dir: None,
            store: Store::open_memory(),
            base_path: String::new(),
            http: reqwest::Client::new(),
            secure_cookies: false,
            secret_key: [7u8; 32],
            webhook_secret: None,
            options_cache: Default::default(),
            files_cache: Default::default(),
            login_limiter: Default::default(),
            config_write_lock: Default::default(),
        })
    }

    fn role_user(state: &AppState, name: &str, def: RoleConfig) -> CurrentUser {
        let mut cfg = (*state.cfg()).clone();
        cfg.auth.roles.insert(name.into(), def);
        state.cfg.store(Arc::new(cfg));
        CurrentUser {
            email: "u@x.io".into(),
            role: name.into(),
        }
    }

    fn admin() -> CurrentUser {
        CurrentUser {
            email: "a@x.io".into(),
            role: "admin".into(),
        }
    }

    #[test]
    fn inline_offset_paginates_by_cap() {
        assert_eq!(inline_offset(0), 0);
        assert_eq!(inline_offset(1), 0);
        assert_eq!(inline_offset(2), INLINE_CAP);
        assert_eq!(inline_offset(3), INLINE_CAP * 2);
    }

    #[tokio::test]
    async fn inline_resolve_rejects_unconfigured_child() {
        let state = inline_state(inline_cfg());
        let user = admin();

        let ok = resolve_configured_inline(&state, &user, "bots", "bot_signals").unwrap();
        assert_eq!(ok.child, "bot_signals");
        assert_eq!(ok.fk_col, "bot_id");

        let err = resolve_configured_inline(&state, &user, "bots", "instruments");
        assert!(
            err.is_err(),
            "a table that is not a declared inline must be rejected"
        );
    }

    #[tokio::test]
    async fn inline_resolve_reapplies_child_row_filter_and_masking() {
        let state = inline_state(inline_cfg());
        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "read".into());
        def.tables.insert("bot_signals".into(), "read".into());
        def.masked
            .insert("bot_signals".into(), vec!["secret".into()]);
        def.row_filter
            .insert("bot_signals".into(), "kind = 'buy'".into());
        let user = role_user(&state, "viewer", def);

        resolve_configured_inline(&state, &user, "bots", "bot_signals").unwrap();
        assert_eq!(
            state.row_filter(&user, "bot_signals").as_deref(),
            Some("kind = 'buy'")
        );
        assert!(state
            .masked_columns(&user, "bot_signals")
            .contains(&"secret".to_string()));
    }

    #[tokio::test]
    async fn inline_effective_perms_gate_create_and_delete() {
        let state = inline_state(inline_cfg());

        let mut writer = RoleConfig::default();
        writer.tables.insert("bots".into(), "write".into());
        writer.tables.insert("bot_signals".into(), "write".into());
        let wuser = role_user(&state, "writer", writer);
        let ri = resolve_configured_inline(&state, &wuser, "bots", "bot_signals").unwrap();
        assert!(
            ri.can_create && ri.can_delete,
            "write on child → create+delete affordances"
        );

        let mut reader = RoleConfig::default();
        reader.tables.insert("bots".into(), "write".into());
        reader.tables.insert("bot_signals".into(), "read".into());
        let ruser = role_user(&state, "reader", reader);
        let ri = resolve_configured_inline(&state, &ruser, "bots", "bot_signals").unwrap();
        assert!(
            !ri.can_create && !ri.can_delete,
            "read-only child → no create/delete affordances"
        );
    }

    #[tokio::test]
    async fn detail_inline_json_matches_page_shape() {
        let state = inline_state(inline_cfg());
        let mut writer = RoleConfig::default();
        writer.tables.insert("bots".into(), "write".into());
        writer.tables.insert("bot_signals".into(), "write".into());
        let user = role_user(&state, "writer", writer);
        let ri = resolve_configured_inline(&state, &user, "bots", "bot_signals").unwrap();

        let obj = inline_json(&ri, vec![], 0);
        let m = obj.as_object().unwrap();
        assert_eq!(m["columns"], json!(["kind"]));
        assert_eq!(m["can_create"], json!(true));
        assert_eq!(m["can_delete"], json!(true));
        assert_eq!(m["cap"], json!(INLINE_CAP));
        assert_eq!(m["table"], json!("bot_signals"));
        assert_eq!(m["fk_col"], json!("bot_id"));
    }

    #[tokio::test]
    async fn inline_hidden_when_child_not_viewable() {
        let state = inline_state(inline_cfg());
        let mut role = RoleConfig::default();
        role.tables.insert("bots".into(), "read".into());
        let user = role_user(&state, "noc", role);
        assert!(
            resolve_inlines(&state, &user, "bots").is_empty(),
            "a child the caller cannot view must not surface as an inline"
        );
    }
}
