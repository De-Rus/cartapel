use crate::config::TableConfig;
use crate::state::{AppError, AppState, CurrentUser};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

pub(crate) fn admin_only(user: &CurrentUser) -> Result<(), AppError> {
    if user.is_admin() {
        Ok(())
    } else {
        Err(AppError::forbidden("config editing is admin-only"))
    }
}

/// A table config lives at the folder path it was loaded from (tracked in
/// `table_sources`), or `{stem}.hcl` at the config root when it does not exist yet.
/// A `schema.table` key is a fine filename component; anything that could escape
/// the directory is rejected.
/// Reserved stems are never editable as a "table" even if the schema happens to
/// contain a table with one of these names: writing one would silently reinterpret
/// the reserved framework folder (`config`, home of the globals + shared assets), a
/// folder-group (`_group`), a custom page (`page`), or a named-query bag (`queries`)
/// on reload. `groups`, `dashboard`, `discover`, and `versions` are literal `/config`
/// route segments — a real table with one of those names would be shadowed by the
/// route rather than reaching `/config/:table`, so it is reserved out entirely.
pub(crate) const RESERVED_STEMS: [&str; 9] = [
    crate::config::RESERVED_DIR,
    "_group",
    "page",
    "queries",
    "groups",
    "dashboard",
    "discover",
    "versions",
    "screens",
];

pub(crate) fn safe_stem(table: &str) -> Result<&str, AppError> {
    if table.is_empty()
        || table.contains('/')
        || table.contains('\\')
        || table.contains("..")
        || table.contains('\0')
    {
        return Err(AppError::bad("unsafe table name"));
    }
    if RESERVED_STEMS.iter().any(|r| r.eq_ignore_ascii_case(table)) {
        return Err(AppError::bad("reserved config name"));
    }
    Ok(table)
}

/// Resolve the file a table config reads from / writes to: its tracked source path
/// (the folder it was loaded from) when it exists, else `{stem}.hcl` at the config
/// root. `safe_stem` still gates the name so a reserved/unsafe key never resolves.
fn config_path(state: &AppState, dir: &std::path::Path, table: &str) -> Result<PathBuf, AppError> {
    let stem = safe_stem(table)?;
    if let Some(src) = state.cfg().table_sources.get(table) {
        let contained = match (dir.canonicalize(), src.path.canonicalize()) {
            (Ok(base), Ok(real)) => real.starts_with(&base),
            _ => false,
        };
        if contained {
            return Ok(src.path.clone());
        }
    }
    Ok(dir.join(format!("{stem}.hcl")))
}

/// Probe whether the config dir can be written to right now — not just its mode
/// bits, but an actual create+remove, so a baked read-only image reads as false.
pub(crate) fn dir_writable(dir: &std::path::Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".steward-write-probe-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Serialize a `TableConfig` to the pretty labeled-block HCL form. Used as the
/// starting template when no `{table}.hcl` file exists yet, and for the visual
/// (`model`) edit path.
pub fn generate_hcl(tc: &TableConfig) -> String {
    hcl::to_string(tc)
        .unwrap_or_else(|_| "# no config file yet — start from this template\n".to_string())
}

pub async fn get_config(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(table): Path<String>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    if state.resolve_table(&table).is_none() {
        return Err(AppError::not_found(format!("unknown table {table}")));
    }
    let writable = state.config_dir.as_deref().map(dir_writable).unwrap_or(false);

    // The effective config drives the visual editor's `model`; the raw HCL text
    // (from disk when present, else generated) drives the raw editor.
    let effective = crate::meta::table_config(&state, &table);
    let hcl_text = match state.config_dir.as_deref() {
        Some(dir) => {
            let path = config_path(&state, dir, &table)?;
            match std::fs::read_to_string(&path) {
                Ok(raw) => raw,
                Err(_) => generate_hcl(&effective),
            }
        }
        None => generate_hcl(&effective),
    };
    let model = serde_json::to_value(&effective)
        .map_err(|e| AppError::internal(format!("serialize model: {e}")))?;

    Ok(Json(json!({
        "table": table,
        "hcl": hcl_text,
        "model": model,
        "writable": writable,
    })))
}

/// A config PUT carries EITHER a raw HCL document (`hcl`) from the raw editor, or
/// a structured `model` (JSON `TableConfig`) from the visual builder. Exactly one
/// must be present.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutConfig {
    #[serde(default)]
    hcl: Option<String>,
    #[serde(default)]
    model: Option<TableConfig>,
    /// Only honored when CREATING a config for a not-yet-configured table: lands
    /// the new `{stem}.hcl` inside the named group's folder (and appends the stem
    /// to that group's `table_order`) instead of the config root. Must name an
    /// existing group. Ignored for updates — a configured table always writes back
    /// to its tracked source file, its nav group changing only via the groups editor.
    #[serde(default)]
    group: Option<String>,
}

pub async fn put_config(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(table): Path<String>,
    Json(body): Json<PutConfig>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    if state.resolve_table(&table).is_none() {
        return Err(AppError::not_found(format!("unknown table {table}")));
    }
    let is_create = !state.cfg().tables.contains_key(&table);

    // Resolve the incoming payload to canonical HCL text. The visual `model` path
    // deserializes into a TableConfig (already validated by axum) and re-emits
    // pretty HCL. The raw `hcl` path trial-parses so a malformed document never
    // reaches disk or the live swap (`deny_unknown_fields` also catches typos).
    // The empty body is legal only for a group-targeted create, which lands the
    // introspection-derived starter template.
    let hcl_text = match (body.hcl, body.model) {
        (Some(_), Some(_)) => {
            return Err(AppError::bad("send exactly one of `hcl` or `model`, not both"))
        }
        (None, None) => {
            if is_create && body.group.is_some() {
                generate_hcl(&crate::meta::table_config(&state, &table))
            } else {
                return Err(AppError::bad("body must contain `hcl` or `model`"));
            }
        }
        (Some(raw), None) => {
            crate::config::reject_duplicate_labels(&raw).map_err(AppError::bad)?;
            hcl::from_str::<TableConfig>(&raw)
                .map_err(|e| AppError::bad(format!("invalid config: {e}")))?;
            raw
        }
        (None, Some(model)) => generate_hcl(&model),
    };

    let Some(dir) = state.config_dir.clone() else {
        return Ok(Json(json!({ "ok": false, "writable": false, "hcl": hcl_text })));
    };
    if !dir_writable(&dir) {
        return Ok(Json(json!({ "ok": false, "writable": false, "hcl": hcl_text })));
    }

    if let Some(group) = body.group.as_deref().filter(|_| is_create) {
        return create_in_group(&state, &user, &dir, &table, group, &hcl_text).await;
    }

    {
        let _guard = state.config_write_lock.lock().unwrap();
        write_and_reload(&state, &dir, &table, &hcl_text)?;
        state.store.config_version_add(&table, &hcl_text, &user.email, None)?;
    }

    state.store.audit(
        &user.email,
        "config",
        Some(&table),
        "config:update",
        Some(&json!({ "table": table })),
    );

    Ok(Json(json!({ "ok": true, "reloaded": true })))
}

/// Land a brand-new table config inside an existing group's folder, appending its
/// stem to the group's `table_order`, as one atomic batch. The table's DB identity
/// and `/t/:table` URL are the stem — placing the file in a folder only sets nav
/// placement, never renames the key.
async fn create_in_group(
    state: &AppState,
    user: &CurrentUser,
    dir: &FsPath,
    table: &str,
    group: &str,
    hcl_text: &str,
) -> Result<Json<Value>, AppError> {
    let stem = safe_stem(table)?;
    let cfg = state.cfg();
    let g = cfg
        .groups
        .iter()
        .find(|g| g.slug == group)
        .ok_or_else(|| AppError::bad(format!("unknown group '{group}'")))?;

    let group_dir = crate::groupsedit::group_dir(dir, &g.slug);
    let in_screens = group_dir.starts_with(dir.join("screens"));
    let table_path = if in_screens {
        group_dir.join(stem).join("screen.hcl")
    } else {
        group_dir.join(format!("{stem}.hcl"))
    };
    if table_path.exists() || (in_screens && group_dir.join(stem).exists()) {
        return Err(AppError(
            axum::http::StatusCode::CONFLICT,
            format!("'{stem}' already exists in group '{group}'"),
        ));
    }

    let mut group_cfg = crate::config::GroupConfig {
        label: g.label.clone(),
        icon: g.icon.clone(),
        order: g.order,
        table_order: g.table_order.clone(),
        nav: g.nav.clone(),
    };
    if !group_cfg.table_order.iter().any(|t| t == stem) {
        group_cfg.table_order.push(stem.to_string());
    }
    let group_hcl = hcl::to_string(&group_cfg)
        .map_err(|e| AppError::internal(format!("serialize group config: {e}")))?;
    let group_path = group_dir.join("_group.hcl");
    let group_key = format!("_group/{}", g.slug);
    drop(cfg);

    {
        let _guard = state.config_write_lock.lock().unwrap();
        let mut ops = Vec::new();
        if in_screens {
            ops.push(FsOp::Mkdir { path: group_dir.join(stem) });
        }
        ops.push(FsOp::Write { path: table_path, contents: hcl_text.to_string() });
        ops.push(FsOp::Write { path: group_path, contents: group_hcl.clone() });
        commit_batch_and_reload(state, dir, ops)?;
        state.store.config_version_add(table, hcl_text, &user.email, None)?;
        state.store.config_version_add(&group_key, &group_hcl, &user.email, None)?;
    }

    state.store.audit(
        &user.email,
        "config",
        Some(table),
        "config:create",
        Some(&json!({ "table": table, "group": group })),
    );

    Ok(Json(json!({ "ok": true, "reloaded": true })))
}

/// Introspected tables that have no config yet — the "add a table" candidates for
/// the config editor. `db.tables` minus everything already configured minus the
/// reserved framework stems.
const NOISE_TABLES: [&str; 8] = [
    "schema_migrations",
    "_prisma_migrations",
    "django_migrations",
    "flyway_schema_history",
    "alembic_version",
    "ar_internal_metadata",
    "knex_migrations",
    "knex_migrations_lock",
];

fn group_icon(slug: &str) -> &'static str {
    let s = slug.to_ascii_lowercase();
    for (kw, icon) in [
        ("user", "users"),
        ("customer", "users"),
        ("account", "users"),
        ("order", "shopping-bag"),
        ("sale", "shopping-bag"),
        ("cart", "shopping-bag"),
        ("product", "package"),
        ("catalog", "package"),
        ("item", "package"),
        ("billing", "credit-card"),
        ("subscription", "credit-card"),
        ("payment", "credit-card"),
        ("invoice", "credit-card"),
        ("log", "file-text"),
        ("audit", "file-text"),
        ("event", "file-text"),
        ("message", "mail"),
        ("mail", "mail"),
        ("job", "clock"),
        ("task", "clock"),
    ] {
        if s.contains(kw) {
            return icon;
        }
    }
    "layers"
}

pub async fn discover(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    let cfg = state.cfg();
    let unconfigured: Vec<(&String, &crate::introspect::DbTable)> = state
        .db
        .tables
        .iter()
        .filter(|(k, _)| !cfg.tables.contains_key(*k))
        .filter(|(k, _)| !RESERVED_STEMS.iter().any(|r| r.eq_ignore_ascii_case(k)))
        .collect();

    let schemas: std::collections::HashSet<&str> =
        unconfigured.iter().map(|(_, t)| t.schema.as_str()).collect();
    let multi_schema = schemas.len() > 1;
    let prefix_of = |name: &str| {
        name.split('_')
            .next()
            .filter(|p| p.len() > 2)
            .map(|p| p.trim_end_matches('s').to_string())
    };
    let mut prefix_counts: HashMap<String, usize> = HashMap::new();
    for (_, t) in &unconfigured {
        if let Some(p) = prefix_of(&t.name) {
            *prefix_counts.entry(p).or_default() += 1;
        }
    }

    let rows: HashMap<String, i64> = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT n.nspname, c.relname, c.reltuples::bigint FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','v','m')",
    )
    .fetch_all(&state.pg)
    .await
    .map(|rs| rs.into_iter().filter(|(_, _, r)| *r >= 0).map(|(s, n, r)| (format!("{s}.{n}"), r)).collect())
    .unwrap_or_default();

    let tables: Vec<Value> = unconfigured
        .iter()
        .map(|(key, t)| {
            let group = if multi_schema {
                t.schema.clone()
            } else {
                match prefix_of(&t.name) {
                    Some(p) if prefix_counts.get(&p).copied().unwrap_or(0) >= 2 => p,
                    _ => "tables".to_string(),
                }
            };
            json!({
                "name": key,
                "schema": t.schema,
                "is_view": t.is_view,
                "pk": t.pk,
                "column_count": t.columns.len(),
                "approx_rows": rows.get(&format!("{}.{}", t.schema, t.name)),
                "noise": NOISE_TABLES.iter().any(|n| t.name.eq_ignore_ascii_case(n)),
                "suggested_group": {
                    "slug": group,
                    "label": crate::meta::capitalize(&crate::meta::humanize(&group)),
                    "icon": group_icon(&group),
                },
            })
        })
        .collect();
    Ok(Json(json!({ "tables": tables })))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetupGroup {
    pub slug: String,
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub tables: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetupPlan {
    pub groups: Vec<SetupGroup>,
}

/// One-shot first-run setup: write every picked table (empty config = runtime
/// defaults) grouped into `_group.hcl` folders, as ONE atomic batch. Read-only
/// config dirs get the would-be files back instead of a write.
pub async fn apply_setup(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Json(plan): Json<SetupPlan>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    if plan.groups.iter().all(|g| g.tables.is_empty()) {
        return Err(AppError::bad("nothing selected"));
    }
    let cfg = state.cfg();
    let mut plan_slugs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for g in &plan.groups {
        if !plan_slugs.insert(g.slug.clone()) {
            return Err(AppError::bad(format!("duplicate group slug '{}'", g.slug)));
        }
        if cfg.groups.iter().any(|eg| eg.slug == g.slug) {
            return Err(AppError::conflict(format!("group '{}' already exists", g.slug)));
        }
    }
    let mut ops: Vec<FsOp> = Vec::new();
    let mut files: serde_json::Map<String, Value> = serde_json::Map::new();
    let mut versions: Vec<(String, String)> = Vec::new();
    let mut count = 0usize;
    let dir_opt = state.config_dir.clone();
    let writable = dir_opt.as_deref().map(dir_writable).unwrap_or(false);
    let base = dir_opt.clone().unwrap_or_default();

    for (i, g) in plan.groups.iter().enumerate() {
        let slug = safe_stem(&g.slug)?.to_string();
        if g.tables.is_empty() {
            continue;
        }
        for t in &g.tables {
            let stem = safe_stem(t)?;
            if cfg.tables.contains_key(stem) {
                return Err(AppError::conflict(format!("'{stem}' is already configured")));
            }
            if state.db.find(None, stem).is_none() {
                return Err(AppError::bad(format!("unknown table '{stem}'")));
            }
        }
        let group_cfg = crate::config::GroupConfig {
            label: g.label.clone(),
            icon: g.icon.clone(),
            order: (i + 1) as i64,
            table_order: g.tables.clone(),
            nav: None,
        };
        let group_hcl = hcl::to_string(&group_cfg)
            .map_err(|e| AppError::internal(format!("serialize group: {e}")))?;
        ops.push(FsOp::Mkdir { path: base.join(&slug) });
        ops.push(FsOp::Write { path: base.join(&slug).join("_group.hcl"), contents: group_hcl.clone() });
        files.insert(format!("{slug}/_group.hcl"), json!(group_hcl));
        versions.push((format!("_group/{slug}"), group_hcl));
        for t in &g.tables {
            let stem = safe_stem(t)?.to_string();
            ops.push(FsOp::Write { path: base.join(&slug).join(format!("{stem}.hcl")), contents: String::new() });
            files.insert(format!("{slug}/{stem}.hcl"), json!(""));
            versions.push((stem, String::new()));
            count += 1;
        }
    }
    drop(cfg);

    let Some(dir) = dir_opt.filter(|_| writable) else {
        return Ok(Json(json!({ "ok": false, "writable": false, "files": files })));
    };
    {
        let _guard = state.config_write_lock.lock().unwrap();
        commit_batch_and_reload(&state, &dir, ops)?;
        for (key, hcl) in &versions {
            state.store.config_version_add(key, hcl, &user.email, None)?;
        }
    }
    state.store.audit(
        &user.email,
        "config",
        None,
        "setup:apply",
        Some(&json!({ "groups": plan.groups.len(), "tables": count })),
    );
    Ok(Json(json!({ "ok": true, "reloaded": true, "tables": count })))
}

/// Resolve `{table}.hcl` and atomically commit + hot-reload it.
fn write_and_reload(
    state: &AppState,
    dir: &std::path::Path,
    table: &str,
    hcl: &str,
) -> Result<(), AppError> {
    let path = config_path(state, dir, table)?;
    commit_and_reload(state, &path, dir, hcl)
}

/// Atomically replace `path` with `hcl` (temp + rename) and hot-reload the whole
/// config dir. On a reload failure the previous file content is restored so the
/// server never keeps a config it won't accept. Caller must have already confirmed
/// `dir` is writable; `path` must resolve inside it.
pub(crate) fn commit_and_reload(
    state: &AppState,
    path: &std::path::Path,
    dir: &std::path::Path,
    hcl: &str,
) -> Result<(), AppError> {
    let previous = std::fs::read_to_string(path).ok();

    let tmp_dir = path.parent().unwrap_or(dir);
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "config.hcl".into());
    let tmp = tmp_dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, hcl).map_err(|e| AppError::internal(format!("write config: {e}")))?;
    std::fs::rename(&tmp, path).map_err(|e| AppError::internal(format!("commit config: {e}")))?;

    if let Err(e) = state.reload_config() {
        match &previous {
            Some(old) => {
                let _ = std::fs::write(path, old);
            }
            None => {
                let _ = std::fs::remove_file(path);
            }
        }
        return Err(AppError::bad(format!("config reload failed, reverted: {e}")));
    }
    Ok(())
}

/// A single filesystem mutation in a batch. Groups are folders, so a create /
/// rename / move touches several files and directories at once; a batch lets the
/// whole set apply atomically (all-or-nothing via reverse-replay of an undo
/// journal). Every path is `confine`d before anything touches disk.
pub(crate) enum FsOp {
    Write { path: PathBuf, contents: String },
    Move { from: PathBuf, to: PathBuf },
    Mkdir { path: PathBuf },
    Remove { path: PathBuf },
    Rmdir { path: PathBuf },
}

/// Resolve `p` to an absolute path proven to live inside `dir`, rejecting any
/// escape. `p` need not exist yet (a batch may create a folder and write into it
/// in one shot): the deepest existing ancestor is canonicalized (which collapses
/// `..` and resolves symlinks safely) and the still-nonexistent tail re-appended,
/// with every tail component checked to be a plain name (no `.`/`..`/separators).
/// The first path component under `dir` may never be a reserved (`_`-leading, incl.
/// `config`) folder — those framework folders are never valid group targets/sources.
pub(crate) fn confine(dir: &FsPath, p: &FsPath) -> Result<PathBuf, AppError> {
    let base = dir
        .canonicalize()
        .map_err(|e| AppError::internal(format!("resolve config dir: {e}")))?;

    let mut existing = p;
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if existing.exists() {
            break;
        }
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                existing = parent;
            }
            _ => return Err(AppError::bad("cannot resolve path inside config dir")),
        }
    }
    let mut resolved = existing
        .canonicalize()
        .map_err(|e| AppError::bad(format!("resolve path: {e}")))?;
    for comp in tail.iter().rev() {
        let s = comp.to_string_lossy();
        if s.is_empty() || s == "." || s == ".." || s.contains('/') || s.contains('\\') {
            return Err(AppError::bad("unsafe path component"));
        }
        resolved.push(comp);
    }

    let rel = resolved
        .strip_prefix(&base)
        .map_err(|_| AppError::bad("path escapes config dir"))?;
    if let Some(first) = rel.components().next() {
        let name = first.as_os_str().to_string_lossy();
        if name.starts_with('_') || name == crate::config::RESERVED_DIR {
            return Err(AppError::bad("reserved config folder is not a valid target"));
        }
    }
    Ok(resolved)
}

/// The inverse of one applied `FsOp`, recorded so a failed batch (including a
/// failed reload) rolls back byte-for-byte in reverse order.
enum Undo {
    // `prior` is a byte snapshot, not text: `read_to_string` loses non-UTF-8
    // files (returns `None`, indistinguishable from absent) and would delete
    // them on rollback. `None` here means the path did not exist at capture.
    RestoreFile { path: PathBuf, prior: Option<Vec<u8>> },
    MoveBack { from: PathBuf, to: PathBuf },
    RemoveCreatedDir { path: PathBuf },
    RecreateDir { path: PathBuf },
}

/// Byte snapshot of `path` for the undo journal: `Some(bytes)` when the file
/// exists (even if non-UTF-8), `None` when it is absent (undo then deletes it).
fn capture_prior(path: &FsPath) -> Option<Vec<u8>> {
    if path.exists() {
        Some(std::fs::read(path).unwrap_or_default())
    } else {
        None
    }
}

fn write_atomic(path: &FsPath, contents: &str) -> Result<(), AppError> {
    let parent = path.parent().ok_or_else(|| AppError::bad("write path has no parent"))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config.hcl".into());
    let tmp = parent.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, contents).map_err(|e| AppError::internal(format!("write config: {e}")))?;
    std::fs::rename(&tmp, path).map_err(|e| AppError::internal(format!("commit config: {e}")))?;
    Ok(())
}

/// Apply `ops` in order as one atomic unit, then hot-reload. On ANY failure —
/// including a reload rejection — the undo journal is replayed in REVERSE so no
/// partial folder move / half-written group can ever survive, and the live config
/// is reloaded back to its prior state. Caller holds `config_write_lock` and has
/// checked `dir_writable`.
pub(crate) fn commit_batch_and_reload(
    state: &AppState,
    dir: &FsPath,
    ops: Vec<FsOp>,
) -> Result<(), AppError> {
    let mut confined: Vec<FsOp> = Vec::with_capacity(ops.len());
    for op in ops {
        let c = match op {
            FsOp::Write { path, contents } => FsOp::Write { path: confine(dir, &path)?, contents },
            FsOp::Move { from, to } => {
                FsOp::Move { from: confine(dir, &from)?, to: confine(dir, &to)? }
            }
            FsOp::Mkdir { path } => FsOp::Mkdir { path: confine(dir, &path)? },
            FsOp::Remove { path } => FsOp::Remove { path: confine(dir, &path)? },
            FsOp::Rmdir { path } => FsOp::Rmdir { path: confine(dir, &path)? },
        };
        confined.push(c);
    }

    let mut journal: Vec<Undo> = Vec::new();
    let mut outcome: Result<(), AppError> = Ok(());
    for op in &confined {
        let step = match op {
            FsOp::Write { path, contents } => {
                let prior = capture_prior(path);
                write_atomic(path, contents).map(|()| {
                    journal.push(Undo::RestoreFile { path: path.clone(), prior });
                })
            }
            // Move must never clobber: `fs::rename` silently overwrites an
            // existing dest and its undo can't restore the lost file, so the
            // safety lives in the primitive itself, not just the callers.
            FsOp::Move { from, to } => {
                if to.exists() {
                    Err(AppError::bad(format!("move destination '{}' exists", to.display())))
                } else {
                    std::fs::rename(from, to)
                        .map_err(|e| AppError::internal(format!("move: {e}")))
                        .map(|()| journal.push(Undo::MoveBack { from: from.clone(), to: to.clone() }))
                }
            }
            FsOp::Mkdir { path } => {
                if path.exists() {
                    Ok(())
                } else {
                    let mut topmost = path.clone();
                    while let Some(parent) = topmost.parent() {
                        if parent.exists() {
                            break;
                        }
                        topmost = parent.to_path_buf();
                    }
                    std::fs::create_dir_all(path)
                        .map_err(|e| AppError::internal(format!("mkdir: {e}")))
                        .map(|()| journal.push(Undo::RemoveCreatedDir { path: topmost }))
                }
            }
            FsOp::Remove { path } => {
                let prior = capture_prior(path);
                std::fs::remove_file(path)
                    .map_err(|e| AppError::internal(format!("remove: {e}")))
                    .map(|()| journal.push(Undo::RestoreFile { path: path.clone(), prior }))
            }
            FsOp::Rmdir { path } => std::fs::remove_dir(path)
                .map_err(|e| AppError::internal(format!("rmdir: {e}")))
                .map(|()| journal.push(Undo::RecreateDir { path: path.clone() })),
        };
        if let Err(e) = step {
            outcome = Err(e);
            break;
        }
    }

    if outcome.is_ok() {
        if let Err(e) = state.reload_config() {
            outcome = Err(AppError::bad(format!("config reload failed: {e}")));
        }
    }

    if let Err(e) = outcome {
        for undo in journal.into_iter().rev() {
            match undo {
                Undo::RestoreFile { path, prior } => match prior {
                    Some(old) => {
                        let _ = std::fs::write(&path, old);
                    }
                    None => {
                        let _ = std::fs::remove_file(&path);
                    }
                },
                Undo::MoveBack { from, to } => {
                    let _ = std::fs::rename(&to, &from);
                }
                Undo::RemoveCreatedDir { path } => {
                    let _ = std::fs::remove_dir_all(&path);
                }
                Undo::RecreateDir { path } => {
                    let _ = std::fs::create_dir_all(&path);
                }
            }
        }
        let _ = state.reload_config();
        return Err(AppError::bad(format!("{} — reverted", e.1)));
    }
    Ok(())
}

/// One-time transitional migration: roles used to live in the SQLite `roles`
/// table; they are now authoritative in config (`config/auth.hcl`). Port any legacy
/// DB rows not already present in config into the file exactly once, snapshot a
/// version, then drop the table. A clean no-op on fresh DBs (no `roles` table) and
/// on read-only configs (where it loudly warns and leaves the table in place so no
/// user is silently left role-less).
pub(crate) fn port_legacy_roles(state: &AppState) {
    let (legacy, unparseable) = state.store.take_legacy_roles();
    if legacy.is_empty() && unparseable.is_empty() {
        return;
    }
    let existing = state.cfg().auth.roles.clone();

    let mut skipped: Vec<String> = unparseable;
    let mut orphans: Vec<(String, crate::config::RoleConfig)> = Vec::new();
    for (name, def) in legacy {
        if existing.contains_key(&name) {
            continue;
        }
        if name == "admin" {
            tracing::warn!(
                "legacy DB role named \"admin\" is reserved and was NOT ported to config; \
                 migrate it manually under a different name"
            );
            skipped.push(name);
            continue;
        }
        if let Err(e) = crate::access::validate_definition(state, &def) {
            tracing::warn!(
                "legacy DB role {:?} failed validation ({}) and was NOT ported to config; \
                 fix and migrate it manually",
                name,
                e.1,
            );
            skipped.push(name);
            continue;
        }
        orphans.push((name, def));
    }

    if orphans.is_empty() && skipped.is_empty() {
        state.store.drop_legacy_roles();
        return;
    }

    let writable = state.config_dir.as_deref().map(dir_writable).unwrap_or(false);
    let Some(dir) = state.config_dir.clone().filter(|_| writable) else {
        warn_orphaned_roles(state, &orphans, &skipped);
        return;
    };

    if !orphans.is_empty() {
        let mut new_auth = state.cfg().auth.clone();
        for (name, def) in &orphans {
            new_auth.roles.insert(name.clone(), def.clone());
        }
        let hcl = match hcl::to_string(&new_auth) {
            Ok(h) => h,
            Err(e) => {
                tracing::warn!("could not serialize ported roles into auth.hcl: {e}");
                return;
            }
        };
        let _ = std::fs::create_dir_all(dir.join("config"));
        let path = dir.join("config").join("auth.hcl");
        if let Err(e) = commit_and_reload(state, &path, &dir, &hcl) {
            tracing::warn!("porting legacy roles into config/auth.hcl failed, kept DB table: {}", e.1);
            return;
        }
        let _ = state.store.config_version_add("config/auth", &hcl, "steward-migration", None);
        let names: Vec<&str> = orphans.iter().map(|(n, _)| n.as_str()).collect();
        tracing::info!("ported {} legacy DB role(s) into config/auth.hcl: {:?}", names.len(), names);
    }

    if skipped.is_empty() {
        state.store.drop_legacy_roles();
    } else {
        tracing::warn!(
            "legacy DB roles {:?} could not be migrated (unparseable, reserved name, or invalid); \
             the `roles` table was KEPT for manual migration — fix these rows and re-run, or migrate them by hand",
            skipped,
        );
    }
}

fn warn_orphaned_roles(
    state: &AppState,
    orphans: &[(String, crate::config::RoleConfig)],
    skipped: &[String],
) {
    let names: Vec<&str> = orphans.iter().map(|(n, _)| n.as_str()).collect();
    let mut affected_roles: Vec<&str> = names.clone();
    affected_roles.extend(skipped.iter().map(String::as_str));
    let users = state.store.list_users().unwrap_or(serde_json::Value::Array(vec![]));
    let affected: Vec<String> = users
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|u| affected_roles.contains(&u["role"].as_str().unwrap_or("")))
                .filter_map(|u| u["email"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    tracing::warn!(
        "legacy DB roles {:?} could not be ported to config (config dir missing or read-only). \
         Role resolution is config-only, so affected users {:?} will be DENIED access until the \
         config dir is made writable and the roles are ported. The `roles` table was KEPT so the \
         rows are not lost.",
        names,
        affected,
    );
}

fn known_table(state: &AppState, table: &str) -> Result<(), AppError> {
    if state.resolve_table(table).is_none() {
        return Err(AppError::not_found(format!("unknown table {table}")));
    }
    safe_stem(table)?;
    Ok(())
}

pub async fn list_config_versions(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(table): Path<String>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    known_table(&state, &table)?;
    Ok(Json(state.store.config_versions_list(&table)?))
}

pub async fn get_config_version(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, id)): Path<(String, i64)>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    known_table(&state, &table)?;
    match state.store.config_version_get(&table, id) {
        Some(hcl) => Ok(Json(json!({ "hcl": hcl }))),
        None => Err(AppError::not_found("no such config version")),
    }
}

pub async fn publish_config_version(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((table, id)): Path<(String, i64)>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    known_table(&state, &table)?;

    let hcl_text = state
        .store
        .config_version_get(&table, id)
        .ok_or_else(|| AppError::not_found("no such config version"))?;

    // A stored version could be stale (e.g. saved before a schema change). Never
    // let one that no longer parses go live.
    hcl::from_str::<TableConfig>(&hcl_text)
        .map_err(|e| AppError::bad(format!("stored config no longer valid: {e}")))?;

    let writable = state.config_dir.as_deref().map(dir_writable).unwrap_or(false);
    if !writable {
        return Ok(Json(json!({ "ok": false, "writable": false, "hcl": hcl_text })));
    }
    let dir = state.config_dir.clone().unwrap();

    {
        let _guard = state.config_write_lock.lock().unwrap();
        write_and_reload(&state, &dir, &table, &hcl_text)?;
        state.store.config_version_publish(&table, id);
    }

    state.store.audit(
        &user.email,
        "config",
        Some(&table),
        "config:publish",
        Some(&json!({ "table": table, "version": id })),
    );

    Ok(Json(json!({ "ok": true, "reloaded": true })))
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::introspect::{DbColumn, DbTable, Kind, Schema};
    use crate::state::{AppState, CurrentUser};
    use crate::store::Store;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    static SEQ: AtomicU32 = AtomicU32::new(0);

    pub fn tmp_dir() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("steward-cfgtest-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    pub fn state_with_tables(dir: Option<PathBuf>, tables: &[&str]) -> Arc<AppState> {
        let mut schema = Schema::default();
        for t in tables {
            schema.tables.insert(
                (*t).into(),
                DbTable {
                    name: (*t).into(),
                    schema: "public".into(),
                    source: String::new(),
                    is_view: false,
                    pk: Some("id".into()),
                    columns: vec![DbColumn {
                        name: "id".into(),
                        udt: "int8".into(),
                        elem_udt: None,
                        kind: Kind::Int,
                        nullable: false,
                        has_default: true,
                        fk: None,
                    }],
                },
            );
        }
        let cfg = crate::config::load(dir.as_deref()).unwrap();
        let pg = sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://x").unwrap();
        Arc::new(AppState {
            pools: Default::default(),
            dbs: Default::default(),
            pg,
            schema: "public".into(),
            db: schema,
            cfg: arc_swap::ArcSwap::from_pointee(cfg),
            config_dir: dir,
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

    pub fn admin() -> CurrentUser {
        CurrentUser { email: "a@x.io".into(), role: "admin".into() }
    }
    pub fn viewer() -> CurrentUser {
        CurrentUser { email: "v@x.io".into(), role: "viewer".into() }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::config::{ListConfig, TableConfig};

    fn state_with_dir(dir: Option<PathBuf>) -> Arc<AppState> {
        state_with_tables(dir, &["bots"])
    }

    fn sample() -> TableConfig {
        let mut tc = TableConfig::default();
        tc.label = Some("Bots".into());
        tc.list = ListConfig {
            columns: vec!["id".into(), "name".into()],
            sort: Some("-id".into()),
            filter_defs: {
                let mut m = std::collections::BTreeMap::new();
                m.insert(
                    "active".into(),
                    crate::config::CustomFilter { label: "Active".into(), sql: "active".into() },
                );
                m
            },
            ..Default::default()
        };
        tc
    }

    #[test]
    fn table_config_hcl_round_trips() {
        let tc = sample();
        let text = generate_hcl(&tc);
        let parsed: TableConfig = hcl::from_str(&text).expect("re-parse generated hcl");
        assert_eq!(parsed.label.as_deref(), Some("Bots"));
        assert_eq!(parsed.list.columns, vec!["id".to_string(), "name".to_string()]);
        assert_eq!(parsed.list.sort.as_deref(), Some("-id"));
        assert!(parsed.list.filter_defs.contains_key("active"));
        // Serialize → parse → serialize is idempotent, and structurally identical.
        let text2 = generate_hcl(&parsed);
        assert_eq!(text, text2, "hcl serialization must be idempotent");
        assert_eq!(
            serde_json::to_value(&tc).unwrap(),
            serde_json::to_value(&parsed).unwrap(),
            "round-trip must preserve the effective config",
        );
    }

    #[test]
    fn default_config_serializes_and_reparses() {
        let text = generate_hcl(&TableConfig::default());
        let _: TableConfig = hcl::from_str(&text).expect("default hcl re-parses");
    }

    #[test]
    fn pretty_labeled_blocks_parse() {
        // The hand-authored labeled-block form (as the converted admin/*.hcl files
        // are written) parses into the same structure the serializer emits.
        let src = r#"
label = "bot"

list {
  columns = ["name", "mode"]
  sort    = "-created_at"
  filter_def "needs_attention" {
    label = "Needs attention"
    sql   = "t.mode <> 'off'"
  }
}

field "mode" {
  widget = "badge"
  params = { colors = { off = "gray", live = "green" } }
}

detail {
  section {
    title  = "Identity"
    fields = ["name", "id"]
  }
  section {
    title  = "Runtime"
    fields = ["mode"]
  }
}

action "pause" {
  label = "Pause"
  kind  = "update"
  set   = { mode = "off" }
}
"#;
        let tc: TableConfig = hcl::from_str(src).expect("parse labeled blocks");
        assert_eq!(tc.detail.sections.len(), 2);
        assert_eq!(tc.detail.sections[0].title, "Identity");
        assert_eq!(tc.detail.sections[1].title, "Runtime");
        assert!(tc.fields.contains_key("mode"));
        assert!(tc.actions.contains_key("pause"));
        assert_eq!(tc.actions["pause"].set.get("mode").unwrap(), "off");
        assert!(tc.list.filter_defs.contains_key("needs_attention"));
    }

    #[test]
    fn safe_stem_rejects_traversal() {
        assert!(safe_stem("../etc/passwd").is_err());
        assert!(safe_stem("a/b").is_err());
        assert!(safe_stem("a\\b").is_err());
        assert!(safe_stem("").is_err());
        assert!(safe_stem("public.orders").is_ok());
        assert!(safe_stem("bots").is_ok());
    }

    #[test]
    fn safe_stem_rejects_reserved_stems() {
        for stem in RESERVED_STEMS {
            assert!(safe_stem(stem).is_err(), "reserved stem {stem:?} must be rejected");
        }
        for stem in ["groups", "dashboard", "discover", "versions", "Groups", "VERSIONS"] {
            assert!(safe_stem(stem).is_err(), "route-shadowing stem {stem:?} must be rejected");
        }
    }

    #[test]
    fn unknown_field_is_rejected() {
        let err = hcl::from_str::<TableConfig>("nonsense_key = 1\n");
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn reload_keeps_old_config_on_bad_file() {
        let dir = tmp_dir();
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::write(dir.join("config").join("steward.hcl"), "brand = \"Good\"\n").unwrap();
        let state = state_with_dir(Some(dir.clone()));
        assert_eq!(state.cfg().steward.brand.as_deref(), Some("Good"));

        std::fs::write(dir.join("config").join("steward.hcl"), "this is @@@ not hcl =\n").unwrap();
        let err = state.reload_config();
        assert!(err.is_err(), "bad config must fail reload");
        // Live config is untouched — auth/branding never degrade on a bad file.
        assert_eq!(state.cfg().steward.brand.as_deref(), Some("Good"));
    }

    #[tokio::test]
    async fn admin_gate_blocks_non_admin() {
        let state = state_with_dir(Some(tmp_dir()));
        let g = get_config(
            axum::extract::State(state.clone()),
            viewer(),
            Path("bots".into()),
        )
        .await;
        assert!(matches!(g, Err(AppError(axum::http::StatusCode::FORBIDDEN, _))));

        let p = put_config(
            axum::extract::State(state),
            viewer(),
            Path("bots".into()),
            Json(PutConfig { hcl: Some(String::new()), model: None, group: None }),
        )
        .await;
        assert!(matches!(p, Err(AppError(axum::http::StatusCode::FORBIDDEN, _))));
    }

    #[tokio::test]
    async fn get_unknown_table_is_404() {
        let state = state_with_dir(Some(tmp_dir()));
        let g = get_config(axum::extract::State(state), admin(), Path("ghost".into())).await;
        assert!(matches!(g, Err(AppError(axum::http::StatusCode::NOT_FOUND, _))));
    }

    #[tokio::test]
    async fn writable_dir_writes_and_hot_reloads() {
        let dir = tmp_dir();
        let state = state_with_dir(Some(dir.clone()));

        // No file yet → generated fallback, dir reported writable.
        let g = get_config(axum::extract::State(state.clone()), admin(), Path("bots".into()))
            .await
            .unwrap()
            .0;
        assert_eq!(g["writable"], json!(true));
        assert!(g["hcl"].as_str().is_some());
        assert!(g["model"].is_object(), "get returns a structured model");
        assert!(state.cfg().tables.get("bots").is_none());

        let p = put_config(
            axum::extract::State(state.clone()),
            admin(),
            Path("bots".into()),
            Json(PutConfig { hcl: Some("label = \"Robots\"\n".into()), model: None, group: None }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(p["ok"], json!(true));
        assert_eq!(p["reloaded"], json!(true));
        assert!(dir.join("bots.hcl").exists());
        // The live config picked up the edit without a restart.
        assert_eq!(
            state.cfg().tables.get("bots").and_then(|t| t.label.as_deref()),
            Some("Robots")
        );
    }

    #[tokio::test]
    async fn put_via_model_serializes_and_reloads() {
        let dir = tmp_dir();
        let state = state_with_dir(Some(dir.clone()));
        let model = serde_json::to_value(&sample()).unwrap();

        let p = put_config(
            axum::extract::State(state.clone()),
            admin(),
            Path("bots".into()),
            Json(PutConfig { hcl: None, model: Some(serde_json::from_value(model).unwrap()), group: None }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(p["ok"], json!(true));
        // The model path wrote pretty labeled-block HCL to disk.
        let on_disk = std::fs::read_to_string(dir.join("bots.hcl")).unwrap();
        assert!(on_disk.contains("filter_def \"active\""), "labeled block emitted:\n{on_disk}");
        assert_eq!(
            state.cfg().tables.get("bots").and_then(|t| t.label.as_deref()),
            Some("Bots")
        );
    }

    #[tokio::test]
    async fn put_rejects_both_or_neither() {
        let state = state_with_dir(Some(tmp_dir()));
        let both = put_config(
            axum::extract::State(state.clone()),
            admin(),
            Path("bots".into()),
            Json(PutConfig { hcl: Some("label = \"x\"\n".into()), model: Some(sample()), group: None }),
        )
        .await;
        assert!(matches!(both, Err(AppError(axum::http::StatusCode::BAD_REQUEST, _))));

        let neither = put_config(
            axum::extract::State(state),
            admin(),
            Path("bots".into()),
            Json(PutConfig { hcl: None, model: None, group: None }),
        )
        .await;
        assert!(matches!(neither, Err(AppError(axum::http::StatusCode::BAD_REQUEST, _))));
    }

    #[tokio::test]
    async fn invalid_hcl_is_400_and_writes_nothing() {
        let dir = tmp_dir();
        let state = state_with_dir(Some(dir.clone()));
        let p = put_config(
            axum::extract::State(state),
            admin(),
            Path("bots".into()),
            Json(PutConfig { hcl: Some("bogus_field = 1\n".into()), model: None, group: None }),
        )
        .await;
        assert!(matches!(p, Err(AppError(axum::http::StatusCode::BAD_REQUEST, _))));
        assert!(!dir.join("bots.hcl").exists());
    }

    #[tokio::test]
    async fn duplicate_labeled_block_is_400_and_writes_nothing() {
        let dir = tmp_dir();
        let state = state_with_dir(Some(dir.clone()));
        let p = put_config(
            axum::extract::State(state),
            admin(),
            Path("bots".into()),
            Json(PutConfig {
                hcl: Some(
                    "field \"secret\" { masked = true }\nfield \"secret\" { label = \"Secret\" }\n"
                        .into(),
                ),
                model: None,
                group: None,
            }),
        )
        .await;
        assert!(matches!(p, Err(AppError(axum::http::StatusCode::BAD_REQUEST, _))));
        assert!(!dir.join("bots.hcl").exists());
    }

    #[tokio::test]
    async fn no_config_dir_reports_not_writable() {
        let state = state_with_dir(None);
        let g = get_config(axum::extract::State(state.clone()), admin(), Path("bots".into()))
            .await
            .unwrap()
            .0;
        assert_eq!(g["writable"], json!(false));

        let p = put_config(
            axum::extract::State(state),
            admin(),
            Path("bots".into()),
            Json(PutConfig { hcl: Some("label = \"x\"\n".into()), model: None, group: None }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(p["ok"], json!(false));
        assert_eq!(p["writable"], json!(false));
        assert_eq!(p["hcl"], json!("label = \"x\"\n"));
    }

    async fn put(state: &Arc<AppState>, hcl: &str) {
        let _ = put_config(
            axum::extract::State(state.clone()),
            admin(),
            Path("bots".into()),
            Json(PutConfig { hcl: Some(hcl.into()), model: None, group: None }),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn save_snapshots_a_version() {
        let state = state_with_dir(Some(tmp_dir()));
        put(&state, "label = \"One\"\n").await;
        put(&state, "label = \"Two\"\n").await;

        let out = list_config_versions(axum::extract::State(state.clone()), admin(), Path("bots".into()))
            .await
            .unwrap()
            .0;
        let rows = out["versions"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["published"], json!(true));
        assert_eq!(rows[1]["published"], json!(false));

        let id = rows[1]["id"].as_i64().unwrap();
        let v = get_config_version(axum::extract::State(state), admin(), Path(("bots".into(), id)))
            .await
            .unwrap()
            .0;
        assert_eq!(v["hcl"], json!("label = \"One\"\n"));
    }

    #[tokio::test]
    async fn publish_restores_prior_version_and_hot_reloads() {
        let dir = tmp_dir();
        let state = state_with_dir(Some(dir.clone()));
        put(&state, "label = \"One\"\n").await;
        put(&state, "label = \"Two\"\n").await;
        assert_eq!(state.cfg().tables.get("bots").and_then(|t| t.label.as_deref()), Some("Two"));

        let out = list_config_versions(axum::extract::State(state.clone()), admin(), Path("bots".into()))
            .await
            .unwrap()
            .0;
        let old_id = out["versions"].as_array().unwrap()[1]["id"].as_i64().unwrap();

        let p = publish_config_version(
            axum::extract::State(state.clone()),
            admin(),
            Path(("bots".into(), old_id)),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(p["ok"], json!(true));
        assert_eq!(p["reloaded"], json!(true));
        // file + live config rolled back
        assert_eq!(std::fs::read_to_string(dir.join("bots.hcl")).unwrap(), "label = \"One\"\n");
        assert_eq!(state.cfg().tables.get("bots").and_then(|t| t.label.as_deref()), Some("One"));

        let out = list_config_versions(axum::extract::State(state), admin(), Path("bots".into()))
            .await
            .unwrap()
            .0;
        let rows = out["versions"].as_array().unwrap();
        let published = rows.iter().find(|r| r["published"] == json!(true)).unwrap();
        assert_eq!(published["id"], json!(old_id));
    }

    #[tokio::test]
    async fn publish_of_invalid_stored_hcl_is_400_and_changes_nothing() {
        let dir = tmp_dir();
        let state = state_with_dir(Some(dir.clone()));
        put(&state, "label = \"One\"\n").await;
        // Inject a version that no longer parses (bypasses the put validation).
        let bad = state.store.config_version_add("bots", "bogus_field = 1\n", "a@x.io", None).unwrap();

        let r = publish_config_version(
            axum::extract::State(state.clone()),
            admin(),
            Path(("bots".into(), bad)),
        )
        .await;
        assert!(matches!(r, Err(AppError(axum::http::StatusCode::BAD_REQUEST, _))));
        // On-disk file untouched (still the good one).
        assert_eq!(std::fs::read_to_string(dir.join("bots.hcl")).unwrap(), "label = \"One\"\n");
    }

    #[tokio::test]
    async fn version_endpoints_are_admin_only() {
        let state = state_with_dir(Some(tmp_dir()));
        let l = list_config_versions(axum::extract::State(state.clone()), viewer(), Path("bots".into())).await;
        assert!(matches!(l, Err(AppError(axum::http::StatusCode::FORBIDDEN, _))));
        let g = get_config_version(axum::extract::State(state.clone()), viewer(), Path(("bots".into(), 1))).await;
        assert!(matches!(g, Err(AppError(axum::http::StatusCode::FORBIDDEN, _))));
        let p = publish_config_version(axum::extract::State(state), viewer(), Path(("bots".into(), 1))).await;
        assert!(matches!(p, Err(AppError(axum::http::StatusCode::FORBIDDEN, _))));
    }

    #[tokio::test]
    async fn versions_unknown_table_is_404() {
        let state = state_with_dir(Some(tmp_dir()));
        let l = list_config_versions(axum::extract::State(state), admin(), Path("ghost".into())).await;
        assert!(matches!(l, Err(AppError(axum::http::StatusCode::NOT_FOUND, _))));
    }

    /// A table config sourced from a group folder writes back to THAT folder file
    /// (not a new root file), keeps its nav group after reload, and the version
    /// publish path targets the same folder file.
    #[tokio::test]
    async fn group_folder_table_writes_back_to_folder() {
        let dir = tmp_dir();
        let group = dir.join("mygroup");
        std::fs::create_dir_all(&group).unwrap();
        std::fs::write(group.join("_group.hcl"), "label = \"My group\"\norder = 1\n").unwrap();
        std::fs::write(group.join("foo.hcl"), "label = \"Foo\"\n").unwrap();

        let state = state_with_tables(Some(dir.clone()), &["foo"]);
        assert_eq!(state.cfg().table_group_label("foo").as_deref(), Some("My group"));
        assert_eq!(
            state.cfg().table_sources.get("foo").map(|s| s.path.clone()),
            Some(group.join("foo.hcl")),
        );

        let mut model = TableConfig::default();
        model.label = Some("Foo edited".into());
        let p = put_config(
            axum::extract::State(state.clone()),
            admin(),
            Path("foo".into()),
            Json(PutConfig { hcl: None, model: Some(model), group: None }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(p["ok"], json!(true));

        let folder_file = std::fs::read_to_string(group.join("foo.hcl")).unwrap();
        assert!(folder_file.contains("Foo edited"), "folder file rewritten:\n{folder_file}");
        assert!(!dir.join("foo.hcl").exists(), "must not create a root file");
        assert_eq!(state.cfg().table_group_label("foo").as_deref(), Some("My group"));

        // A second save + publish of the first version still targets the folder file.
        let mut model2 = TableConfig::default();
        model2.label = Some("Foo v2".into());
        let _ = put_config(
            axum::extract::State(state.clone()),
            admin(),
            Path("foo".into()),
            Json(PutConfig { hcl: None, model: Some(model2), group: None }),
        )
        .await
        .unwrap();

        let versions = list_config_versions(
            axum::extract::State(state.clone()),
            admin(),
            Path("foo".into()),
        )
        .await
        .unwrap()
        .0;
        let first_id = versions["versions"].as_array().unwrap()
            .iter()
            .min_by_key(|r| r["id"].as_i64().unwrap())
            .unwrap()["id"]
            .as_i64()
            .unwrap();

        let _ = publish_config_version(
            axum::extract::State(state.clone()),
            admin(),
            Path(("foo".into(), first_id)),
        )
        .await
        .unwrap();

        let republished = std::fs::read_to_string(group.join("foo.hcl")).unwrap();
        assert!(republished.contains("Foo edited"), "publish rewrote the folder file");
        assert!(!dir.join("foo.hcl").exists(), "publish never wrote to root");
        assert_eq!(state.cfg().table_group_label("foo").as_deref(), Some("My group"));
    }

    /// A tracked source path that escapes the config dir is never written to:
    /// `config_path` falls back to `{stem}.hcl` at the root.
    #[tokio::test]
    async fn config_path_rejects_escaping_source() {
        use crate::config::TableSource;
        let dir = tmp_dir();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);

        let mut cfg = crate::config::load(Some(&dir)).unwrap();
        cfg.table_sources.insert(
            "bots".into(),
            TableSource { path: PathBuf::from("/etc/steward-escape.hcl"), group: None },
        );
        state.cfg.store(Arc::new(cfg));

        let resolved = config_path(&state, &dir, "bots").unwrap();
        assert_eq!(resolved, dir.join("bots.hcl"), "escaping path falls back to root");
    }

    #[tokio::test]
    async fn port_legacy_roles_merges_then_drops_table() {
        let dir = tmp_dir();
        std::fs::write(dir.join("bots.hcl"), "").unwrap();
        let state = state_with_dir(Some(dir.clone()));
        assert!(state.cfg().auth.roles.get("legacy").is_none());
        state.store.seed_legacy_role("legacy", r#"{"tables":{"bots":"read"}}"#);

        port_legacy_roles(&state);

        let on_disk = std::fs::read_to_string(dir.join("config").join("auth.hcl")).unwrap();
        assert!(on_disk.contains("role \"legacy\""), "ported role written:\n{on_disk}");
        assert!(state.cfg().auth.roles.contains_key("legacy"), "ported role went live");
        assert!(
            state.store.take_legacy_roles().0.is_empty(),
            "legacy table dropped after port",
        );

        let versions = state.store.config_versions_list("config/auth").unwrap();
        assert_eq!(versions["versions"].as_array().unwrap().len(), 1, "one auth version snapshot");
    }

    #[tokio::test]
    async fn port_legacy_roles_is_noop_on_fresh_db() {
        let dir = tmp_dir();
        let state = state_with_dir(Some(dir.clone()));
        port_legacy_roles(&state);
        assert!(!dir.join("config").join("auth.hcl").exists(), "nothing written when no legacy table");
        assert!(state.cfg().auth.roles.is_empty());
    }

    #[tokio::test]
    async fn port_legacy_roles_keeps_table_when_a_row_is_unparseable() {
        let dir = tmp_dir();
        std::fs::write(dir.join("bots.hcl"), "").unwrap();
        let state = state_with_dir(Some(dir.clone()));
        state.store.seed_legacy_role("good", r#"{"tables":{"bots":"read"}}"#);
        state.store.seed_legacy_role("broken", r#"{"tables":{"bots":42}}"#);

        port_legacy_roles(&state);

        let on_disk = std::fs::read_to_string(dir.join("config").join("auth.hcl")).unwrap();
        assert!(on_disk.contains("role \"good\""), "good role ported:\n{on_disk}");
        assert!(!on_disk.contains("role \"broken\""), "unparseable role not ported");
        assert!(state.cfg().auth.roles.contains_key("good"), "good role went live");
        assert!(
            !state.store.take_legacy_roles().0.is_empty()
                || !state.store.take_legacy_roles().1.is_empty(),
            "legacy table KEPT because a row failed to parse",
        );
    }

    #[tokio::test]
    async fn port_legacy_roles_never_writes_admin() {
        let dir = tmp_dir();
        let state = state_with_dir(Some(dir.clone()));
        state.store.seed_legacy_role("admin", r#"{"tables":{"bots":"write"}}"#);

        port_legacy_roles(&state);

        assert!(
            !state.cfg().auth.roles.contains_key("admin"),
            "a config admin role must never be written",
        );
        let hcl_path = dir.join("config").join("auth.hcl");
        if let Ok(on_disk) = std::fs::read_to_string(&hcl_path) {
            assert!(!on_disk.contains("role \"admin\""), "admin role never on disk:\n{on_disk}");
        }
    }

    #[tokio::test]
    async fn batch_applies_multiple_ops() {
        let dir = tmp_dir();
        std::fs::create_dir_all(dir.join("g")).unwrap();
        std::fs::write(dir.join("g").join("_group.hcl"), "label = \"G\"\n").unwrap();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);

        commit_batch_and_reload(
            &state,
            &dir,
            vec![
                FsOp::Mkdir { path: dir.join("h") },
                FsOp::Write { path: dir.join("h").join("_group.hcl"), contents: "label = \"H\"\n".into() },
                FsOp::Write { path: dir.join("bots.hcl"), contents: "label = \"Bots\"\n".into() },
            ],
        )
        .unwrap();
        assert!(dir.join("h").join("_group.hcl").exists());
        assert!(dir.join("bots.hcl").exists());
        assert!(state.cfg().groups.iter().any(|g| g.slug == "h"));
        assert_eq!(state.cfg().tables.get("bots").and_then(|t| t.label.as_deref()), Some("Bots"));
    }

    #[tokio::test]
    async fn batch_reverts_every_op_on_reload_failure() {
        let dir = tmp_dir();
        std::fs::write(dir.join("bots.hcl"), "label = \"Original\"\n").unwrap();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);

        let err = commit_batch_and_reload(
            &state,
            &dir,
            vec![
                FsOp::Mkdir { path: dir.join("newgroup") },
                FsOp::Write { path: dir.join("newgroup").join("_group.hcl"), contents: "label = \"N\"\n".into() },
                FsOp::Write { path: dir.join("bots.hcl"), contents: "label = \"Edited\"\n".into() },
                // A malformed file makes reload_config fail → the WHOLE batch reverts.
                FsOp::Write { path: dir.join("broken.hcl"), contents: "this is @@@ not hcl =\n".into() },
            ],
        );
        assert!(err.is_err());
        assert!(err.unwrap_err().1.contains("reverted"));
        assert!(!dir.join("newgroup").exists(), "created dir removed on revert");
        assert!(!dir.join("broken.hcl").exists(), "created file removed on revert");
        assert_eq!(
            std::fs::read_to_string(dir.join("bots.hcl")).unwrap(),
            "label = \"Original\"\n",
            "prior file content restored",
        );
        // Live config is the pre-batch one.
        assert!(!state.cfg().groups.iter().any(|g| g.slug == "newgroup"));
    }

    #[tokio::test]
    async fn move_onto_existing_dest_errors_and_reverts() {
        let dir = tmp_dir();
        std::fs::create_dir_all(dir.join("g")).unwrap();
        std::fs::create_dir_all(dir.join("h")).unwrap();
        std::fs::write(dir.join("g").join("_group.hcl"), "label = \"G\"\n").unwrap();
        std::fs::write(dir.join("h").join("_group.hcl"), "label = \"H\"\n").unwrap();
        std::fs::write(dir.join("g").join("foo.hcl"), "label = \"Foo G\"\n").unwrap();
        std::fs::write(dir.join("h").join("bar.hcl"), "label = \"Bar H\"\n").unwrap();
        let state = state_with_tables(Some(dir.clone()), &["foo", "bar"]);

        let err = commit_batch_and_reload(
            &state,
            &dir,
            vec![FsOp::Move { from: dir.join("g").join("foo.hcl"), to: dir.join("h").join("bar.hcl") }],
        );
        assert!(err.is_err());
        assert!(err.unwrap_err().1.contains("reverted"));
        assert_eq!(
            std::fs::read_to_string(dir.join("g").join("foo.hcl")).unwrap(),
            "label = \"Foo G\"\n",
            "source untouched",
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("h").join("bar.hcl")).unwrap(),
            "label = \"Bar H\"\n",
            "destination never clobbered",
        );
    }

    #[tokio::test]
    async fn rollback_restores_a_non_utf8_file() {
        let dir = tmp_dir();
        let blob = dir.join("keep.bin");
        let original: &[u8] = &[0xff, 0xfe, 0x00, 0x9c, 0x41, 0x80];
        std::fs::write(&blob, original).unwrap();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);

        let err = commit_batch_and_reload(
            &state,
            &dir,
            vec![
                FsOp::Write { path: blob.clone(), contents: "clobbered".into() },
                FsOp::Write { path: dir.join("broken.hcl"), contents: "this is @@@ not hcl =\n".into() },
            ],
        );
        assert!(err.is_err());
        assert_eq!(std::fs::read(&blob).unwrap(), original, "non-UTF-8 bytes restored, not deleted");
        assert!(!dir.join("broken.hcl").exists());
    }

    #[tokio::test]
    async fn mkdir_undo_removes_created_dirs_and_keeps_preexisting() {
        let dir = tmp_dir();
        std::fs::create_dir_all(dir.join("existing")).unwrap();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);

        let err = commit_batch_and_reload(
            &state,
            &dir,
            vec![
                FsOp::Mkdir { path: dir.join("a").join("b").join("c") },
                FsOp::Mkdir { path: dir.join("existing").join("child") },
                FsOp::Write { path: dir.join("broken.hcl"), contents: "this is @@@ not hcl =\n".into() },
            ],
        );
        assert!(err.is_err());
        assert!(!dir.join("a").exists(), "every nested dir the batch created is removed");
        assert!(!dir.join("existing").join("child").exists(), "created leaf removed");
        assert!(dir.join("existing").exists(), "pre-existing dir kept");
    }

    #[test]
    fn confine_rejects_escapes_and_reserved() {
        let dir = tmp_dir();
        assert!(confine(&dir, &dir.join("ok").join("_group.hcl")).is_ok());
        assert!(confine(&dir, &dir.join("..").join("escape.hcl")).is_err());
        assert!(confine(&dir, std::path::Path::new("/etc/passwd")).is_err());
        assert!(confine(&dir, &dir.join("config").join("auth.hcl")).is_err());
        assert!(confine(&dir, &dir.join("_secret").join("x.hcl")).is_err());
        // A Move dest whose parent escapes the config dir.
        assert!(confine(&dir, &dir.join("g").join("..").join("..").join("out.hcl")).is_err());
    }

    #[tokio::test]
    async fn discover_lists_unconfigured_only() {
        let dir = tmp_dir();
        std::fs::write(dir.join("bots.hcl"), "label = \"Bots\"\n").unwrap();
        let state = state_with_tables(Some(dir.clone()), &["bots", "orders"]);

        let out = discover(axum::extract::State(state), admin()).await.unwrap().0;
        let names: Vec<&str> = out["tables"].as_array().unwrap()
            .iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"orders"), "unconfigured table listed");
        assert!(!names.contains(&"bots"), "configured table excluded");
    }

    #[tokio::test]
    async fn create_with_group_lands_file_in_folder() {
        let dir = tmp_dir();
        std::fs::create_dir_all(dir.join("trading")).unwrap();
        std::fs::write(dir.join("trading").join("_group.hcl"), "label = \"Trading\"\norder = 1\n").unwrap();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);

        let out = put_config(
            axum::extract::State(state.clone()),
            admin(),
            Path("bots".into()),
            Json(PutConfig { hcl: None, model: None, group: Some("trading".into())  }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(out["ok"], json!(true));
        assert!(dir.join("trading").join("bots.hcl").exists(), "starter landed in group folder");
        assert!(!dir.join("bots.hcl").exists(), "no root file");
        assert_eq!(
            state.cfg().table_sources.get("bots").and_then(|s| s.group.as_deref()),
            Some("trading"),
        );
        let group_hcl = std::fs::read_to_string(dir.join("trading").join("_group.hcl")).unwrap();
        assert!(group_hcl.contains("bots"), "stem appended to table_order:\n{group_hcl}");
    }

    #[tokio::test]
    async fn create_with_nonexistent_group_is_400() {
        let dir = tmp_dir();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        let r = put_config(
            axum::extract::State(state),
            admin(),
            Path("bots".into()),
            Json(PutConfig { hcl: None, model: None, group: Some("ghost".into())  }),
        )
        .await;
        assert!(matches!(r, Err(AppError(axum::http::StatusCode::BAD_REQUEST, _))));
    }
}
