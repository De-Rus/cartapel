//! The upload engine shared by `image { }` ([`crate::images`]) and
//! `file { }` ([`crate::filefield`]) fields: where a field's bytes live
//! (local disk, or a named `storage "…" { }` S3 bucket — see
//! [`crate::config::NamedStorage`]), the read/write of those bytes, and the
//! write-through mechanism (`name_col`/`write_to`) both field kinds use
//! identically to tell the database which file a row now has.
//!
//! Neither field kind cares which backend answered — `Dest` is resolved once,
//! from `dir` + `storage` (both backend-agnostic strings), and everything
//! downstream is the same either way.

use crate::state::{AppError, AppState, CurrentUser};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Where one field's file actually lives. `Local` is the only option a field
/// that never sets `storage` ever sees — `S3` only exists once a field opts
/// into a named `storage "…" { }` block.
pub enum Dest {
    Local(PathBuf),
    S3 {
        storage: crate::config::NamedStorage,
        key: String,
    },
}

/// `dir` (the field's own path/prefix, backend-agnostic) + `name` (the
/// filename), joined the way each backend wants: native separators on disk,
/// always `/` in an S3 key regardless of the server's OS.
pub fn dest_for(
    state: &AppState,
    dir: &str,
    storage: &Option<String>,
    name: &str,
) -> Result<Dest, AppError> {
    let Some(storage_name) = storage else {
        return Ok(Dest::Local(PathBuf::from(dir).join(name)));
    };
    let storage = state
        .cfg
        .load()
        .cartapel
        .storages
        .get(storage_name)
        .cloned()
        .ok_or_else(|| {
            AppError::internal(format!("storage \"{storage_name}\" is not configured"))
        })?;
    let key = format!("{}/{name}", dir.trim_matches('/'));
    Ok(Dest::S3 { storage, key })
}

fn creds_of(storage: &crate::config::NamedStorage) -> Result<crate::s3::Creds, AppError> {
    let env_of = |key: &Option<String>| {
        key.as_deref()
            .and_then(|k| std::env::var(k).ok())
            .unwrap_or_default()
    };
    let creds = crate::s3::Creds {
        access_key: env_of(&storage.access_key_env),
        secret_key: env_of(&storage.secret_key_env),
        region: storage
            .region
            .as_deref()
            .and_then(crate::config::resolve_env)
            .unwrap_or_else(|| "auto".into()),
    };
    if creds.access_key.is_empty() || creds.secret_key.is_empty() {
        return Err(AppError::internal("storage credential env vars are unset"));
    }
    Ok(creds)
}

fn resolve_required(field: &str, val: &Option<String>) -> Result<String, AppError> {
    val.as_deref()
        .and_then(crate::config::resolve_env)
        .ok_or_else(|| AppError::internal(format!("storage: missing `{field}`")))
}

pub async fn read_bytes(state: &AppState, dest: &Dest) -> Result<(Vec<u8>, String), AppError> {
    match dest {
        Dest::Local(path) => {
            let bytes = tokio::fs::read(path)
                .await
                .map_err(|_| AppError::not_found("not found"))?;
            let ct = mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string();
            Ok((bytes, ct))
        }
        Dest::S3 { storage, key } => {
            let creds = creds_of(storage)?;
            let endpoint = resolve_required("endpoint", &storage.endpoint)?;
            let bucket = resolve_required("bucket", &storage.bucket)?;
            let bytes = crate::s3::get_object(&state.http, &endpoint, &bucket, key, &creds)
                .await
                .map_err(|_| AppError::not_found("not found"))?;
            let ct = mime_guess::from_path(key)
                .first_or_octet_stream()
                .to_string();
            Ok((bytes, ct))
        }
    }
}

/// Local writes go through a tmp-file-then-rename for atomicity; an S3 `PUT`
/// is already atomic at the object level, so there is nothing to stage.
pub async fn write_bytes(state: &AppState, dest: &Dest, bytes: &[u8]) -> Result<(), AppError> {
    match dest {
        Dest::Local(path) => {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| AppError::internal(e.to_string()))?;
            }
            let tmp = path.with_extension("tmp");
            tokio::fs::write(&tmp, bytes)
                .await
                .map_err(|e| AppError::internal(format!("write file: {e}")))?;
            tokio::fs::rename(&tmp, path)
                .await
                .map_err(|e| AppError::internal(format!("commit file: {e}")))
        }
        Dest::S3 { storage, key } => {
            let creds = creds_of(storage)?;
            let endpoint = resolve_required("endpoint", &storage.endpoint)?;
            let bucket = resolve_required("bucket", &storage.bucket)?;
            crate::s3::put_object(&state.http, &endpoint, &bucket, key, &creds, bytes)
                .await
                .map_err(|e| AppError::internal(format!("s3 upload: {e}")))
        }
    }
}

/// The `write_to` shape `image { }` and `file { }` share verbatim — built from
/// whichever config the caller has, so the SQL below is written once.
pub struct WriteThrough<'a> {
    pub write_to: &'a Option<String>,
    pub name_col: &'a str,
    pub write_key: &'a BTreeMap<String, String>,
    pub write_defaults: &'a BTreeMap<String, String>,
}

/// The current filename for a plain (non-join) field: read `name_col` (or
/// `name_sql` for a field joined from a related table) off the row, and
/// refuse anything that isn't a bare filename — this value becomes a path
/// segment on disk or an S3 key, so a `/` or `..` in it must never reach
/// there. Also enforces field-level masking, since that's a property of the
/// *column*, independent of which field kind (image or file) reads it.
pub async fn resolve_name(
    state: &AppState,
    user: &CurrentUser,
    table: &str,
    col: &str,
    pk: &str,
    name_col: &str,
    name_sql: &Option<String>,
) -> Result<String, AppError> {
    let dbt = state.readable_table(user, table)?;
    if state.masked_columns(user, table).contains(&col.to_string()) {
        return Err(AppError::forbidden("field is masked"));
    }
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
    // The filename comes from a real column, or — for a file joined from a
    // related table — from a correlated `name_sql` expression over the `t` alias.
    let name_expr = if let Some(sql) = name_sql {
        format!("({sql})")
    } else {
        let name_col = dbt
            .column(name_col)
            .ok_or_else(|| AppError::internal("name_col not in schema"))?;
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
        .ok_or_else(|| AppError::not_found("no file for this row"))?;

    if name.is_empty() || name.contains('/') || name.contains("..") || name.contains('\\') {
        return Err(AppError::bad("unsafe stored filename"));
    }
    Ok(name)
}

/// The parent's write_key parent-column values, in target-column (sorted) order.
pub async fn writethrough_keys(
    state: &AppState,
    user: &CurrentUser,
    table: &str,
    wt: &WriteThrough<'_>,
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
    let sel: Vec<String> = wt
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
    for (target_col, parent_col) in wt.write_key {
        let v = row
            .get(parent_col)
            .and_then(|v| v.as_str().map(String::from))
            .ok_or_else(|| {
                AppError::bad(format!("write_key parent column {parent_col} is null"))
            })?;
        out.push((target_col.clone(), v));
    }
    Ok(out)
}

/// Deterministic filename for a write-through upload: the key values joined,
/// sanitised, with `ext` appended (`"png"` for an `image { }` field — uploads
/// are always normalised to PNG; the uploaded file's own extension for `file { }`).
pub fn writethrough_filename(keys: &[(String, String)], ext: &str) -> String {
    let stem: String = keys
        .iter()
        .map(|(_, v)| {
            v.chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("_");
    format!("{stem}.{ext}")
}

/// Upsert the target row: UPDATE by write_key (setting the filename column and
/// write_defaults); INSERT if absent. One transaction.
pub async fn writethrough_upsert(
    state: &AppState,
    user: &CurrentUser,
    table: &str,
    wt: &WriteThrough<'_>,
    pk: &str,
    filename: &str,
) -> Result<(), AppError> {
    let write_to = wt.write_to.as_ref().unwrap();
    if !state.table_perms(user, write_to).update {
        return Err(AppError::forbidden("no write access to the target table"));
    }
    let keys = writethrough_keys(state, user, table, wt, pk).await?;
    let target = state
        .resolve_table(write_to)
        .ok_or_else(|| AppError::bad(format!("unknown table {write_to}")))?;
    let pool = state.pool_of(target);
    let qual = state.qualified_of(target);
    let name_col = crate::sqlval::ident(wt.name_col);

    let key_pred = |binds: &mut crate::sqlval::Binds| -> String {
        keys.iter()
            .map(|(col, val)| {
                format!(
                    "{} = {}",
                    crate::sqlval::ident(col),
                    binds.ph(Some(val.clone()))
                )
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    };

    // UPDATE first — filename + the write_defaults (the state a good upload has).
    let mut ub = crate::sqlval::Binds::for_dialect(pool.dialect());
    let mut sets = vec![format!(
        "{name_col} = {}",
        ub.ph(Some(filename.to_string()))
    )];
    for (col, val) in wt.write_defaults {
        sets.push(format!(
            "{} = {}",
            crate::sqlval::ident(col),
            ub.ph(Some(val.clone()))
        ));
    }
    let usql = format!(
        "UPDATE {qual} SET {} WHERE {}",
        sets.join(", "),
        key_pred(&mut ub)
    );
    let updated = crate::db::execute(pool, &usql, &ub).await?.rows_affected;

    if updated == 0 {
        let mut ib = crate::sqlval::Binds::for_dialect(pool.dialect());
        let mut cols: Vec<String> = keys.iter().map(|(c, _)| crate::sqlval::ident(c)).collect();
        let mut vals: Vec<String> = keys.iter().map(|(_, v)| ib.ph(Some(v.clone()))).collect();
        cols.push(name_col.clone());
        vals.push(ib.ph(Some(filename.to_string())));
        for (col, val) in wt.write_defaults {
            cols.push(crate::sqlval::ident(col));
            vals.push(ib.ph(Some(val.clone())));
        }
        let isql = format!(
            "INSERT INTO {qual} ({}) VALUES ({})",
            cols.join(", "),
            vals.join(", ")
        );
        crate::db::execute(pool, &isql, &ib).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `image { }` always passes `"png"` here (uploads are normalised to
    /// PNG); `file { }` passes the upload's own extension. One function, two
    /// callers — this pins that the `ext` param actually lands in the name.
    #[test]
    fn writethrough_filename_uses_the_given_extension() {
        // Non-alphanumerics in a key value (the hyphen here) are sanitised to
        // `_`, same as everywhere else this function is used.
        let keys = vec![("sku".to_string(), "widget-42".to_string())];
        assert_eq!(writethrough_filename(&keys, "png"), "widget_42.png");
        assert_eq!(writethrough_filename(&keys, "pdf"), "widget_42.pdf");
    }

    #[test]
    fn writethrough_filename_sanitises_and_joins_multiple_keys() {
        let keys = vec![
            ("a".to_string(), "Order #42".to_string()),
            ("b".to_string(), "2026/09".to_string()),
        ];
        assert_eq!(writethrough_filename(&keys, "pdf"), "Order__42_2026_09.pdf");
    }
}
