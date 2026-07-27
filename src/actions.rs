use crate::config::ActionKind;
use crate::meta::table_config;
use crate::sqlval::{ident, value_expr, Binds};
use crate::state::{AppError, AppState, CurrentUser};
use axum::extract::{Path, State};
use axum::Json;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::Arc;

const MAX_PKS: usize = 1000;

pub async fn action_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, name)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let dbt = state.readable_table(&user, &table)?;
    if !state.allowed_actions(&user, &table).contains(&name) {
        return Err(AppError::forbidden("action not allowed"));
    }
    let cfg = table_config(&state, &table);
    let action = cfg
        .actions
        .get(&name)
        .ok_or_else(|| AppError::not_found(format!("unknown action {name}")))?;

    let pks: Vec<String> = body
        .get("pks")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::bad("body must be {\"pks\": [...]}"))?
        .iter()
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .collect();
    if pks.is_empty() || pks.len() > MAX_PKS {
        return Err(AppError::bad(format!("pks must be 1..{MAX_PKS}")));
    }
    let pk_name = dbt
        .pk
        .as_ref()
        .ok_or_else(|| AppError::bad("table has no primary key"))?
        .clone();

    let affected = match action.kind {
        ActionKind::Update => {
            if !state.table_perms(&user, &table).update {
                return Err(AppError::forbidden("no write access"));
            }
            let mut binds = Binds::for_dialect(state.pool_for_table(&table).dialect());
            let mut sets = Vec::new();
            for (col_name, tv) in &action.set {
                let col = dbt.column(col_name).ok_or_else(|| {
                    AppError::bad(format!("action sets unknown column {col_name}"))
                })?;
                let expr = value_expr(col, tv, &mut binds)?;
                sets.push(format!("{} = {expr}", ident(col_name)));
            }
            if sets.is_empty() {
                return Err(AppError::bad("update action has empty set"));
            }
            run_bulk(
                &state,
                &user,
                &table,
                &pk_name,
                &pks,
                binds,
                format!(
                    "UPDATE {} SET {}",
                    state.qualified_table(&table),
                    sets.join(", ")
                ),
            )
            .await?
        }
        ActionKind::Delete => {
            if !state.table_perms(&user, &table).delete {
                return Err(AppError::forbidden("no delete access"));
            }
            run_bulk(
                &state,
                &user,
                &table,
                &pk_name,
                &pks,
                Binds::for_dialect(state.pool_for_table(&table).dialect()),
                format!("DELETE FROM {}", state.qualified_table(&table)),
            )
            .await?
        }
        ActionKind::Webhook => {
            if state.cfg().cartapel.disable_webhooks {
                return Err(AppError::forbidden("webhook actions are disabled"));
            }
            let url = action
                .url
                .as_ref()
                .ok_or_else(|| AppError::internal("webhook action missing url"))?;
            let payload = json!({
                "action": name,
                "table": table,
                "pks": pks,
                "actor": user.email,
                "ts": chrono::Utc::now().to_rfc3339(),
            });
            let body_bytes = serde_json::to_vec(&payload).unwrap();
            let method: reqwest::Method = action
                .method
                .as_deref()
                .unwrap_or("POST")
                .parse()
                .map_err(|_| AppError::internal("bad webhook method"))?;
            let mut req = state
                .http
                .request(method, url)
                .header("content-type", "application/json")
                .timeout(std::time::Duration::from_secs(20))
                .body(body_bytes.clone());
            if let Some(secret) = &state.webhook_secret {
                let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
                    .map_err(|e| AppError::internal(e.to_string()))?;
                mac.update(&body_bytes);
                req = req.header(
                    "x-cartapel-signature",
                    hex::encode(mac.finalize().into_bytes()),
                );
            }
            let resp = req
                .send()
                .await
                .map_err(|e| AppError::internal(format!("webhook failed: {e}")))?;
            let status = resp.status().as_u16();
            state.store.audit(
                &user.email,
                &table,
                None,
                &format!("action:{name}"),
                Some(&json!({ "pks": pks, "webhook_status": status })),
            );
            if !(200..300).contains(&status) {
                return Err(AppError::bad(format!("webhook returned {status}")));
            }
            return Ok(Json(
                json!({ "affected": pks.len(), "webhook_status": status }),
            ));
        }
    };

    state.store.audit(
        &user.email,
        &table,
        None,
        &format!("action:{name}"),
        Some(&json!({ "pks": pks, "affected": affected })),
    );
    Ok(Json(json!({ "affected": affected })))
}

async fn run_bulk(
    state: &AppState,
    user: &CurrentUser,
    table: &str,
    pk_name: &str,
    pks: &[String],
    mut binds: Binds,
    head: String,
) -> Result<u64, AppError> {
    let mut placeholders = Vec::with_capacity(pks.len());
    for pk in pks {
        let n = binds.ph(Some(pk.clone()));
        placeholders.push(n);
    }
    let mut where_sql = format!(
        "{} IN ({})",
        crate::sqlval::text_cast(binds.dialect(), &ident(pk_name)),
        placeholders.join(", ")
    );
    if let Some(rf) = state.row_filter(user, table) {
        where_sql = format!("{where_sql} AND ({rf})");
    }
    let sql = format!("{head} WHERE {where_sql}");
    let result = crate::db::execute(state.pool_for_table(table), &sql, &binds).await?;
    Ok(result.rows_affected)
}
