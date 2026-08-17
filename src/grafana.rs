//! `type = "grafana"` sources: a panel asks Grafana's datasource proxy
//! (`/api/datasources/proxy/uid/<uid>/…`) with one service-account token, and
//! the answer — Prometheus, Loki or Tempo, whichever the datasource is — comes
//! back as rows the stat/chart/table renderers already understand. Grafana is
//! the credential holder and the router; cartapel never learns the backends'
//! addresses, and its UI never has to open Grafana's.
//!
//! Row shapes, per datasource type:
//! - Prometheus / Loki metric queries → `{t, v, …labels, __series}` for a range,
//!   `{v, …labels}` for an instant vector, `{v}` for a scalar.
//! - Loki log queries → `{t, line, message?, …labels}`, newest first.
//! - Tempo TraceQL search → `{trace_id, service, name, started_at, duration_ms}`.

use crate::state::{AppError, AppState, CurrentUser};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DS_TTL: Duration = Duration::from_secs(300);
const TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_RANGE_SECS: u64 = 3600;
const MIN_STEP_SECS: u64 = 15;
const TARGET_POINTS: u64 = 200;
const BODY_CAP: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Datasource {
    pub uid: String,
    pub kind: String,
}

type DsCache = HashMap<(String, String), (Instant, Datasource)>;
static DS_CACHE: LazyLock<Mutex<DsCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// What a panel asks of the datasource. `range` is the lookback that ends now;
/// `instant` asks for the value at now (metrics only); `limit` caps log lines
/// and traces.
#[derive(Debug, Clone)]
pub struct Query {
    pub ds: String,
    pub expr: String,
    pub range: Duration,
    pub step: Option<Duration>,
    pub instant: bool,
    pub limit: usize,
}

/// `30s` / `5m` / `6h` / `7d` / a bare number of seconds.
pub fn parse_duration(s: &str) -> Result<Duration, String> {
    let s = s.trim();
    let (num, unit) = match s.char_indices().find(|(_, c)| !c.is_ascii_digit()) {
        Some((i, _)) => s.split_at(i),
        None => (s, "s"),
    };
    let n: u64 = num
        .parse()
        .map_err(|_| format!("bad duration \"{s}\" — use 30s, 5m, 6h or 7d"))?;
    let mult = match unit.trim() {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        _ => return Err(format!("bad duration \"{s}\" — use 30s, 5m, 6h or 7d")),
    };
    Ok(Duration::from_secs(n * mult))
}

pub fn default_range() -> Duration {
    Duration::from_secs(DEFAULT_RANGE_SECS)
}

fn step_for(range: Duration, step: Option<Duration>) -> u64 {
    match step {
        Some(s) => s.as_secs().max(1),
        None => (range.as_secs() / TARGET_POINTS).max(MIN_STEP_SECS),
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn rfc3339(secs: f64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(
        secs.floor() as i64,
        ((secs.fract()) * 1e9) as u32,
    )
    .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    .unwrap_or_default()
}

fn rfc3339_nanos(ns: i128) -> String {
    let secs = (ns / 1_000_000_000) as i64;
    let sub = (ns % 1_000_000_000) as u32;
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, sub)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

struct Source {
    url: String,
    token: Option<String>,
}

fn source_for(state: &AppState, user: &CurrentUser, alias: &str) -> Result<Source, AppError> {
    let cfg = state.cfg();
    let src = cfg
        .sources
        .get(alias)
        .ok_or_else(|| AppError::not_found(format!("unknown source {alias}")))?;
    if !user.may(&src.roles, crate::state::Access::AdminOnly) {
        return Err(AppError::forbidden("source not allowed for your role"));
    }
    if !src.is_grafana() {
        return Err(AppError::bad(format!(
            "source \"{alias}\" is a {} source, not grafana",
            src.kind
        )));
    }
    let url = crate::config::resolve_env(&src.url)
        .unwrap_or_else(|| src.url.clone())
        .trim_end_matches('/')
        .to_string();
    if url.is_empty() {
        return Err(AppError::bad(format!("source \"{alias}\": missing url")));
    }
    let token = src
        .token_env
        .as_deref()
        .and_then(|k| std::env::var(k).ok())
        .filter(|t| !t.is_empty());
    Ok(Source { url, token })
}

async fn get_json(
    state: &AppState,
    src: &Source,
    path: &str,
    what: &str,
) -> Result<Value, AppError> {
    let mut req = state
        .http
        .get(format!("{}{path}", src.url))
        .timeout(TIMEOUT);
    if let Some(t) = &src.token {
        req = req.bearer_auth(t);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::internal(format!("grafana {what}: {e}")))?;
    let status = resp.status();
    let body = resp
        .bytes()
        .await
        .map_err(|e| AppError::internal(format!("grafana {what}: {e}")))?;
    if body.len() > BODY_CAP {
        return Err(AppError::bad(format!(
            "grafana {what}: answer over the {BODY_CAP} byte cap"
        )));
    }
    if !status.is_success() {
        let snippet = String::from_utf8_lossy(&body[..body.len().min(300)]).into_owned();
        return Err(AppError::bad(format!(
            "grafana {what}: {status} — {snippet}"
        )));
    }
    serde_json::from_slice(&body)
        .map_err(|e| AppError::bad(format!("grafana {what}: not json: {e}")))
}

/// The datasource a panel names, by Grafana name or uid, remembered for a while
/// — the list changes when someone provisions, not per request.
async fn datasource(
    state: &AppState,
    src: &Source,
    alias: &str,
    ds: &str,
) -> Result<Datasource, AppError> {
    let key = (alias.to_string(), ds.to_string());
    if let Some((at, d)) = DS_CACHE.lock().unwrap().get(&key) {
        if at.elapsed() < DS_TTL {
            return Ok(d.clone());
        }
    }
    let list = get_json(state, src, "/api/datasources", "datasources").await?;
    let found = list
        .as_array()
        .into_iter()
        .flatten()
        .find(|d| {
            d.get("uid").and_then(Value::as_str) == Some(ds)
                || d.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| n.eq_ignore_ascii_case(ds))
        })
        .and_then(|d| {
            Some(Datasource {
                uid: d.get("uid")?.as_str()?.to_string(),
                kind: d.get("type")?.as_str()?.to_string(),
            })
        })
        .ok_or_else(|| {
            AppError::bad(format!(
                "grafana source \"{alias}\" has no datasource \"{ds}\""
            ))
        })?;
    DS_CACHE
        .lock()
        .unwrap()
        .insert(key, (Instant::now(), found.clone()));
    Ok(found)
}

/// Run one query against the datasource and return rows.
pub async fn rows(
    state: &AppState,
    user: &CurrentUser,
    alias: &str,
    q: &Query,
) -> Result<Vec<Value>, AppError> {
    let src = source_for(state, user, alias)?;
    let ds = datasource(state, &src, alias, &q.ds).await?;
    let proxy = format!("/api/datasources/proxy/uid/{}", ds.uid);
    let end = now_secs();
    let start = end.saturating_sub(q.range.as_secs());
    let step = step_for(q.range, q.step);
    let expr = with_intervals(&q.expr, step);
    let expr = percent_encoding::utf8_percent_encode(&expr, percent_encoding::NON_ALPHANUMERIC)
        .to_string();
    match ds.kind.as_str() {
        "prometheus" => {
            let path = if q.instant {
                format!("{proxy}/api/v1/query?query={expr}&time={end}")
            } else {
                format!(
                    "{proxy}/api/v1/query_range?query={expr}&start={start}&end={end}&step={step}"
                )
            };
            let v = get_json(state, &src, &path, "prometheus").await?;
            let rows = prometheus_rows(&v).map_err(AppError::bad)?;
            Ok(if q.instant {
                rows
            } else {
                fill_grid(rows, start, end, step)
            })
        }
        "loki" => {
            let path = if q.instant {
                format!(
                    "{proxy}/loki/api/v1/query?query={expr}&time={}",
                    end as u128 * 1_000_000_000
                )
            } else {
                format!(
                    "{proxy}/loki/api/v1/query_range?query={expr}&start={}&end={}&step={step}&limit={}&direction=backward",
                    start as u128 * 1_000_000_000,
                    end as u128 * 1_000_000_000,
                    q.limit.max(1)
                )
            };
            let v = get_json(state, &src, &path, "loki").await?;
            let rows = loki_rows(&v).map_err(AppError::bad)?;
            let metric = rows.first().is_some_and(|r| r.get("__series").is_some());
            Ok(if q.instant || !metric {
                rows
            } else {
                fill_grid(rows, start, end, step)
            })
        }
        "tempo" => {
            let path = format!(
                "{proxy}/api/search?q={expr}&start={start}&end={end}&limit={}",
                q.limit.max(1)
            );
            let v = get_json(state, &src, &path, "tempo").await?;
            tempo_rows(&v).map_err(AppError::bad)
        }
        other => Err(AppError::bad(format!(
            "grafana datasource \"{}\" is {other} — prometheus, loki and tempo are supported",
            q.ds
        ))),
    }
}

/// Grafana's interval tokens, so a rate window follows the resolution instead
/// of a hard-coded `[1m]` that turns into noise at a 7-day step: `$__interval`
/// is the step, `$__rate_interval` four times a scrape or the step plus one,
/// whichever is larger (Grafana's own rule, with a 15s scrape assumed).
fn with_intervals(expr: &str, step_secs: u64) -> String {
    const SCRAPE: u64 = 15;
    let rate = (4 * SCRAPE).max(step_secs + SCRAPE);
    expr.replace("$__rate_interval", &format!("{rate}s"))
        .replace("$__interval", &format!("{step_secs}s"))
}

/// Range rows on the full `start..=end` grid at `step`: every series gets one
/// row per slot, `v` null where it had no sample. Series then line up point
/// for point and a chart spans the window asked for, not the span the data
/// happened to cover.
pub fn fill_grid(rows: Vec<Value>, start: u64, end: u64, step: u64) -> Vec<Value> {
    if rows.is_empty() || step == 0 {
        return rows;
    }
    let slots: Vec<u64> = (0..=(end.saturating_sub(start)) / step)
        .map(|k| start + k * step)
        .collect();
    let mut order: Vec<String> = Vec::new();
    let mut labels: HashMap<String, Map<String, Value>> = HashMap::new();
    let mut samples: HashMap<String, HashMap<u64, f64>> = HashMap::new();
    for r in &rows {
        let Some(obj) = r.as_object() else { continue };
        let Some(t) = obj
            .get("t")
            .and_then(Value::as_str)
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        else {
            continue;
        };
        let key = obj
            .get("__series")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !labels.contains_key(&key) {
            order.push(key.clone());
            let mut l = obj.clone();
            l.remove("t");
            l.remove("v");
            labels.insert(key.clone(), l);
        }
        let ts = t.timestamp().max(0) as u64;
        let slot = start + ((ts.saturating_sub(start) + step / 2) / step) * step;
        if let Some(v) = obj.get("v").and_then(Value::as_f64) {
            samples.entry(key).or_default().insert(slot, v);
        }
    }
    let mut out = Vec::with_capacity(order.len() * slots.len());
    for key in order {
        let l = labels.remove(&key).unwrap_or_default();
        let s = samples.remove(&key).unwrap_or_default();
        for slot in &slots {
            let mut row = l.clone();
            row.insert("t".into(), json!(rfc3339(*slot as f64)));
            row.insert(
                "v".into(),
                s.get(slot).map(|v| json!(v)).unwrap_or(Value::Null),
            );
            out.push(Value::Object(row));
        }
    }
    out
}

/// A series label for the chart legend: the label VALUES, joined — a legend
/// reads `history · ok`, not `intent=history,result=ok` — falling back to the
/// metric name, then to `other` (a legend only shows with several series, and
/// the unlabelled one is whatever the grouping could not name).
fn series_label(metric: &Map<String, Value>) -> String {
    let values: Vec<&str> = metric
        .iter()
        .filter(|(k, _)| k.as_str() != "__name__")
        .filter_map(|(_, v)| v.as_str())
        .collect();
    if !values.is_empty() {
        return values.join(" · ");
    }
    metric
        .get("__name__")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
        .unwrap_or("other")
        .to_string()
}

fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn labels_into(row: &mut Map<String, Value>, metric: &Map<String, Value>) {
    for (k, v) in metric {
        if k != "__name__" {
            row.insert(k.clone(), v.clone());
        }
    }
}

/// Prometheus `/api/v1/query{,_range}` → rows. Shared by Loki metric queries,
/// whose answer has the same shape.
pub fn prometheus_rows(v: &Value) -> Result<Vec<Value>, String> {
    if v.get("status").and_then(Value::as_str) != Some("success") {
        let msg = v
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("query failed");
        return Err(msg.to_string());
    }
    let data = v.get("data").ok_or("no data in answer")?;
    let kind = data.get("resultType").and_then(Value::as_str).unwrap_or("");
    let result = data.get("result").ok_or("no result in answer")?;
    let mut rows = Vec::new();
    match kind {
        "scalar" | "string" => {
            if let Some(val) = result.get(1).and_then(number) {
                rows.push(json!({ "v": val }));
            }
        }
        "vector" => {
            for item in result.as_array().into_iter().flatten() {
                let metric = item
                    .get("metric")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let Some(val) = item.get("value").and_then(|p| p.get(1)).and_then(number) else {
                    continue;
                };
                let mut row = Map::new();
                labels_into(&mut row, &metric);
                row.insert("v".into(), json!(val));
                rows.push(Value::Object(row));
            }
        }
        "matrix" => {
            for item in result.as_array().into_iter().flatten() {
                let metric = item
                    .get("metric")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let label = series_label(&metric);
                for p in item
                    .get("values")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let (Some(t), Some(val)) =
                        (p.get(0).and_then(number), p.get(1).and_then(number))
                    else {
                        continue;
                    };
                    let mut row = Map::new();
                    row.insert("t".into(), json!(rfc3339(t)));
                    row.insert("v".into(), json!(val));
                    labels_into(&mut row, &metric);
                    row.insert("__series".into(), json!(label));
                    rows.push(Value::Object(row));
                }
            }
        }
        "streams" => return loki_rows(v),
        other => return Err(format!("unexpected result type \"{other}\"")),
    }
    Ok(rows)
}

/// Loki `/loki/api/v1/query{,_range}` → rows. A metric query answers like
/// Prometheus; a log query answers streams, flattened newest-first with the
/// stream labels as columns and, when the line is JSON, what it says lifted
/// into `message` (its `message`, else `msg`, `error` or `name`).
pub fn loki_rows(v: &Value) -> Result<Vec<Value>, String> {
    let kind = v
        .get("data")
        .and_then(|d| d.get("resultType"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if kind != "streams" {
        return prometheus_rows(v);
    }
    let result = v["data"]["result"].as_array().cloned().unwrap_or_default();
    let mut rows: Vec<(i128, Value)> = Vec::new();
    for stream in result {
        let labels = stream
            .get("stream")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for entry in stream
            .get("values")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(ts), Some(line)) = (
                entry
                    .get(0)
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<i128>().ok()),
                entry.get(1).and_then(Value::as_str),
            ) else {
                continue;
            };
            let mut row = Map::new();
            row.insert("t".into(), json!(rfc3339_nanos(ts)));
            if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(line) {
                let said = ["message", "msg", "error", "name"]
                    .iter()
                    .filter_map(|k| obj.get(*k).and_then(Value::as_str))
                    .find(|m| !m.trim().is_empty());
                if let Some(m) = said {
                    row.insert("message".into(), json!(m));
                }
            }
            row.insert("line".into(), json!(line));
            for (k, val) in &labels {
                row.insert(k.clone(), val.clone());
            }
            rows.push((ts, Value::Object(row)));
        }
    }
    rows.sort_by_key(|r| std::cmp::Reverse(r.0));
    Ok(rows.into_iter().map(|(_, r)| r).collect())
}

/// Tempo `/api/search` → one row per trace.
pub fn tempo_rows(v: &Value) -> Result<Vec<Value>, String> {
    let traces = v
        .get("traces")
        .and_then(Value::as_array)
        .ok_or("no traces in answer")?;
    Ok(traces
        .iter()
        .map(|t| {
            let started = t
                .get("startTimeUnixNano")
                .and_then(|s| {
                    s.as_str()
                        .and_then(|s| s.parse::<i128>().ok())
                        .or_else(|| s.as_i64().map(i128::from))
                })
                .map(rfc3339_nanos)
                .unwrap_or_default();
            json!({
                "trace_id": t.get("traceID").and_then(Value::as_str).unwrap_or(""),
                "service": t.get("rootServiceName").and_then(Value::as_str).unwrap_or(""),
                "name": t.get("rootTraceName").and_then(Value::as_str).unwrap_or(""),
                "started_at": started,
                "duration_ms": t.get("durationMs").and_then(number).unwrap_or(0.0),
            })
        })
        .collect())
}

/// Chart series from range rows: one `{label, points}` per distinct `__series`,
/// in first-seen order. Rows without the marker are one anonymous series.
pub fn series_of(rows: &[Value]) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut by: HashMap<String, Vec<Value>> = HashMap::new();
    for r in rows {
        let Some(obj) = r.as_object() else { continue };
        let Some(t) = obj.get("t") else { continue };
        let v = obj.get("v").cloned().unwrap_or(Value::Null);
        if !(v.is_number() || v.is_null()) {
            continue;
        }
        let label = obj
            .get("__series")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !by.contains_key(&label) {
            order.push(label.clone());
        }
        by.entry(label).or_default().push(json!({ "t": t, "v": v }));
    }
    order
        .into_iter()
        .map(|label| {
            let points = by.remove(&label).unwrap_or_default();
            json!({ "label": label, "points": points })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_read_the_usual_suffixes() {
        assert_eq!(parse_duration("30s").unwrap(), Duration::from_secs(30));
        assert_eq!(parse_duration("5m").unwrap(), Duration::from_secs(300));
        assert_eq!(parse_duration("6h").unwrap(), Duration::from_secs(21_600));
        assert_eq!(parse_duration("7d").unwrap(), Duration::from_secs(604_800));
        assert_eq!(parse_duration("90").unwrap(), Duration::from_secs(90));
        assert!(parse_duration("6 fortnights").is_err());
    }

    #[test]
    fn a_step_aims_at_two_hundred_points_and_never_under_the_floor() {
        assert_eq!(step_for(Duration::from_secs(3600), None), 18);
        assert_eq!(step_for(Duration::from_secs(600), None), MIN_STEP_SECS);
        assert_eq!(
            step_for(Duration::from_secs(600), Some(Duration::from_secs(60))),
            60
        );
    }

    #[test]
    fn a_prometheus_vector_keeps_its_labels_and_value() {
        let v = json!({"status":"success","data":{"resultType":"vector","result":[
            {"metric":{"__name__":"bots_active","role":"bots"},"value":[1786916440.0,"415"]}
        ]}});
        let rows = prometheus_rows(&v).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["v"], json!(415.0));
        assert_eq!(rows[0]["role"], json!("bots"));
        assert!(rows[0].get("__name__").is_none());
    }

    #[test]
    fn a_prometheus_matrix_becomes_time_rows_with_a_series_marker() {
        let v = json!({"status":"success","data":{"resultType":"matrix","result":[
            {"metric":{"container":"a"},"values":[[1786916400,"1"],[1786916460,"2"]]},
            {"metric":{"container":"b"},"values":[[1786916400,"3"]]}
        ]}});
        let rows = prometheus_rows(&v).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["__series"], json!("a"));
        assert!(rows[0]["t"].as_str().unwrap().starts_with("2026-08-16T"));
        let series = series_of(&rows);
        assert_eq!(series.len(), 2);
        assert_eq!(series[0]["points"].as_array().unwrap().len(), 2);
        assert_eq!(series[1]["label"], json!("b"));
    }

    #[test]
    fn a_prometheus_error_is_its_message() {
        let v = json!({"status":"error","errorType":"bad_data","error":"parse error at char 3"});
        assert_eq!(prometheus_rows(&v).unwrap_err(), "parse error at char 3");
    }

    #[test]
    fn loki_streams_flatten_newest_first_with_labels_and_lifted_message() {
        let v = json!({"status":"success","data":{"resultType":"streams","result":[
            {"stream":{"level":"error","node":"fly-1"},"values":[
                ["1786916440000000000","{\"message\":\"boom\",\"pid\":\"1\"}"],
                ["1786916445000000000","{\"message\":\"\",\"name\":\"ExportError\",\"error\":\"timed out\"}"],
                ["1786916450000000000","plain text line"]
            ]}
        ]}});
        let rows = loki_rows(&v).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["line"], json!("plain text line"));
        assert!(rows[0].get("message").is_none());
        assert_eq!(rows[1]["message"], json!("timed out"));
        assert_eq!(rows[2]["message"], json!("boom"));
        assert_eq!(rows[2]["node"], json!("fly-1"));
        assert_eq!(rows[2]["level"], json!("error"));
    }

    #[test]
    fn a_loki_metric_query_reads_like_prometheus() {
        let v = json!({"status":"success","data":{"resultType":"vector","result":[
            {"metric":{},"value":[1786916440.0,"7"]}
        ]}});
        assert_eq!(loki_rows(&v).unwrap()[0]["v"], json!(7.0));
    }

    #[test]
    fn tempo_search_is_one_row_per_trace() {
        let v = json!({"traces":[
            {"traceID":"abc","rootServiceName":"data","rootTraceName":"backtest_job","startTimeUnixNano":"1786916440000000000","durationMs":5123}
        ]});
        let rows = tempo_rows(&v).unwrap();
        assert_eq!(rows[0]["trace_id"], json!("abc"));
        assert_eq!(rows[0]["duration_ms"], json!(5123.0));
        assert!(rows[0]["started_at"]
            .as_str()
            .unwrap()
            .starts_with("2026-08-16T"));
    }

    #[test]
    fn a_grid_fill_lines_series_up_and_spans_the_window() {
        let rows = vec![
            json!({"t": rfc3339(1000.0), "v": 1.0, "__series": "a", "role": "a"}),
            json!({"t": rfc3339(1060.0), "v": 2.0, "__series": "a", "role": "a"}),
            json!({"t": rfc3339(1120.0), "v": 5.0, "__series": "b", "role": "b"}),
        ];
        let out = fill_grid(rows, 940, 1120, 60);
        assert_eq!(out.len(), 8, "two series × four slots");
        let a: Vec<&Value> = out.iter().filter(|r| r["__series"] == "a").collect();
        assert_eq!(a[0]["v"], Value::Null);
        assert_eq!(a[1]["v"], json!(1.0));
        assert_eq!(a[3]["v"], Value::Null);
        assert_eq!(a[3]["role"], json!("a"));
        let b: Vec<&Value> = out.iter().filter(|r| r["__series"] == "b").collect();
        assert_eq!(b[3]["v"], json!(5.0));
        let series = series_of(&out);
        assert_eq!(series[0]["points"].as_array().unwrap().len(), 4);
        assert_eq!(series[1]["points"][0]["v"], Value::Null);
    }

    #[test]
    fn interval_tokens_follow_the_step() {
        assert_eq!(
            with_intervals("rate(x[$__rate_interval])", 18),
            "rate(x[60s])"
        );
        assert_eq!(
            with_intervals("rate(x[$__rate_interval])", 3024),
            "rate(x[3039s])"
        );
        assert_eq!(
            with_intervals("increase(x[$__interval])", 300),
            "increase(x[300s])"
        );
    }

    #[test]
    fn a_series_label_is_the_values_a_reader_cares_about() {
        let mut m = Map::new();
        m.insert("__name__".into(), json!("up"));
        assert_eq!(series_label(&m), "up");
        m.insert("intent".into(), json!("history"));
        m.insert("result".into(), json!("ok"));
        assert_eq!(series_label(&m), "history · ok");
        assert_eq!(series_label(&Map::new()), "other");
    }
}
