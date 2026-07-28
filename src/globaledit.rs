use crate::config::{DashboardConfig, PanelConfig, PanelKind};
use crate::configedit::admin_only;
use crate::state::{AppError, AppState, CurrentUser};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const DASHBOARD_KEY: &str = "config/dashboard";

fn validate_panel(w: &PanelConfig) -> Result<(), AppError> {
    let blank = |o: &Option<String>| o.as_deref().map(str::trim).unwrap_or("").is_empty();
    match w.kind {
        PanelKind::Stat | PanelKind::Chart | PanelKind::Table => {
            if blank(&w.sql) {
                return Err(AppError::bad(format!(
                    "widget '{}' requires `sql`",
                    w.label
                )));
            }
        }
        PanelKind::Iframe => {
            if blank(&w.url) {
                return Err(AppError::bad(format!(
                    "iframe widget '{}' requires `url`",
                    w.label
                )));
            }
        }
    }
    Ok(())
}

pub async fn get_dashboard(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    let cfg = state.cfg();
    let writable = state
        .config_dir
        .as_deref()
        .map(crate::configedit::dir_writable)
        .unwrap_or(false);

    let hcl_text = match state.config_dir.as_deref() {
        Some(dir) => match std::fs::read_to_string(dir.join("config").join("dashboard.hcl")) {
            Ok(raw) => raw,
            Err(_) => hcl::to_string(&cfg.dashboard).unwrap_or_default(),
        },
        None => hcl::to_string(&cfg.dashboard).unwrap_or_default(),
    };
    Ok(Json(json!({
        "writable": writable,
        "widgets": cfg.dashboard.widgets,
        "columns": cfg.dashboard.columns,
        "hcl": hcl_text,
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutDashboard {
    widgets: Vec<PanelConfig>,
    #[serde(default)]
    columns: Option<u8>,
    /// Carried through the editor so saving the layout cannot silently drop a
    /// refresh the config author set by hand.
    #[serde(default)]
    refresh: Option<String>,
}

pub async fn put_dashboard(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Json(body): Json<PutDashboard>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    for w in &body.widgets {
        validate_panel(w)?;
    }
    crate::config::validate_panel_fields(&body.widgets).map_err(AppError::bad)?;
    let dashboard = DashboardConfig {
        columns: body.columns,
        refresh: body.refresh,
        widgets: body.widgets,
    };
    let hcl = hcl::to_string(&dashboard)
        .map_err(|e| AppError::internal(format!("serialize dashboard: {e}")))?;
    crate::config::reject_duplicate_labels(&hcl).map_err(AppError::bad)?;

    let writable = state
        .config_dir
        .as_deref()
        .map(crate::configedit::dir_writable)
        .unwrap_or(false);
    let Some(dir) = state.config_dir.clone().filter(|_| writable) else {
        return Ok(Json(json!({ "ok": false, "writable": false, "hcl": hcl })));
    };

    {
        let _guard = state.config_write_lock.lock().unwrap();
        let _ = std::fs::create_dir_all(dir.join("config"));
        let path = dir.join("config").join("dashboard.hcl");
        crate::configedit::commit_and_reload(&state, &path, &dir, &hcl)?;
        state
            .store
            .config_version_add(DASHBOARD_KEY, &hcl, &user.email, None)?;
    }

    state.store.audit(
        &user.email,
        "config",
        Some("dashboard"),
        "dashboard:update",
        None,
    );
    Ok(Json(json!({ "ok": true, "reloaded": true })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewWidget {
    widget: PanelConfig,
}

pub async fn preview_panel(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Json(body): Json<PreviewWidget>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    if state.cfg().cartapel.disable_sql_preview {
        return Err(AppError::forbidden("ad-hoc SQL preview is disabled"));
    }
    validate_panel(&body.widget)?;
    let env = crate::vars::resolve(&state, &user, &Default::default()).await?;
    let rendered = crate::dashboard::render_panel(&state, &user, &body.widget, "preview", &env)
        .await
        .unwrap_or(Value::Null);
    Ok(Json(json!({ "widget": rendered })))
}

pub async fn list_dashboard_versions(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    Ok(Json(state.store.config_versions_list(DASHBOARD_KEY)?))
}

pub async fn get_dashboard_version(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    match state.store.config_version_get(DASHBOARD_KEY, id) {
        Some(hcl) => Ok(Json(json!({ "hcl": hcl }))),
        None => Err(AppError::not_found("no such dashboard version")),
    }
}

pub async fn publish_dashboard_version(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    admin_only(&user)?;
    let hcl = state
        .store
        .config_version_get(DASHBOARD_KEY, id)
        .ok_or_else(|| AppError::not_found("no such dashboard version"))?;
    hcl::from_str::<DashboardConfig>(&hcl)
        .map_err(|e| AppError::bad(format!("stored dashboard no longer valid: {e}")))?;

    let writable = state
        .config_dir
        .as_deref()
        .map(crate::configedit::dir_writable)
        .unwrap_or(false);
    let Some(dir) = state.config_dir.clone().filter(|_| writable) else {
        return Ok(Json(json!({ "ok": false, "writable": false, "hcl": hcl })));
    };

    {
        let _guard = state.config_write_lock.lock().unwrap();
        let _ = std::fs::create_dir_all(dir.join("config"));
        let path = dir.join("config").join("dashboard.hcl");
        crate::configedit::commit_and_reload(&state, &path, &dir, &hcl)?;
        state.store.config_version_publish(DASHBOARD_KEY, id);
    }

    state.store.audit(
        &user.email,
        "config",
        Some("dashboard"),
        "dashboard:publish",
        Some(&json!({ "version": id })),
    );
    Ok(Json(json!({ "ok": true, "reloaded": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PanelConfig;
    use crate::configedit::test_support::{admin, state_with_tables, tmp_dir, viewer};

    fn iframe(label: &str, url: &str) -> PanelConfig {
        hcl::from_str(&format!(
            "type = \"iframe\"\nlabel = \"{label}\"\nurl = \"{url}\"\n"
        ))
        .unwrap()
    }

    #[tokio::test]
    async fn put_writes_and_reloads() {
        let dir = tmp_dir();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        let p = put_dashboard(
            axum::extract::State(state.clone()),
            admin(),
            Json(PutDashboard {
                refresh: None,
                widgets: vec![iframe("Docs", "https://x.io")],
                columns: None,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(p["ok"], json!(true));
        assert_eq!(p["reloaded"], json!(true));
        assert!(dir.join("config").join("dashboard.hcl").exists());
        assert_eq!(state.cfg().dashboard.widgets.len(), 1);
        assert_eq!(state.cfg().dashboard.widgets[0].label, "Docs");
    }

    #[tokio::test]
    async fn invalid_widget_missing_sql_is_400() {
        let dir = tmp_dir();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        let bad: PanelConfig = hcl::from_str("type = \"stat\"\nlabel = \"Count\"\n").unwrap();
        let p = put_dashboard(
            axum::extract::State(state),
            admin(),
            Json(PutDashboard {
                refresh: None,
                widgets: vec![bad],
                columns: None,
            }),
        )
        .await;
        assert!(matches!(
            p,
            Err(AppError(axum::http::StatusCode::BAD_REQUEST, _))
        ));
        assert!(!dir.join("config").join("dashboard.hcl").exists());
    }

    #[tokio::test]
    async fn preview_runs_without_writing() {
        let dir = tmp_dir();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        let out = preview_panel(
            axum::extract::State(state.clone()),
            admin(),
            Json(PreviewWidget {
                widget: iframe("Docs", "https://x.io"),
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(out["widget"]["type"], json!("iframe"));
        assert_eq!(out["widget"]["url"], json!("https://x.io"));
        assert!(
            !dir.join("config").join("dashboard.hcl").exists(),
            "preview never writes"
        );
        assert!(
            state.store.config_versions_list(DASHBOARD_KEY).unwrap()["versions"]
                .as_array()
                .unwrap()
                .is_empty(),
            "preview snapshots nothing",
        );
    }

    #[tokio::test]
    async fn admin_gate_blocks_non_admin() {
        let state = state_with_tables(Some(tmp_dir()), &["bots"]);
        let g = get_dashboard(axum::extract::State(state.clone()), viewer()).await;
        assert!(matches!(
            g,
            Err(AppError(axum::http::StatusCode::FORBIDDEN, _))
        ));
        let p = put_dashboard(
            axum::extract::State(state),
            viewer(),
            Json(PutDashboard {
                refresh: None,
                widgets: vec![],
                columns: None,
            }),
        )
        .await;
        assert!(matches!(
            p,
            Err(AppError(axum::http::StatusCode::FORBIDDEN, _))
        ));
    }

    #[tokio::test]
    async fn version_publish_restores() {
        let dir = tmp_dir();
        let state = state_with_tables(Some(dir.clone()), &["bots"]);
        let _ = put_dashboard(
            axum::extract::State(state.clone()),
            admin(),
            Json(PutDashboard {
                refresh: None,
                widgets: vec![iframe("One", "https://one.io")],
                columns: None,
            }),
        )
        .await
        .unwrap();
        let _ = put_dashboard(
            axum::extract::State(state.clone()),
            admin(),
            Json(PutDashboard {
                refresh: None,
                widgets: vec![iframe("Two", "https://two.io")],
                columns: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(state.cfg().dashboard.widgets[0].label, "Two");

        let list = list_dashboard_versions(axum::extract::State(state.clone()), admin())
            .await
            .unwrap()
            .0;
        let old_id = list["versions"].as_array().unwrap()[1]["id"]
            .as_i64()
            .unwrap();

        let p =
            publish_dashboard_version(axum::extract::State(state.clone()), admin(), Path(old_id))
                .await
                .unwrap()
                .0;
        assert_eq!(p["ok"], json!(true));
        assert_eq!(state.cfg().dashboard.widgets[0].label, "One");
    }

    #[tokio::test]
    async fn no_config_dir_reports_not_writable() {
        let state = state_with_tables(None, &["bots"]);
        let p = put_dashboard(
            axum::extract::State(state),
            admin(),
            Json(PutDashboard {
                refresh: None,
                widgets: vec![iframe("Docs", "https://x.io")],
                columns: None,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(p["ok"], json!(false));
        assert_eq!(p["writable"], json!(false));
    }
}
