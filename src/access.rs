use crate::config::RoleConfig;
use crate::state::{AppError, AppState, CurrentUser};
use crate::store::UserCreateError;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const MIN_PASSWORD_LEN: usize = 8;
const MAX_ROLE_NAME_LEN: usize = 64;

fn admin_only(user: &CurrentUser) -> Result<(), AppError> {
    if user.is_admin() {
        Ok(())
    } else {
        Err(AppError::forbidden("access management is admin-only"))
    }
}

fn normalize_email(raw: &str) -> String {
    raw.trim().to_lowercase()
}

pub async fn users_list(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    Ok(Json(state.store.list_users()?))
}

#[derive(Deserialize)]
pub struct CreateUser {
    email: String,
    password: String,
    role: String,
}

pub async fn users_create(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Json(body): Json<CreateUser>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    admin_only(&user)?;
    let email = normalize_email(&body.email);
    if email.is_empty() {
        return Err(AppError::bad("email is required"));
    }
    if body.password.len() < MIN_PASSWORD_LEN {
        return Err(AppError::bad(format!(
            "password must be at least {MIN_PASSWORD_LEN} characters"
        )));
    }
    if !state.effective_role_names().contains(&body.role) {
        return Err(AppError::bad(format!("unknown role {}", body.role)));
    }
    let id = match state.store.create_user(&email, &body.password, &body.role) {
        Ok(id) => id,
        Err(UserCreateError::Duplicate) => {
            return Err(AppError(StatusCode::CONFLICT, "email already exists".into()))
        }
        Err(UserCreateError::Other(e)) => return Err(AppError::internal(e)),
    };
    state.store.audit(
        &user.email,
        "users",
        Some(&id.to_string()),
        "user:create",
        Some(&json!({ "email": email, "role": body.role })),
    );
    Ok((StatusCode::CREATED, Json(json!({ "id": id, "email": email, "role": body.role }))))
}

#[derive(Deserialize)]
pub struct UpdateUser {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

pub async fn users_update(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(body): Json<UpdateUser>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    let (email, current_role) = state
        .store
        .user_by_id(id)
        .ok_or_else(|| AppError::not_found("user not found"))?;

    let mut changes = serde_json::Map::new();

    if let Some(new_role) = &body.role {
        if !state.effective_role_names().contains(new_role) {
            return Err(AppError::bad(format!("unknown role {new_role}")));
        }
        if new_role != &current_role {
            match state.store.guarded_admin_mutation(id, Some(new_role))? {
                crate::store::AdminGuard::LastAdmin => {
                    return Err(AppError::bad(
                        "cannot remove the last admin — promote another user to admin first",
                    ))
                }
                crate::store::AdminGuard::NotFound => {
                    return Err(AppError::not_found("user not found"))
                }
                crate::store::AdminGuard::Done => {}
            }
            changes.insert(
                "role".into(),
                json!({ "from": current_role, "to": new_role }),
            );
        }
    }

    if let Some(pw) = &body.password {
        if pw.len() < MIN_PASSWORD_LEN {
            return Err(AppError::bad(format!(
                "password must be at least {MIN_PASSWORD_LEN} characters"
            )));
        }
        state.store.update_user_password(id, pw).map_err(AppError::internal)?;
        changes.insert("password".into(), json!("reset"));
    }

    if !changes.is_empty() {
        state.store.audit(
            &user.email,
            "users",
            Some(&id.to_string()),
            "user:update",
            Some(&Value::Object(changes)),
        );
    }

    let role = body.role.unwrap_or(current_role);
    Ok(Json(json!({ "id": id, "email": email, "role": role })))
}

pub async fn users_delete(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    let (email, role) = state
        .store
        .user_by_id(id)
        .ok_or_else(|| AppError::not_found("user not found"))?;
    match state.store.guarded_admin_mutation(id, None)? {
        crate::store::AdminGuard::LastAdmin => {
            return Err(AppError::bad(
                "cannot delete the last admin — promote another user to admin first",
            ))
        }
        crate::store::AdminGuard::NotFound => return Err(AppError::not_found("user not found")),
        crate::store::AdminGuard::Done => {}
    }
    state.store.audit(
        &user.email,
        "users",
        Some(&id.to_string()),
        "user:delete",
        Some(&json!({ "email": email, "role": role })),
    );
    Ok(Json(json!({})))
}

/// The full set of `table.action` names configured across all tables — the
/// vocabulary a role's `actions` list must draw from.
fn all_action_names(state: &AppState) -> Vec<String> {
    let mut out = Vec::new();
    for (table, tc) in &state.cfg().tables {
        for name in tc.actions.keys() {
            out.push(format!("{table}.{name}"));
        }
    }
    out.sort();
    out
}

fn table_configured(state: &AppState, table: &str) -> bool {
    state.resolve_table(table).is_some() && state.cfg().tables.contains_key(table)
}

/// Validate a role definition against the live schema + configured actions.
/// Fails closed: any reference to an unknown OR unconfigured table / level /
/// action is rejected. Unconfigured tables are not part of the admin, so a
/// role's raw `row_filter` SQL cannot be used as an oracle into them.
pub(crate) fn validate_definition(state: &AppState, def: &RoleConfig) -> Result<(), AppError> {
    for (table, level) in &def.tables {
        if table != "*" && !table_configured(state, table) {
            return Err(AppError::bad(format!("unknown table in tables: {table}")));
        }
        if level != "read" && level != "write" {
            return Err(AppError::bad(format!(
                "invalid level '{level}' for table {table} (expected read|write)"
            )));
        }
    }
    let valid_actions = all_action_names(state);
    for action in &def.actions {
        if !valid_actions.contains(action) {
            return Err(AppError::bad(format!("unknown action: {action}")));
        }
    }
    for table in def.perms.keys() {
        if !table_configured(state, table) {
            return Err(AppError::bad(format!("unknown table in perms: {table}")));
        }
    }
    for (table, cols) in &def.editable {
        if !table_configured(state, table) {
            return Err(AppError::bad(format!("unknown table in editable: {table}")));
        }
        let Some(dbt) = state.resolve_table(table) else { continue };
        for col in cols {
            if dbt.column(col).is_none() {
                return Err(AppError::bad(format!(
                    "unknown column '{col}' in editable for table {table}"
                )));
            }
        }
    }
    for table in def.masked.keys() {
        if !table_configured(state, table) {
            return Err(AppError::bad(format!("unknown table in masked: {table}")));
        }
    }
    for table in def.row_filter.keys() {
        if !table_configured(state, table) {
            return Err(AppError::bad(format!("unknown table in row_filter: {table}")));
        }
    }
    Ok(())
}

pub async fn roles_list(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    let counts = state.store.role_user_counts();
    let mut roles: Vec<Value> = Vec::new();

    roles.push(json!({
        "name": "admin",
        "source": "builtin",
        "editable": false,
        "definition": Value::Null,
        "user_count": counts.get("admin").copied().unwrap_or(0),
    }));

    for (name, cfg) in &state.cfg().auth.roles {
        roles.push(json!({
            "name": name,
            "source": "config",
            "editable": true,
            "definition": serde_json::to_value(cfg).unwrap_or(Value::Null),
            "user_count": counts.get(name).copied().unwrap_or(0),
        }));
    }

    let mut tables: Vec<String> = state
        .cfg()
        .tables
        .keys()
        .filter(|t| state.resolve_table(t).is_some())
        .cloned()
        .collect();
    tables.sort();
    Ok(Json(json!({
        "roles": roles,
        "tables": tables,
        "actions": all_action_names(&state),
    })))
}

/// Apply `mutate` to a clone of the live `auth` config, serialize it to HCL, and
/// atomically write + hot-reload `config/auth.hcl` (validate-before-swap, revert on
/// failure), then snapshot a version under the `config/auth` key. Admin-gated. When
/// no writable config dir is present it returns the same `{ ok:false, writable:false,
/// hcl }` shape `put_config` uses, changing nothing.
fn write_auth(
    state: &AppState,
    user: &CurrentUser,
    mutate: impl FnOnce(&mut crate::config::AuthConfig) -> Result<(), AppError>,
) -> Result<(bool, Value), AppError> {
    admin_only(user)?;
    let _guard = state.config_write_lock.lock().unwrap();
    let mut new_auth = (*state.cfg()).auth.clone();
    mutate(&mut new_auth)?;
    let hcl = hcl::to_string(&new_auth)
        .map_err(|e| AppError::internal(format!("serialize auth config: {e}")))?;
    crate::config::reject_duplicate_labels(&hcl).map_err(AppError::bad)?;

    let writable = state.config_dir.as_deref().map(crate::configedit::dir_writable).unwrap_or(false);
    let Some(dir) = state.config_dir.clone().filter(|_| writable) else {
        return Ok((false, json!({ "ok": false, "writable": false, "hcl": hcl })));
    };
    let _ = std::fs::create_dir_all(dir.join("config"));
    let path = dir.join("config").join("auth.hcl");
    crate::configedit::commit_and_reload(state, &path, &dir, &hcl)?;
    state.store.config_version_add("config/auth", &hcl, &user.email, None)?;
    Ok((true, json!({ "ok": true, "reloaded": true })))
}

#[derive(Deserialize)]
pub struct CreateRole {
    name: String,
    definition: RoleConfig,
}

fn valid_role_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_ROLE_NAME_LEN
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub async fn roles_create(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Json(body): Json<CreateRole>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    admin_only(&user)?;
    let name = body.name.trim().to_string();
    if !valid_role_name(&name) {
        return Err(AppError::bad(
            "role name must be 1-64 chars of letters, digits, _ or -",
        ));
    }
    if name == "admin" || state.cfg().auth.roles.contains_key(&name) {
        return Err(AppError(StatusCode::CONFLICT, format!("role '{name}' already exists")));
    }
    validate_definition(&state, &body.definition)?;
    let def = body.definition;
    let (ok, out) = write_auth(&state, &user, |auth| {
        auth.roles.insert(name.clone(), def.clone());
        Ok(())
    })?;
    if !ok {
        return Ok((StatusCode::OK, Json(out)));
    }
    state.store.audit(
        &user.email,
        "roles",
        Some(&name),
        "role:create",
        Some(&serde_json::to_value(&def).unwrap_or(Value::Null)),
    );
    Ok((StatusCode::CREATED, Json(out)))
}

#[derive(Deserialize)]
pub struct UpdateRole {
    definition: RoleConfig,
}

pub async fn roles_update(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(name): Path<String>,
    Json(body): Json<UpdateRole>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    if name == "admin" {
        return Err(AppError::forbidden("the built-in admin role cannot be edited"));
    }
    if !state.cfg().auth.roles.contains_key(&name) {
        return Err(AppError::not_found(format!("role '{name}' not found")));
    }
    validate_definition(&state, &body.definition)?;
    let def = body.definition;
    let (ok, out) = write_auth(&state, &user, |auth| {
        auth.roles.insert(name.clone(), def.clone());
        Ok(())
    })?;
    if !ok {
        return Ok(Json(out));
    }
    state.store.audit(
        &user.email,
        "roles",
        Some(&name),
        "role:update",
        Some(&serde_json::to_value(&def).unwrap_or(Value::Null)),
    );
    Ok(Json(out))
}

pub async fn roles_delete(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(name): Path<String>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    if name == "admin" {
        return Err(AppError::forbidden("the built-in admin role cannot be deleted"));
    }
    if !state.cfg().auth.roles.contains_key(&name) {
        return Err(AppError::not_found(format!("role '{name}' not found")));
    }
    let count = state.store.role_user_counts().get(&name).copied().unwrap_or(0);
    if count > 0 {
        return Err(AppError(
            StatusCode::CONFLICT,
            format!("role '{name}' is assigned to {count} user(s) — reassign them first"),
        ));
    }
    let (ok, out) = write_auth(&state, &user, |auth| {
        auth.roles.remove(&name);
        Ok(())
    })?;
    if !ok {
        return Ok(Json(out));
    }
    state.store.audit(&user.email, "roles", Some(&name), "role:delete", None);
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ActionConfig, ActionKind, ConfigDir, TableConfig};
    use crate::introspect::{DbColumn, DbTable, Kind, Schema};
    use crate::store::Store;

    fn text_col(name: &str) -> DbColumn {
        DbColumn {
            name: name.into(),
            udt: "text".into(),
            elem_udt: None,
            kind: Kind::Text,
            nullable: true,
            has_default: false,
            fk: None,
        }
    }

    fn test_schema() -> Schema {
        let mut schema = Schema::default();
        schema.tables.insert(
            "bots".into(),
            DbTable {
                name: "bots".into(),
                schema: "public".into(),
                source: String::new(),
                is_view: false,
                pk: Some("id".into()),
                columns: vec![
                    DbColumn {
                        name: "id".into(),
                        udt: "int8".into(),
                        elem_udt: None,
                        kind: Kind::Int,
                        nullable: false,
                        has_default: true,
                        fk: None,
                    },
                    text_col("owner_email"),
                    text_col("secret"),
                    text_col("mode"),
                    text_col("status"),
                ],
            },
        );
        schema.tables.insert(
            "locked".into(),
            DbTable {
                name: "locked".into(),
                schema: "public".into(),
                source: String::new(),
                is_view: false,
                pk: Some("id".into()),
                columns: vec![
                    DbColumn {
                        name: "id".into(),
                        udt: "int8".into(),
                        elem_udt: None,
                        kind: Kind::Int,
                        nullable: false,
                        has_default: true,
                        fk: None,
                    },
                    text_col("note"),
                ],
            },
        );
        schema
    }

    fn test_cfg() -> ConfigDir {
        let mut cfg = ConfigDir::default();
        let mut bots_cfg = TableConfig::default();
        bots_cfg.actions.insert(
            "halt".into(),
            ActionConfig {
                label: "Halt".into(),
                kind: ActionKind::Update,
                set: serde_json::Map::new(),
                url: None,
                method: None,
                confirm: None,
                danger: false,
            },
        );
        cfg.tables.insert("bots".into(), bots_cfg);
        let mut locked_cfg = TableConfig::default();
        locked_cfg.permissions.create = false;
        cfg.tables.insert("locked".into(), locked_cfg);
        cfg
    }

    fn state_from(cfg: ConfigDir, config_dir: Option<std::path::PathBuf>) -> Arc<AppState> {
        let pg = sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://x").unwrap();
        Arc::new(AppState {
            pools: Default::default(),
            dbs: Default::default(),
            pg,
            schema: "public".into(),
            db: test_schema(),
            cfg: arc_swap::ArcSwap::from_pointee(cfg),
            config_dir,
            store: Store::open_memory(),
            base_path: String::new(),
            brand: "t".into(),
            http: reqwest::Client::new(),
            secure_cookies: false,
            secret_key: [7u8; 32],
            webhook_secret: None,
            options_cache: Default::default(),
            login_limiter: Default::default(),
            config_write_lock: Default::default(),
        })
    }

    fn test_state() -> Arc<AppState> {
        state_from(test_cfg(), None)
    }

    fn admin() -> CurrentUser {
        CurrentUser { email: "a@x.io".into(), role: "admin".into() }
    }

    /// A state whose config lives in a fresh writable temp dir (with an empty
    /// `config/`), so the roles handlers can actually write `config/auth.hcl` and the
    /// live config hot-reloads from disk. `db` still carries the `bots`/`locked`
    /// tables the role validator checks against.
    fn writable_state() -> (Arc<AppState>, std::path::PathBuf) {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("steward-roles-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::write(dir.join("bots.hcl"), "").unwrap();
        let cfg = crate::config::load(Some(&dir)).unwrap();
        (state_from(cfg, Some(dir.clone())), dir)
    }

    /// Insert a role into a clone of the live `auth.roles` and hot-swap it in —
    /// the config path is now the only role-resolution source.
    fn make_config_role(state: &AppState, name: &str, def: &RoleConfig) -> CurrentUser {
        let mut cfg = (*state.cfg()).clone();
        cfg.auth.roles.insert(name.into(), def.clone());
        state.cfg.store(Arc::new(cfg));
        CurrentUser { email: "u@x.io".into(), role: name.into() }
    }

    #[tokio::test]
    async fn last_admin_cannot_be_demoted_or_deleted() {
        let state = test_state();
        let id = state.store.create_user("admin@x.io", "password1", "admin").unwrap();
        assert_eq!(state.store.count_admins().unwrap(), 1);

        let demote =
            state.store.user_by_id(id).map(|(_, r)| r == "admin" && state.store.count_admins().unwrap() <= 1);
        assert_eq!(demote, Some(true));
    }

    #[tokio::test]
    async fn create_user_rejects_duplicate() {
        let state = test_state();
        state.store.create_user("a@x.io", "password1", "admin").unwrap();
        let dup = state.store.create_user("a@x.io", "password2", "admin");
        assert!(matches!(dup, Err(UserCreateError::Duplicate)));
    }

    #[tokio::test]
    async fn role_validation_rejects_unknown_refs() {
        let state = test_state();
        let mut def = RoleConfig::default();
        def.tables.insert("nope".into(), "read".into());
        assert!(validate_definition(&state, &def).is_err());

        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "sideways".into());
        assert!(validate_definition(&state, &def).is_err());

        let mut def = RoleConfig::default();
        def.actions.push("bots.nonexistent".into());
        assert!(validate_definition(&state, &def).is_err());

        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "read".into());
        def.actions.push("bots.halt".into());
        def.masked.insert("bots".into(), vec!["secret".into()]);
        def.row_filter.insert("bots".into(), "owner_email = {actor.email}".into());
        assert!(validate_definition(&state, &def).is_ok());
    }

    #[tokio::test]
    async fn config_role_grants_and_filters_through_resolution() {
        let state = test_state();
        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "read".into());
        def.masked.insert("bots".into(), vec!["secret".into()]);
        def.row_filter.insert("bots".into(), "owner_email = {actor.email}".into());
        let _ = make_config_role(&state, "support", &def);

        let u = CurrentUser { email: "admin@example.com".into(), role: "support".into() };
        assert_eq!(state.role_level(&u, "bots"), crate::state::Level::Read);
        assert_eq!(state.role_level(&u, "instruments"), crate::state::Level::None);
        assert!(state.masked_columns(&u, "bots").contains(&"secret".to_string()));
        assert_eq!(
            state.row_filter(&u, "bots"),
            Some("owner_email = 'admin@example.com'".to_string())
        );

        let unknown = CurrentUser { email: "x@x.io".into(), role: "ghost".into() };
        assert_eq!(state.role_level(&unknown, "bots"), crate::state::Level::None);
    }

    #[tokio::test]
    async fn config_role_actions_resolve() {
        let state = test_state();
        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "write".into());
        def.actions.push("bots.halt".into());
        let u = make_config_role(&state, "ops", &def);
        assert!(state.allowed_actions(&u, "bots").contains(&"halt".to_string()));
    }

    #[tokio::test]
    async fn role_user_counts_reflects_assignment() {
        let state = test_state();
        let _ = make_config_role(&state, "ops", &RoleConfig::default());
        state.store.create_user("o@x.io", "password1", "ops").unwrap();
        assert_eq!(state.store.role_user_counts().get("ops").copied(), Some(1));
    }

    #[tokio::test]
    async fn effective_role_names_includes_config_roles() {
        let state = test_state();
        let _ = make_config_role(&state, "ops", &RoleConfig::default());
        let names = state.effective_role_names();
        assert!(names.contains(&"admin".to_string()));
        assert!(names.contains(&"ops".to_string()));
    }

    use crate::config::TablePerm;

    #[tokio::test]
    async fn coarse_only_perms_are_backcompat() {
        let state = test_state();
        let mut w = RoleConfig::default();
        w.tables.insert("bots".into(), "write".into());
        let writer = make_config_role(&state, "writer", &w);
        let p = state.table_perms(&writer, "bots");
        assert!(p.view && p.create && p.update && p.delete);

        let mut r = RoleConfig::default();
        r.tables.insert("bots".into(), "read".into());
        let reader = make_config_role(&state, "reader", &r);
        let p = state.table_perms(&reader, "bots");
        assert!(p.view);
        assert!(!p.create && !p.update && !p.delete);
    }

    #[tokio::test]
    async fn perms_entry_restricts_to_view_and_update() {
        let state = test_state();
        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "write".into());
        def.perms.insert(
            "bots".into(),
            TablePerm { view: Some(true), create: Some(false), update: Some(true), delete: Some(false) },
        );
        let u = make_config_role(&state, "support", &def);
        let p = state.table_perms(&u, "bots");
        assert!(p.view && p.update);
        assert!(!p.create && !p.delete);
    }

    #[tokio::test]
    async fn perms_cannot_exceed_config_ceiling() {
        let state = test_state();
        let mut def = RoleConfig::default();
        def.tables.insert("locked".into(), "write".into());
        // Ask for create even though the table config forbids it.
        def.perms.insert(
            "locked".into(),
            TablePerm { view: None, create: Some(true), update: None, delete: None },
        );
        let u = make_config_role(&state, "clamp", &def);
        let p = state.table_perms(&u, "locked");
        assert!(p.view && p.update && p.delete);
        assert!(!p.create, "config create=false must clamp perms create=true");
    }

    #[tokio::test]
    async fn phase4_meta_emits_presentation_and_effective_inline_perms() {
        use crate::config::{ColorSpec, FieldConfig, InlineSpec};

        let mut cfg = test_cfg();
        let mut bots_cfg = cfg.tables.remove("bots").unwrap();
        bots_cfg.fields.insert(
            "mode".into(),
            FieldConfig {
                format: Some("percent".into()),
                prefix: Some(">".into()),
                color: Some(ColorSpec::Named("sign".into())),
                ..Default::default()
            },
        );
        bots_cfg.relations.inlines = vec![
            InlineSpec::Full {
                table: "bots".into(),
                fk_col: Some("owner_email".into()),
                label: None,
                columns: vec!["mode".into(), "status".into()],
                can_create: None,
                can_delete: None,
            },
            InlineSpec::Full {
                table: "locked".into(),
                fk_col: Some("note".into()),
                label: None,
                columns: vec![],
                can_create: None,
                can_delete: Some(true),
            },
        ];
        cfg.tables.insert("bots".into(), bots_cfg);
        let state = state_from(cfg, None);

        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "write".into());
        def.tables.insert("locked".into(), "write".into());
        let u = make_config_role(&state, "writer2", &def);

        let meta = crate::meta::table_meta(&state, &u, "bots").await.unwrap();

        let mode = meta["columns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "mode")
            .unwrap();
        assert_eq!(mode["format"], "percent");
        assert_eq!(mode["prefix"], ">");
        assert_eq!(mode["color"], serde_json::json!({ "strategy": "sign" }));

        let inlines = meta["inlines"].as_array().unwrap();
        let self_inline = inlines.iter().find(|i| i["table"] == "bots").unwrap();
        assert_eq!(self_inline["columns"], serde_json::json!(["mode", "status"]));
        assert_eq!(self_inline["can_create"], true, "bots has no create ceiling");
        assert_eq!(self_inline["can_delete"], true);

        let locked_inline = inlines.iter().find(|i| i["table"] == "locked").unwrap();
        assert_eq!(
            locked_inline["can_create"], false,
            "locked config ceiling create=false ANDs to false",
        );
        assert_eq!(
            locked_inline["can_delete"], true,
            "inline can_delete=true AND locked delete(true) = true",
        );
    }

    #[tokio::test]
    async fn phase4_meta_inline_can_create_false_when_role_lacks_child_create() {
        use crate::config::{InlineSpec, TableConfig};

        let mut cfg = test_cfg();
        let mut child = TableConfig::default();
        child.label = Some("Child".into());
        cfg.tables.insert("locked".into(), child);
        let mut bots_cfg = cfg.tables.remove("bots").unwrap();
        bots_cfg.relations.inlines = vec![InlineSpec::Full {
            table: "locked".into(),
            fk_col: Some("note".into()),
            label: None,
            columns: vec![],
            can_create: None,
            can_delete: None,
        }];
        cfg.tables.insert("bots".into(), bots_cfg);
        let state = state_from(cfg, None);

        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "write".into());
        def.tables.insert("locked".into(), "read".into());
        let u = make_config_role(&state, "reader2", &def);

        let meta = crate::meta::table_meta(&state, &u, "bots").await.unwrap();
        let inline = meta["inlines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["table"] == "locked")
            .unwrap();
        assert_eq!(
            inline["can_create"], false,
            "role has only read on child → effective can_create is false",
        );
    }

    #[tokio::test]
    async fn perms_unset_capability_falls_back_to_coarse() {
        let state = test_state();
        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "write".into());
        // Only pin delete=false; the rest defer to coarse write.
        def.perms.insert(
            "bots".into(),
            TablePerm { view: None, create: None, update: None, delete: Some(false) },
        );
        let u = make_config_role(&state, "nodelete", &def);
        let p = state.table_perms(&u, "bots");
        assert!(p.view && p.create && p.update);
        assert!(!p.delete);
    }

    #[tokio::test]
    async fn editable_whitelist_gates_editable_set() {
        let state = test_state();
        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "write".into());
        def.editable.insert("bots".into(), vec!["mode".into(), "status".into()]);
        let u = make_config_role(&state, "editrole", &def);

        assert_eq!(
            state.editable_columns(&u, "bots"),
            Some(vec!["mode".to_string(), "status".to_string()])
        );

        let dbt = state.db.tables.get("bots").unwrap();
        let ok = json!({ "set": { "mode": "paper" } });
        assert!(crate::rows::editable_set(&state, &u, "bots", dbt, &ok, false).is_ok());

        let denied = json!({ "set": { "owner_email": "x@x.io" } });
        assert!(crate::rows::editable_set(&state, &u, "bots", dbt, &denied, false).is_err());

        // A listed column mixed with an unlisted one still fails closed.
        let mixed = json!({ "set": { "mode": "live", "owner_email": "x@x.io" } });
        assert!(crate::rows::editable_set(&state, &u, "bots", dbt, &mixed, false).is_err());
    }

    #[tokio::test]
    async fn admin_bypasses_granular_perms_and_editable() {
        let state = test_state();
        let admin = CurrentUser { email: "a@x.io".into(), role: "admin".into() };
        let p = state.table_perms(&admin, "bots");
        assert!(p.view && p.create && p.update && p.delete);
        // Even on the create-capped table, admin still can't exceed the config ceiling.
        let pl = state.table_perms(&admin, "locked");
        assert!(pl.view && pl.update && pl.delete && !pl.create);
        assert_eq!(state.editable_columns(&admin, "bots"), None);
    }

    #[tokio::test]
    async fn validation_rejects_bad_perms_and_editable() {
        let state = test_state();

        let mut def = RoleConfig::default();
        def.perms.insert(
            "nope".into(),
            TablePerm { view: Some(true), ..Default::default() },
        );
        assert!(validate_definition(&state, &def).is_err());

        let mut def = RoleConfig::default();
        def.editable.insert("bots".into(), vec!["ghost_col".into()]);
        assert!(validate_definition(&state, &def).is_err());

        let mut def = RoleConfig::default();
        def.editable.insert("missing".into(), vec!["x".into()]);
        assert!(validate_definition(&state, &def).is_err());

        // A well-formed granular definition validates.
        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "write".into());
        def.perms.insert(
            "bots".into(),
            TablePerm { view: Some(true), create: Some(false), update: Some(true), delete: Some(false) },
        );
        def.editable.insert("bots".into(), vec!["mode".into(), "status".into()]);
        assert!(validate_definition(&state, &def).is_ok());
    }

    #[tokio::test]
    async fn validation_rejects_unconfigured_table_in_editable() {
        let state = test_state();
        // Drop bots' config: it's still introspected but no longer part of the
        // admin, so a role may not reference it.
        let mut cfg = (*state.cfg()).clone();
        cfg.tables.remove("bots");
        state.cfg.store(Arc::new(cfg));

        let mut def = RoleConfig::default();
        def.editable.insert("bots".into(), vec!["mode".into()]);
        assert!(validate_definition(&state, &def).is_err());

        let mut def = RoleConfig::default();
        def.perms.insert("bots".into(), TablePerm { view: Some(true), ..Default::default() });
        assert!(validate_definition(&state, &def).is_err());
    }

    #[tokio::test]
    async fn unconfigured_table_is_absent_and_404s() {
        let state = test_state();
        // `locked` is introspected AND configured — visible + resolvable.
        assert!(state.visible_tables(&admin()).contains(&"locked".to_string()));
        assert!(state.readable_table(&admin(), "locked").is_ok());

        // Drop `locked`'s config: still introspected, but no longer part of the admin.
        let mut cfg = (*state.cfg()).clone();
        cfg.tables.remove("locked");
        state.cfg.store(Arc::new(cfg));

        assert!(!state.visible_tables(&admin()).contains(&"locked".to_string()));
        let err = state.readable_table(&admin(), "locked").unwrap_err();
        assert_eq!(err.0, StatusCode::NOT_FOUND, "direct URL to an unconfigured table 404s");
    }

    #[tokio::test]
    async fn config_role_granular_perms_round_trip_and_resolve() {
        let state = test_state();
        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "write".into());
        def.perms.insert(
            "bots".into(),
            TablePerm { view: Some(true), create: Some(false), update: Some(true), delete: Some(false) },
        );
        def.editable.insert("bots".into(), vec!["mode".into()]);
        let u = make_config_role(&state, "granular", &def);

        let p = state.table_perms(&u, "bots");
        assert!(p.view && p.update && !p.create && !p.delete);
        assert_eq!(state.editable_columns(&u, "bots"), Some(vec!["mode".to_string()]));

        let stored = state.resolve_role("granular").unwrap();
        assert!(stored.perms.get("bots").unwrap().update == Some(true));
        assert_eq!(stored.editable.get("bots").unwrap(), &vec!["mode".to_string()]);
    }

    fn read_role_def(state: &AppState, name: &str) -> RoleConfig {
        state.cfg().auth.roles.get(name).cloned().expect("role present")
    }

    #[tokio::test]
    async fn create_role_writes_auth_hcl_and_reloads() {
        let (state, dir) = writable_state();
        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "read".into());
        def.masked.insert("bots".into(), vec!["secret".into()]);

        let (code, body) = roles_create(
            State(state.clone()),
            admin(),
            Json(CreateRole { name: "support".into(), definition: def }),
        )
        .await
        .unwrap();
        assert_eq!(code, StatusCode::CREATED);
        assert_eq!(body.0["ok"], json!(true));

        let on_disk = std::fs::read_to_string(dir.join("config").join("auth.hcl")).unwrap();
        assert!(on_disk.contains("role \"support\""), "written to config/auth.hcl:\n{on_disk}");
        assert!(state.cfg().auth.roles.contains_key("support"), "live config picked it up");
        assert_eq!(
            state.store.config_versions_list("config/auth").unwrap()["versions"].as_array().unwrap().len(),
            1,
            "a version was snapshotted under config/auth",
        );
    }

    #[tokio::test]
    async fn update_role_persists_full_definition() {
        let (state, _dir) = writable_state();
        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "read".into());
        let _ = roles_create(
            State(state.clone()),
            admin(),
            Json(CreateRole { name: "support".into(), definition: def }),
        )
        .await
        .unwrap();

        // Round-trip a granular perms block + editable whitelist through update.
        let mut def2 = RoleConfig::default();
        def2.tables.insert("bots".into(), "write".into());
        def2.perms.insert(
            "bots".into(),
            TablePerm { view: Some(true), create: Some(false), update: Some(true), delete: Some(false) },
        );
        def2.editable.insert("bots".into(), vec!["mode".into()]);
        let out = roles_update(
            State(state.clone()),
            admin(),
            Path("support".into()),
            Json(UpdateRole { definition: def2 }),
        )
        .await
        .unwrap();
        assert_eq!(out.0["ok"], json!(true));

        let stored = read_role_def(&state, "support");
        assert_eq!(stored.tables.get("bots").map(String::as_str), Some("write"));
        assert_eq!(stored.perms.get("bots").unwrap().update, Some(true));
        assert_eq!(stored.editable.get("bots").unwrap(), &vec!["mode".to_string()]);
    }

    #[tokio::test]
    async fn delete_role_removes_it_from_config() {
        let (state, dir) = writable_state();
        let _ = roles_create(
            State(state.clone()),
            admin(),
            Json(CreateRole { name: "support".into(), definition: RoleConfig::default() }),
        )
        .await
        .unwrap();
        assert!(state.cfg().auth.roles.contains_key("support"));

        let out = roles_delete(State(state.clone()), admin(), Path("support".into())).await.unwrap();
        assert_eq!(out.0["ok"], json!(true));
        assert!(!state.cfg().auth.roles.contains_key("support"), "removed from live config");
        let on_disk = std::fs::read_to_string(dir.join("config").join("auth.hcl")).unwrap();
        assert!(!on_disk.contains("role \"support\""), "removed from disk:\n{on_disk}");
    }

    #[tokio::test]
    async fn delete_blocked_when_users_reference_role() {
        let (state, _dir) = writable_state();
        let _ = roles_create(
            State(state.clone()),
            admin(),
            Json(CreateRole { name: "support".into(), definition: RoleConfig::default() }),
        )
        .await
        .unwrap();
        state.store.create_user("s@x.io", "password1", "support").unwrap();

        let r = roles_delete(State(state.clone()), admin(), Path("support".into())).await;
        assert!(matches!(r, Err(AppError(StatusCode::CONFLICT, _))));
        assert!(state.cfg().auth.roles.contains_key("support"), "role kept while assigned");
    }

    #[tokio::test]
    async fn admin_role_cannot_be_edited_or_deleted() {
        let (state, _dir) = writable_state();
        let u = roles_update(
            State(state.clone()),
            admin(),
            Path("admin".into()),
            Json(UpdateRole { definition: RoleConfig::default() }),
        )
        .await;
        assert!(matches!(u, Err(AppError(StatusCode::FORBIDDEN, _))));
        let d = roles_delete(State(state.clone()), admin(), Path("admin".into())).await;
        assert!(matches!(d, Err(AppError(StatusCode::FORBIDDEN, _))));
    }

    #[tokio::test]
    async fn broken_reload_reverts_auth_and_never_goes_live() {
        let (state, dir) = writable_state();
        std::fs::write(dir.join("config").join("auth.hcl"), "role \"seed\" {\n}\n").unwrap();
        state.reload_config().unwrap();
        assert!(state.cfg().auth.roles.contains_key("seed"));
        let before = std::fs::read_to_string(dir.join("config").join("auth.hcl")).unwrap();

        // Any subsequent reload now fails on this un-parseable table file.
        std::fs::write(dir.join("broken.hcl"), "@@@ not hcl =\n").unwrap();

        let mut def = RoleConfig::default();
        def.tables.insert("bots".into(), "read".into());
        let r = roles_create(
            State(state.clone()),
            admin(),
            Json(CreateRole { name: "support".into(), definition: def }),
        )
        .await;
        assert!(matches!(r, Err(AppError(StatusCode::BAD_REQUEST, _))));
        assert_eq!(
            std::fs::read_to_string(dir.join("config").join("auth.hcl")).unwrap(),
            before,
            "auth.hcl reverted byte-for-byte",
        );
        assert!(!state.cfg().auth.roles.contains_key("support"), "failed write never went live");
        assert!(state.cfg().auth.roles.contains_key("seed"), "prior role still live");
    }

    #[tokio::test]
    async fn role_write_reports_not_writable_without_config_dir() {
        let state = test_state();
        let out = roles_create(
            State(state.clone()),
            admin(),
            Json(CreateRole { name: "support".into(), definition: RoleConfig::default() }),
        )
        .await
        .unwrap();
        assert_eq!(out.1 .0["ok"], json!(false));
        assert_eq!(out.1 .0["writable"], json!(false));
        assert!(out.1 .0["hcl"].as_str().is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn role_write_to_readonly_dir_does_not_audit_or_201() {
        use std::os::unix::fs::PermissionsExt;
        let (state, dir) = writable_state();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let before =
            state.store.audit_list(Some("roles"), 1, 10).unwrap()["total"].as_i64().unwrap();

        let (code, body) = roles_create(
            State(state.clone()),
            admin(),
            Json(CreateRole { name: "support".into(), definition: RoleConfig::default() }),
        )
        .await
        .unwrap();

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(body.0["ok"], json!(false));
        assert_eq!(body.0["writable"], json!(false));
        assert_ne!(code, StatusCode::CREATED, "read-only write must not 201");
        let after =
            state.store.audit_list(Some("roles"), 1, 10).unwrap()["total"].as_i64().unwrap();
        assert_eq!(before, after, "no audit row for a write that never applied");
        assert!(!state.cfg().auth.roles.contains_key("support"), "role never went live");
    }
}
