mod access;
mod actions;
mod agg;
mod assets;
mod auth;
mod config;
mod configedit;
mod dashboard;
mod db;
mod files;
mod globaledit;
mod grafana;
mod groupsedit;
mod i18n;
mod images;
mod interp;
mod introspect;
mod meta;
mod plugins;
mod rows;
mod s3;
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
#[command(
    name = "cartapel",
    version,
    about = "Admin panel for your existing Postgres — one binary, code-first config."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the admin server
    Serve {
        /// Postgres connection URL. Falls back to the primary `source` url in
        /// config/cartapel.hcl (which supports `env:NAME` / `${NAME}`).
        #[arg(long, env = "CARTAPEL_DB")]
        db: Option<String>,
        /// Postgres schema to introspect. Falls back to the primary source's `schemas`.
        #[arg(long, env = "CARTAPEL_SCHEMA")]
        schema: Option<String>,
        /// Directory of HCL config files
        #[arg(long, env = "CARTAPEL_CONFIG")]
        config: Option<PathBuf>,
        /// Directory for cartapel's own state (users, sessions, audit)
        #[arg(long, env = "CARTAPEL_DATA", default_value = "./cartapel-data")]
        data: PathBuf,
        /// URL prefix the panel is served under; injected into the SPA at runtime.
        #[arg(long, env = "CARTAPEL_BASE_PATH", default_value = "/admin")]
        base_path: String,
        #[arg(long, env = "CARTAPEL_LISTEN", default_value = "127.0.0.1:8686")]
        listen: String,
        /// Set Secure on session cookies. On behind HTTPS; pass --secure-cookies=false for local http.
        #[arg(long, env = "CARTAPEL_SECURE_COOKIES", action = clap::ArgAction::Set, default_value_t = true)]
        secure_cookies: bool,
    },
    /// Manage panel users
    User {
        #[command(subcommand)]
        command: UserCommand,
    },
    /// Validate a config directory (optionally cross-checked against a live
    /// database). Exit 0 = valid; exit 1 with the errors otherwise — CI-ready.
    /// Translation tooling for author text (group, table, field, page and
    /// panel names) — see `cartapel i18n extract`.
    I18n {
        #[command(subcommand)]
        cmd: I18nCommand,
    },
    Check {
        #[arg(long, env = "CARTAPEL_CONFIG")]
        config: PathBuf,
        /// When given, every configured table is verified to exist in the
        /// introspected schema(s), and list/search/filter/sort columns are
        /// verified to be real columns.
        #[arg(long, env = "CARTAPEL_DB")]
        db: Option<String>,
        #[arg(long, env = "CARTAPEL_SCHEMA")]
        schema: Option<String>,
    },
}

#[derive(Subcommand)]
enum I18nCommand {
    /// Print a `config/i18n/<locale>.hcl` stub with every author string the
    /// locale has not translated yet, in config order. With --db, the column
    /// names the panel humanizes are included too.
    Extract {
        #[arg(long, env = "CARTAPEL_CONFIG")]
        config: PathBuf,
        /// The locale to extract for, e.g. `es`.
        #[arg(long)]
        locale: String,
        /// `hcl` (default, with comments) or `json` (a flat object, for
        /// translation tools) — either lands in config/i18n/.
        #[arg(long, default_value = "hcl")]
        format: String,
        #[arg(long, env = "CARTAPEL_DB")]
        db: Option<String>,
        #[arg(long, env = "CARTAPEL_SCHEMA")]
        schema: Option<String>,
    },
}

#[derive(Subcommand)]
enum UserCommand {
    /// Create or update a user
    Add {
        email: String,
        #[arg(long, default_value = "admin")]
        role: String,
        #[arg(long, env = "CARTAPEL_PASSWORD")]
        password: Option<String>,
        #[arg(long, env = "CARTAPEL_DATA", default_value = "./cartapel-data")]
        data: PathBuf,
    },
}

/// Resolve cartapel's app-level secret to a uniform 32-byte HMAC key.
/// Precedence: `CARTAPEL_SECRET_KEY` env → config `cartapel.secret_key`
/// (env-interpolated). Each candidate is trimmed and required non-empty;
/// with none set, cartapel refuses to start.
fn resolve_secret_key(
    env: Option<String>,
    cfg: &config::CartapelConfig,
) -> Result<[u8; 32], String> {
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
        None => Err("no SECRET_KEY set — set the CARTAPEL_SECRET_KEY env var or [cartapel].secret_key in config/cartapel.hcl".into()),
    }
}

/// Supabase's transaction-mode pooler (pgbouncer) drops prepared statements
/// between transactions, so sqlx's statement cache must be disabled or it errors
/// with "prepared statement already exists". Detected by port 6543, or forced via
/// CARTAPEL_DB_TX_POOL=1. The session pooler (5432) keeps the cache on.
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
        std::env::var("CARTAPEL_DB_TX_POOL")
            .map(|v| v == "1")
            .unwrap_or(false),
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
    match pool_opts.connect_with(opts).await {
        Ok(pool) => pool,
        Err(e) => {
            let host = url
                .parse::<PgConnectOptions>()
                .map(|o| format!("{}:{}", o.get_host(), o.get_port()))
                .unwrap_or_default();
            die(&format!(
                "cannot connect to postgres at {host}: {e}\n  · is the database reachable from here?\n  · transaction poolers (e.g. Supabase :6543) are auto-detected; force with CARTAPEL_DB_TX_POOL=1"
            ));
        }
    }
}

/// The URL's scheme picks the engine — one `CARTAPEL_DB` works for all.
async fn connect_any(alias: &str, url: &str) -> crate::db::DbPool {
    if url.starts_with("mysql://") || url.starts_with("mariadb://") {
        connect_mysql(alias, url).await
    } else if url.starts_with("clickhouse://") || url.starts_with("chttp://") {
        connect_clickhouse(alias, url).await
    } else if url.starts_with("postgres://") || url.starts_with("postgresql://") {
        crate::db::DbPool::Pg(connect_pg(url).await)
    } else {
        die(&format!(
            "source \"{alias}\": unrecognized database url — use postgres:// or mysql://"
        ))
    }
}

/// `clickhouse://user:pass@host:8123/db` → HTTP interface with basic auth;
/// the path picks the database. Read-only by construction.
async fn connect_clickhouse(alias: &str, url: &str) -> crate::db::DbPool {
    let http = url
        .replacen("clickhouse://", "http://", 1)
        .replacen("chttp://", "http://", 1);
    let parsed = reqwest::Url::parse(&http)
        .unwrap_or_else(|e| die(&format!("source \"{alias}\": bad clickhouse url: {e}")));
    let user = if parsed.username().is_empty() {
        "default".to_string()
    } else {
        parsed.username().to_string()
    };
    let password = parsed.password().unwrap_or("").to_string();
    let database = parsed.path().trim_matches('/').to_string();
    let mut base = parsed.clone();
    let _ = base.set_username("");
    let _ = base.set_password(None);
    base.set_path("/");
    let mut endpoint = base.to_string();
    if !database.is_empty() {
        endpoint = format!("{endpoint}?database={database}");
    }
    let pool = crate::db::ChPool {
        client: reqwest::Client::new(),
        url: endpoint,
        user,
        password,
    };
    match pool
        .query_json("SELECT version() AS v", &[], 1, 5_000)
        .await
    {
        Ok(rows) => {
            let v = rows
                .first()
                .and_then(|m| m.get("v"))
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string();
            tracing::info!("source {alias}: connected (ClickHouse {v}, read-only)");
        }
        Err(e) => die(&format!("source \"{alias}\": cannot reach clickhouse: {e}")),
    }
    crate::db::DbPool::ClickHouse(pool)
}

async fn connect_mysql(alias: &str, url: &str) -> crate::db::DbPool {
    let url = url.replacen("mariadb://", "mysql://", 1);
    let opts: sqlx::mysql::MySqlConnectOptions = url.parse().expect("parse mysql url");
    let pool = match sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(5)
        .min_connections(1)
        .idle_timeout(std::time::Duration::from_secs(60))
        .max_lifetime(std::time::Duration::from_secs(1800))
        .acquire_timeout(std::time::Duration::from_secs(10))
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET time_zone = '+00:00'")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query(
                    "SET SESSION sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES,NO_BACKSLASH_ESCAPES')",
                )
                    .execute(&mut *conn)
                    .await
                    .map(|_| ())
            })
        })
        .connect_with(opts)
        .await
    {
        Ok(pool) => pool,
        Err(e) => die(&format!("source \"{alias}\": cannot connect to mysql: {e}")),
    };
    let version: String = sqlx::query_scalar("SELECT VERSION()")
        .fetch_one(&pool)
        .await
        .unwrap_or_default();
    let flavor = if version.contains("MariaDB") {
        crate::db::MyFlavor::MariaDb
    } else {
        crate::db::MyFlavor::MySql
    };
    tracing::info!("source {alias}: connected ({version}, {flavor:?})");
    crate::db::DbPool::MySql(pool, flavor)
}

fn die(msg: &str) -> ! {
    eprintln!("✗ {msg}");
    std::process::exit(1);
}

fn gen_password() -> String {
    const CHARS: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..20)
        .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
        .collect()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cartapel=info,tower_http=warn".into()),
        )
        .init();

    let cli = Cli::parse();
    match cli.command {
        Command::User {
            command:
                UserCommand::Add {
                    email,
                    role,
                    password,
                    data,
                },
        } => {
            let store = store::Store::open(&data).expect("open cartapel data dir");
            let (password, generated) = match password {
                Some(p) => (p, false),
                None => (gen_password(), true),
            };
            store
                .add_user(&email.to_lowercase(), &password, &role)
                .expect("add user");
            if generated {
                println!("user {email} ({role}) — generated password: {password}");
            } else {
                println!("user {email} ({role}) updated");
            }
        }
        Command::Serve {
            db,
            schema,
            config,
            data,
            base_path,
            listen,
            secure_cookies,
        } => {
            serve(db, schema, config, data, base_path, listen, secure_cookies).await;
        }
        Command::Check { config, db, schema } => {
            std::process::exit(check(&config, db, schema).await);
        }
        Command::I18n {
            cmd:
                I18nCommand::Extract {
                    config,
                    locale,
                    format,
                    db,
                    schema,
                },
        } => {
            let format = match format.as_str() {
                "hcl" => i18n::StubFormat::Hcl,
                "json" => i18n::StubFormat::Json,
                other => {
                    eprintln!("✗ --format must be hcl or json, not {other}");
                    std::process::exit(2);
                }
            };
            std::process::exit(i18n_extract(&config, &locale, format, db, schema).await);
        }
    }
}

/// `cartapel i18n extract`: the untranslated author strings for one locale, as
/// an HCL stub ready to fill in. The live schema is optional; with it, column
/// names the panel would humanize are listed too.
async fn i18n_extract(
    config: &std::path::Path,
    locale: &str,
    format: i18n::StubFormat,
    db: Option<String>,
    schema: Option<String>,
) -> i32 {
    let cfg = match config::load(Some(config)) {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("✗ config invalid:\n{e}");
            return 1;
        }
    };
    let db = db.or_else(|| {
        cfg.primary_source()
            .and_then(|(_, s)| config::resolve_env(&s.url))
    });
    let dbs = match db {
        Some(db) if db.starts_with("postgres://") || db.starts_with("postgresql://") => {
            let schemas: Vec<String> = match schema {
                Some(s) => vec![s],
                None => cfg
                    .primary_source()
                    .map(|(_, s)| s.schemas.clone())
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| vec!["public".into()]),
            };
            let pool = match sqlx::postgres::PgPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(std::time::Duration::from_secs(10))
                .connect(&db)
                .await
            {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("✗ cannot connect to --db: {e}");
                    return 1;
                }
            };
            match introspect::introspect(&pool, &schemas).await {
                Ok(s) => Some(s),
                Err(e) => {
                    eprintln!("✗ introspection failed: {e}");
                    return 1;
                }
            }
        }
        Some(_) => {
            eprintln!("· non-postgres --db — column names are postgres-only, extracting from config alone");
            None
        }
        None => {
            eprintln!("· no --db / resolvable primary source url — extracting from config alone (column names not included)");
            None
        }
    };
    let (out, missing, all) = i18n::extract(&cfg, dbs.as_ref(), locale, format);
    print!("{out}");
    eprintln!("· {locale}: {missing} of {all} author strings untranslated");
    0
}

/// `cartapel check`: parse + validate the bundle, then (with --db) cross-check
/// every configured table and referenced column against the live schema.
async fn check(config: &std::path::Path, db: Option<String>, schema: Option<String>) -> i32 {
    let cfg = match config::load(Some(config)) {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("✗ config invalid:\n{e}");
            return 1;
        }
    };
    println!(
        "✓ config parses: {} tables, {} groups, {} queries, {} variables, {} pages",
        cfg.tables.len(),
        cfg.groups.len(),
        cfg.queries.len(),
        cfg.variables.len(),
        cfg.pages.len()
    );
    let db = db.or_else(|| {
        cfg.primary_source()
            .and_then(|(_, s)| config::resolve_env(&s.url))
    });
    let Some(db) = db else {
        println!("· no --db / resolvable primary source url — skipping live-schema checks");
        return 0;
    };
    let schemas: Vec<String> = match schema {
        Some(s) => vec![s],
        None => cfg
            .primary_source()
            .map(|(_, s)| s.schemas.clone())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| vec!["public".into()]),
    };
    if !db.starts_with("postgres://") && !db.starts_with("postgresql://") {
        println!("· non-postgres primary url — live-schema checks are postgres-only, skipping");
        return 0;
    }
    let pool = match sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&db)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("✗ cannot connect to the database: {e}");
            return 1;
        }
    };
    let dbs = match introspect::introspect(&pool, &schemas).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("✗ introspection failed: {e}");
            return 1;
        }
    };
    let mut errors = 0usize;
    for (key, tc) in &cfg.tables {
        let phys = tc.from.table.as_deref().unwrap_or(key);
        let Some(dbt) = dbs.find(tc.from.schema.as_deref(), phys) else {
            eprintln!("✗ {key}: table not found in schemas {schemas:?}");
            errors += 1;
            continue;
        };
        let mut missing = |what: &str, col: &str| {
            let virtual_col = tc
                .fields
                .get(col)
                .is_some_and(|f| f.sql.is_some() || f.image.is_some());
            if dbt.column(col).is_none() && !virtual_col {
                eprintln!("✗ {key}: {what} column '{col}' does not exist");
                errors += 1;
            }
        };
        for c in &tc.list.columns {
            missing("list", c);
        }
        for c in &tc.list.search {
            missing("search", c);
        }
        for c in &tc.edit.readonly {
            missing("edit.readonly", c);
        }
        if let Some(sort) = &tc.list.sort {
            for part in sort.split(',') {
                missing("sort", part.trim().trim_start_matches('-'));
            }
        }
    }
    if errors > 0 {
        eprintln!("✗ {errors} error(s)");
        1
    } else {
        println!("✓ live schema: every configured table and column checks out");
        0
    }
}

/// Hot-reload the config when its files change on disk (editor saves, git
/// checkout, volume sync). Debounced; a failed load keeps the last good config
/// and logs the error. In-app edits already reload synchronously — the watcher
/// just re-runs an idempotent load after them.
fn watch_config(state: Arc<AppState>) {
    use notify::Watcher;
    let Some(dir) = state.config_dir.clone() else {
        return;
    };
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher =
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                let relevant = ev.paths.iter().any(|p| {
                    p.extension().is_some_and(|e| e == "hcl")
                        || p.extension()
                            .is_some_and(|e| e == "tsx" || e == "ts" || e == "js")
                });
                if relevant {
                    let _ = tx.send(());
                }
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("config watcher unavailable: {e}");
                return;
            }
        };
    if let Err(e) = watcher.watch(&dir, notify::RecursiveMode::Recursive) {
        tracing::warn!("config watcher failed to start: {e}");
        return;
    }
    std::thread::spawn(move || {
        let _keepalive = watcher;
        while rx.recv().is_ok() {
            // Debounce: a save often lands as several events (tmp write + rename).
            std::thread::sleep(std::time::Duration::from_millis(300));
            while rx.try_recv().is_ok() {}
            match state.reload_config() {
                Ok(()) => tracing::info!("config reloaded from disk"),
                Err(e) => tracing::warn!("config change ignored (kept last good): {e}"),
            }
        }
    });
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
    let cfg = match config::load(config.as_deref()) {
        Ok(cfg) => cfg,
        Err(e) => die(&format!("config invalid:\n{e}")),
    };

    let (primary_alias, primary_src) = match cfg.primary_source() {
        Some((a, s)) => (a.to_string(), s.clone()),
        None => match &db {
            Some(url) => ("main".to_string(), config::NamedSource::from_url(url)),
            None => die(
                "no database — pass --db / CARTAPEL_DB (postgres:// or mysql://), or define a `source \"main\" { primary = true }` in config/cartapel.hcl",
            ),
        },
    };
    let Some(db) = db.or_else(|| config::resolve_env(&primary_src.url)) else {
        die("no database url — pass --db / CARTAPEL_DB or set the primary source url");
    };
    let schemas: Vec<String> = match schema {
        Some(s) => vec![s],
        None if !primary_src.schemas.is_empty() => primary_src.schemas.clone(),
        None => vec!["public".into()],
    };
    let primary_schema = schemas.first().cloned().unwrap_or_else(|| "public".into());

    let store = store::Store::open(&data).expect("open cartapel data dir");

    let mut pools: std::collections::HashMap<String, crate::db::DbPool> =
        std::collections::HashMap::new();
    pools.insert(
        primary_alias.clone(),
        connect_any(&primary_alias, &db).await,
    );
    for (alias, src) in cfg.sources.iter() {
        if alias == &primary_alias {
            continue;
        }
        if !src.is_postgres() && !src.is_mysql() && !src.is_clickhouse() {
            continue;
        }
        let url = config::resolve_env(&src.url)
            .unwrap_or_else(|| panic!("source \"{alias}\": missing/unresolved url"));
        pools.insert(alias.clone(), connect_any(alias, &url).await);
    }
    let pg = pools[&primary_alias].clone();
    if store.user_count().unwrap_or(0) == 0 {
        let email =
            std::env::var("CARTAPEL_ADMIN_EMAIL").unwrap_or_else(|_| "admin@localhost".into());
        let (password, generated) = match std::env::var("CARTAPEL_ADMIN_PASSWORD") {
            Ok(p) if !p.is_empty() => (p, false),
            _ => (gen_password(), true),
        };
        // The bootstrap user is an `admin` by default; a public demo can bootstrap
        // a restricted role instead (e.g. a read-mostly `demo` role from auth.hcl).
        let role = std::env::var("CARTAPEL_ADMIN_ROLE")
            .ok()
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| "admin".into());
        store
            .add_user(&email.to_lowercase(), &password, &role)
            .expect("bootstrap user");
        if generated {
            tracing::warn!("bootstrapped {role} user {email} with password: {password}");
        } else {
            tracing::info!("bootstrapped {role} user {email}");
        }
    }

    let mut dbs: std::collections::HashMap<String, introspect::Schema> =
        std::collections::HashMap::new();
    let mut db_schema = match &pg {
        crate::db::DbPool::Pg(pool) => introspect::introspect(pool, &schemas)
            .await
            .expect("introspect schema"),
        crate::db::DbPool::MySql(pool, flavor) => {
            let s = introspect::introspect_mysql(pool)
                .await
                .expect("introspect schema");
            tracing::info!("introspected {} tables ({flavor:?})", s.tables.len());
            s
        }
        crate::db::DbPool::ClickHouse(_) => {
            die("clickhouse cannot be the primary source — it is read-only; declare it as a secondary `source` and keep a postgres or mysql primary")
        }
    };
    for t in db_schema.tables.values_mut() {
        t.source = primary_alias.clone();
    }
    if db_schema.tables.is_empty() {
        tracing::warn!("schemas {schemas:?} have no tables");
    } else {
        tracing::info!(
            "introspected {} tables from schemas {schemas:?}",
            db_schema.tables.len()
        );
    }
    dbs.insert(primary_alias.clone(), db_schema.clone());
    for (alias, src) in cfg.sources.iter() {
        if alias == &primary_alias {
            continue;
        }
        let mut s = match &pools.get(alias) {
            Some(crate::db::DbPool::Pg(pool)) => {
                let sch = if src.schemas.is_empty() {
                    vec!["public".into()]
                } else {
                    src.schemas.clone()
                };
                let s = introspect::introspect(pool, &sch)
                    .await
                    .expect("introspect source");
                tracing::info!(
                    "source {alias}: introspected {} tables from {sch:?}",
                    s.tables.len()
                );
                s
            }
            Some(crate::db::DbPool::MySql(pool, flavor)) => {
                let s = introspect::introspect_mysql(pool)
                    .await
                    .expect("introspect mysql source");
                tracing::info!(
                    "source {alias}: introspected {} tables ({flavor:?})",
                    s.tables.len()
                );
                s
            }
            Some(crate::db::DbPool::ClickHouse(ch)) => {
                let s = introspect::introspect_clickhouse(ch)
                    .await
                    .expect("introspect clickhouse source");
                tracing::info!(
                    "source {alias}: introspected {} tables (ClickHouse, read-only)",
                    s.tables.len()
                );
                s
            }
            None => continue,
        };
        for t in s.tables.values_mut() {
            t.source = alias.clone();
        }
        dbs.insert(alias.clone(), s);
    }

    for (table, tc) in cfg.tables.iter() {
        let src = tc.from.source.as_deref();
        let phys = tc.from.table.as_deref().unwrap_or(table);
        let found = match src {
            Some(alias) => dbs
                .get(alias)
                .map(|s| s.find(tc.from.schema.as_deref(), phys).is_some())
                .unwrap_or(false),
            None => db_schema.find(tc.from.schema.as_deref(), phys).is_some(),
        };
        if !found {
            match src {
                Some(alias) => tracing::warn!(
                    "config file {table}.hcl → source \"{alias}\" has no matching table"
                ),
                None => tracing::warn!(
                    "config file {table}.hcl has no matching table in schemas {schemas:?}"
                ),
            }
        }
    }

    let secret_key = resolve_secret_key(std::env::var("CARTAPEL_SECRET_KEY").ok(), &cfg.cartapel)
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
        // No redirect-following: the source proxy and webhook actions both attach
        // secrets (token_env / HMAC signature); a 3xx to another host would leak
        // them. Upstreams are pinned to their configured (trusted, internal) host.
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("build http client"),
        secure_cookies,
        secret_key,
        webhook_secret: std::env::var("CARTAPEL_WEBHOOK_SECRET")
            .ok()
            .filter(|s| !s.is_empty()),
        options_cache: Default::default(),
        files_cache: Default::default(),
        login_limiter: Default::default(),
        config_write_lock: Default::default(),
    });
    configedit::port_legacy_roles(&state);
    watch_config(state.clone());

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
        .route(
            "/views",
            get(views::list_views_handler).post(views::create_view_handler),
        )
        .route(
            "/views/:id",
            axum::routing::delete(views::delete_view_handler),
        )
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
        .route(
            "/t/:table",
            get(rows::list_handler).post(rows::create_handler),
        )
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
        .route(
            "/t/:table/r/:pk/revert/:audit_id",
            post(rows::revert_handler),
        )
        .route(
            "/t/:table/r/:pk/inline/:child",
            get(rows::inline_page_handler),
        )
        .route("/t/:table/options/:col", get(rows::options_handler))
        .route(
            "/t/:table/image/:col/:pk",
            get(images::get_image).post(images::put_image),
        )
        .route("/t/:table/action/:name", post(actions::action_handler))
        .route("/config/discover", get(configedit::discover))
        .route("/config/setup", post(configedit::apply_setup))
        .route(
            "/config/groups",
            get(groupsedit::list_groups).post(groupsedit::create_group),
        )
        .route("/config/groups/layout", post(groupsedit::save_layout))
        .route(
            "/config/groups/:slug",
            axum::routing::patch(groupsedit::patch_group).delete(groupsedit::delete_group),
        )
        .route(
            "/config/groups/:slug/rename",
            post(groupsedit::rename_group),
        )
        .route(
            "/config/dashboard",
            get(globaledit::get_dashboard).put(globaledit::put_dashboard),
        )
        .route("/config/dashboard/preview", post(globaledit::preview_panel))
        .route(
            "/config/dashboard/versions",
            get(globaledit::list_dashboard_versions),
        )
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
        .route(
            "/config/:table/versions",
            get(configedit::list_config_versions),
        )
        .route(
            "/config/:table/versions/:id",
            get(configedit::get_config_version),
        )
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
    tracing::info!("cartapel listening on http://{listen}{}/", base_path);

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

    fn cfg_with_key(key: Option<&str>) -> config::CartapelConfig {
        config::CartapelConfig {
            secret_key: key.map(str::to_string),
            ..Default::default()
        }
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
        let key =
            resolve_secret_key(Some("env-key".into()), &cfg_with_key(Some("cfg-key"))).unwrap();
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
