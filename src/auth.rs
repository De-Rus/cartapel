use crate::state::{AppError, AppState, CurrentUser};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::Json;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const COOKIE: &str = "steward_session";
const LOGIN_WINDOW: Duration = Duration::from_secs(900);
const LOGIN_MAX_FAILS: u32 = 10;

#[axum::async_trait]
impl FromRequestParts<Arc<AppState>> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let cookie = jar.get(COOKIE).ok_or_else(AppError::unauthorized)?;
        let (token, sig) = cookie
            .value()
            .split_once('.')
            .ok_or_else(AppError::unauthorized)?;
        if !state.verify(token.as_bytes(), sig) {
            return Err(AppError::unauthorized());
        }
        let (email, role) = state
            .store
            .session_user(token)
            .ok_or_else(AppError::unauthorized)?;
        // View-as: admins may impersonate a lesser role to verify what it sees.
        // Never escalates — only admins are honored, and `admin` itself is a no-op.
        let is_admin = role.split(',').map(str::trim).any(|r| r == "admin");
        if is_admin {
            if let Some(as_role) = parts
                .headers
                .get("x-steward-as-role")
                .and_then(|v| v.to_str().ok())
                .filter(|r| !r.is_empty() && *r != "admin")
            {
                if state.cfg().auth.roles.contains_key(as_role) {
                    if !matches!(parts.method, Method::GET | Method::HEAD) {
                        return Err(AppError::forbidden(
                            "read-only while viewing as another role",
                        ));
                    }
                    return Ok(CurrentUser {
                        email,
                        role: as_role.to_string(),
                    });
                }
            }
        }
        Ok(CurrentUser { email, role })
    }
}

pub async fn csrf_guard(req: Request, next: Next) -> Result<Response, AppError> {
    let mutating = matches!(
        *req.method(),
        Method::POST | Method::PATCH | Method::PUT | Method::DELETE
    );
    if mutating && !req.headers().contains_key("x-steward") {
        return Err(AppError(
            StatusCode::FORBIDDEN,
            "missing X-Steward header".into(),
        ));
    }
    Ok(next.run(req).await)
}

#[derive(Deserialize)]
pub struct LoginBody {
    email: String,
    password: String,
}

fn client_ip(parts: &axum::http::HeaderMap) -> String {
    parts
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next_back())
        .unwrap_or("local")
        .trim()
        .chars()
        .take(64)
        .collect()
}

pub async fn login_handler(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(body): Json<LoginBody>,
) -> Result<(CookieJar, Json<Value>), AppError> {
    let ip = client_ip(&headers);
    {
        let mut limiter = state.login_limiter.lock().unwrap();
        limiter.retain(|_, (_, at)| at.elapsed() < LOGIN_WINDOW);
        let entry = limiter.entry(ip.clone()).or_insert((0, Instant::now()));
        if entry.1.elapsed() > LOGIN_WINDOW {
            *entry = (0, Instant::now());
        }
        if entry.0 >= LOGIN_MAX_FAILS {
            return Err(AppError(
                StatusCode::TOO_MANY_REQUESTS,
                "too many attempts, try later".into(),
            ));
        }
    }

    let Some((email, role)) = state
        .store
        .verify_login(&body.email.trim().to_lowercase(), &body.password)
    else {
        state
            .login_limiter
            .lock()
            .unwrap()
            .entry(ip)
            .and_modify(|e| e.0 += 1)
            .or_insert((1, Instant::now()));
        return Err(AppError(
            StatusCode::UNAUTHORIZED,
            "invalid credentials".into(),
        ));
    };

    let token = state.store.create_session(&email)?;
    state.store.audit(&email, "-", None, "login", None);
    let sig = state.sign(token.as_bytes());
    let mut cookie = Cookie::new(COOKIE, format!("{token}.{sig}"));
    cookie.set_path("/");
    cookie.set_http_only(true);
    cookie.set_same_site(SameSite::Lax);
    cookie.set_secure(state.secure_cookies);
    cookie.set_max_age(time::Duration::days(30));
    Ok((
        jar.add(cookie),
        Json(json!({ "email": email, "role": role })),
    ))
}

pub async fn logout_handler(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> (CookieJar, Json<Value>) {
    if let Some(c) = jar.get(COOKIE) {
        let token = c.value().split_once('.').map_or(c.value(), |(t, _)| t);
        state.store.delete_session(token);
    }
    let mut removal = Cookie::from(COOKIE);
    removal.set_path("/");
    (jar.remove(removal), Json(json!({})))
}

pub async fn me_handler(user: CurrentUser) -> Json<Value> {
    Json(json!({ "email": user.email, "role": user.role }))
}

pub async fn audit_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, AppError> {
    if !user.is_admin() {
        return Err(AppError::forbidden("audit log is admin-only"));
    }
    let page = params
        .get("page")
        .and_then(|p| p.parse().ok())
        .unwrap_or(1u32)
        .max(1);
    let pp = params
        .get("pp")
        .and_then(|p| p.parse().ok())
        .unwrap_or(50u32)
        .clamp(1, 200);
    let table = params
        .get("table")
        .filter(|t| !t.is_empty())
        .map(String::as_str);
    Ok(Json(state.store.audit_list(table, page, pp)?))
}

pub async fn health_handler() -> Json<Value> {
    Json(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state_with_key(secret_key: [u8; 32]) -> Arc<AppState> {
        let pg = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://x")
            .unwrap();
        Arc::new(AppState {
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
            secret_key,
            webhook_secret: None,
            options_cache: Default::default(),
            login_limiter: Default::default(),
            config_write_lock: Default::default(),
        })
    }

    fn test_state() -> Arc<AppState> {
        test_state_with_key([7u8; 32])
    }

    async fn extract(
        state: &Arc<AppState>,
        cookie_val: Option<&str>,
    ) -> Result<CurrentUser, AppError> {
        let mut builder = axum::http::Request::builder();
        if let Some(v) = cookie_val {
            builder = builder.header("cookie", format!("{COOKIE}={v}"));
        }
        let req = builder.body(axum::body::Body::empty()).unwrap();
        let (mut parts, _) = req.into_parts();
        CurrentUser::from_request_parts(&mut parts, state).await
    }

    #[tokio::test]
    async fn signed_token_round_trips_and_rejects_tampering() {
        let state = test_state();
        let sig = state.sign(b"tok123");
        assert!(state.verify(b"tok123", &sig));
        assert!(!state.verify(b"tok124", &sig), "tampered token");

        let mut bad_sig = sig.clone();
        let flip = if bad_sig.starts_with('a') { "b" } else { "a" };
        bad_sig.replace_range(0..1, flip);
        assert!(!state.verify(b"tok123", &bad_sig), "tampered signature");
        assert!(!state.verify(b"tok123", "not-hex-zz"), "non-hex signature");
    }

    #[tokio::test]
    async fn current_user_requires_valid_signature() {
        let state = test_state();
        state.store.create_user("u@x.io", "pw", "admin").unwrap();
        let token = state.store.create_session("u@x.io").unwrap();
        let sig = state.sign(token.as_bytes());

        let ok = extract(&state, Some(&format!("{token}.{sig}")))
            .await
            .unwrap();
        assert_eq!(ok.email, "u@x.io");
        assert_eq!(ok.role, "admin");

        assert!(
            extract(&state, Some(&format!("{token}.deadbeef")))
                .await
                .is_err(),
            "bad sig"
        );
        assert!(extract(&state, Some(&token)).await.is_err(), "missing sig");
        assert!(extract(&state, None).await.is_err(), "no cookie");

        let other = test_state_with_key([9u8; 32]);
        let cross_sig = other.sign(token.as_bytes());
        assert!(
            extract(&state, Some(&format!("{token}.{cross_sig}")))
                .await
                .is_err(),
            "signature from a different secret_key is rejected"
        );
    }

    #[tokio::test]
    async fn bad_signature_is_rejected_before_session_lookup() {
        let state = test_state();
        state.store.create_user("u@x.io", "pw", "admin").unwrap();
        let token = state.store.create_session("u@x.io").unwrap();
        assert!(
            state.store.session_user(&token).is_some(),
            "token present in store"
        );

        let forged = state.sign(b"a-different-token");
        assert!(
            extract(&state, Some(&format!("{token}.{forged}")))
                .await
                .is_err(),
            "valid stored token with a bad signature is 401 — verify gates the DB lookup"
        );
    }
}
