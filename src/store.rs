use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use chrono::Utc;
use rand::RngCore;
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};
use crate::config::RoleConfig;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, PartialEq)]
pub enum AdminGuard {
    Done,
    NotFound,
    LastAdmin,
}
use std::sync::{LazyLock, Mutex};

#[derive(Debug)]
pub enum UserCreateError {
    Duplicate,
    Other(String),
}

pub struct Store {
    conn: Mutex<Connection>,
}

const SESSION_DAYS: i64 = 30;

const V1_BASELINE: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    pw_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    table_name TEXT NOT NULL,
    pk TEXT,
    action TEXT NOT NULL,
    changes TEXT
);
CREATE INDEX IF NOT EXISTS audit_table_idx ON audit_log(table_name, id);
CREATE INDEX IF NOT EXISTS audit_row_idx ON audit_log(table_name, pk, id);
CREATE TABLE IF NOT EXISTS saved_views (
    id INTEGER PRIMARY KEY,
    owner_email TEXT NOT NULL,
    table_name TEXT NOT NULL,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS saved_views_table_idx ON saved_views(table_name);
CREATE TABLE IF NOT EXISTS config_versions (
    id INTEGER PRIMARY KEY,
    table_name TEXT NOT NULL,
    toml TEXT NOT NULL,
    actor TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS config_versions_idx ON config_versions(table_name, id DESC);
"#;

// Append-only. Shipped migrations are IMMUTABLE — never edit, delete, or reorder
// an existing M::up entry; only push new ones. V1 uses IF NOT EXISTS so it absorbs
// databases created by the pre-migration ad-hoc schema without data loss.
static MIGRATIONS: LazyLock<Migrations<'static>> =
    LazyLock::new(|| Migrations::new(vec![M::up(V1_BASELINE)]));

static DUMMY_HASH: LazyLock<PasswordHash<'static>> = LazyLock::new(|| {
    static RAW: LazyLock<String> = LazyLock::new(|| {
        let salt = SaltString::generate(&mut rand::rngs::OsRng);
        Argon2::default()
            .hash_password(b"steward-dummy-password", &salt)
            .expect("dummy hash")
            .to_string()
    });
    PasswordHash::new(&RAW).expect("parse dummy hash")
});

impl Store {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        let mut conn = Connection::open(data_dir.join("steward.db")).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
        MIGRATIONS.to_latest(&mut conn).map_err(|e| e.to_string())?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn user_count(&self) -> rusqlite::Result<i64> {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM users", [], |r| r.get(0))
    }

    pub fn add_user(&self, email: &str, password: &str, role: &str) -> Result<(), String> {
        let salt = SaltString::generate(&mut rand::rngs::OsRng);
        let hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| e.to_string())?
            .to_string();
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO users (email, pw_hash, role, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(email) DO UPDATE SET pw_hash = ?2, role = ?3",
                rusqlite::params![email, hash, role, Utc::now().to_rfc3339()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn hash_password(password: &str) -> Result<String, String> {
        let salt = SaltString::generate(&mut rand::rngs::OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| e.to_string())
    }

    pub fn list_users(&self) -> rusqlite::Result<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id, email, role, created_at FROM users ORDER BY id")?;
        let mut q = stmt.query([])?;
        let mut rows = Vec::new();
        while let Some(r) = q.next()? {
            rows.push(json!({
                "id": r.get::<_, i64>(0)?,
                "email": r.get::<_, String>(1)?,
                "role": r.get::<_, String>(2)?,
                "created_at": r.get::<_, String>(3)?,
            }));
        }
        Ok(Value::Array(rows))
    }

    pub fn user_by_id(&self, id: i64) -> Option<(String, String)> {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT email, role FROM users WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .ok()
    }

    pub fn create_user(&self, email: &str, password: &str, role: &str) -> Result<i64, UserCreateError> {
        let hash = Self::hash_password(password).map_err(UserCreateError::Other)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO users (email, pw_hash, role, created_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![email, hash, role, Utc::now().to_rfc3339()],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(f, _)
                if f.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                UserCreateError::Duplicate
            }
            other => UserCreateError::Other(other.to_string()),
        })?;
        Ok(conn.last_insert_rowid())
    }

    /// Atomic (single mutex hold) check-then-mutate for the last-admin invariant.
    /// `new_role = None` means delete. Returns the outcome so the handler can map
    /// to 404 / 409 / success without a separate racy count.
    pub fn guarded_admin_mutation(&self, id: i64, new_role: Option<&str>) -> rusqlite::Result<AdminGuard> {
        let conn = self.conn.lock().unwrap();
        let current: Option<String> = conn
            .query_row("SELECT role FROM users WHERE id = ?1", [id], |r| r.get(0))
            .ok();
        let Some(current) = current else { return Ok(AdminGuard::NotFound) };
        let losing_admin = current == "admin" && new_role != Some("admin");
        if losing_admin {
            let admins: i64 =
                conn.query_row("SELECT count(*) FROM users WHERE role = 'admin'", [], |r| r.get(0))?;
            if admins <= 1 {
                return Ok(AdminGuard::LastAdmin);
            }
        }
        match new_role {
            Some(role) => {
                conn.execute("UPDATE users SET role = ?1 WHERE id = ?2", rusqlite::params![role, id])?;
            }
            None => {
                conn.execute("DELETE FROM users WHERE id = ?1", [id])?;
            }
        }
        Ok(AdminGuard::Done)
    }

    pub fn update_user_password(&self, id: i64, password: &str) -> Result<usize, String> {
        let hash = Self::hash_password(password)?;
        self.conn
            .lock()
            .unwrap()
            .execute("UPDATE users SET pw_hash = ?1 WHERE id = ?2", rusqlite::params![hash, id])
            .map_err(|e| e.to_string())
    }


    #[allow(dead_code)]
    pub fn count_admins(&self) -> rusqlite::Result<i64> {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM users WHERE role = 'admin'", [], |r| r.get(0))
    }

    /// One-time transitional read of the legacy `roles` table for the config
    /// migration ([`crate::configedit::port_legacy_roles`]). Returns rows only if
    /// that table still exists — a clean empty no-op on fresh DBs built from the
    /// roles-free baseline. Adapts the old JSON row shape into `RoleConfig`.
    /// Returns `(parsed, failed_names)`: any row whose `definition` fails to
    /// deserialize is reported by name so the caller can refuse to drop the table.
    pub fn take_legacy_roles(&self) -> (Vec<(String, RoleConfig)>, Vec<String>) {
        let conn = self.conn.lock().unwrap();
        let has_table = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roles'",
                [],
                |_| Ok(()),
            )
            .is_ok();
        if !has_table {
            return (Vec::new(), Vec::new());
        }
        let Ok(mut stmt) = conn.prepare("SELECT name, definition FROM roles ORDER BY name") else {
            return (Vec::new(), Vec::new());
        };
        let Ok(mut q) = stmt.query([]) else { return (Vec::new(), Vec::new()) };
        let mut out = Vec::new();
        let mut failed = Vec::new();
        while let Ok(Some(r)) = q.next() {
            let (Ok(name), Ok(def)) = (r.get::<_, String>(0), r.get::<_, String>(1)) else {
                continue;
            };
            match serde_json::from_str::<RoleConfig>(&def) {
                Ok(cfg) => out.push((name, cfg)),
                Err(_) => failed.push(name),
            }
        }
        (out, failed)
    }

    /// Drop the legacy `roles` table once its rows have been ported to config.
    pub fn drop_legacy_roles(&self) {
        let _ = self.conn.lock().unwrap().execute("DROP TABLE IF EXISTS roles", []);
    }

    #[cfg(test)]
    pub fn seed_legacy_role(&self, name: &str, definition_json: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS roles (name TEXT PRIMARY KEY, definition TEXT NOT NULL, created_at TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO roles (name, definition, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![name, definition_json, Utc::now().to_rfc3339()],
        )
        .unwrap();
    }

    pub fn role_user_counts(&self) -> HashMap<String, i64> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT role, count(*) FROM users GROUP BY role") else {
            return HashMap::new();
        };
        let Ok(mut q) = stmt.query([]) else { return HashMap::new() };
        let mut out = HashMap::new();
        while let Ok(Some(r)) = q.next() {
            if let (Ok(role), Ok(n)) = (r.get::<_, String>(0), r.get::<_, i64>(1)) {
                out.insert(role, n);
            }
        }
        out
    }

    pub fn verify_login(&self, email: &str, password: &str) -> Option<(String, String)> {
        let row: Option<(String, String, String)> = self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT email, pw_hash, role FROM users WHERE email = ?1",
                [email],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        match row {
            Some((email, pw_hash, role)) => {
                let parsed = PasswordHash::new(&pw_hash).ok()?;
                Argon2::default()
                    .verify_password(password.as_bytes(), &parsed)
                    .ok()?;
                Some((email, role))
            }
            None => {
                let _ = Argon2::default().verify_password(password.as_bytes(), &DUMMY_HASH);
                None
            }
        }
    }

    pub fn create_session(&self, email: &str) -> rusqlite::Result<String> {
        let mut raw = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut raw);
        let token = hex::encode(raw);
        let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
             SELECT ?1, id, ?2, ?3 FROM users WHERE email = ?4",
            rusqlite::params![
                token_hash,
                (Utc::now() + chrono::Duration::days(SESSION_DAYS)).to_rfc3339(),
                Utc::now().to_rfc3339(),
                email
            ],
        )?;
        Ok(token)
    }

    pub fn session_user(&self, token: &str) -> Option<(String, String)> {
        let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1 AND s.expires_at > ?2",
            rusqlite::params![token_hash, Utc::now().to_rfc3339()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
    }

    pub fn delete_session(&self, token: &str) {
        let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
        let _ = self
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash]);
    }

    pub fn audit(&self, actor: &str, table: &str, pk: Option<&str>, action: &str, changes: Option<&Value>) {
        let _ = self.conn.lock().unwrap().execute(
            "INSERT INTO audit_log (ts, actor, table_name, pk, action, changes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                Utc::now().to_rfc3339(),
                actor,
                table,
                pk,
                action,
                changes.map(|c| c.to_string())
            ],
        );
    }

    pub fn audit_for_row(&self, table: &str, pk: &str) -> rusqlite::Result<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, ts, actor, table_name, pk, action, changes FROM audit_log
             WHERE table_name = ?1 AND pk = ?2 ORDER BY id DESC LIMIT 200",
        )?;
        let mut q = stmt.query(rusqlite::params![table, pk])?;
        let mut rows = Vec::new();
        while let Some(r) = q.next()? {
            let changes: Option<String> = r.get(6)?;
            rows.push(json!({
                "id": r.get::<_, i64>(0)?,
                "ts": r.get::<_, String>(1)?,
                "actor": r.get::<_, String>(2)?,
                "table_name": r.get::<_, String>(3)?,
                "pk": r.get::<_, Option<String>>(4)?,
                "action": r.get::<_, String>(5)?,
                "changes": changes.and_then(|c| serde_json::from_str::<Value>(&c).ok()),
            }));
        }
        Ok(json!({ "rows": rows }))
    }

    pub fn views_list(&self, owner: &str, table: Option<&str>) -> rusqlite::Result<Value> {
        let conn = self.conn.lock().unwrap();
        let (where_extra, params): (&str, Vec<String>) = match table {
            Some(t) => ("AND table_name = ?2", vec![owner.to_string(), t.to_string()]),
            None => ("", vec![owner.to_string()]),
        };
        let sql = format!(
            "SELECT id, owner_email, table_name, name, query, shared, created_at FROM saved_views
             WHERE (owner_email = ?1 OR shared = 1) {where_extra} ORDER BY table_name, name",
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut q = stmt.query(rusqlite::params_from_iter(&params))?;
        let mut rows = Vec::new();
        while let Some(r) = q.next()? {
            let owner_email: String = r.get(1)?;
            rows.push(json!({
                "id": r.get::<_, i64>(0)?,
                "owner_email": owner_email,
                "table_name": r.get::<_, String>(2)?,
                "name": r.get::<_, String>(3)?,
                "query": r.get::<_, String>(4)?,
                "shared": r.get::<_, i64>(5)? != 0,
                "created_at": r.get::<_, String>(6)?,
                "own": owner_email == owner,
            }));
        }
        Ok(json!({ "rows": rows }))
    }

    pub fn view_create(
        &self,
        owner: &str,
        table: &str,
        name: &str,
        query: &str,
        shared: bool,
    ) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO saved_views (owner_email, table_name, name, query, shared, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![owner, table, name, query, shared as i64, Utc::now().to_rfc3339()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn view_meta(&self, id: i64) -> Option<(String, String)> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT owner_email, table_name FROM saved_views WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok()
    }

    pub fn view_delete(&self, id: i64) -> rusqlite::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM saved_views WHERE id = ?1", [id])?;
        Ok(())
    }

    #[cfg(test)]
    pub fn open_memory() -> Self {
        let dir = std::env::temp_dir().join(format!("steward-test-{}", rand::random::<u64>()));
        Store::open(&dir).expect("open test store")
    }

    pub fn audit_list(&self, table: Option<&str>, page: u32, pp: u32) -> rusqlite::Result<Value> {
        let conn = self.conn.lock().unwrap();
        let (where_sql, params): (&str, Vec<String>) = match table {
            Some(t) => ("WHERE table_name = ?1", vec![t.to_string()]),
            None => ("", vec![]),
        };
        let total: i64 = conn.query_row(
            &format!("SELECT count(*) FROM audit_log {where_sql}"),
            rusqlite::params_from_iter(&params),
            |r| r.get(0),
        )?;
        let mut rows = Vec::new();
        let sql = format!(
            "SELECT id, ts, actor, table_name, pk, action, changes FROM audit_log {where_sql}
             ORDER BY id DESC LIMIT {} OFFSET {}",
            pp.min(200),
            page.saturating_sub(1) * pp
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut q = stmt.query(rusqlite::params_from_iter(&params))?;
        while let Some(r) = q.next()? {
            let changes: Option<String> = r.get(6)?;
            rows.push(json!({
                "id": r.get::<_, i64>(0)?,
                "ts": r.get::<_, String>(1)?,
                "actor": r.get::<_, String>(2)?,
                "table_name": r.get::<_, String>(3)?,
                "pk": r.get::<_, Option<String>>(4)?,
                "action": r.get::<_, String>(5)?,
                "changes": changes.and_then(|c| serde_json::from_str::<Value>(&c).ok()),
            }));
        }
        Ok(json!({ "rows": rows, "total": total }))
    }

    /// Snapshot a saved config. Inserts the new version, marks it the sole
    /// published one for its table (a save is always the newly-published state),
    /// and prunes to the most recent [`CONFIG_VERSION_CAP`] rows for that table —
    /// all under one lock so history and the published flag are never split.
    pub fn config_version_add(
        &self,
        table: &str,
        toml: &str,
        actor: &str,
        note: Option<&str>,
    ) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE config_versions SET published = 0 WHERE table_name = ?1", [table])?;
        conn.execute(
            "INSERT INTO config_versions (table_name, toml, actor, note, created_at, published)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)",
            rusqlite::params![table, toml, actor, note, Utc::now().to_rfc3339()],
        )?;
        let id = conn.last_insert_rowid();
        conn.execute(
            "DELETE FROM config_versions WHERE table_name = ?1 AND id NOT IN (
                 SELECT id FROM config_versions WHERE table_name = ?1 ORDER BY id DESC LIMIT ?2
             )",
            rusqlite::params![table, CONFIG_VERSION_CAP],
        )?;
        Ok(id)
    }

    pub fn config_versions_list(&self, table: &str) -> rusqlite::Result<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, actor, note, created_at, published, length(toml) FROM config_versions
             WHERE table_name = ?1 ORDER BY id DESC",
        )?;
        let mut q = stmt.query([table])?;
        let mut rows = Vec::new();
        while let Some(r) = q.next()? {
            rows.push(json!({
                "id": r.get::<_, i64>(0)?,
                "actor": r.get::<_, String>(1)?,
                "note": r.get::<_, Option<String>>(2)?,
                "created_at": r.get::<_, String>(3)?,
                "published": r.get::<_, i64>(4)? != 0,
                "bytes": r.get::<_, i64>(5)?,
            }));
        }
        Ok(json!({ "versions": rows }))
    }

    pub fn config_version_get(&self, table: &str, id: i64) -> Option<String> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT toml FROM config_versions WHERE id = ?1 AND table_name = ?2",
                rusqlite::params![id, table],
                |r| r.get(0),
            )
            .ok()
    }

    /// Mark version `id` the sole published one for `table` and return its TOML,
    /// or `None` if it does not exist for that table. The flip and the read share
    /// one lock so a concurrent add can't interleave.
    pub fn config_version_publish(&self, table: &str, id: i64) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        let toml: Option<String> = conn
            .query_row(
                "SELECT toml FROM config_versions WHERE id = ?1 AND table_name = ?2",
                rusqlite::params![id, table],
                |r| r.get(0),
            )
            .ok();
        let toml = toml?;
        conn.execute("UPDATE config_versions SET published = 0 WHERE table_name = ?1", [table])
            .ok()?;
        conn.execute(
            "UPDATE config_versions SET published = 1 WHERE id = ?1 AND table_name = ?2",
            rusqlite::params![id, table],
        )
        .ok()?;
        Some(toml)
    }
}

/// Keep at most this many config snapshots per table; older ones are pruned on add.
const CONFIG_VERSION_CAP: i64 = 100;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_db_migrates_to_expected_schema() {
        let store = Store::open_memory();
        let conn = store.conn.lock().unwrap();
        let mut tables: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            rows.map(Result::unwrap).collect()
        };
        tables.sort();
        assert_eq!(
            tables,
            vec![
                "audit_log",
                "config_versions",
                "saved_views",
                "sessions",
                "users",
            ]
        );
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 1);
    }

    #[test]
    fn reopening_existing_db_preserves_rows() {
        let dir = std::env::temp_dir().join(format!("steward-reopen-{}", rand::random::<u64>()));
        {
            let store = Store::open(&dir).unwrap();
            store.create_user("keep@x.io", "pw", "admin").unwrap();
            store
                .view_create("keep@x.io", "bots", "Mine", "q=btc", false)
                .unwrap();
            store.audit("keep@x.io", "bots", Some("1"), "update", None);
        }
        let store = Store::open(&dir).unwrap();
        assert_eq!(store.user_count().unwrap(), 1);
        assert!(store.verify_login("keep@x.io", "pw").is_some());
        let views = store.views_list("keep@x.io", Some("bots")).unwrap();
        assert_eq!(views["rows"].as_array().unwrap().len(), 1);
        let audit = store.audit_for_row("bots", "1").unwrap();
        assert_eq!(audit["rows"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn saved_views_round_trip() {
        let store = Store::open_memory();
        let id = store
            .view_create("admin@example.com", "bots", "Active bots", "f_active=1&sort=-id", false)
            .unwrap();
        let other = store
            .view_create("someone@x.io", "bots", "Shared view", "q=btc", true)
            .unwrap();
        let private = store
            .view_create("someone@x.io", "bots", "Private", "q=eth", false)
            .unwrap();

        let out = store.views_list("admin@example.com", Some("bots")).unwrap();
        let rows = out["rows"].as_array().unwrap();
        // own view + the shared one, but not someone else's private view
        let names: Vec<&str> = rows.iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"Active bots"));
        assert!(names.contains(&"Shared view"));
        assert!(!names.contains(&"Private"));

        let own_row = rows.iter().find(|r| r["id"] == id).unwrap();
        assert_eq!(own_row["own"], serde_json::json!(true));
        assert_eq!(own_row["query"], serde_json::json!("f_active=1&sort=-id"));
        let shared_row = rows.iter().find(|r| r["id"] == other).unwrap();
        assert_eq!(shared_row["own"], serde_json::json!(false));
        assert_eq!(shared_row["shared"], serde_json::json!(true));

        // table filter isolates
        let empty = store.views_list("admin@example.com", Some("orders")).unwrap();
        assert!(empty["rows"].as_array().unwrap().is_empty());

        let (owner, table) = store.view_meta(id).unwrap();
        assert_eq!(owner, "admin@example.com");
        assert_eq!(table, "bots");

        store.view_delete(id).unwrap();
        assert!(store.view_meta(id).is_none());
        let _ = private;
    }

    #[test]
    fn audit_for_row_filters_to_table_and_pk() {
        let store = Store::open_memory();
        store.audit("admin@example.com", "bots", Some("7"), "update", None);
        store.audit("admin@example.com", "bots", Some("8"), "update", None);
        store.audit("admin@example.com", "orders", Some("7"), "delete", None);

        let out = store.audit_for_row("bots", "7").unwrap();
        let rows = out["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["action"], serde_json::json!("update"));
        assert_eq!(rows[0]["table_name"], serde_json::json!("bots"));
    }

    #[test]
    fn config_version_add_publishes_newest_and_unsets_others() {
        let store = Store::open_memory();
        let v1 = store.config_version_add("bots", "label = \"A\"\n", "a@x.io", None).unwrap();
        let v2 = store.config_version_add("bots", "label = \"B\"\n", "a@x.io", Some("second")).unwrap();

        let out = store.config_versions_list("bots").unwrap();
        let rows = out["versions"].as_array().unwrap();
        // newest first, and no toml body leaks into the list
        assert_eq!(rows[0]["id"], serde_json::json!(v2));
        assert_eq!(rows[1]["id"], serde_json::json!(v1));
        assert!(rows[0].get("toml").is_none());
        assert_eq!(rows[0]["bytes"], serde_json::json!("label = \"B\"\n".len() as i64));
        assert_eq!(rows[0]["note"], serde_json::json!("second"));
        // exactly the newest is published
        assert_eq!(rows[0]["published"], serde_json::json!(true));
        assert_eq!(rows[1]["published"], serde_json::json!(false));
    }

    #[test]
    fn config_version_get_is_scoped_to_table() {
        let store = Store::open_memory();
        let id = store.config_version_add("bots", "label = \"A\"\n", "a@x.io", None).unwrap();
        assert_eq!(store.config_version_get("bots", id).as_deref(), Some("label = \"A\"\n"));
        // same id, wrong table → None
        assert!(store.config_version_get("orders", id).is_none());
        assert!(store.config_version_get("bots", 99999).is_none());
    }

    #[test]
    fn config_version_publish_flips_published_and_returns_toml() {
        let store = Store::open_memory();
        let v1 = store.config_version_add("bots", "label = \"A\"\n", "a@x.io", None).unwrap();
        let _v2 = store.config_version_add("bots", "label = \"B\"\n", "a@x.io", None).unwrap();

        let toml = store.config_version_publish("bots", v1);
        assert_eq!(toml.as_deref(), Some("label = \"A\"\n"));

        let out = store.config_versions_list("bots").unwrap();
        let rows = out["versions"].as_array().unwrap();
        let r1 = rows.iter().find(|r| r["id"] == serde_json::json!(v1)).unwrap();
        assert_eq!(r1["published"], serde_json::json!(true));
        let published_count = rows.iter().filter(|r| r["published"] == serde_json::json!(true)).count();
        assert_eq!(published_count, 1);

        // wrong table / missing → None, nothing published for it
        assert!(store.config_version_publish("orders", v1).is_none());
    }
}
