use crate::meta::table_config;
use crate::state::{AppError, AppState, CurrentUser};
use axum::body::Bytes;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use image::imageops::FilterType;
use image::GenericImageView;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

const MAX_UPLOAD: usize = 8 * 1024 * 1024;

fn image_cfg(state: &AppState, table: &str, col: &str) -> Option<crate::config::ImageConfig> {
    table_config(state, table)
        .fields
        .get(col)
        .and_then(|f| f.image.clone())
}

async fn resolve_path(
    state: &AppState,
    user: &CurrentUser,
    table: &str,
    col: &str,
    pk: &str,
) -> Result<(PathBuf, String), AppError> {
    let dbt = state.readable_table(user, table)?;
    if state.masked_columns(user, table).contains(&col.to_string()) {
        return Err(AppError::forbidden("image field is masked"));
    }
    let cfg = image_cfg(state, table, col)
        .ok_or_else(|| AppError::bad(format!("{col} is not an image field")))?;
    let name_col = dbt
        .column(&cfg.name_col)
        .ok_or_else(|| AppError::internal("image name_col not in schema"))?;
    let pk_col = dbt
        .pk
        .as_ref()
        .and_then(|p| dbt.column(p))
        .ok_or_else(|| AppError::bad("table has no primary key"))?;

    let mut binds = crate::sqlval::Binds::new();
    let mut where_sql = crate::sqlval::pk_predicate(pk_col, pk, &mut binds);
    if let Some(rf) = state.row_filter(user, table) {
        where_sql = format!("{where_sql} AND ({rf})");
    }
    let sql = format!(
        "SELECT {}::text AS n FROM {} WHERE {where_sql}",
        crate::sqlval::ident(&name_col.name),
        state.qualified_of(dbt)
    );
    let row = binds.query(&sql).fetch_one(state.pool_of(dbt)).await?;
    let name: Option<String> = sqlx::Row::get(&row, "n");
    let name = name.ok_or_else(|| AppError::not_found("no image for this row"))?;

    if name.is_empty() || name.contains('/') || name.contains("..") || name.contains('\\') {
        return Err(AppError::bad("unsafe image filename"));
    }
    let dir = PathBuf::from(&cfg.dir);
    Ok((dir.join(&name), name))
}

pub async fn get_image(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, col, pk)): Path<(String, String, String)>,
) -> Response {
    let (path, _) = match resolve_path(&state, &user, &table, &col, &pk).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let ct = mime_guess::from_path(&path)
                .first_or_octet_stream()
                .to_string();
            (
                [
                    (header::CONTENT_TYPE, ct),
                    (header::CACHE_CONTROL, "no-cache".to_string()),
                ],
                bytes,
            )
                .into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "no image").into_response(),
    }
}

pub async fn put_image(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, col, pk)): Path<(String, String, String)>,
    mut multipart: Multipart,
) -> Result<Json<Value>, AppError> {
    if !state.table_perms(&user, &table).update {
        return Err(AppError::forbidden("no write access"));
    }
    let cfg = image_cfg(&state, &table, &col)
        .ok_or_else(|| AppError::bad(format!("{col} is not an image field")))?;
    let (path, name) = resolve_path(&state, &user, &table, &col, &pk).await?;

    let mut raw: Option<Bytes> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad(e.to_string()))?
    {
        if field.name() == Some("file") {
            let data = field
                .bytes()
                .await
                .map_err(|e| AppError::bad(e.to_string()))?;
            if data.len() > MAX_UPLOAD {
                return Err(AppError::bad("image too large (max 8MB)"));
            }
            raw = Some(data);
            break;
        }
    }
    let raw = raw.ok_or_else(|| AppError::bad("missing 'file' part"))?;

    let bytes = if cfg.normalize {
        normalize_png(&raw, cfg.max_px).map_err(AppError::bad)?
    } else {
        raw.to_vec()
    };

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::internal(e.to_string()))?;
    }
    let tmp = path.with_extension("tmp");
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| AppError::internal(format!("write image: {e}")))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| AppError::internal(format!("commit image: {e}")))?;

    state.store.audit(
        &user.email,
        &table,
        Some(&pk),
        "image",
        Some(&json!({ "field": col, "file": name, "bytes": bytes.len() })),
    );
    Ok(Json(json!({ "ok": true, "bytes": bytes.len() })))
}

fn normalize_png(raw: &[u8], max_px: u32) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(raw).map_err(|e| format!("decode image: {e}"))?;
    let (w, h) = img.dimensions();
    let scaled = if w > max_px || h > max_px {
        img.resize(max_px, max_px, FilterType::Lanczos3)
    } else {
        img
    };
    let rgba = scaled.to_rgba8();
    let (sw, sh) = rgba.dimensions();
    let mut canvas = image::RgbaImage::new(max_px, max_px);
    let ox = ((max_px - sw) / 2) as i64;
    let oy = ((max_px - sh) / 2) as i64;
    image::imageops::overlay(&mut canvas, &rgba, ox, oy);
    let mut out = std::io::Cursor::new(Vec::new());
    canvas
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| format!("encode png: {e}"))?;
    Ok(out.into_inner())
}
