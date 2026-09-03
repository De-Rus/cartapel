//! `remote { }` fields: a read-only value fetched at request time from an
//! already-declared `http` source, `{column}`-templated per row. Nothing is
//! stored — every read hits the source live — and there is no write path.
//!
//! Deliberately thin: this reuses [`crate::plugins::fetch_source`] for the
//! actual HTTP call (same role gate, same size cap, same `env:`/`${}`
//! resolution as every other `http` source), so a remote field carries no
//! auth or fetching logic of its own.

use crate::meta::table_config;
use crate::state::{AppError, AppState, CurrentUser};
use axum::extract::{Path, State};
use axum::Json;
use serde_json::{Map, Value};
use std::sync::Arc;

/// Fill `{column}` placeholders in `path` from the row, refusing any column
/// that's masked for this user — a masked value must never leak into an
/// outbound request just because it's hiding behind a template.
fn fill_path(template: &str, row: &Map<String, Value>, masked: &[String]) -> Result<String, AppError> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let Some(close) = rest[open + 1..].find('}') else {
            return Err(AppError::internal("unterminated { in remote path"));
        };
        let name = rest[open + 1..open + 1 + close].trim();
        if masked.contains(&name.to_string()) {
            return Err(AppError::forbidden(format!(
                "remote path references masked column {name}"
            )));
        }
        let value = row.get(name).ok_or_else(|| {
            AppError::bad(format!("remote path references unknown column {name}"))
        })?;
        match value {
            Value::String(s) => out.push_str(s),
            Value::Null => return Err(AppError::bad(format!("column {name} is null"))),
            other => out.push_str(&other.to_string()),
        }
        rest = &rest[open + 1 + close + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

enum Seg<'a> {
    Key(&'a str),
    Index(usize),
}

/// A small path DSL, not jq: dotted keys plus `[N]` array indices, e.g.
/// `data.results[0].status`. No filters, pipes or functions — a remote
/// field reads one value, it doesn't transform a document.
fn parse_at(p: &str) -> Vec<Seg<'_>> {
    let mut segs = Vec::new();
    for part in p.split('.') {
        let mut rest = part;
        if let Some(br) = rest.find('[') {
            if br > 0 {
                segs.push(Seg::Key(&rest[..br]));
            }
            rest = &rest[br..];
        } else if !rest.is_empty() {
            segs.push(Seg::Key(rest));
            continue;
        }
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(close) = stripped.find(']') else { break };
            if let Ok(idx) = stripped[..close].parse::<usize>() {
                segs.push(Seg::Index(idx));
            }
            rest = &stripped[close + 1..];
        }
    }
    segs
}

fn at_path(body: Value, at: Option<&str>) -> Value {
    let Some(p) = at else { return body };
    parse_at(p)
        .into_iter()
        .try_fold(body, |acc, seg| match seg {
            Seg::Key(k) => acc.get(k).cloned(),
            Seg::Index(i) => acc.get(i).cloned(),
        })
        .unwrap_or(Value::Null)
}

pub async fn get_remote(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, col, pk)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let fc = table_config(&state, &table)
        .fields
        .get(&col)
        .cloned()
        .ok_or_else(|| AppError::bad(format!("{col} is not a remote field")))?;
    let cfg = fc
        .remote
        .ok_or_else(|| AppError::bad(format!("{col} is not a remote field")))?;

    let masked = state.masked_columns(&user, &table);
    if masked.contains(&col) {
        return Err(AppError::forbidden("field is masked"));
    }

    let dbt = state.readable_table(&user, &table)?;
    let pk_col = dbt
        .pk
        .as_ref()
        .and_then(|p| dbt.column(p))
        .ok_or_else(|| AppError::bad("table has no primary key"))?;
    let pool = state.pool_of(dbt);
    let mut binds = crate::sqlval::Binds::for_dialect(pool.dialect());
    let mut where_sql = crate::sqlval::pk_predicate(pk_col, &pk, &mut binds)?;
    if let Some(rf) = state.row_filter(&user, &table) {
        where_sql = format!("{where_sql} AND ({rf})");
    }
    let sql = format!(
        "SELECT * FROM {} t WHERE {where_sql}",
        state.qualified_of(dbt)
    );
    let row = crate::db::fetch_json_rows(pool, &sql, &binds)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::not_found("row not found"))?;

    let path = fill_path(&cfg.path, &row, &masked)?;
    let (status, body) = crate::plugins::fetch_source(&state, &user, &cfg.source, &path).await?;
    if !status.is_success() {
        return Err(AppError::bad(format!(
            "remote source \"{}\" answered {status}",
            cfg.source
        )));
    }
    let parsed: Value = serde_json::from_slice(&body)
        .map_err(|e| AppError::bad(format!("remote response is not json: {e}")))?;
    Ok(Json(json_wrap(at_path(parsed, cfg.at.as_deref()))))
}

fn json_wrap(value: Value) -> Value {
    serde_json::json!({ "value": value })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_path_substitutes_row_columns() {
        let mut row = Map::new();
        row.insert("tracking_number".into(), Value::String("ABC123".into()));
        let out = fill_path("/track/{tracking_number}", &row, &[]).unwrap();
        assert_eq!(out, "/track/ABC123");
    }

    #[test]
    fn fill_path_refuses_a_masked_column() {
        let mut row = Map::new();
        row.insert("ssn".into(), Value::String("123-45-6789".into()));
        let err = fill_path("/lookup/{ssn}", &row, &["ssn".to_string()]).unwrap_err();
        assert!(err.1.contains("masked"), "{err:?}");
    }

    #[test]
    fn fill_path_rejects_an_unknown_column() {
        let row = Map::new();
        let err = fill_path("/lookup/{missing}", &row, &[]).unwrap_err();
        assert!(err.1.contains("unknown column"), "{err:?}");
    }

    #[test]
    fn fill_path_rejects_a_null_column() {
        let mut row = Map::new();
        row.insert("tracking_number".into(), Value::Null);
        let err = fill_path("/track/{tracking_number}", &row, &[]).unwrap_err();
        assert!(err.1.contains("null"), "{err:?}");
    }

    #[test]
    fn at_path_walks_a_dotted_path() {
        let body = serde_json::json!({ "data": { "status": "in_transit" } });
        assert_eq!(at_path(body, Some("data.status")), Value::String("in_transit".into()));
    }

    #[test]
    fn at_path_none_returns_whole_body() {
        let body = serde_json::json!({ "a": 1 });
        assert_eq!(at_path(body.clone(), None), body);
    }

    #[test]
    fn at_path_indexes_an_array() {
        let body = serde_json::json!({ "data": { "results": [{ "status": "a" }, { "status": "b" }] } });
        assert_eq!(
            at_path(body, Some("data.results[1].status")),
            Value::String("b".into())
        );
    }

    #[test]
    fn at_path_a_bare_top_level_array() {
        let body = serde_json::json!(["x", "y", "z"]);
        assert_eq!(at_path(body, Some("[2]")), Value::String("z".into()));
    }

    #[test]
    fn at_path_out_of_bounds_is_null() {
        let body = serde_json::json!({ "results": [] });
        assert_eq!(at_path(body, Some("results[0].status")), Value::Null);
    }
}
