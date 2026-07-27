//! Aggregating rows a listing source returned.
//!
//! A SQL panel groups in SQL, where it belongs. A `files` or `s3` listing has
//! no SQL to group in, so the rows the server already holds are folded here
//! instead — with a deliberately tiny vocabulary (`count`, `sum:`, `min:`,
//! `max:`, `count_distinct:`) rather than a query language. Anything richer is
//! a sign the data wants a database in front of it.

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub struct Agg {
    pub op: Op,
    pub field: Option<String>,
    pub alias: String,
}

#[derive(PartialEq)]
pub enum Op {
    Count,
    CountDistinct,
    Sum,
    Min,
    Max,
}

/// `"sum:bytes as size"` → sum of `bytes`, output column `size`. The alias is
/// optional and defaults to the field (or `count`).
pub fn parse(spec: &str) -> Result<Agg, String> {
    let (expr, alias) = match spec.split_once(" as ") {
        Some((e, a)) => (e.trim(), Some(a.trim().to_string())),
        None => (spec.trim(), None),
    };
    let (op_name, field) = match expr.split_once(':') {
        Some((o, f)) => (o.trim(), Some(f.trim().to_string())),
        None => (expr, None),
    };
    let op = match op_name {
        "count" => Op::Count,
        "count_distinct" => Op::CountDistinct,
        "sum" => Op::Sum,
        "min" => Op::Min,
        "max" => Op::Max,
        other => {
            return Err(format!(
                "unknown aggregate \"{other}\" — use count, count_distinct, sum, min or max"
            ))
        }
    };
    if op != Op::Count && field.is_none() {
        return Err(format!("{op_name} needs a field, e.g. \"{op_name}:bytes\""));
    }
    let alias = alias.unwrap_or_else(|| field.clone().unwrap_or_else(|| "count".into()));
    Ok(Agg { op, field, alias })
}

fn num(row: &Map<String, Value>, field: &str) -> Option<f64> {
    row.get(field).and_then(Value::as_f64)
}

fn key_of(row: &Map<String, Value>, field: &str) -> String {
    match row.get(field) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Fold `rows` into one row per distinct value of `group_by` (or a single row
/// when `group_by` is empty), carrying the requested aggregates.
pub fn fold(rows: &[Value], group_by: Option<&str>, aggs: &[Agg]) -> Vec<Value> {
    let mut groups: BTreeMap<String, Vec<&Map<String, Value>>> = BTreeMap::new();
    for r in rows {
        let Some(obj) = r.as_object() else { continue };
        let key = group_by.map(|g| key_of(obj, g)).unwrap_or_default();
        groups.entry(key).or_default().push(obj);
    }
    groups
        .into_iter()
        .map(|(key, members)| {
            let mut out = Map::new();
            if let Some(g) = group_by {
                out.insert(g.to_string(), json!(key));
            }
            for a in aggs {
                let value = match (&a.op, &a.field) {
                    (Op::Count, _) => json!(members.len()),
                    (Op::CountDistinct, Some(f)) => {
                        let seen: BTreeSet<String> = members.iter().map(|m| key_of(m, f)).collect();
                        json!(seen.len())
                    }
                    (Op::Sum, Some(f)) => {
                        json!(members.iter().filter_map(|m| num(m, f)).sum::<f64>())
                    }
                    (Op::Min, Some(f)) => members
                        .iter()
                        .filter_map(|m| num(m, f))
                        .fold(None, |acc: Option<f64>, v| {
                            Some(acc.map_or(v, |a| a.min(v)))
                        })
                        .map(|v| json!(v))
                        .unwrap_or(Value::Null),
                    (Op::Max, Some(f)) => members
                        .iter()
                        .filter_map(|m| num(m, f))
                        .fold(None, |acc: Option<f64>, v| {
                            Some(acc.map_or(v, |a| a.max(v)))
                        })
                        .map(|v| json!(v))
                        .unwrap_or(Value::Null),
                    _ => Value::Null,
                };
                out.insert(a.alias.clone(), value);
            }
            Value::Object(out)
        })
        .collect()
}

/// Keep rows whose fields match every `field = value` pair. An empty value
/// means "not filtering on this", so an unset control shows everything.
pub fn filter(rows: Vec<Value>, pairs: &BTreeMap<String, String>) -> Vec<Value> {
    let active: Vec<(&String, &String)> = pairs.iter().filter(|(_, v)| !v.is_empty()).collect();
    if active.is_empty() {
        return rows;
    }
    rows.into_iter()
        .filter(|r| {
            let Some(obj) = r.as_object() else {
                return false;
            };
            active.iter().all(|(f, v)| &key_of(obj, f) == *v)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<Value> {
        vec![
            json!({"source": "binance", "symbol": "BTC", "tf": "1h", "bytes": 100}),
            json!({"source": "binance", "symbol": "BTC", "tf": "1d", "bytes": 50}),
            json!({"source": "binance", "symbol": "ETH", "tf": "1h", "bytes": 25}),
            json!({"source": "okx", "symbol": "BTC", "tf": "1h", "bytes": 10}),
        ]
    }

    #[test]
    fn parses_the_small_vocabulary() {
        let a = parse("sum:bytes as size").unwrap();
        assert!(a.op == Op::Sum && a.field.as_deref() == Some("bytes") && a.alias == "size");
        assert_eq!(parse("count").unwrap().alias, "count");
        assert_eq!(parse("count_distinct:symbol").unwrap().alias, "symbol");
        assert!(parse("median:bytes").is_err(), "no query language here");
        assert!(parse("sum").is_err(), "sum needs a field");
    }

    #[test]
    fn groups_by_a_field_with_distinct_counts() {
        let aggs = [
            parse("count as series").unwrap(),
            parse("count_distinct:symbol as symbols").unwrap(),
            parse("sum:bytes as bytes").unwrap(),
        ];
        let out = fold(&rows(), Some("source"), &aggs);
        assert_eq!(out.len(), 2);
        let binance = &out[0];
        assert_eq!(binance["source"], json!("binance"));
        assert_eq!(binance["series"], json!(3));
        assert_eq!(binance["symbols"], json!(2), "BTC and ETH, not three rows");
        assert_eq!(binance["bytes"], json!(175.0));
    }

    #[test]
    fn folds_to_one_row_without_a_group() {
        let out = fold(&rows(), None, &[parse("sum:bytes").unwrap()]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["bytes"], json!(185.0));
    }

    #[test]
    fn an_empty_filter_value_is_not_a_filter() {
        let all = BTreeMap::from([("source".to_string(), String::new())]);
        assert_eq!(filter(rows(), &all).len(), 4);
        let one = BTreeMap::from([("source".to_string(), "okx".to_string())]);
        assert_eq!(filter(rows(), &one).len(), 1);
    }
}
