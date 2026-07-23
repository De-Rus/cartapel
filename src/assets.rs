use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "ui/dist/"]
pub struct Assets;

pub async fn spa_handler(uri: Uri, base_path: axum::extract::State<String>) -> Response {
    let base = base_path.0;
    let path = uri.path();
    let rel = path
        .strip_prefix(&format!("{base}/"))
        .or_else(|| path.strip_prefix(&base))
        .unwrap_or(path)
        .trim_start_matches('/');

    if !rel.is_empty() {
        if let Some(file) = Assets::get(rel) {
            let mime = mime_guess::from_path(rel).first_or_octet_stream();
            let cache = if rel.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            return (
                [
                    (header::CONTENT_TYPE, mime.as_ref().to_string()),
                    (header::CACHE_CONTROL, cache.to_string()),
                ],
                file.data,
            )
                .into_response();
        }
    }

    match Assets::get("index.html") {
        Some(index) => {
            // Inject the runtime mount prefix so one build serves under any path.
            let html = String::from_utf8_lossy(&index.data).replace("%BASE_PATH%", &base);
            (
                [
                    (header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
                    (header::CACHE_CONTROL, "no-cache".to_string()),
                ],
                html,
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "UI not built").into_response(),
    }
}
