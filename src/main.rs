mod access;
mod actions;
mod assets;
mod auth;
mod config;
mod configedit;
mod dashboard;
mod globaledit;
mod groupsedit;
mod images;
mod interp;
mod introspect;
mod meta;
mod plugins;
mod rows;
mod search;
mod sqlval;
mod state;
mod store;
mod vars;
mod views;

use axum::routing::{get, post};
use axum::Router;
use clap::{Parser, Subcommand};
use rand::Rng;
use sha2::{Digest, Sha256};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use state::AppState;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "steward", version, about = "Admin panel for your existing Postgres — one binary, code-first config.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the admin server
    Serve {
        /// Postgres connection URL. Falls back to the config `[database].url`
        /// (which itself supports `env:NAME` / `${NAME}` interpolation).
        #[arg(long, env = "STEWARD_DB")]
        db: Option<String>,
        /// Postgres schema to introspect. Falls back to config `[database].schema`.
        #[arg(long, env = "STEWARD_SCHEMA")]
        schema: Option<String>,
        /// Directory of HCL config files
        #[arg(long, env = "STEWARD_CONFIG")]
        config: Option<PathBuf>,
        /// Directory for steward's own state (users, sessions, audit)
        #[arg(long, env = "STEWARD_DATA", default_value = "./steward-data")]
        data: PathBuf,
        /// URL prefix the panel is served under. Defaults to `/admin` to match
        /// the SPA's build-time base (vite.config `base`); keep the two in sync.
        #[arg(long, env = "STEWARD_BASE_PATH", default_value = "/admin")]
        base_path: String,
        #[arg(long, env = "STEWARD_LISTEN", default_value = "127.0.0.1:8686")]
        listen: String,
        /// Set Secure on session cookies. On behind HTTPS; pass --secure-cookies=false for local http.
        #[arg(long, env = "STEWARD_SECURE_COOKIES", action = clap::ArgAction::Set, default_value_t = true)]
        secure_cookies: bool,
    },
    /// Manage panel users
    User {
        #[command(subcommand)]
        command: UserCommand,
    },
}

#[derive(Subcommand)]
enum UserCommand {
    /// Create or update a user
    Add {
        email: String,
        #[arg(long, default_value = "admin")]
        role: String,
        #[arg(long, env = "STEWARD_PASSWORD")]
        password: Option<String>,
        #[arg(long, env = "STEWARD_DATA", default_value = "./steward-data")]
        data: PathBuf,
    },
}

/// Resolve steward's app-level secret to a uniform 32-byte HMAC key.
/// Precedence: `STEWARD_SECRET_KEY` env → config `steward.secret_key`
/// (env-interpolated). Each candidate is trimmed and required non-empty;
/// with none set, steward refuses to start.
fn resolve_secret_key(env: Option<String>, cfg: &config::StewardConfig) -> Result<[u8; 32], String> {
    let candidate = env
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            cfg.secret_key
                .as_deref()
                .and_then(config::resolve_env)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    match candidate {
        Some(s) => Ok(Sha256::digest(s.as_bytes()).into()),
        None => Err("no SECRET_KEY set — set the STEWARD_SECRET_KEY env var or [steward].secret_key in config/steward.hcl".into()),
    }
}

/// Supabase's transaction-mode pooler (pgbouncer) drops prepared statements
/// between transactions, so sqlx's statement cache must be disabled or it errors
/// with "prepared statement already exists". Detected by port 6543, or forced via
/// STEWARD_DB_TX_POOL=1. The session pooler (5432) keeps the cache on.
fn is_transaction_pooler(db: &str, env_override: bool) -> bool {
    if env_override {
        return true;
    }
    db.parse::<PgConnectOptions>()
        .map(|o| o.get_port() == 6543)
        .unwrap_or(false)
}

async fn connect_pg(url: &str) -> sqlx::PgPool {
    let tx_pooler = is_transaction_pooler(
        url,
        std::env::var("STEWARD_DB_TX_POOL").map(|v| v == "1").unwrap_or(false),
    );
    let mut opts: PgConnectOptions = url.parse().expect("parse database url");
    if tx_pooler {
        opts = opts.statement_cache_capacity(0);
        tracing::info!("transaction pooler detected — sqlx statement cache disabled");
    }
    let mut pool_opts = PgPoolOptions::new()
        .max_connections(5)
        .min_connections(1)
        .idle_timeout(std::time::Duration::from_secs(60))
        .max_lifetime(std::time::Duration::from_secs(1800))
        .acquire_timeout(std::time::Duration::from_secs(10));
    if !tx_pooler {
        pool_opts = pool_opts.after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET statement_timeout = '15000ms'")
                    .execute(conn)
                    .await
                    .map(|_| ())
            })
        });
    }
    pool_opts.connect_with(opts).await.expect("connect postgres")
}

fn gen_password() -> String {
    const CHARS: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..20).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "steward=info,tower_http=warn".into()),
        )
        .init();

    let cli = Cli::parse();
    match cli.command {
        Command::User { command: UserCommand::Add { email, role, password, data } } => {
            let store = store::Store::open(&data).expect("open steward data dir");
            let (password, generated) = match password {
                Some(p) => (p, false),
                None => (gen_password(), true),
            };
            store.add_user(&email.to_lowercase(), &password, &role).expect("add user");
            if generated {
                println!("user {email} ({role}) — generated password: {password}");
            } else {
                println!("user {email} ({role}) updated");
            }
        }
        Command::Serve { db, schema, config, data, base_path, listen, secure_cookies } => {
            serve(db, schema, config, data, base_path, listen, secure_cookies).await;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn serve(
    db: Option<String>,
    schema: Option<String>,
    config: Option<PathBuf>,
    data: PathBuf,
    base_path: String,
    listen: String,
    secure_cookies: bool,
) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let base_path = base_path.trim_end_matches('/').to_string();
    let cfg = config::load(config.as_deref()).expect("config");

    let (primary_alias, primary_src) = cfg
        .primary_source()
        .map(|(a, s)| (a.to_string(), s.clone()))
        .expect("no primary postgres source — define `source \"main\" { type = \"postgres\" primary = true }` in steward.hcl");
    let db = db
        .or_else(|| config::resolve_env(&primary_src.url))
        .expect("no database url — pass --db / STEWARD_DB or set the primary source url");
    let schemas: Vec<String> = match schema {
        Some(s) => vec![s],
        None if !primary_src.schemas.is_empty() => primary_src.schemas.clone(),
        None => vec!["public".into()],
    };
    let primary_schema = schemas.first().cloned().unwrap_or_else(|| "public".into());

    let store = store::Store::open(&data).expect("open steward data dir");

    if store.user_count().unwrap_or(0) == 0 {
        let email = std::env::var("STEWARD_ADMIN_EMAIL").unwrap_or_else(|_| "admin@localhost".into());
        let (password, generated) = match std::env::var("STEWARD_ADMIN_PASSWORD") {
            Ok(p) if !p.is_empty() => (p, false),
            _ => (gen_password(), true),
        };
        // The bootstrap user is an `admin` by default; a public demo can bootstrap
        // a restricted role instead (e.g. a read-mostly `demo` role from auth.hcl).
        let role = std::env::var("STEWARD_ADMIN_ROLE")
            .ok()
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| "admin".into());
        store.add_user(&email.to_lowercase(), &password, &role).expect("bootstrap user");
        if generated {
            tracing::warn!("bootstrapped {role} user {email} with password: {password}");
        } else {
            tracing::info!("bootstrapped {role} user {email}");
        }
    }

    let mut pools: std::collections::HashMap<String, sqlx::PgPool> = std::collections::HashMap::new();
    pools.insert(primary_alias.clone(), connect_pg(&db).await);
    for (alias, src) in cfg.sources.iter() {
        if !src.is_postgres() || alias == &primary_alias {
            continue;
        }
        let url = config::resolve_env(&src.url)
            .unwrap_or_else(|| panic!("source \"{alias}\": missing/unresolved url"));
        pools.insert(alias.clone(), connect_pg(&url).await);
    }
    let pg = pools[&primary_alias].clone();
    let mut dbs: std::collections::HashMap<String, introspect::Schema> = std::collections::HashMap::new();
    let mut db_schema = introspect::introspect(&pg, &schemas).await.expect("introspect schema");
    for t in db_schema.tables.values_mut() {
        t.source = primary_alias.clone();
    }
    if db_schema.tables.is_empty() {
        tracing::warn!("schemas {schemas:?} have no tables");
    } else {
        tracing::info!("introspected {} tables from schemas {schemas:?}", db_schema.tables.len());
    }
    dbs.insert(primary_alias.clone(), db_schema.clone());
    for (alias, src) in cfg.sources.iter() {
        if !src.is_postgres() || alias == &primary_alias {
            continue;
        }
        let sch = if src.schemas.is_empty() { vec!["public".into()] } else { src.schemas.clone() };
        let mut s = introspect::introspect(&pools[alias], &sch).await.expect("introspect source");
        for t in s.tables.values_mut() {
            t.source = alias.clone();
        }
        tracing::info!("source {alias}: introspected {} tables from {sch:?}", s.tables.len());
        dbs.insert(alias.clone(), s);
    }

    for (table, tc) in cfg.tables.iter() {
        let src = tc.from.source.as_deref();
        let phys = tc.from.table.as_deref().unwrap_or(table);
        let found = match src {
            Some(alias) => dbs.get(alias).map(|s| s.find(tc.from.schema.as_deref(), phys).is_some()).unwrap_or(false),
            None => db_schema.find(tc.from.schema.as_deref(), phys).is_some(),
        };
        if !found {
            match src {
                Some(alias) => tracing::warn!("config file {table}.hcl → source \"{alias}\" has no matching table"),
                None => tracing::warn!("config file {table}.hcl has no matching table in schemas {schemas:?}"),
            }
        }
    }

    let brand = cfg.steward.brand.clone().unwrap_or_else(|| "steward".into());
    let secret_key = resolve_secret_key(std::env::var("STEWARD_SECRET_KEY").ok(), &cfg.steward)
        .unwrap_or_else(|e| {
            tracing::error!("{e}");
            std::process::exit(1);
        });
    let state = Arc::new(AppState {
        pg,
        pools,
        schema: primary_schema,
        db: db_schema,
        dbs,
        cfg: arc_swap::ArcSwap::from_pointee(cfg),
        config_dir: config,
        store,
        base_path: base_path.clone(),
        brand,
        // No redirect-following: the source proxy and webhook actions both attach
        // secrets (token_env / HMAC signature); a 3xx to another host would leak
        // them. Upstreams are pinned to their configured (trusted, internal) host.
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("build http client"),
        secure_cookies,
        secret_key,
        webhook_secret: std::env::var("STEWARD_WEBHOOK_SECRET").ok().filter(|s| !s.is_empty()),
        options_cache: Default::default(),
        login_limiter: Default::default(),
        config_write_lock: Default::default(),
    });
    configedit::port_legacy_roles(&state);

    let api = Router::new()
        .route("/health", get(auth::health_handler))
        .route("/auth/login", post(auth::login_handler))
        .route("/auth/logout", post(auth::logout_handler))
        .route("/me", get(auth::me_handler))
        .route("/public", get(meta::public_branding_handler))
        .route("/meta", get(meta::meta_handler))
        .route("/dashboard", get(dashboard::dashboard_handler))
        .route("/dash/*id", get(dashboard::page_widgets_handler))
        .route("/audit", get(auth::audit_handler))
        .route("/search", get(search::search_handler))
        .route("/views", get(views::list_views_handler).post(views::create_view_handler))
        .route("/views/:id", axum::routing::delete(views::delete_view_handler))
        .route("/users", get(access::users_list).post(access::users_create))
        .route(
            "/users/:id",
            axum::routing::patch(access::users_update).delete(access::users_delete),
        )
        .route("/roles", get(access::roles_list).post(access::roles_create))
        .route(
            "/roles/:name",
            axum::routing::patch(access::roles_update).delete(access::roles_delete),
        )
        .route("/t/:table", get(rows::list_handler).post(rows::create_handler))
        .route("/t/:table/bulk", post(rows::bulk_handler))
        .route(
            "/t/:table/import",
            post(rows::import_handler)
                .layer(axum::extract::DefaultBodyLimit::max(12 * 1024 * 1024)),
        )
        .route("/t/:table/export", get(rows::export_handler))
        .route(
            "/t/:table/r/:pk",
            get(rows::detail_handler)
                .patch(rows::update_handler)
                .delete(rows::delete_handler),
        )
        .route("/t/:table/r/:pk/audit", get(rows::row_audit_handler))
        .route("/t/:table/r/:pk/inline/:child", get(rows::inline_page_handler))
        .route("/t/:table/options/:col", get(rows::options_handler))
        .route(
            "/t/:table/image/:col/:pk",
            get(images::get_image).post(images::put_image),
        )
        .route("/t/:table/action/:name", post(actions::action_handler))
        .route("/config/discover", get(configedit::discover))
        .route(
            "/config/groups",
            get(groupsedit::list_groups).post(groupsedit::create_group),
        )
        .route("/config/groups/layout", post(groupsedit::save_layout))
        .route(
            "/config/groups/:slug",
            axum::routing::patch(groupsedit::patch_group).delete(groupsedit::delete_group),
        )
        .route("/config/groups/:slug/rename", post(groupsedit::rename_group))
        .route(
            "/config/dashboard",
            get(globaledit::get_dashboard).put(globaledit::put_dashboard),
        )
        .route("/config/dashboard/preview", post(globaledit::preview_panel))
        .route("/config/dashboard/versions", get(globaledit::list_dashboard_versions))
        .route(
            "/config/dashboard/versions/:id",
            get(globaledit::get_dashboard_version),
        )
        .route(
            "/config/dashboard/versions/:id/publish",
            post(globaledit::publish_dashboard_version),
        )
        .route(
            "/config/:table",
            get(configedit::get_config).put(configedit::put_config),
        )
        .route("/config/:table/versions", get(configedit::list_config_versions))
        .route("/config/:table/versions/:id", get(configedit::get_config_version))
        .route(
            "/config/:table/versions/:id/publish",
            post(configedit::publish_config_version),
        )
        .route("/query/:name", get(plugins::named_query))
        .route("/source/:name", get(plugins::named_source_root))
        .route("/source/:name/*rest", get(plugins::named_source))
        .layer(axum::middleware::from_fn(auth::csrf_guard))
        .with_state(state.clone());

    let static_assets = Router::new()
        .route("/*path", get(plugins::serve_static))
        .with_state(state.clone());

    let spa = Router::new()
        .fallback(assets::spa_handler)
        .with_state(base_path.clone());

    let mut app = Router::new()
        .nest(&format!("{base_path}/api"), api)
        .nest(&format!("{base_path}/static"), static_assets)
        .merge(spa);
    if !base_path.is_empty() {
        let to = format!("{base_path}/");
        app = app.route(
            "/",
            get(move || {
                let to = to.clone();
                async move { axum::response::Redirect::temporary(&to) }
            }),
        );
    }
    let app = app.layer(tower_http::trace::TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(&listen).await.expect("bind");
    tracing::info!("steward listening on http://{listen}{}/", base_path);

    let warm_state = state.clone();
    tokio::spawn(async move {
        tracing::info!("warming meta cache…");
        meta::warm_options_cache(&warm_state).await;
        tracing::info!("meta cache warmed");
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(600)).await;
            meta::warm_options_cache(&warm_state).await;
        }
    });

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server");
}

#[cfg(test)]
mod secret_tests {
    use super::*;

    fn cfg_with_key(key: Option<&str>) -> config::StewardConfig {
        let mut cfg = config::StewardConfig::default();
        cfg.secret_key = key.map(str::to_string);
        cfg
    }

    #[test]
    fn env_value_is_used() {
        let key = resolve_secret_key(Some("env-key".into()), &cfg_with_key(None)).unwrap();
        assert_eq!(key, <[u8; 32]>::from(Sha256::digest(b"env-key")));
    }

    #[test]
    fn config_value_used_when_env_absent() {
        let key = resolve_secret_key(None, &cfg_with_key(Some("cfg-key"))).unwrap();
        assert_eq!(key, <[u8; 32]>::from(Sha256::digest(b"cfg-key")));
    }

    #[test]
    fn env_takes_precedence_over_config() {
        let key = resolve_secret_key(Some("env-key".into()), &cfg_with_key(Some("cfg-key"))).unwrap();
        assert_eq!(key, <[u8; 32]>::from(Sha256::digest(b"env-key")));
    }

    #[test]
    fn missing_everywhere_is_error() {
        assert!(resolve_secret_key(None, &cfg_with_key(None)).is_err());
    }

    #[test]
    fn empty_or_whitespace_candidate_is_error() {
        assert!(resolve_secret_key(Some("".into()), &cfg_with_key(None)).is_err());
        assert!(resolve_secret_key(Some("   ".into()), &cfg_with_key(None)).is_err());
        assert!(resolve_secret_key(None, &cfg_with_key(Some("  "))).is_err());
    }

    #[test]
    fn transaction_pooler_detected_by_port() {
        assert!(is_transaction_pooler(
            "postgres://user:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres",
            false
        ));
        assert!(!is_transaction_pooler(
            "postgres://user:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres",
            false
        ));
    }

    #[test]
    fn transaction_pooler_env_override_forces_true() {
        assert!(is_transaction_pooler(
            "postgres://user:pw@host:5432/postgres",
            true
        ));
    }
}
