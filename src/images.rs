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
    let pk_col = dbt
        .pk
        .as_ref()
        .and_then(|p| dbt.column(p))
        .ok_or_else(|| AppError::bad("table has no primary key"))?;

    let pool = state.pool_of(dbt);
    let mut binds = crate::sqlval::Binds::for_dialect(pool.dialect());
    let mut where_sql = crate::sqlval::pk_predicate(pk_col, pk, &mut binds)?;
    if let Some(rf) = state.row_filter(user, table) {
        where_sql = format!("{where_sql} AND ({rf})");
    }
    // The filename comes from a real column, or — for an image joined from a
    // related table — from a correlated `name_sql` expression over the `t` alias.
    let name_expr = if let Some(sql) = &cfg.name_sql {
        format!("({sql})")
    } else {
        let name_col = dbt
            .column(&cfg.name_col)
            .ok_or_else(|| AppError::internal("image name_col not in schema"))?;
        crate::sqlval::text_cast(pool.dialect(), &crate::sqlval::ident(&name_col.name))
    };
    let sql = format!(
        "SELECT {name_expr} AS n FROM {} t WHERE {where_sql}",
        state.qualified_of(dbt)
    );
    let name = crate::db::fetch_json_rows(pool, &sql, &binds)
        .await?
        .into_iter()
        .next()
        .ok_or(sqlx::Error::RowNotFound)?
        .get("n")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| AppError::not_found("no image for this row"))?;

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
    if cfg.name_sql.is_some() && cfg.write_to.is_none() {
        return Err(AppError::bad(
            "this image is joined read-only (name_sql without write_to) — upload it on the owning table",
        ));
    }
    // A write-through field derives its path from the parent's key; a plain
    // field reads the filename from its own column.
    let (path, name) = if cfg.write_to.is_some() {
        writethrough_path(&state, &user, &table, &cfg, &pk).await?
    } else {
        resolve_path(&state, &user, &table, &col, &pk).await?
    };

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

    if cfg.write_to.is_some() {
        writethrough_upsert(&state, &user, &table, &cfg, &pk, &name).await?;
    }

    state.store.audit(
        &user.email,
        &table,
        Some(&pk),
        "image",
        Some(&json!({ "field": col, "file": name, "bytes": bytes.len() })),
    );
    Ok(Json(json!({ "ok": true, "bytes": bytes.len() })))
}

/// The parent's write_key parent-column values, in target-column (sorted) order.
async fn writethrough_keys(
    state: &AppState,
    user: &CurrentUser,
    table: &str,
    cfg: &crate::config::ImageConfig,
    pk: &str,
) -> Result<Vec<(String, String)>, AppError> {
    let dbt = state.readable_table(user, table)?;
    let pk_col = dbt
        .pk
        .as_ref()
        .and_then(|p| dbt.column(p))
        .ok_or_else(|| AppError::bad("table has no primary key"))?;
    let pool = state.pool_of(dbt);
    let mut binds = crate::sqlval::Binds::for_dialect(pool.dialect());
    let where_sql = crate::sqlval::pk_predicate(pk_col, pk, &mut binds)?;
    // BTreeMap iteration is sorted by target col — a stable order for both the
    // key predicate and the generated filename.
    let sel: Vec<String> = cfg
        .write_key
        .values()
        .map(|parent_col| crate::sqlval::ident(parent_col))
        .collect();
    let sql = format!(
        "SELECT {} FROM {} WHERE {where_sql}",
        sel.join(", "),
        state.qualified_of(dbt)
    );
    let row = crate::db::fetch_json_rows(pool, &sql, &binds)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::not_found("row not found"))?;
    let mut out = Vec::new();
    for (target_col, parent_col) in &cfg.write_key {
        let v = row
            .get(parent_col)
            .and_then(|v| v.as_str().map(String::from))
            .ok_or_else(|| AppError::bad(format!("write_key parent column {parent_col} is null")))?;
        out.push((target_col.clone(), v));
    }
    Ok(out)
}

/// Deterministic filename for a write-through upload: the key values joined,
/// sanitised, `.png` (uploads are normalised to PNG).
fn writethrough_filename(keys: &[(String, String)]) -> String {
    let stem: String = keys
        .iter()
        .map(|(_, v)| {
            v.chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("_");
    format!("{stem}.png")
}

async fn writethrough_path(
    state: &AppState,
    user: &CurrentUser,
    table: &str,
    cfg: &crate::config::ImageConfig,
    pk: &str,
) -> Result<(PathBuf, String), AppError> {
    let keys = writethrough_keys(state, user, table, cfg, pk).await?;
    let name = writethrough_filename(&keys);
    Ok((PathBuf::from(&cfg.dir).join(&name), name))
}

/// Upsert the target row: UPDATE by write_key (setting the filename column and
/// write_defaults); INSERT if absent. One transaction.
async fn writethrough_upsert(
    state: &AppState,
    user: &CurrentUser,
    table: &str,
    cfg: &crate::config::ImageConfig,
    pk: &str,
    filename: &str,
) -> Result<(), AppError> {
    let write_to = cfg.write_to.as_ref().unwrap();
    if !state.table_perms(user, write_to).update {
        return Err(AppError::forbidden("no write access to the logo table"));
    }
    let keys = writethrough_keys(state, user, table, cfg, pk).await?;
    let target = state
        .resolve_table(write_to)
        .ok_or_else(|| AppError::bad(format!("unknown table {write_to}")))?;
    let pool = state.pool_of(target);
    let qual = state.qualified_of(target);
    let name_col = crate::sqlval::ident(&cfg.name_col);

    let key_pred = |binds: &mut crate::sqlval::Binds| -> String {
        keys.iter()
            .map(|(col, val)| format!("{} = {}", crate::sqlval::ident(col), binds.ph(Some(val.clone()))))
            .collect::<Vec<_>>()
            .join(" AND ")
    };

    // UPDATE first — filename + the write_defaults (the state a good upload has).
    let mut ub = crate::sqlval::Binds::for_dialect(pool.dialect());
    let mut sets = vec![format!("{name_col} = {}", ub.ph(Some(filename.to_string())))];
    for (col, val) in &cfg.write_defaults {
        sets.push(format!("{} = {}", crate::sqlval::ident(col), ub.ph(Some(val.clone()))));
    }
    let usql = format!("UPDATE {qual} SET {} WHERE {}", sets.join(", "), key_pred(&mut ub));
    let updated = crate::db::execute(pool, &usql, &ub).await?.rows_affected;

    if updated == 0 {
        let mut ib = crate::sqlval::Binds::for_dialect(pool.dialect());
        let mut cols: Vec<String> = keys.iter().map(|(c, _)| crate::sqlval::ident(c)).collect();
        let mut vals: Vec<String> = keys.iter().map(|(_, v)| ib.ph(Some(v.clone()))).collect();
        cols.push(name_col.clone());
        vals.push(ib.ph(Some(filename.to_string())));
        for (col, val) in &cfg.write_defaults {
            cols.push(crate::sqlval::ident(col));
            vals.push(ib.ph(Some(val.clone())));
        }
        let isql = format!("INSERT INTO {qual} ({}) VALUES ({})", cols.join(", "), vals.join(", "));
        crate::db::execute(pool, &isql, &ib).await?;
    }
    Ok(())
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
