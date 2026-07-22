use crate::state::{AppError, AppState, CurrentUser};
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use sqlx::Row;
use std::path::PathBuf;
use std::sync::Arc;

const QUERY_CAP: i64 = 1000;

const FORBIDDEN_EXT: [&str; 4] = ["hcl", "toml", "env", "ini"];

fn content_type(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        // .ts/.tsx page modules are transpiled by the frontend loader (widgets.ts).
        "ts" | "tsx" => "text/plain; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// Serve a static asset that lives INSIDE the config bundle, addressed by an
/// admin-relative path. The resolved file must stay within the canonical config
/// dir (traversal + symlink-escape rejected), carry an allowlisted extension, and
/// never be config/secret material (`.hcl`/`.toml`/`.env`/dotfiles).
pub async fn serve_static(State(state): State<Arc<AppState>>, Path(path): Path<String>) -> Response {
    let Some(dir) = &state.config_dir else {
        return (StatusCode::NOT_FOUND, "no config dir").into_response();
    };
    if path
        .split('/')
        .any(|seg| {
            seg.is_empty() || seg == ".." || seg.starts_with('.') || seg.contains('\\')
        })
    {
        return (StatusCode::BAD_REQUEST, "bad asset path").into_response();
    }
    let ext = PathBuf::from(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if FORBIDDEN_EXT.contains(&ext.as_str()) {
        return (StatusCode::BAD_REQUEST, "forbidden asset type").into_response();
    }
    let Some(ct) = content_type(&ext) else {
        return (StatusCode::BAD_REQUEST, "unsupported asset type").into_response();
    };
    let (real, base) = match (dir.join(&path).canonicalize(), dir.canonicalize()) {
        (Ok(real), Ok(base)) => (real, base),
        _ => return (StatusCode::NOT_FOUND, "asset not found").into_response(),
    };
    if !real.starts_with(&base) {
        return (StatusCode::BAD_REQUEST, "asset path escapes config dir").into_response();
    }
    match tokio::fs::read(&real).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, ct.to_string()),
                (header::CACHE_CONTROL, "no-cache".to_string()),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "asset not found").into_response(),
    }
}

pub async fn named_query(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(name): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, AppError> {
    let (sql, source) = {
        let cfg = state.cfg();
        let q = cfg
            .queries
            .get(&name)
            .ok_or_else(|| AppError::not_found(format!("unknown query {name}")))?;
        if !user.is_admin() && (q.roles.is_empty() || !q.roles.contains(&user.role)) {
            return Err(AppError::forbidden("query not allowed for your role"));
        }
        (q.sql.clone(), q.source.clone())
    };

    let env = crate::vars::resolve(&state, &user, &params).await?;
    let (sql, binds) =
        crate::interp::interpolate(&sql, &env.types, &env.values).map_err(AppError::bad)?;

    let mut tx = state.pool_for(source.as_deref()).begin().await?;
    sqlx::query("SET TRANSACTION READ ONLY").execute(&mut *tx).await?;
    sqlx::query("SET LOCAL statement_timeout = '8000ms'")
        .execute(&mut *tx)
        .await?;
    let wrapped = format!(
        "SELECT coalesce(json_agg(row_to_json(sub.*)), '[]'::json) AS r FROM ({sql}) sub LIMIT {QUERY_CAP}"
    );
    let row = crate::interp::bind_all(sqlx::query(&wrapped), &binds).fetch_one(&mut *tx).await?;
    let _ = tx.rollback().await;
    let rows: Value = row.get("r");
    Ok(Json(json!({ "rows": rows })))
}

/// `GET /source/:name` — proxy a configured external source (no sub-path).
pub async fn named_source_root(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path(name): Path<String>,
) -> Result<Response, AppError> {
    proxy_source(&state, &user, &name, "").await
}

/// `GET /source/:name/*rest` — proxy a configured external source, appending
/// `rest` to its base url. steward attaches the secret server-side.
pub async fn named_source(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    Path((name, rest)): Path<(String, String)>,
) -> Result<Response, AppError> {
    proxy_source(&state, &user, &name, &rest).await
}

async fn proxy_source(
    state: &Arc<AppState>,
    user: &CurrentUser,
    name: &str,
    rest: &str,
) -> Result<Response, AppError> {
    let cfg = state.cfg();
    let src = cfg
        .sources
        .get(name)
        .ok_or_else(|| AppError::not_found(format!("unknown source {name}")))?;
    // Same role gate as named_query: non-admins need an explicit role match.
    if !user.is_admin() && (src.roles.is_empty() || !src.roles.contains(&user.role)) {
        return Err(AppError::forbidden("source not allowed for your role"));
    }
    match src.kind.as_str() {
        "http" => {
            if rest.contains("..") {
                return Err(AppError::bad("bad source path"));
            }
            let base = src.url.trim_end_matches('/');
            let url = if rest.is_empty() {
                base.to_string()
            } else {
                format!("{base}/{}", rest.trim_start_matches('/'))
            };
            let mut req = state.http.get(&url).timeout(std::time::Duration::from_secs(15));
            if let Some(env_name) = &src.token_env {
                if let Ok(tok) = std::env::var(env_name) {
                    let hdr = src.header.as_deref().unwrap_or("x-admin-token");
                    req = req.header(hdr, tok);
                }
            }
            let resp = req
                .send()
                .await
                .map_err(|e| AppError::internal(format!("source {name} failed: {e}")))?;
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = resp
                .bytes()
                .await
                .map_err(|e| AppError::internal(e.to_string()))?;
            Ok((status, [(header::CONTENT_TYPE, "application/json")], body).into_response())
        }
        other => Err(AppError::bad(format!("unsupported source type \"{other}\""))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header::CONTENT_TYPE;

    fn asset_state(dir: PathBuf) -> Arc<AppState> {
        let pg = sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://x").unwrap();
        Arc::new(AppState {
            pools: Default::default(),
            dbs: Default::default(),
            pg,
            schema: "public".into(),
            db: crate::introspect::Schema::default(),
            cfg: arc_swap::ArcSwap::from_pointee(crate::config::ConfigDir::default()),
            config_dir: Some(dir),
            store: crate::store::Store::open_memory(),
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

    fn bundle() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("steward-asset-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("overview").join("ops")).unwrap();
        std::fs::create_dir_all(root.join("config").join("widgets")).unwrap();
        std::fs::write(root.join("overview").join("ops").join("ops.js"), "export default 1;").unwrap();
        std::fs::write(root.join("overview").join("ops").join("page.hcl"), "label = \"Ops\"\n").unwrap();
        std::fs::write(root.join("config").join("widgets").join("minibar.js"), "export const minibar = 1;").unwrap();
        root
    }

    async fn get(dir: &PathBuf, path: &str) -> Response {
        serve_static(State(asset_state(dir.clone())), Path(path.to_string())).await
    }

    #[tokio::test]
    async fn serves_colocated_page_module_and_shared_widget_kind() {
        let dir = bundle();
        let ops = get(&dir, "overview/ops/ops.js").await;
        assert_eq!(ops.status(), StatusCode::OK);
        assert_eq!(
            ops.headers().get(CONTENT_TYPE).unwrap(),
            "text/javascript; charset=utf-8"
        );
        let mini = get(&dir, "config/widgets/minibar.js").await;
        assert_eq!(mini.status(), StatusCode::OK, "shared widget-kind served from config/widgets");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn rejects_hcl_traversal_and_missing_config_dir() {
        let dir = bundle();
        assert_eq!(
            get(&dir, "overview/ops/page.hcl").await.status(),
            StatusCode::BAD_REQUEST,
            ".hcl is never served"
        );
        assert_eq!(
            get(&dir, "../secret.txt").await.status(),
            StatusCode::BAD_REQUEST,
            ".. traversal rejected"
        );
        assert_eq!(
            get(&dir, "overview/../config/widgets/minibar.js").await.status(),
            StatusCode::BAD_REQUEST,
            "interior .. rejected"
        );
        assert_eq!(
            get(&dir, ".env").await.status(),
            StatusCode::BAD_REQUEST,
            "dotfiles rejected"
        );
        assert_eq!(
            get(&dir, "config\\widgets\\minibar.js").await.status(),
            StatusCode::BAD_REQUEST,
            "backslash-containing segment rejected"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_config_dir_is_404() {
        let pg = sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://x").unwrap();
        let state = Arc::new(AppState {
            pools: Default::default(),
            dbs: Default::default(),
            pg,
            schema: "public".into(),
            db: crate::introspect::Schema::default(),
            cfg: arc_swap::ArcSwap::from_pointee(crate::config::ConfigDir::default()),
            config_dir: None,
            store: crate::store::Store::open_memory(),
            base_path: String::new(),
            brand: "t".into(),
            http: reqwest::Client::new(),
            secure_cookies: false,
            secret_key: [7u8; 32],
            webhook_secret: None,
            options_cache: Default::default(),
            login_limiter: Default::default(),
            config_write_lock: Default::default(),
        });
        let r = serve_static(State(state), Path("overview/ops/ops.js".to_string())).await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND, "no config dir => 404");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn rejects_out_of_tree_symlink() {
        let dir = bundle();
        let outside = std::env::temp_dir().join(format!("steward-asset-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("evil.js"), "export const evil = 1;").unwrap();
        std::os::unix::fs::symlink(outside.join("evil.js"), dir.join("config").join("widgets").join("evil.js")).unwrap();

        assert_eq!(
            get(&dir, "config/widgets/evil.js").await.status(),
            StatusCode::BAD_REQUEST,
            "symlink escaping the config dir is rejected"
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
