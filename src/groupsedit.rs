use crate::config::GroupConfig;
use crate::configedit::{admin_only, commit_batch_and_reload, dir_writable, FsOp, RESERVED_STEMS};
use crate::state::{AppError, AppState, CurrentUser};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path as FsPath;
use std::sync::Arc;

/// Where a group's folder lives (or should live). An existing group keeps its
/// convention; a NEW group follows the config's: `screens/<slug>/` when a
/// `screens/` root exists, else the flat `<slug>/`.
pub(crate) fn group_dir(dir: &FsPath, slug: &str) -> std::path::PathBuf {
    let screens = dir.join("screens").join(slug);
    let flat = dir.join(slug);
    if screens.join("_group.hcl").exists() {
        screens
    } else if flat.join("_group.hcl").exists() || !dir.join("screens").is_dir() {
        flat
    } else {
        screens
    }
}

/// A group's stable key is its folder name. It must be a plain slug: ASCII
/// letters/digits/`-`, never empty, never leading `_` or `-` (leading `_` is
/// reserved for framework folders like `config`), and never a reserved stem.
fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && !slug.starts_with('_')
        && !slug.starts_with('-')
        && slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !RESERVED_STEMS.iter().any(|r| r.eq_ignore_ascii_case(slug))
}

fn ensure_slug(slug: &str) -> Result<(), AppError> {
    if valid_slug(slug) {
        return Ok(());
    }
    if RESERVED_STEMS.iter().any(|r| r.eq_ignore_ascii_case(slug)) {
        return Err(AppError::bad(format!(
            "'{slug}' is a reserved name and cannot be a group"
        )));
    }
    Err(AppError::bad(
        "group slug must be letters, digits or '-', with no leading '_' or '-'",
    ))
}

fn writable_dir(state: &AppState) -> Option<std::path::PathBuf> {
    let dir = state.config_dir.clone()?;
    dir_writable(&dir).then_some(dir)
}

fn not_writable(hcl: Option<String>) -> Json<Value> {
    match hcl {
        Some(h) => Json(json!({ "ok": false, "writable": false, "hcl": h })),
        None => Json(json!({ "ok": false, "writable": false })),
    }
}

/// Tables in a group, ordered by the group's `table_order` first (persisted
/// preference), then any remaining members alphabetically.
fn ordered_members(members: Vec<String>, table_order: &[String]) -> Vec<String> {
    let mut out: Vec<String> = table_order
        .iter()
        .filter(|t| members.contains(t))
        .cloned()
        .collect();
    let mut rest: Vec<String> = members.into_iter().filter(|t| !out.contains(t)).collect();
    rest.sort();
    out.extend(rest);
    out
}

pub async fn list_groups(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    let cfg = state.cfg();
    let writable = state
        .config_dir
        .as_deref()
        .map(dir_writable)
        .unwrap_or(false);

    let groups: Vec<Value> = cfg
        .groups
        .iter()
        .map(|g| {
            let members: Vec<String> = cfg
                .table_sources
                .iter()
                .filter(|(_, s)| s.group.as_deref() == Some(g.slug.as_str()))
                .map(|(k, _)| k.clone())
                .collect();
            json!({
                "slug": g.slug,
                "label": g.label,
                "icon": g.icon,
                "order": g.order,
                "tables": ordered_members(members, &g.table_order),
            })
        })
        .collect();

    let ungrouped: Vec<String> = cfg
        .table_sources
        .iter()
        .filter(|(_, s)| s.group.is_none())
        .map(|(k, _)| k.clone())
        .collect();

    let unconfigured: Vec<String> = state
        .db
        .tables
        .keys()
        .filter(|t| !cfg.tables.contains_key(*t))
        .filter(|t| !RESERVED_STEMS.iter().any(|r| r.eq_ignore_ascii_case(t)))
        .cloned()
        .collect();

    Ok(Json(json!({
        "writable": writable,
        "groups": groups,
        "ungrouped": ungrouped,
        "unconfigured": unconfigured,
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateGroup {
    slug: String,
    label: String,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    order: Option<i64>,
}

pub async fn create_group(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Json(body): Json<CreateGroup>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    admin_only(&user)?;
    let slug = body.slug.trim().to_string();
    ensure_slug(&slug)?;
    if state.cfg().groups.iter().any(|g| g.slug == slug) {
        return Err(AppError(
            StatusCode::CONFLICT,
            format!("group '{slug}' already exists"),
        ));
    }

    let group_cfg = GroupConfig {
        label: body.label,
        labels: Default::default(),
        icon: body.icon,
        order: body.order.unwrap_or(0),
        table_order: Vec::new(),
        nav: None,
    };
    let hcl = serialize_group(&group_cfg)?;

    let Some(dir) = writable_dir(&state) else {
        return Ok((StatusCode::OK, not_writable(Some(hcl))));
    };
    let gdir = group_dir(&dir, &slug);
    if gdir.exists() {
        return Err(AppError(
            StatusCode::CONFLICT,
            format!("folder '{slug}' already exists"),
        ));
    }

    {
        let _guard = state.config_write_lock.lock().unwrap();
        commit_batch_and_reload(
            &state,
            &dir,
            vec![
                FsOp::Mkdir { path: gdir.clone() },
                FsOp::Write {
                    path: gdir.join("_group.hcl"),
                    contents: hcl.clone(),
                },
            ],
        )?;
        state
            .store
            .config_version_add(&format!("_group/{slug}"), &hcl, &user.email, None)?;
    }

    state.store.audit(
        &user.email,
        "config",
        Some(&slug),
        "group:create",
        Some(&json!({ "slug": slug })),
    );
    Ok((
        StatusCode::CREATED,
        Json(json!({ "ok": true, "reloaded": true })),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchGroup {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    order: Option<i64>,
    #[serde(default)]
    table_order: Option<Vec<String>>,
}

pub async fn patch_group(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(slug): Path<String>,
    Json(body): Json<PatchGroup>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    ensure_slug(&slug)?;
    let cfg = state.cfg();
    let existing = cfg
        .groups
        .iter()
        .find(|g| g.slug == slug)
        .ok_or_else(|| AppError::not_found(format!("group '{slug}' not found")))?;

    let group_cfg = GroupConfig {
        label: body.label.unwrap_or_else(|| existing.label.clone()),
        labels: existing.labels.clone(),
        icon: body.icon.or_else(|| existing.icon.clone()),
        order: body.order.unwrap_or(existing.order),
        table_order: body
            .table_order
            .unwrap_or_else(|| existing.table_order.clone()),
        nav: existing.nav.clone(),
    };
    drop(cfg);
    let hcl = serialize_group(&group_cfg)?;

    let Some(dir) = writable_dir(&state) else {
        return Ok(not_writable(Some(hcl)));
    };

    {
        let _guard = state.config_write_lock.lock().unwrap();
        commit_batch_and_reload(
            &state,
            &dir,
            vec![FsOp::Write {
                path: group_dir(&dir, &slug).join("_group.hcl"),
                contents: hcl.clone(),
            }],
        )?;
        state
            .store
            .config_version_add(&format!("_group/{slug}"), &hcl, &user.email, None)?;
    }

    state.store.audit(
        &user.email,
        "config",
        Some(&slug),
        "group:update",
        Some(&json!({ "slug": slug })),
    );
    Ok(Json(json!({ "ok": true, "reloaded": true })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenameGroup {
    to: String,
}

pub async fn rename_group(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(slug): Path<String>,
    Json(body): Json<RenameGroup>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    ensure_slug(&slug)?;
    let to = body.to.trim().to_string();
    ensure_slug(&to)?;
    if to == slug {
        return Err(AppError::bad("new slug is the same as the current one"));
    }
    let cfg = state.cfg();
    if !cfg.groups.iter().any(|g| g.slug == slug) {
        return Err(AppError::not_found(format!("group '{slug}' not found")));
    }
    if cfg.groups.iter().any(|g| g.slug == to) {
        return Err(AppError(
            StatusCode::CONFLICT,
            format!("group '{to}' already exists"),
        ));
    }
    let group_hcl = std::fs::read_to_string(
        state
            .config_dir
            .as_ref()
            .map(|d| group_dir(d, &slug).join("_group.hcl"))
            .unwrap_or_default(),
    )
    .unwrap_or_default();
    drop(cfg);

    let Some(dir) = writable_dir(&state) else {
        return Ok(not_writable(None));
    };
    let from_dir = group_dir(&dir, &slug);
    let to_dir = from_dir.with_file_name(&to);
    if to_dir.exists() {
        return Err(AppError(
            StatusCode::CONFLICT,
            format!("folder '{to}' already exists"),
        ));
    }

    {
        let _guard = state.config_write_lock.lock().unwrap();
        commit_batch_and_reload(
            &state,
            &dir,
            vec![FsOp::Move {
                from: from_dir,
                to: to_dir,
            }],
        )?;
        if !group_hcl.is_empty() {
            state.store.config_version_add(
                &format!("_group/{to}"),
                &group_hcl,
                &user.email,
                None,
            )?;
        }
    }

    state.store.audit(
        &user.email,
        "config",
        Some(&to),
        "group:rename",
        Some(&json!({ "from": slug, "to": to })),
    );
    Ok(Json(json!({ "ok": true, "reloaded": true })))
}

pub async fn delete_group(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(slug): Path<String>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    ensure_slug(&slug)?;
    let cfg = state.cfg();
    if !cfg.groups.iter().any(|g| g.slug == slug) {
        return Err(AppError::not_found(format!("group '{slug}' not found")));
    }
    let has_members = cfg
        .table_sources
        .values()
        .any(|s| s.group.as_deref() == Some(slug.as_str()))
        || cfg
            .pages
            .iter()
            .any(|p| p.group.as_deref() == Some(slug.as_str()));
    drop(cfg);
    if has_members {
        return Err(AppError(
            StatusCode::CONFLICT,
            format!("group '{slug}' is not empty — reassign members first"),
        ));
    }

    let Some(dir) = writable_dir(&state) else {
        return Ok(not_writable(None));
    };
    let group_dir = group_dir(&dir, &slug);
    if leftover_entries(&group_dir) {
        return Err(AppError(
            StatusCode::CONFLICT,
            format!("group '{slug}' folder still holds config — reassign members first"),
        ));
    }

    {
        let _guard = state.config_write_lock.lock().unwrap();
        commit_batch_and_reload(
            &state,
            &dir,
            vec![
                FsOp::Remove {
                    path: group_dir.join("_group.hcl"),
                },
                FsOp::Rmdir {
                    path: group_dir.clone(),
                },
            ],
        )?;
    }

    state.store.audit(
        &user.email,
        "config",
        Some(&slug),
        "group:delete",
        Some(&json!({ "slug": slug })),
    );
    Ok(Json(json!({ "ok": true, "reloaded": true })))
}

/// True if the folder holds any entry other than its `_group.hcl` — a lingering
/// table config or page subfolder that would be orphaned by a bare rmdir.
fn leftover_entries(group_dir: &FsPath) -> bool {
    let Ok(rd) = std::fs::read_dir(group_dir) else {
        return false;
    };
    rd.filter_map(|e| e.ok())
        .any(|e| e.file_name() != "_group.hcl")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayoutGroup {
    slug: String,
    #[serde(default)]
    tables: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    #[serde(default)]
    groups: Vec<LayoutGroup>,
    #[serde(default)]
    ungrouped: Vec<String>,
}

/// Assign + reorder + move in one atomic save. Every relocated table's `<t>.hcl`
/// is moved between group folders and each touched `_group.hcl` `table_order`
/// rewritten. INVARIANT: a table's DB identity and `/t/:table` URL are its stem,
/// which never changes here — only its enclosing folder (nav placement) does.
pub async fn save_layout(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Json(body): Json<Layout>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    let cfg = state.cfg();

    // A single table may be placed in exactly one destination. Reject a request
    // that assigns the same stem to two DIFFERENT places (two groups, or a group
    // AND ungrouped) BEFORE touching disk, rather than silently last-wins. A stem
    // repeated within one placement is benign and deduped when written.
    let mut placed: std::collections::BTreeMap<&str, Option<&str>> =
        std::collections::BTreeMap::new();
    for g in &body.groups {
        for t in &g.tables {
            match placed.get(t.as_str()) {
                Some(Some(prev)) if *prev == g.slug.as_str() => {}
                Some(_) => {
                    return Err(AppError::bad(format!(
                        "table '{t}' assigned to more than one group"
                    )))
                }
                None => {
                    placed.insert(t.as_str(), Some(g.slug.as_str()));
                }
            }
        }
    }
    for t in &body.ungrouped {
        match placed.get(t.as_str()) {
            Some(None) => {}
            Some(Some(_)) => {
                return Err(AppError::bad(format!(
                    "table '{t}' assigned to more than one group"
                )))
            }
            None => {
                placed.insert(t.as_str(), None);
            }
        }
    }

    let mut desired: std::collections::BTreeMap<String, Option<String>> =
        std::collections::BTreeMap::new();
    for g in &body.groups {
        ensure_slug(&g.slug)?;
        if !cfg.groups.iter().any(|grp| grp.slug == g.slug) {
            return Err(AppError::not_found(format!("group '{}' not found", g.slug)));
        }
        for t in &g.tables {
            if !cfg.table_sources.contains_key(t) {
                return Err(AppError::bad(format!("unknown table '{t}'")));
            }
            desired.insert(t.clone(), Some(g.slug.clone()));
        }
    }
    for t in &body.ungrouped {
        if !cfg.table_sources.contains_key(t) {
            return Err(AppError::bad(format!("unknown table '{t}'")));
        }
        desired.insert(t.clone(), None);
    }

    let Some(dir) = writable_dir(&state) else {
        return Ok(not_writable(None));
    };

    // The full post-save placement of EVERY configured table: its requested
    // destination when named, else where it already lives.
    let mut placement: std::collections::BTreeMap<String, Option<String>> = cfg
        .table_sources
        .iter()
        .map(|(t, s)| (t.clone(), s.group.clone()))
        .collect();
    for (t, want) in &desired {
        placement.insert(t.clone(), want.clone());
    }

    let mut ops: Vec<FsOp> = Vec::new();
    let mut dest_paths: std::collections::BTreeSet<std::path::PathBuf> =
        std::collections::BTreeSet::new();
    // Every group that lost or gained a member must have its `table_order`
    // reconciled — including a source group omitted from the request, whose
    // `_group.hcl` would otherwise keep listing a stem that moved away.
    let mut affected_groups: std::collections::BTreeSet<String> =
        body.groups.iter().map(|g| g.slug.clone()).collect();
    for (table, want_group) in &desired {
        let src = &cfg.table_sources[table];
        let current = src.group.clone();
        if &current == want_group {
            continue;
        }
        if let Some(sg) = &current {
            affected_groups.insert(sg.clone());
        }
        if let Some(dg) = want_group {
            affected_groups.insert(dg.clone());
        }
        let stem = crate::configedit::safe_stem(table)?;
        // A `screen.hcl` table is a folder — the folder moves whole (keeps its
        // module files). A flat `<t>.hcl` moving into a screens-layout group is
        // converted to the folder form (a bare stem under screens/ is rejected
        // by the loader).
        let src_is_screen = src.path.file_name().is_some_and(|n| n == "screen.hcl");
        let from = if src_is_screen {
            src.path
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| src.path.clone())
        } else {
            src.path.clone()
        };
        let mut mkdir: Option<std::path::PathBuf> = None;
        let to = match want_group {
            Some(slug) => {
                let gd = group_dir(&dir, slug);
                let in_screens = gd.starts_with(dir.join("screens"));
                if src_is_screen {
                    gd.join(stem)
                } else if in_screens {
                    let td = gd.join(stem);
                    mkdir = Some(td.clone());
                    td.join("screen.hcl")
                } else {
                    gd.join(format!("{stem}.hcl"))
                }
            }
            None => {
                // Ungrouped folder-form tables live under the config's root
                // convention — screens/ when it exists, else the dir root.
                let root = if dir.join("screens").is_dir() {
                    dir.join("screens")
                } else {
                    dir.clone()
                };
                if src_is_screen {
                    root.join(stem)
                } else {
                    dir.join(format!("{stem}.hcl"))
                }
            }
        };
        // A moved stem must not land on an existing DIFFERENT file or folder in
        // the destination — that would trip the loader's duplicate-table error
        // (or silently merge into a page's folder).
        if to != from && to.exists() {
            return Err(AppError(
                StatusCode::CONFLICT,
                format!("'{stem}' already exists in the destination group"),
            ));
        }
        if let Some(d) = &mkdir {
            if d.exists() {
                return Err(AppError(
                    StatusCode::CONFLICT,
                    format!("folder '{stem}' already exists in the destination group"),
                ));
            }
        }
        if !dest_paths.insert(to.clone()) {
            return Err(AppError(
                StatusCode::CONFLICT,
                format!("two tables target the same destination '{stem}'"),
            ));
        }
        if let Some(d) = mkdir {
            ops.push(FsOp::Mkdir { path: d });
        }
        ops.push(FsOp::Move { from, to });
    }

    let requested_order: std::collections::BTreeMap<&str, &[String]> = body
        .groups
        .iter()
        .map(|g| (g.slug.as_str(), g.tables.as_slice()))
        .collect();

    let mut touched_groups: Vec<(String, String)> = Vec::new();
    for slug in &affected_groups {
        let Some(existing) = cfg.groups.iter().find(|grp| &grp.slug == slug) else {
            continue;
        };
        let members: std::collections::BTreeSet<String> = placement
            .iter()
            .filter(|(_, g)| g.as_deref() == Some(slug.as_str()))
            .map(|(t, _)| t.clone())
            .collect();
        let preferred: &[String] = requested_order
            .get(slug.as_str())
            .copied()
            .unwrap_or(existing.table_order.as_slice());
        let group_cfg = GroupConfig {
            label: existing.label.clone(),
            labels: existing.labels.clone(),
            icon: existing.icon.clone(),
            order: existing.order,
            table_order: reconcile_order(&members, preferred),
            nav: existing.nav.clone(),
        };
        let hcl = serialize_group(&group_cfg)?;
        ops.push(FsOp::Write {
            path: group_dir(&dir, slug).join("_group.hcl"),
            contents: hcl.clone(),
        });
        touched_groups.push((slug.clone(), hcl));
    }
    drop(cfg);

    if ops.is_empty() {
        return Ok(Json(json!({ "ok": true, "reloaded": true })));
    }

    {
        let _guard = state.config_write_lock.lock().unwrap();
        commit_batch_and_reload(&state, &dir, ops)?;
        for (slug, hcl) in &touched_groups {
            state
                .store
                .config_version_add(&format!("_group/{slug}"), hcl, &user.email, None)?;
        }
    }

    state.store.audit(
        &user.email,
        "config",
        None,
        "group:layout",
        Some(&json!({ "moved": desired.len() })),
    );
    Ok(Json(json!({ "ok": true, "reloaded": true })))
}

/// A group's `table_order` for its resulting members: those named in `preferred`
/// first (deduped, in that order), then any remaining members alphabetically.
/// Only members actually in the folder are emitted — a stem whose file no longer
/// lives here is never written back into `table_order`.
fn reconcile_order(
    members: &std::collections::BTreeSet<String>,
    preferred: &[String],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in preferred {
        if members.contains(t) && !out.contains(t) {
            out.push(t.clone());
        }
    }
    let mut rest: Vec<String> = members
        .iter()
        .filter(|t| !out.contains(*t))
        .cloned()
        .collect();
    rest.sort();
    out.extend(rest);
    out
}

fn serialize_group(g: &GroupConfig) -> Result<String, AppError> {
    hcl::to_string(g).map_err(|e| AppError::internal(format!("serialize group config: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::configedit::test_support::{admin, state_with_tables, tmp_dir, viewer};

    fn seed_group(dir: &FsPath, slug: &str, label: &str) {
        let gdir = dir.join(slug);
        std::fs::create_dir_all(&gdir).unwrap();
        std::fs::write(
            gdir.join("_group.hcl"),
            format!("label = \"{label}\"\norder = 1\n"),
        )
        .unwrap();
    }

    fn seed_table(dir: &FsPath, group: Option<&str>, stem: &str, label: &str) {
        let path = match group {
            Some(g) => dir.join(g).join(format!("{stem}.hcl")),
            None => dir.join(format!("{stem}.hcl")),
        };
        std::fs::write(path, format!("label = \"{label}\"\n")).unwrap();
    }

    #[tokio::test]
    async fn create_patch_and_list() {
        let dir = tmp_dir();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        let (code, _) = create_group(
            axum::extract::State(state.clone()),
            admin(),
            Json(CreateGroup {
                slug: "trading".into(),
                label: "Trading".into(),
                icon: Some("chart".into()),
                order: Some(2),
            }),
        )
        .await
        .unwrap();
        assert_eq!(code, StatusCode::CREATED);
        assert!(dir.join("trading").join("_group.hcl").exists());
        assert!(state.cfg().groups.iter().any(|g| g.slug == "trading"));

        let _ = patch_group(
            axum::extract::State(state.clone()),
            admin(),
            Path("trading".into()),
            Json(PatchGroup {
                label: Some("Trading desk".into()),
                icon: None,
                order: Some(5),
                table_order: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            state.cfg().group_label("trading").as_deref(),
            Some("Trading desk")
        );
        assert_eq!(
            state
                .cfg()
                .groups
                .iter()
                .find(|g| g.slug == "trading")
                .and_then(|g| g.icon.as_deref()),
            Some("chart"),
            "patching only the label preserves the previously-set icon",
        );

        let out = list_groups(axum::extract::State(state), admin())
            .await
            .unwrap()
            .0;
        assert!(out["groups"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["slug"] == "trading"));
        assert!(out["unconfigured"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t == "bots"));
    }

    #[tokio::test]
    async fn create_duplicate_is_409() {
        let dir = tmp_dir();
        seed_group(&dir, "trading", "Trading");
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        let r = create_group(
            axum::extract::State(state),
            admin(),
            Json(CreateGroup {
                slug: "trading".into(),
                label: "Trading".into(),
                icon: None,
                order: None,
            }),
        )
        .await;
        assert!(matches!(r, Err(AppError(StatusCode::CONFLICT, _))));
    }

    #[tokio::test]
    async fn rename_relocates_folder() {
        let dir = tmp_dir();
        seed_group(&dir, "trading", "Trading");
        seed_table(&dir, Some("trading"), "bots", "Bots");
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        assert_eq!(
            state.cfg().table_group_label("bots").as_deref(),
            Some("Trading")
        );

        let _ = rename_group(
            axum::extract::State(state.clone()),
            admin(),
            Path("trading".into()),
            Json(RenameGroup { to: "desk".into() }),
        )
        .await
        .unwrap();
        assert!(!dir.join("trading").exists());
        assert!(dir.join("desk").join("bots.hcl").exists());
        // Table identity unchanged: still keyed "bots", now under the new group.
        assert!(state.cfg().tables.contains_key("bots"));
        assert_eq!(
            state
                .cfg()
                .table_sources
                .get("bots")
                .and_then(|s| s.group.as_deref()),
            Some("desk"),
        );
    }

    #[tokio::test]
    async fn rename_to_existing_is_409() {
        let dir = tmp_dir();
        seed_group(&dir, "a", "A");
        seed_group(&dir, "b", "B");
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        let r = rename_group(
            axum::extract::State(state),
            admin(),
            Path("a".into()),
            Json(RenameGroup { to: "b".into() }),
        )
        .await;
        assert!(matches!(r, Err(AppError(StatusCode::CONFLICT, _))));
    }

    #[tokio::test]
    async fn delete_empty_and_reject_nonempty() {
        let dir = tmp_dir();
        seed_group(&dir, "empty", "Empty");
        seed_group(&dir, "full", "Full");
        seed_table(&dir, Some("full"), "bots", "Bots");
        let state = state_with_tables(Some(dir.clone()), &["bots"]);

        let bad = delete_group(
            axum::extract::State(state.clone()),
            admin(),
            Path("full".into()),
        )
        .await;
        assert!(matches!(bad, Err(AppError(StatusCode::CONFLICT, _))));
        assert!(dir.join("full").exists());

        let _ = delete_group(
            axum::extract::State(state.clone()),
            admin(),
            Path("empty".into()),
        )
        .await
        .unwrap();
        assert!(!dir.join("empty").exists());
        assert!(!state.cfg().groups.iter().any(|g| g.slug == "empty"));
    }

    #[tokio::test]
    async fn layout_move_preserves_identity_and_regroups() {
        let dir = tmp_dir();
        seed_group(&dir, "a", "A");
        seed_group(&dir, "b", "B");
        seed_table(&dir, Some("a"), "bots", "Bots");
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        assert_eq!(
            state
                .cfg()
                .table_sources
                .get("bots")
                .and_then(|s| s.group.as_deref()),
            Some("a")
        );

        let out = save_layout(
            axum::extract::State(state.clone()),
            admin(),
            Json(Layout {
                groups: vec![
                    LayoutGroup {
                        slug: "a".into(),
                        tables: vec![],
                    },
                    LayoutGroup {
                        slug: "b".into(),
                        tables: vec!["bots".into()],
                    },
                ],
                ungrouped: vec![],
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(out["ok"], json!(true));
        assert!(!dir.join("a").join("bots.hcl").exists());
        assert!(dir.join("b").join("bots.hcl").exists());
        // /t/bots URL identity is the stem — unchanged; only the nav group moved.
        assert!(state.cfg().tables.contains_key("bots"));
        assert_eq!(
            state
                .cfg()
                .table_sources
                .get("bots")
                .and_then(|s| s.group.as_deref()),
            Some("b"),
        );
        assert_eq!(state.cfg().table_group_label("bots").as_deref(), Some("B"));
    }

    #[tokio::test]
    async fn layout_move_in_screens_layout_moves_the_table_folder() {
        let dir = tmp_dir();
        let screens = dir.join("screens");
        for (g, label) in [("a", "A"), ("b", "B")] {
            let gd = screens.join(g);
            std::fs::create_dir_all(&gd).unwrap();
            std::fs::write(
                gd.join("_group.hcl"),
                format!("label = \"{label}\"\norder = 1\n"),
            )
            .unwrap();
        }
        let td = screens.join("a").join("bots");
        std::fs::create_dir_all(&td).unwrap();
        std::fs::write(td.join("screen.hcl"), "label = \"Bots\"\n").unwrap();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        assert_eq!(
            state
                .cfg()
                .table_sources
                .get("bots")
                .and_then(|s| s.group.as_deref()),
            Some("a")
        );

        let out = save_layout(
            axum::extract::State(state.clone()),
            admin(),
            Json(Layout {
                groups: vec![
                    LayoutGroup {
                        slug: "a".into(),
                        tables: vec![],
                    },
                    LayoutGroup {
                        slug: "b".into(),
                        tables: vec!["bots".into()],
                    },
                ],
                ungrouped: vec![],
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(out["ok"], json!(true));
        // The folder moved whole, stayed inside screens/, and NO flat fork
        // (dir/b/, dir/b/_group.hcl) was created.
        assert!(!screens.join("a").join("bots").exists());
        assert!(screens.join("b").join("bots").join("screen.hcl").exists());
        assert!(!dir.join("b").exists());
        assert_eq!(
            state
                .cfg()
                .table_sources
                .get("bots")
                .and_then(|s| s.group.as_deref()),
            Some("b"),
        );
    }

    #[tokio::test]
    async fn flat_table_moved_into_screens_group_converts_to_folder_form() {
        let dir = tmp_dir();
        let gd = dir.join("screens").join("a");
        std::fs::create_dir_all(&gd).unwrap();
        std::fs::write(gd.join("_group.hcl"), "label = \"A\"\norder = 1\n").unwrap();
        seed_table(&dir, None, "bots", "Bots");
        let state = state_with_tables(Some(dir.clone()), &["bots"]);

        let out = save_layout(
            axum::extract::State(state.clone()),
            admin(),
            Json(Layout {
                groups: vec![LayoutGroup {
                    slug: "a".into(),
                    tables: vec!["bots".into()],
                }],
                ungrouped: vec![],
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(out["ok"], json!(true));
        assert!(!dir.join("bots.hcl").exists());
        assert!(dir
            .join("screens")
            .join("a")
            .join("bots")
            .join("screen.hcl")
            .exists());
        assert_eq!(
            state
                .cfg()
                .table_sources
                .get("bots")
                .and_then(|s| s.group.as_deref()),
            Some("a"),
        );
    }

    #[tokio::test]
    async fn layout_collision_is_409() {
        let dir = tmp_dir();
        seed_group(&dir, "a", "A");
        seed_group(&dir, "b", "B");
        seed_table(&dir, Some("a"), "bots", "Bots");
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        // An orphan file lands at the destination AFTER load — the pre-check reads
        // disk, so it must reject the move that would collide with it.
        seed_table(&dir, Some("b"), "bots", "Other");

        let r = save_layout(
            axum::extract::State(state),
            admin(),
            Json(Layout {
                groups: vec![LayoutGroup {
                    slug: "b".into(),
                    tables: vec!["bots".into()],
                }],
                ungrouped: vec![],
            }),
        )
        .await;
        assert!(matches!(r, Err(AppError(StatusCode::CONFLICT, _))));
    }

    #[tokio::test]
    async fn layout_table_in_two_groups_is_400() {
        let dir = tmp_dir();
        seed_group(&dir, "a", "A");
        seed_group(&dir, "b", "B");
        seed_table(&dir, Some("a"), "bots", "Bots");
        let state = state_with_tables(Some(dir.clone()), &["bots"]);

        let r = save_layout(
            axum::extract::State(state),
            admin(),
            Json(Layout {
                groups: vec![
                    LayoutGroup {
                        slug: "a".into(),
                        tables: vec!["bots".into()],
                    },
                    LayoutGroup {
                        slug: "b".into(),
                        tables: vec!["bots".into()],
                    },
                ],
                ungrouped: vec![],
            }),
        )
        .await;
        assert!(matches!(r, Err(AppError(StatusCode::BAD_REQUEST, _))));
    }

    /// Moving a table to ungrouped while its source group is OMITTED from the
    /// request still strips the stale stem from the source `_group.hcl`, and the
    /// table keeps its bare-stem `/t/:table` identity under the root.
    #[tokio::test]
    async fn layout_move_to_ungrouped_strips_stale_source_order() {
        let dir = tmp_dir();
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::write(
            dir.join("a").join("_group.hcl"),
            "label = \"A\"\norder = 1\ntable_order = [\"bots\", \"other\"]\n",
        )
        .unwrap();
        seed_table(&dir, Some("a"), "bots", "Bots");
        seed_table(&dir, Some("a"), "other", "Other");
        let state = state_with_tables(Some(dir.clone()), &["bots", "other"]);

        let out = save_layout(
            axum::extract::State(state.clone()),
            admin(),
            Json(Layout {
                groups: vec![],
                ungrouped: vec!["bots".into()],
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(out["ok"], json!(true));
        assert!(dir.join("bots.hcl").exists(), "moved to root");
        assert!(!dir.join("a").join("bots.hcl").exists());

        let ghcl = std::fs::read_to_string(dir.join("a").join("_group.hcl")).unwrap();
        assert!(
            !ghcl.contains("\"bots\""),
            "stale stem stripped from source order:\n{ghcl}"
        );
        assert!(ghcl.contains("\"other\""), "remaining member kept");

        assert!(
            state.cfg().tables.contains_key("bots"),
            "same /t/bots identity"
        );
        assert_eq!(
            state
                .cfg()
                .table_sources
                .get("bots")
                .and_then(|s| s.group.as_deref()),
            None,
            "now ungrouped",
        );
    }

    #[tokio::test]
    async fn layout_dedups_repeated_stem_in_table_order() {
        let dir = tmp_dir();
        seed_group(&dir, "a", "A");
        seed_table(&dir, Some("a"), "bots", "Bots");
        let state = state_with_tables(Some(dir.clone()), &["bots"]);

        let out = save_layout(
            axum::extract::State(state.clone()),
            admin(),
            Json(Layout {
                groups: vec![LayoutGroup {
                    slug: "a".into(),
                    tables: vec!["bots".into(), "bots".into()],
                }],
                ungrouped: vec![],
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(out["ok"], json!(true));
        let ghcl = std::fs::read_to_string(dir.join("a").join("_group.hcl")).unwrap();
        assert_eq!(
            ghcl.matches("\"bots\"").count(),
            1,
            "table_order deduped:\n{ghcl}"
        );
    }

    /// Renaming a group moves the WHOLE folder, including a co-located page
    /// subfolder and `queries.hcl` — both still load under the new group slug.
    #[tokio::test]
    async fn rename_carries_page_and_queries() {
        let dir = tmp_dir();
        seed_group(&dir, "trading", "Trading");
        std::fs::write(
            dir.join("trading").join("queries.hcl"),
            "query \"trading_fleet\" { sql = \"SELECT 1\" }\n",
        )
        .unwrap();
        let page_dir = dir.join("trading").join("ops");
        std::fs::create_dir_all(&page_dir).unwrap();
        std::fs::write(
            page_dir.join("page.hcl"),
            "label = \"Ops\"\npanel {\n  type = \"stat\"\n  label = \"X\"\n  sql = \"SELECT 1 AS v\"\n}\n",
        )
        .unwrap();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        assert!(state.cfg().queries.contains_key("trading_fleet"));
        assert!(state.cfg().pages.iter().any(|p| p.id() == "trading/ops"));

        let _ = rename_group(
            axum::extract::State(state.clone()),
            admin(),
            Path("trading".into()),
            Json(RenameGroup { to: "desk".into() }),
        )
        .await
        .unwrap();
        assert!(!dir.join("trading").exists());
        assert!(dir.join("desk").join("ops").join("page.hcl").exists());
        assert!(dir.join("desk").join("queries.hcl").exists());
        assert!(
            state.cfg().queries.contains_key("trading_fleet"),
            "query still registered"
        );
        assert!(
            state.cfg().pages.iter().any(|p| p.id() == "desk/ops"),
            "page re-ids under the renamed group",
        );
    }

    #[tokio::test]
    async fn read_only_dir_writes_no_audit_or_version() {
        let state = state_with_tables(None, &["bots"]);
        let (_, out) = create_group(
            axum::extract::State(state.clone()),
            admin(),
            Json(CreateGroup {
                slug: "trading".into(),
                label: "Trading".into(),
                icon: None,
                order: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(out.0["ok"], json!(false));
        assert_eq!(out.0["writable"], json!(false));
        assert!(
            state.store.config_versions_list("_group/trading").unwrap()["versions"]
                .as_array()
                .unwrap()
                .is_empty(),
            "no version snapshot on a read-only dir",
        );
    }

    #[tokio::test]
    async fn admin_gate_blocks_non_admin() {
        let state = state_with_tables(Some(tmp_dir()), &["bots"]);
        let r = list_groups(axum::extract::State(state), viewer()).await;
        assert!(matches!(r, Err(AppError(StatusCode::FORBIDDEN, _))));
    }

    #[tokio::test]
    async fn invalid_slug_rejected() {
        let dir = tmp_dir();
        let state = state_with_tables(Some(dir), &["bots"]);
        let r = create_group(
            axum::extract::State(state),
            admin(),
            Json(CreateGroup {
                slug: "config".into(),
                label: "x".into(),
                icon: None,
                order: None,
            }),
        )
        .await;
        assert!(matches!(r, Err(AppError(StatusCode::BAD_REQUEST, _))));
    }
}
