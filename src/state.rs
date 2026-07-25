use crate::config::{ConfigDir, RoleConfig};
use crate::introspect::Schema;
use crate::store::Store;
use arc_swap::ArcSwap;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::Sha256;
use sqlx::PgPool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// `(table, column, row_filter)` — the cache key for enum-option queries.
pub type OptionsCacheKey = (String, String, Option<String>);

pub struct AppState {
    pub pg: PgPool,
    pub pools: std::collections::HashMap<String, PgPool>,
    pub schema: String,
    pub db: Schema,
    pub dbs: std::collections::HashMap<String, Schema>,
    /// The live config, atomically hot-swappable via [`AppState::reload_config`].
    /// Never read the field directly — go through [`AppState::cfg`].
    pub cfg: ArcSwap<ConfigDir>,
    /// Directory the config was loaded from, if any. Absent = no config dir
    /// configured (defaults only); reload/write are then no-ops.
    pub config_dir: Option<PathBuf>,
    pub store: Store,
    pub base_path: String,
    pub brand: String,
    pub http: reqwest::Client,
    pub secure_cookies: bool,
    /// HMAC-SHA256 root for signing session cookies (and future at-rest secret
    /// encryption). Derived to a uniform 32 bytes from the required configured
    /// key — see [`AppState::sign`]/[`AppState::verify`]. Rotating it invalidates
    /// every outstanding session cookie.
    pub secret_key: [u8; 32],
    pub webhook_secret: Option<String>,
    pub options_cache: Mutex<HashMap<OptionsCacheKey, (Instant, serde_json::Value)>>,
    pub login_limiter: Mutex<HashMap<String, (u32, Instant)>>,
    /// Serializes the read-modify-write of the on-disk config files so two
    /// concurrent admin writes can't clobber each other (last rename wins =
    /// lost update). Held across clone → serialize → commit_and_reload only;
    /// never across an `.await`.
    pub config_write_lock: Mutex<()>,
}

fn secret_shaped(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "passwd",
        "api_key",
        "apikey",
        "private_key",
    ]
    .iter()
    .any(|k| n.contains(k))
}

#[derive(Debug)]
pub struct AppError(pub StatusCode, pub String);

impl AppError {
    pub fn bad(msg: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self(StatusCode::NOT_FOUND, msg.into())
    }
    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self(StatusCode::FORBIDDEN, msg.into())
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self(StatusCode::CONFLICT, msg.into())
    }
    pub fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "not authenticated".into())
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, msg.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::RowNotFound => AppError::not_found("row not found"),
            sqlx::Error::Database(db) => {
                tracing::warn!("db error: {}", db.message());
                // Constraint/format violations carry actionable, user-caused
                // messages ("null value in column …"); anything else stays opaque.
                let code = db.code();
                let known = matches!(
                    code.as_deref(),
                    Some(
                        "23502"
                            | "23505"
                            | "23503"
                            | "23514"
                            | "22P02"
                            | "22001"
                            | "22003"
                            | "22007"
                            | "22008"
                    )
                );
                if known {
                    AppError::bad(db.message())
                } else {
                    AppError::bad("invalid value for this operation")
                }
            }
            _ => {
                tracing::warn!("query error: {e}");
                AppError::internal("internal error")
            }
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        tracing::warn!("store error: {e}");
        AppError::internal("internal error")
    }
}

#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub email: String,
    pub role: String,
}

impl CurrentUser {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub enum Level {
    None,
    Read,
    Write,
}

/// Effective, fully-resolved per-table capabilities for one user: the coarse
/// `tables` level, refined by any granular `perms` override, then intersected
/// (AND) with the table config ceiling + the read-only-table gate.
/// `update` is the master write capability (row edits, bulk, upsert, image
/// upload, UPDATE actions); `view` gates every read path.
#[derive(Debug, Clone, Copy)]
pub struct TablePerms {
    pub view: bool,
    pub create: bool,
    pub update: bool,
    pub delete: bool,
}

impl AppState {
    /// HMAC-SHA256 a message under [`AppState::secret_key`], hex-encoded.
    pub fn sign(&self, msg: &[u8]) -> String {
        let mut mac =
            <Hmac<Sha256>>::new_from_slice(&self.secret_key).expect("hmac accepts any key length");
        mac.update(msg);
        hex::encode(mac.finalize().into_bytes())
    }

    /// Constant-time verify of a hex signature produced by [`AppState::sign`].
    pub fn verify(&self, msg: &[u8], sig: &str) -> bool {
        let Ok(sig_bytes) = hex::decode(sig) else {
            return false;
        };
        let mut mac =
            <Hmac<Sha256>>::new_from_slice(&self.secret_key).expect("hmac accepts any key length");
        mac.update(msg);
        mac.verify_slice(&sig_bytes).is_ok()
    }

    /// A cheap snapshot of the live config. Cloning the returned `Arc` is a
    /// single atomic refcount bump; hold it for as long as a consistent view is
    /// needed (including across `.await`) without blocking a concurrent reload.
    pub fn cfg(&self) -> Arc<ConfigDir> {
        self.cfg.load_full()
    }

    /// Re-read the config directory and atomically swap it in. On any failure the
    /// currently-live config is KEPT untouched — a bad config can never take down
    /// auth/permissions.
    pub fn reload_config(&self) -> Result<(), String> {
        let new = crate::config::load(self.config_dir.as_deref())?;
        self.cfg.store(Arc::new(new));
        Ok(())
    }

    /// Resolve a role's effective definition from config (`config/auth.hcl`), the
    /// single authoritative source, flattening its `extends` chain: the root
    /// ancestor applies first, each descendant overrides per key (`actions`
    /// union). Cycles are load errors; the seen-guard here is belt and braces.
    pub fn resolve_role(&self, name: &str) -> Option<RoleConfig> {
        let cfg = self.cfg();
        let mut chain: Vec<&RoleConfig> = Vec::new();
        let mut seen: Vec<&str> = vec![name];
        let mut cur = cfg.auth.roles.get(name)?;
        chain.push(cur);
        while let Some(parent) = cur.extends.as_deref() {
            if seen.contains(&parent) {
                break;
            }
            let Some(p) = cfg.auth.roles.get(parent) else {
                break;
            };
            seen.push(parent);
            chain.push(p);
            cur = p;
        }
        let mut out = RoleConfig::default();
        for role in chain.iter().rev() {
            out.tables.extend(role.tables.clone());
            out.perms.extend(role.perms.clone());
            out.editable.extend(role.editable.clone());
            out.masked.extend(role.masked.clone());
            out.row_filter.extend(role.row_filter.clone());
            for a in &role.actions {
                if !out.actions.contains(a) {
                    out.actions.push(a.clone());
                }
            }
        }
        Some(out)
    }

    /// Every role name a user may be assigned: the hardcoded `admin` plus every
    /// config role. Deduplicated, admin first.
    pub fn effective_role_names(&self) -> Vec<String> {
        let mut out = vec!["admin".to_string()];
        for k in self.cfg().auth.roles.keys() {
            if !out.contains(k) {
                out.push(k.clone());
            }
        }
        out
    }

    pub fn role_level(&self, user: &CurrentUser, table: &str) -> Level {
        if user.is_admin() {
            return Level::Write;
        }
        let Some(role) = self.resolve_role(&user.role) else {
            return Level::None;
        };
        let raw = role
            .tables
            .get(table)
            .or_else(|| role.tables.get("*"))
            .map(String::as_str)
            .unwrap_or("none");
        match raw {
            "read" => Level::Read,
            "write" => Level::Write,
            _ => Level::None,
        }
    }

    pub fn table_perms(&self, user: &CurrentUser, table: &str) -> TablePerms {
        let level = self.role_level(user, table);
        let coarse_view = level >= Level::Read;
        let coarse_write = level >= Level::Write;
        let (mut view, mut create, mut update, mut delete) =
            (coarse_view, coarse_write, coarse_write, coarse_write);
        if !user.is_admin() {
            if let Some(role) = self.resolve_role(&user.role) {
                if let Some(tp) = role.perms.get(table) {
                    view = tp.view.unwrap_or(view);
                    create = tp.create.unwrap_or(create);
                    update = tp.update.unwrap_or(update);
                    delete = tp.delete.unwrap_or(delete);
                }
            }
        }
        let cfg = self.cfg();
        let caps = cfg
            .tables
            .get(table)
            .map(|t| t.permissions.clone())
            .unwrap_or_default();
        let read_only_table = self
            .db
            .tables
            .get(table)
            .map(|t| t.is_view || t.pk.is_none())
            .unwrap_or(true);
        let writable = caps.write && !read_only_table;
        TablePerms {
            view,
            create: create && writable && caps.create,
            update: update && writable,
            delete: delete && writable && caps.delete,
        }
    }

    /// The whitelist of columns a role may edit on a table, or `None` when the
    /// role imposes no per-column restriction (admin, or no `editable` entry).
    /// `Some(list)` means every write must draw only from `list`.
    pub fn editable_columns(&self, user: &CurrentUser, table: &str) -> Option<Vec<String>> {
        if user.is_admin() {
            return None;
        }
        self.resolve_role(&user.role)?.editable.get(table).cloned()
    }

    pub fn allowed_actions(&self, user: &CurrentUser, table: &str) -> Vec<String> {
        let cfg = self.cfg();
        let Some(tc) = cfg.tables.get(table) else {
            return vec![];
        };
        let names = tc.actions.keys().cloned();
        if user.is_admin() {
            return names.collect();
        }
        let Some(role) = self.resolve_role(&user.role) else {
            return vec![];
        };
        names
            .filter(|n| role.actions.iter().any(|a| a == &format!("{table}.{n}")))
            .collect()
    }

    pub fn masked_columns(&self, user: &CurrentUser, table: &str) -> Vec<String> {
        // Secret-shaped columns mask by default for EVERYONE (admins included) —
        // an admin panel must never show tokens in cleartext by accident. Any
        // `field` block on the column hands control back to the author.
        let cfg = self.cfg();
        let fields = cfg.tables.get(table).map(|t| &t.fields);
        let mut out: Vec<String> = self
            .resolve_table(table)
            .map(|dbt| {
                dbt.columns
                    .iter()
                    .filter(|c| secret_shaped(&c.name))
                    .filter(|c| !fields.is_some_and(|f| f.contains_key(&c.name)))
                    .map(|c| c.name.clone())
                    .collect()
            })
            .unwrap_or_default();
        // An explicit `masked = true` is the author's call — it applies to
        // everyone, admins included (the field block only OPTS OUT of the
        // secret-shape default when masked is absent/false).
        if let Some(f) = fields {
            for (k, fc) in f {
                if fc.masked && !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
        if user.is_admin() {
            return out;
        }
        if let Some(role) = self.resolve_role(&user.role) {
            if let Some(extra) = role.masked.get(table) {
                for c in extra {
                    if !out.contains(c) {
                        out.push(c.clone());
                    }
                }
            }
        }
        out
    }

    pub fn row_filter(&self, user: &CurrentUser, table: &str) -> Option<String> {
        if user.is_admin() {
            return None;
        }
        let role = self.resolve_role(&user.role)?;
        let raw = role.row_filter.get(table)?;
        let email_escaped = user.email.replace('\'', "''");
        Some(raw.replace("{actor.email}", &format!("'{email_escaped}'")))
    }

    /// Every configured-and-introspected table the user may view. A table is part
    /// of the admin only when it has a config file (`cfg.tables`); an unconfigured
    /// introspected table is not exposed at all.
    pub fn visible_tables(&self, user: &CurrentUser) -> Vec<String> {
        let cfg = self.cfg();
        cfg.tables
            .keys()
            .filter(|t| self.resolve_table(t).is_some())
            .filter(|t| self.table_perms(user, t).view)
            .cloned()
            .collect()
    }

    /// The physical [`DbTable`](crate::introspect::DbTable) behind a configured
    /// admin table, resolved across sources via its `from { source, schema, table }`.
    /// Unconfigured names fall back to a by-name lookup in the primary db.
    pub fn resolve_table(&self, table: &str) -> Option<&crate::introspect::DbTable> {
        let (src, schema, phys) = match self.cfg().tables.get(table) {
            Some(tc) => (
                tc.from.source.clone(),
                tc.from.schema.clone(),
                tc.from.table.clone().unwrap_or_else(|| table.to_string()),
            ),
            None => (None, None, table.to_string()),
        };
        self.db_for(src.as_deref()).find(schema.as_deref(), &phys)
    }

    pub fn pool_for(&self, source: Option<&str>) -> &PgPool {
        source.and_then(|s| self.pools.get(s)).unwrap_or(&self.pg)
    }

    pub fn db_for(&self, source: Option<&str>) -> &Schema {
        source.and_then(|s| self.dbs.get(s)).unwrap_or(&self.db)
    }

    pub fn pool_of(&self, dbt: &crate::introspect::DbTable) -> &PgPool {
        self.pools.get(&dbt.source).unwrap_or(&self.pg)
    }

    pub fn qualified_of(&self, dbt: &crate::introspect::DbTable) -> String {
        format!("\"{}\".\"{}\"", dbt.schema, dbt.name)
    }

    /// The pool a configured table lives on — its `from` source, else the primary.
    pub fn pool_for_table(&self, table: &str) -> &PgPool {
        match self.resolve_table(table) {
            Some(dbt) => self.pool_of(dbt),
            None => &self.pg,
        }
    }

    /// The `"schema"."table"` a configured table resolves to across its source.
    pub fn qualified_table(&self, table: &str) -> String {
        match self.resolve_table(table) {
            Some(dbt) => self.qualified_of(dbt),
            None => format!("\"{}\".\"{}\"", self.schema, table),
        }
    }

    /// Resolve a table for a data endpoint. Unconfigured tables (no `.hcl`) are not
    /// part of the admin, so they 404 exactly as a nonexistent table would — even
    /// by direct URL. Configured tables then pass through the per-role view gate.
    pub fn readable_table(
        &self,
        user: &CurrentUser,
        table: &str,
    ) -> Result<&crate::introspect::DbTable, AppError> {
        if !self.cfg().tables.contains_key(table) {
            return Err(AppError::not_found(format!("unknown table {table}")));
        }
        let dbt = self
            .resolve_table(table)
            .ok_or_else(|| AppError::not_found(format!("unknown table {table}")))?;
        if !self.table_perms(user, table).view {
            return Err(AppError::forbidden("no access to this table"));
        }
        Ok(dbt)
    }
}
