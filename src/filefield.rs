//! `file { }` fields: one upload primitive for a column, regardless of what
//! ends up in it. Storage (local disk or a named `storage "…" { }` bucket)
//! and the write-through mechanics (`name_col`/`name_sql`/`write_to`) live in
//! [`crate::uploads`] and don't know or care what kind of bytes they're
//! moving.
//!
//! What *does* care is the widget: `widget = "image"` decodes the upload,
//! resizes it and re-encodes to PNG (`max_px`/`normalize` as widget
//! `params`, same as any other widget's options) — anything else stores the
//! bytes exactly as uploaded. One route, one config block; the widget picks
//! the behaviour, the same way it picks rendering for every other field kind.

use crate::meta::table_config;
use crate::state::{AppError, AppState, CurrentUser};
use crate::uploads::{self, Dest, WriteThrough};
use axum::body::Bytes;
use axum::extract::{Multipart, Path, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use image::imageops::FilterType;
use image::GenericImageView;
use serde_json::{json, Map, Value};
use std::sync::Arc;

const DEFAULT_MAX_UPLOAD: usize = 25 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_IMAGE: usize = 8 * 1024 * 1024;

fn field_cfg(state: &AppState, table: &str, col: &str) -> Option<crate::config::FieldConfig> {
    table_config(state, table).fields.get(col).cloned()
}

fn wt_view(cfg: &crate::config::FileConfig) -> WriteThrough<'_> {
    WriteThrough {
        write_to: &cfg.write_to,
        name_col: &cfg.name_col,
        write_key: &cfg.write_key,
        write_defaults: &cfg.write_defaults,
    }
}

fn is_image(fc: &crate::config::FieldConfig) -> bool {
    fc.widget.as_deref() == Some("image")
}

fn max_px(params: &Map<String, Value>) -> u32 {
    params
        .get("max_px")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(256)
}

fn should_normalize(params: &Map<String, Value>) -> bool {
    params
        .get("normalize")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// The extension a write-through upload's generated filename gets, taken from
/// the client-supplied filename. Sanitised the same way the filename itself
/// is (see [`uploads::resolve_name`]) — this becomes part of a path/key too.
fn safe_ext(client_filename: Option<&str>) -> String {
    let ext = client_filename
        .and_then(|n| n.rsplit_once('.'))
        .map(|(_, ext)| ext)
        .unwrap_or("bin");
    let cleaned: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(16)
        .collect::<String>()
        .to_ascii_lowercase();
    if cleaned.is_empty() {
        "bin".to_string()
    } else {
        cleaned
    }
}

async fn resolve_path(
    state: &AppState,
    user: &CurrentUser,
    table: &str,
    col: &str,
    pk: &str,
) -> Result<(Dest, String), AppError> {
    let fc = field_cfg(state, table, col)
        .ok_or_else(|| AppError::bad(format!("{col} is not a file field")))?;
    let cfg = fc
        .file
        .as_ref()
        .ok_or_else(|| AppError::bad(format!("{col} is not a file field")))?;
    let name =
        uploads::resolve_name(state, user, table, col, pk, &cfg.name_col, &cfg.name_sql).await?;
    let dest = uploads::dest_for(state, &cfg.dir, &cfg.storage, &name)?;
    Ok((dest, name))
}

pub async fn get_file(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, col, pk)): Path<(String, String, String)>,
) -> Response {
    let (dest, name) = match resolve_path(&state, &user, &table, &col, &pk).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match uploads::read_bytes(&state, &dest).await {
        Ok((bytes, ct)) => (
            [
                (header::CONTENT_TYPE, ct),
                (
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{name}\""),
                ),
                (header::CACHE_CONTROL, "no-cache".to_string()),
            ],
            bytes,
        )
            .into_response(),
        Err(e) => e.into_response(),
    }
}

pub async fn put_file(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, col, pk)): Path<(String, String, String)>,
    mut multipart: Multipart,
) -> Result<Json<Value>, AppError> {
    if !state.table_perms(&user, &table).update {
        return Err(AppError::forbidden("no write access"));
    }
    let fc = field_cfg(&state, &table, &col)
        .ok_or_else(|| AppError::bad(format!("{col} is not a file field")))?;
    let cfg = fc
        .file
        .clone()
        .ok_or_else(|| AppError::bad(format!("{col} is not a file field")))?;
    if cfg.name_sql.is_some() && cfg.write_to.is_none() {
        return Err(AppError::bad(
            "this field is joined read-only (name_sql without write_to) — upload it on the owning table",
        ));
    }
    let image = is_image(&fc);
    let max_upload = cfg.max_bytes.unwrap_or(if image {
        DEFAULT_MAX_UPLOAD_IMAGE
    } else {
        DEFAULT_MAX_UPLOAD
    });

    let mut raw: Option<Bytes> = None;
    let mut client_filename: Option<String> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad(e.to_string()))?
    {
        if field.name() == Some("file") {
            client_filename = field.file_name().map(str::to_string);
            let data = field
                .bytes()
                .await
                .map_err(|e| AppError::bad(e.to_string()))?;
            if data.len() > max_upload {
                return Err(AppError::bad(format!(
                    "file too large (max {}MB)",
                    max_upload / (1024 * 1024)
                )));
            }
            raw = Some(data);
            break;
        }
    }
    let raw = raw.ok_or_else(|| AppError::bad("missing 'file' part"))?;

    let bytes = if image && should_normalize(&fc.params) {
        normalize_png(&raw, max_px(&fc.params)).map_err(AppError::bad)?
    } else {
        raw.to_vec()
    };

    // A write-through field derives its path from the parent's key, with the
    // right extension (`png` for a normalised image upload, else the
    // uploaded file's own); a plain field reads the filename (and so
    // implicitly its extension) from its own column.
    let (dest, name) = if cfg.write_to.is_some() {
        let keys = uploads::writethrough_keys(&state, &user, &table, &wt_view(&cfg), &pk).await?;
        let ext = if image {
            "png".to_string()
        } else {
            safe_ext(client_filename.as_deref())
        };
        let name = uploads::writethrough_filename(&keys, &ext);
        let dest = uploads::dest_for(&state, &cfg.dir, &cfg.storage, &name)?;
        (dest, name)
    } else {
        resolve_path(&state, &user, &table, &col, &pk).await?
    };

    uploads::write_bytes(&state, &dest, &bytes).await?;

    if cfg.write_to.is_some() {
        uploads::writethrough_upsert(&state, &user, &table, &wt_view(&cfg), &pk, &name).await?;
    }

    state.store.audit(
        &user.email,
        &table,
        Some(&pk),
        "file",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_ext_keeps_a_plain_extension() {
        assert_eq!(safe_ext(Some("invoice.pdf")), "pdf");
        assert_eq!(safe_ext(Some("report.CSV")), "csv", "lowercased");
    }

    #[test]
    fn safe_ext_falls_back_to_bin() {
        assert_eq!(safe_ext(Some("no-dot-at-all")), "bin");
        assert_eq!(safe_ext(None), "bin");
        assert_eq!(safe_ext(Some("weird.tar.gz")), "gz", "last segment only");
    }

    /// The extension becomes part of a generated write-through filename — a
    /// `/`, `.` or `\` surviving into it would let a crafted upload filename
    /// escape the intended directory/key, the same hazard
    /// `uploads::resolve_name` guards against on the stored filename itself.
    /// Assert the *property*, not a specific string: alnum-filtering can turn
    /// traversal segments into a plausible-looking (but harmless) extension.
    #[test]
    fn safe_ext_never_lets_a_path_character_through() {
        for input in [
            "../../etc/passwd",
            "sneaky.png/../../x",
            "a/b\\c.d/e",
            "....",
        ] {
            let ext = safe_ext(Some(input));
            assert!(
                ext.chars().all(|c| c.is_ascii_alphanumeric()),
                "{input:?} -> {ext:?} contains a non-alphanumeric character"
            );
            assert!(!ext.is_empty());
        }
    }

    #[test]
    fn max_px_and_normalize_read_from_params_with_the_old_defaults() {
        let empty = Map::new();
        assert_eq!(max_px(&empty), 256);
        assert!(should_normalize(&empty));

        let mut params = Map::new();
        params.insert("max_px".into(), json!(128));
        params.insert("normalize".into(), json!(false));
        assert_eq!(max_px(&params), 128);
        assert!(!should_normalize(&params));
    }
}
