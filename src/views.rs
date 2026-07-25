use crate::state::{AppError, AppState, CurrentUser};
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub async fn list_views_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, AppError> {
    let table = params
        .get("table")
        .filter(|t| !t.is_empty())
        .map(String::as_str);
    Ok(Json(state.store.views_list(&user.email, table)?))
}

#[derive(Deserialize)]
pub struct CreateView {
    table: String,
    name: String,
    query: String,
    #[serde(default)]
    shared: bool,
}

pub async fn create_view_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Json(body): Json<CreateView>,
) -> Result<(axum::http::StatusCode, Json<Value>), AppError> {
    state.readable_table(&user, &body.table)?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::bad("view name is required"));
    }
    if name.len() > 120 || body.query.len() > 4000 {
        return Err(AppError::bad("view name or query too long"));
    }
    let id = state
        .store
        .view_create(&user.email, &body.table, name, &body.query, body.shared)?;
    state.store.audit(
        &user.email,
        &body.table,
        None,
        "view.create",
        Some(&json!({ "id": id, "name": name, "shared": body.shared })),
    );
    Ok((axum::http::StatusCode::CREATED, Json(json!({ "id": id }))))
}

pub async fn delete_view_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let (owner, table) = state
        .store
        .view_meta(id)
        .ok_or_else(|| AppError::not_found("view not found"))?;
    if owner != user.email && !user.is_admin() {
        return Err(AppError::forbidden("not your view"));
    }
    state.store.view_delete(id)?;
    state.store.audit(
        &user.email,
        &table,
        None,
        "view.delete",
        Some(&json!({ "id": id })),
    );
    Ok(Json(json!({})))
}
