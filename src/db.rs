//! The database boundary. Everything dialect-specific lives here; the rest of
//! the codebase speaks JSON rows and never sees a sqlx row type.
//!
//! How it fits together, in one breath: a configured source becomes a
//! [`DbPool`] (Postgres or MySQL). Handlers build SQL with [`crate::sqlval`]
//! helpers — [`crate::sqlval::Binds`] hands out the right placeholder (`$n` or
//! `?`), `typed`/`text_cast`/`ilike_clause`/`order_term` spell the few
//! constructs the dialects disagree on — then run it through one of the verbs
//! below, which decode every row into `serde_json::Map` with the dialect's own
//! decoder:
//!
//! - [`fetch_json_rows`] — plain reads (lists, detail, labels, options).
//! - [`read_only_json_rows`] — config-authored SQL, fenced by a read-only
//!   transaction and a statement timeout.
//! - [`execute`] / [`DbTx`] — writes; `DbTx` is a dispatched transaction so
//!   update/create/import keep one dialect-free code path.
//! - [`estimate_rows`] — cheap row-count estimates for the list page.
//!
//! The decoders ([`pg_row_to_json`], [`my_row_to_json`]) exist to answer one
//! question byte-for-byte: "what would the old `to_jsonb(t.*)` have said?" —
//! a live golden test pins that for Postgres. Where a Rust decode can't be
//! proven identical, the column emitter (`meta::select_items_for`) routes the
//! column through the database's own rendering instead.

use bigdecimal::{BigDecimal, ToPrimitive};
use chrono::{DateTime, NaiveDate, NaiveDateTime, Timelike, Utc};
use serde_json::{Map, Number, Value};
use sqlx::postgres::PgRow;
use sqlx::{Column, Row, TypeInfo};

/// Materialize a row selected via `meta::select_items` into the same JSON shape
/// `to_jsonb(t.*)` used to produce: keys in column order, timestamps in
/// Postgres' ISO form, numerics as JSON numbers (f64, like the old jsonb parse).
pub fn pg_row_to_json(row: &PgRow) -> Result<Map<String, Value>, sqlx::Error> {
    let mut out = Map::new();
    for col in row.columns() {
        let v = pg_value(row, col.ordinal(), col.type_info().name())?;
        out.insert(col.name().to_string(), v);
    }
    Ok(out)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dialect {
    Pg,
    MySql,
}

/// MySQL-protocol servers diverge where it matters (statement timeouts, auth,
/// some type reporting) — sniffed once at connect from `VERSION()`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MyFlavor {
    MySql,
    MariaDb,
}

/// One handle per configured source. Every `.pg()` call marks a site that still
/// assumes Postgres — the dialect port works by making those calls disappear
/// behind seams; reaching one with a MySQL source is a routing bug upstream
/// (config load refuses bindings the port hasn't reached yet).
#[derive(Clone)]
pub enum DbPool {
    Pg(sqlx::PgPool),
    MySql(sqlx::MySqlPool, MyFlavor),
}

impl DbPool {
    pub fn pg(&self) -> &sqlx::PgPool {
        match self {
            DbPool::Pg(p) => p,
            DbPool::MySql(..) => unreachable!("MySQL source reached a Postgres-only path"),
        }
    }

    pub fn dialect(&self) -> Dialect {
        match self {
            DbPool::Pg(_) => Dialect::Pg,
            DbPool::MySql(..) => Dialect::MySql,
        }
    }
}

/// MySQL rows decode natively — the closed type surface the Phase-0 rig proved:
/// unsigned bigints need u64, DECIMAL only decodes via rust_decimal, JSON decodes
/// as Value even when MariaDB's TypeInfo says BLOB.
pub fn my_row_to_json(row: &sqlx::mysql::MySqlRow) -> Result<Map<String, Value>, sqlx::Error> {
    let mut out = Map::new();
    for col in row.columns() {
        let v = my_value(row, col.ordinal(), col.type_info().name())?;
        out.insert(col.name().to_string(), v);
    }
    Ok(out)
}

fn my_value(row: &sqlx::mysql::MySqlRow, i: usize, ty: &str) -> Result<Value, sqlx::Error> {
    let v = match ty {
        "BOOLEAN" | "BOOL" => row.try_get::<Option<bool>, _>(i)?.map(Value::from),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => {
            row.try_get::<Option<i64>, _>(i)?.map(Value::from)
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIGINT UNSIGNED" | "BIT" => row.try_get::<Option<u64>, _>(i)?.map(Value::from),
        "FLOAT" | "DOUBLE" => row.try_get::<Option<f64>, _>(i)?.map(json_float),
        "DECIMAL" => row
            .try_get::<Option<rust_decimal::Decimal>, _>(i)?
            .map(|d| match d.to_string().parse::<Number>() {
                Ok(n) => Value::Number(n),
                Err(_) => Value::String(d.to_string()),
            }),
        "DATETIME" | "TIMESTAMP" => row
            .try_get::<Option<NaiveDateTime>, _>(i)?
            .map(|dt| Value::String(fmt_pg_ts(dt))),
        "DATE" => row
            .try_get::<Option<NaiveDate>, _>(i)?
            .map(|d| Value::String(d.format("%Y-%m-%d").to_string())),
        "TIME" => row
            .try_get::<Option<String>, _>(i)
            .or_else(|_| {
                row.try_get::<Option<Vec<u8>>, _>(i)
                    .map(|b| b.map(|b| String::from_utf8_lossy(&b).into_owned()))
            })?
            .map(Value::String),
        "JSON" => row.try_get::<Option<Value>, _>(i)?,
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" => {
            match row.try_get::<Option<Value>, _>(i) {
                Ok(v) => v,
                Err(_) => row
                    .try_get::<Option<Vec<u8>>, _>(i)?
                    .map(|b| Value::String(format!("\\x{}", hex::encode(b)))),
            }
        }
        _ => match row.try_get::<Option<String>, _>(i) {
            Ok(s) => s.map(Value::String),
            Err(e) => {
                tracing::warn!(column = i, r#type = ty, "undecodable mysql column: {e}");
                Some(Value::Null)
            }
        },
    };
    Ok(v.unwrap_or(Value::Null))
}

/// Dialect-dispatched fetch: the only place handler code runs table SQL, decoded
/// straight to JSON rows so nothing outside db.rs touches a sqlx row type.
pub async fn fetch_json_rows(
    pool: &DbPool,
    sql: &str,
    binds: &crate::sqlval::Binds,
) -> Result<Vec<Map<String, Value>>, sqlx::Error> {
    match pool {
        DbPool::Pg(pg) => {
            let rows = binds.query(sql).fetch_all(pg).await?;
            rows.iter().map(pg_row_to_json).collect()
        }
        DbPool::MySql(my, _) => {
            let mut q = sqlx::query(sql);
            for v in &binds.values {
                q = q.bind(v.as_deref());
            }
            let rows = q.fetch_all(my).await?;
            rows.iter().map(my_row_to_json).collect()
        }
    }
}

pub struct ExecResult {
    pub rows_affected: u64,
    pub last_insert_id: Option<u64>,
}

/// A dialect-dispatched transaction: write handlers stay dialect-free by doing
/// every statement through these verbs.
pub enum DbTx<'c> {
    Pg(sqlx::Transaction<'c, sqlx::Postgres>),
    My(sqlx::Transaction<'c, sqlx::MySql>),
}

impl DbPool {
    pub async fn begin_tx(&self) -> Result<DbTx<'_>, sqlx::Error> {
        match self {
            DbPool::Pg(p) => Ok(DbTx::Pg(p.begin().await?)),
            DbPool::MySql(p, _) => Ok(DbTx::My(p.begin().await?)),
        }
    }
}

impl DbTx<'_> {
    pub async fn fetch_json_rows(
        &mut self,
        sql: &str,
        binds: &crate::sqlval::Binds,
    ) -> Result<Vec<Map<String, Value>>, sqlx::Error> {
        match self {
            DbTx::Pg(tx) => {
                let rows = binds.query(sql).fetch_all(&mut **tx).await?;
                rows.iter().map(pg_row_to_json).collect()
            }
            DbTx::My(tx) => {
                let mut q = sqlx::query(sql);
                for v in &binds.values {
                    q = q.bind(v.as_deref());
                }
                let rows = q.fetch_all(&mut **tx).await?;
                rows.iter().map(my_row_to_json).collect()
            }
        }
    }

    pub async fn execute(
        &mut self,
        sql: &str,
        binds: &crate::sqlval::Binds,
    ) -> Result<ExecResult, sqlx::Error> {
        match self {
            DbTx::Pg(tx) => {
                let r = binds.query(sql).execute(&mut **tx).await?;
                Ok(ExecResult {
                    rows_affected: r.rows_affected(),
                    last_insert_id: None,
                })
            }
            DbTx::My(tx) => {
                let mut q = sqlx::query(sql);
                for v in &binds.values {
                    q = q.bind(v.as_deref());
                }
                let r = q.execute(&mut **tx).await?;
                Ok(ExecResult {
                    rows_affected: r.rows_affected(),
                    last_insert_id: Some(r.last_insert_id()),
                })
            }
        }
    }

    /// Unprepared statement (text protocol) — savepoint verbs and other
    /// commands MySQL refuses to prepare.
    pub async fn raw(&mut self, sql: &str) -> Result<(), sqlx::Error> {
        match self {
            DbTx::Pg(tx) => sqlx::Executor::execute(&mut **tx, sql).await.map(|_| ()),
            DbTx::My(tx) => sqlx::Executor::execute(&mut **tx, sql).await.map(|_| ()),
        }
    }

    pub async fn commit(self) -> Result<(), sqlx::Error> {
        match self {
            DbTx::Pg(tx) => tx.commit().await,
            DbTx::My(tx) => tx.commit().await,
        }
    }
}

/// Non-transactional dispatched execute (deletes, bulk updates).
pub async fn execute(
    pool: &DbPool,
    sql: &str,
    binds: &crate::sqlval::Binds,
) -> Result<ExecResult, sqlx::Error> {
    match pool {
        DbPool::Pg(pg) => {
            let r = binds.query(sql).execute(pg).await?;
            Ok(ExecResult {
                rows_affected: r.rows_affected(),
                last_insert_id: None,
            })
        }
        DbPool::MySql(my, _) => {
            let mut q = sqlx::query(sql);
            for v in &binds.values {
                q = q.bind(v.as_deref());
            }
            let r = q.execute(my).await?;
            Ok(ExecResult {
                rows_affected: r.rows_affected(),
                last_insert_id: Some(r.last_insert_id()),
            })
        }
    }
}

/// Read-only + timeout rails, decoded to JSON rows:
/// MySQL runs `START TRANSACTION READ ONLY` raw (sqlx tx verbs can't) and the
/// statement timeout rides flavor syntax — optimizer hint on MySQL, wrapped
/// `SET STATEMENT` on MariaDB.
pub async fn read_only_json_rows(
    pool: &DbPool,
    sql: &str,
    binds: &crate::sqlval::Binds,
    timeout_ms: u32,
) -> Result<Vec<Map<String, Value>>, sqlx::Error> {
    match pool {
        DbPool::Pg(pg) => {
            let mut tx = pg.begin().await?;
            sqlx::query("SET TRANSACTION READ ONLY")
                .execute(&mut *tx)
                .await?;
            sqlx::query(&format!("SET LOCAL statement_timeout = '{timeout_ms}ms'"))
                .execute(&mut *tx)
                .await?;
            let rows = binds.query(sql).fetch_all(&mut *tx).await?;
            let _ = tx.rollback().await;
            rows.iter().map(pg_row_to_json).collect()
        }
        DbPool::MySql(my, flavor) => {
            let mut conn = my.acquire().await?;
            sqlx::Executor::execute(&mut *conn, "START TRANSACTION READ ONLY").await?;
            let timed = match flavor {
                MyFlavor::MySql => mysql_timeout_hint(sql, timeout_ms),
                MyFlavor::MariaDb => format!(
                    "SET STATEMENT max_statement_time={} FOR {sql}",
                    timeout_ms as f64 / 1000.0
                ),
            };
            let mut q = sqlx::query(&timed);
            for v in &binds.values {
                q = q.bind(v.as_deref());
            }
            let res = q.fetch_all(&mut *conn).await;
            let _ = sqlx::Executor::execute(&mut *conn, "ROLLBACK").await;
            res?.iter().map(my_row_to_json).collect()
        }
    }
}

/// Config-authored SQL (dashboard panels, variable queries, plugin queries)
/// run read-only, time-boxed and row-capped, and come back as JSON rows.
/// Postgres materializes through `row_to_json` — exact for its open type
/// surface; MySQL decodes natively — its type surface is closed, so
/// [`my_row_to_json`] covers it.
pub async fn config_query_rows(
    pool: &DbPool,
    sql: &str,
    binds: &[crate::interp::BoundVal],
    cap: i64,
    timeout_ms: u32,
) -> Result<Vec<Map<String, Value>>, sqlx::Error> {
    match pool {
        DbPool::Pg(pg) => {
            let wrapped = format!("SELECT row_to_json(sub.*) AS r FROM ({sql}) sub LIMIT {cap}");
            let mut tx = pg.begin().await?;
            sqlx::query("SET TRANSACTION READ ONLY")
                .execute(&mut *tx)
                .await?;
            sqlx::query(&format!("SET LOCAL statement_timeout = '{timeout_ms}ms'"))
                .execute(&mut *tx)
                .await?;
            let rows = crate::interp::bind_all(sqlx::query(&wrapped), binds)
                .fetch_all(&mut *tx)
                .await?;
            let _ = tx.rollback().await;
            Ok(rows
                .into_iter()
                .filter_map(|r| match r.get::<Value, _>("r") {
                    Value::Object(m) => Some(m),
                    _ => None,
                })
                .collect())
        }
        DbPool::MySql(my, flavor) => {
            let wrapped = format!("SELECT sub.* FROM ({sql}) sub LIMIT {cap}");
            let mut conn = my.acquire().await?;
            sqlx::Executor::execute(&mut *conn, "START TRANSACTION READ ONLY").await?;
            let timed = match flavor {
                MyFlavor::MySql => mysql_timeout_hint(&wrapped, timeout_ms),
                MyFlavor::MariaDb => format!(
                    "SET STATEMENT max_statement_time={} FOR {wrapped}",
                    timeout_ms as f64 / 1000.0
                ),
            };
            let mut q = sqlx::query(&timed);
            for b in binds {
                q = match b {
                    crate::interp::BoundVal::Text(s) => q.bind(s.as_str()),
                    crate::interp::BoundVal::Int(n) => q.bind(*n),
                    crate::interp::BoundVal::Float(f) => q.bind(*f),
                };
            }
            let res = q.fetch_all(&mut *conn).await;
            let _ = sqlx::Executor::execute(&mut *conn, "ROLLBACK").await;
            res?.iter().map(my_row_to_json).collect()
        }
    }
}

/// Cheap row-count estimate for the unfiltered list page: planner stats on
/// Postgres, information_schema on MySQL (staleness documented — TABLE_ROWS can
/// lag by up to a day on MySQL 8 defaults).
pub async fn estimate_rows(
    pool: &DbPool,
    dbt: &crate::introspect::DbTable,
) -> Result<i64, sqlx::Error> {
    match pool {
        DbPool::Pg(pg) => {
            let est = sqlx::query(
                "SELECT GREATEST(reltuples, 0)::bigint AS n FROM pg_class WHERE oid = $1::regclass",
            )
            .bind(format!("\"{}\".\"{}\"", dbt.schema, dbt.name))
            .fetch_optional(pg)
            .await?
            .map(|r| r.get::<i64, _>("n"))
            .unwrap_or(0);
            Ok(est)
        }
        DbPool::MySql(my, _) => {
            let est = sqlx::query(
                "SELECT CAST(COALESCE(TABLE_ROWS, 0) AS SIGNED) AS n
                 FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
            )
            .bind(&dbt.name)
            .fetch_optional(my)
            .await?
            .map(|r| r.get::<i64, _>("n"))
            .unwrap_or(0);
            Ok(est)
        }
    }
}

/// `MAX_EXECUTION_TIME` only applies as a post-SELECT optimizer hint.
fn mysql_timeout_hint(sql: &str, ms: u32) -> String {
    let t = sql.trim_start();
    if t.len() > 7 && t[..7].eq_ignore_ascii_case("select ") {
        format!("SELECT /*+ MAX_EXECUTION_TIME({ms}) */ {}", &t[7..])
    } else {
        sql.to_string()
    }
}

fn pg_value(row: &PgRow, i: usize, ty: &str) -> Result<Value, sqlx::Error> {
    let v = match ty {
        "INT2" => row.try_get::<Option<i16>, _>(i)?.map(Value::from),
        "INT4" => row.try_get::<Option<i32>, _>(i)?.map(Value::from),
        "INT8" => row.try_get::<Option<i64>, _>(i)?.map(Value::from),
        "OID" => row
            .try_get::<Option<sqlx::postgres::types::Oid>, _>(i)?
            .map(|o| Value::from(o.0)),
        "FLOAT4" => row
            .try_get::<Option<f32>, _>(i)?
            .map(|f| json_float(f.to_string().parse().unwrap_or(f64::NAN))),
        "FLOAT8" => row.try_get::<Option<f64>, _>(i)?.map(json_float),
        "NUMERIC" => row.try_get::<Option<BigDecimal>, _>(i)?.map(json_numeric),
        "BOOL" => row.try_get::<Option<bool>, _>(i)?.map(Value::from),
        "UUID" => row
            .try_get::<Option<uuid::Uuid>, _>(i)?
            .map(|u| Value::String(u.to_string())),
        "TIMESTAMP" => row
            .try_get::<Option<NaiveDateTime>, _>(i)?
            .map(|dt| Value::String(fmt_pg_ts(dt))),
        "TIMESTAMPTZ" => row
            .try_get::<Option<DateTime<Utc>>, _>(i)?
            .map(|dt| Value::String(fmt_pg_tstz(dt))),
        "DATE" => row
            .try_get::<Option<NaiveDate>, _>(i)?
            .map(|d| Value::String(d.format("%Y-%m-%d").to_string())),
        "JSON" | "JSONB" => row.try_get::<Option<Value>, _>(i)?,
        "BYTEA" => row
            .try_get::<Option<Vec<u8>>, _>(i)?
            .map(|b| Value::String(format!("\\x{}", hex::encode(b)))),
        _ => match row.try_get::<Option<String>, _>(i) {
            Ok(s) => s.map(Value::String),
            Err(e) => {
                tracing::warn!(column = i, r#type = ty, "undecodable column: {e}");
                Some(Value::Null)
            }
        },
    };
    Ok(v.unwrap_or(Value::Null))
}

/// `to_jsonb` renders integer-valued floats without a decimal point, which the
/// old jsonb parse then read as a JSON integer — reproduce that. Fallback path
/// only: table floats are emitted via per-column `to_jsonb`.
fn json_float(f: f64) -> Value {
    if f.is_finite() && f == f.trunc() {
        if (0.0..18446744073709551616.0).contains(&f) {
            return Value::from(f as u64);
        }
        if (-9223372036854775808.0..0.0).contains(&f) {
            return Value::from(f as i64);
        }
    }
    Number::from_f64(f)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// Fallback path only (table numerics ride per-column `to_jsonb`; sqlx drops
/// the wire dscale, so stored-scale rendering is not reproducible here).
fn json_numeric(d: BigDecimal) -> Value {
    let (_, scale) = d.as_bigint_and_exponent();
    if scale <= 0 {
        if let Some(i) = d.to_i64() {
            return Value::from(i);
        }
    }
    Number::from_f64(d.to_f64().unwrap_or(f64::NAN))
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn fmt_frac(micros: u32) -> String {
    if micros == 0 {
        return String::new();
    }
    format!(".{:06}", micros).trim_end_matches('0').to_string()
}

fn fmt_pg_ts(dt: NaiveDateTime) -> String {
    format!(
        "{}{}",
        dt.format("%Y-%m-%dT%H:%M:%S"),
        fmt_frac(dt.time().nanosecond() / 1000)
    )
}

fn fmt_pg_tstz(dt: DateTime<Utc>) -> String {
    format!(
        "{}{}+00:00",
        dt.format("%Y-%m-%dT%H:%M:%S"),
        fmt_frac(dt.time().nanosecond() / 1000)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;

    fn ts(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f").unwrap()
    }

    #[test]
    fn timestamp_format_matches_to_jsonb() {
        assert_eq!(fmt_pg_ts(ts("2024-03-05 07:08:09")), "2024-03-05T07:08:09");
        assert_eq!(
            fmt_pg_ts(ts("2024-03-05 07:08:09.123450")),
            "2024-03-05T07:08:09.12345"
        );
        assert_eq!(
            fmt_pg_ts(ts("2024-03-05 07:08:09.5")),
            "2024-03-05T07:08:09.5"
        );
        assert_eq!(
            fmt_pg_tstz(ts("2024-03-05 07:08:09.000001").and_utc()),
            "2024-03-05T07:08:09.000001+00:00"
        );
        assert_eq!(
            fmt_pg_tstz(ts("2024-03-05 07:08:09").and_utc()),
            "2024-03-05T07:08:09+00:00"
        );
    }

    #[test]
    fn float_edge_values_become_null_not_panics() {
        assert_eq!(json_float(f64::NAN), Value::Null);
        assert_eq!(json_float(f64::INFINITY), Value::Null);
        assert_eq!(json_float(2.0), serde_json::json!(2));
        assert_eq!(json_float(2.5), serde_json::json!(2.5));
    }

    /// The Phase-1 gate: for a fixture spanning every Kind (plus enum, interval,
    /// bpchar, arrays-with-NULLs, unicode, fractional timestamps, big ints), the
    /// Rust decoder must produce exactly what `to_jsonb(t.*)` produced — after
    /// `present_row`, which is where binary length-vs-hex converges. Needs a live
    /// PG in CARTAPEL_TEST_DB; skipped otherwise.
    #[tokio::test]
    async fn golden_diff_matches_to_jsonb() {
        let Ok(url) = std::env::var("CARTAPEL_TEST_DB") else {
            eprintln!("CARTAPEL_TEST_DB not set — golden diff skipped");
            return;
        };
        let pool = sqlx::PgPool::connect(&url).await.unwrap();
        for stmt in [
            "DROP TABLE IF EXISTS golden_kinds",
            "DROP TYPE IF EXISTS golden_mood",
            "DROP TYPE IF EXISTS golden_pt",
            "CREATE TYPE golden_mood AS ENUM ('ok','meh','wow')",
            "CREATE TYPE golden_pt AS (a int, b text)",
            r#"CREATE TABLE golden_kinds (
                id bigserial PRIMARY KEY,
                t text, vc varchar(40), ch char(3), "we""ird" text, wch "char",
                i2 int2, i4 int4, i8 int8,
                f4 float4, f8 float8, num numeric(20,4), num_free numeric,
                b bool, ts timestamp, tstz timestamptz, d date,
                u uuid, js jsonb, jsn json,
                arr_t text[], arr_i int[],
                by bytea, mood golden_mood, iv interval, comp golden_pt)"#,
            "INSERT INTO golden_kinds (t) VALUES (NULL)",
            r#"INSERT INTO golden_kinds
               (t, vc, ch, i2, i4, i8, f4, f8, num, num_free, b, ts, tstz, d,
                u, js, jsn, arr_t, arr_i, by, mood, iv)
               VALUES
               ('héllo "q" \', 'vc', 'ab', -3, 42, 9007199254740993, 1.5, 2.0,
                1234.5000, 0.1, true,
                '2024-03-05 07:08:09.123450', '2024-03-05 07:08:09.5+00', '2024-03-05',
                'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
                '{"a": [1, null, "x"], "b": {"c": 2.5}}', '{"k": 1}',
                ARRAY['a', NULL, 'ü'], ARRAY[1, NULL, 3],
                '\xdeadbeef', 'wow', interval '1 day 02:03:04')"#,
            "INSERT INTO golden_kinds (f4, f8, num, num_free)
             VALUES (0.1, 123456789.0, 5, 7)",
            r#"INSERT INTO golden_kinds
               ("we""ird", wch, f4, f8, num, ts, tstz, d, comp, jsn)
               VALUES ('q"uoted', 'Y', 'Infinity', 'NaN', 49.0000,
                       'infinity', '-infinity', '0200-01-01 BC',
                       ROW(1, 'foo')::golden_pt, '{"dup": 1, "dup": 2, "e": 1E2}')"#,
            "INSERT INTO golden_kinds (ts, d) VALUES ('10200-01-02 03:04:05', '10200-01-02')",
        ] {
            sqlx::query(stmt).execute(&pool).await.unwrap();
        }

        let schema = crate::introspect::introspect(&pool, &["public".into()])
            .await
            .unwrap();
        let dbt = schema.tables.get("golden_kinds").expect("fixture table");
        let mut cfg = crate::config::TableConfig::default();
        cfg.fields.insert(
            "i4_plus".into(),
            crate::config::FieldConfig {
                sql: Some("t.i4 + 1".into()),
                ..Default::default()
            },
        );

        let bins: Vec<String> = dbt
            .columns
            .iter()
            .filter(|c| c.kind == crate::introspect::Kind::Binary)
            .map(|c| c.name.clone())
            .collect();
        let old_sql = "SELECT to_jsonb(t.*) || jsonb_build_object('i4_plus', (t.i4 + 1)) AS r
                       FROM golden_kinds t ORDER BY id";
        let new_sql = format!(
            "SELECT {} FROM golden_kinds t ORDER BY id",
            crate::meta::select_items_for(dbt, &cfg, Dialect::Pg).join(", ")
        );
        let old_rows = sqlx::query(old_sql).fetch_all(&pool).await.unwrap();
        let new_rows = sqlx::query(&new_sql).fetch_all(&pool).await.unwrap();
        assert_eq!(old_rows.len(), new_rows.len());
        for (o, n) in old_rows.iter().zip(&new_rows) {
            let mut old: Value = o.get("r");
            let mut new = Value::Object(pg_row_to_json(n).unwrap());
            crate::sqlval::present_row(&mut old, &[], &bins);
            crate::sqlval::present_row(&mut new, &[], &bins);
            assert_eq!(
                old, new,
                "decoder output diverged from to_jsonb\nold: {old}\nnew: {new}"
            );
        }
    }
}
