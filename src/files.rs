//! `type = "files"` sources: a directory tree read as rows.
//!
//! A `pattern` like `{source}/{symbol}/{tf}.parquet` says both what to walk and
//! what the path means — each `{name}` captures a segment as a column, so a
//! cache tree becomes a table without anyone writing a scanner. Metadata only:
//! names, sizes and mtimes. Contents are never read, which is what keeps a
//! listing from being an arbitrary-file-read primitive.

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const DEFAULT_MAX_ENTRIES: usize = 5_000;
pub const DEFAULT_TTL_SECS: u64 = 60;

enum Part {
    Literal(String),
    Capture(String),
}

fn parse_segment(seg: &str) -> Result<Vec<Part>, String> {
    let mut parts = Vec::new();
    let mut rest = seg;
    while let Some(open) = rest.find('{') {
        if open > 0 {
            parts.push(Part::Literal(rest[..open].to_string()));
        }
        let close = rest[open..]
            .find('}')
            .ok_or_else(|| format!("unclosed {{ in pattern segment \"{seg}\""))?
            + open;
        let name = &rest[open + 1..close];
        if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return Err(format!("bad capture name \"{name}\" in pattern"));
        }
        parts.push(Part::Capture(name.to_string()));
        rest = &rest[close + 1..];
    }
    if !rest.is_empty() {
        parts.push(Part::Literal(rest.to_string()));
    }
    Ok(parts)
}

/// Match one path segment, binding captures. A capture stops at the next
/// literal, so `{tf}.parquet` binds `tf = "1h"` for `1h.parquet`.
fn match_segment(parts: &[Part], name: &str, out: &mut Map<String, Value>) -> bool {
    let mut rest = name;
    let mut i = 0;
    while i < parts.len() {
        match &parts[i] {
            Part::Literal(lit) => {
                let Some(stripped) = rest.strip_prefix(lit.as_str()) else {
                    return false;
                };
                rest = stripped;
            }
            Part::Capture(cap) => {
                let next_lit = parts.get(i + 1).and_then(|p| match p {
                    Part::Literal(l) => Some(l.as_str()),
                    Part::Capture(_) => None,
                });
                let taken = match next_lit {
                    Some(lit) => match rest.find(lit) {
                        Some(at) if at > 0 => at,
                        _ => return false,
                    },
                    None => rest.len(),
                };
                if taken == 0 {
                    return false;
                }
                out.insert(cap.clone(), Value::String(rest[..taken].to_string()));
                rest = &rest[taken..];
            }
        }
        i += 1;
    }
    rest.is_empty()
}

fn modified_ms(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

/// A parsed `{a}/{b}.ext` pattern. The same shape matches a filesystem path and
/// an object key — a key is a path, which is what lets one pattern serve both.
pub struct Pattern(Vec<Vec<Part>>);

pub fn parse_pattern(pattern: &str) -> Result<Pattern, String> {
    let segments: Vec<Vec<Part>> = pattern
        .trim_matches('/')
        .split('/')
        .map(parse_segment)
        .collect::<Result<_, _>>()?;
    if segments.is_empty() {
        return Err("pattern is empty".into());
    }
    Ok(Pattern(segments))
}

impl Pattern {
    pub fn depth(&self) -> usize {
        self.0.len()
    }

    /// Bind captures for a whole key, e.g. `binance/BTCUSDT/1h.parquet`.
    pub fn match_key(&self, key: &str) -> Option<Map<String, Value>> {
        let parts: Vec<&str> = key.trim_matches('/').split('/').collect();
        if parts.len() != self.0.len() {
            return None;
        }
        let mut out = Map::new();
        for (seg, name) in self.0.iter().zip(parts) {
            if !match_segment(seg, name, &mut out) {
                return None;
            }
        }
        Some(out)
    }
}

/// Walk `root` collecting entries that match `pattern`. Returns rows carrying
/// the captured columns plus `path`, `bytes` and `modified_ms`.
pub fn scan(root: &Path, pattern: &str, max_entries: usize) -> Result<Vec<Value>, String> {
    let segments = parse_pattern(pattern)?.0;
    let base = root
        .canonicalize()
        .map_err(|e| format!("root {}: {e}", root.display()))?;
    let mut out = Vec::new();
    walk(
        &base,
        &base,
        &segments,
        0,
        &mut Map::new(),
        max_entries,
        &mut out,
    )?;
    // Truncation must never look like "that is all there is".
    if out.len() >= max_entries {
        tracing::warn!(
            "listing of {} hit the {max_entries}-entry cap — raise max_entries to see the rest",
            base.display()
        );
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn walk(
    base: &Path,
    dir: &PathBuf,
    segments: &[Vec<Part>],
    depth: usize,
    bound: &mut Map<String, Value>,
    max_entries: usize,
    out: &mut Vec<Value>,
) -> Result<(), String> {
    if out.len() >= max_entries {
        return Ok(());
    }
    let last = depth + 1 == segments.len();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        if out.len() >= max_entries {
            return Ok(());
        }
        // Symlinks are skipped rather than followed: a link inside the root
        // could otherwise point anywhere on the host.
        let Ok(meta) = entry.metadata() else { continue };
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(true) {
            continue;
        }
        if last != meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let mut row = bound.clone();
        if !match_segment(&segments[depth], &name, &mut row) {
            continue;
        }
        let path = entry.path();
        if !path.starts_with(base) {
            continue;
        }
        if last {
            let rel = path.strip_prefix(base).unwrap_or(&path);
            row.insert("path".into(), json!(rel.to_string_lossy()));
            row.insert("bytes".into(), json!(meta.len()));
            row.insert("modified_ms".into(), json!(modified_ms(&meta)));
            out.push(Value::Object(row));
        } else {
            walk(base, &path, segments, depth + 1, &mut row, max_entries, out)?;
        }
    }
    Ok(())
}

pub fn cache_ttl(secs: Option<u64>) -> std::time::Duration {
    std::time::Duration::from_secs(secs.unwrap_or(DEFAULT_TTL_SECS))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(seg: &str, name: &str) -> Option<Map<String, Value>> {
        let parts = parse_segment(seg).unwrap();
        let mut out = Map::new();
        match_segment(&parts, name, &mut out).then_some(out)
    }

    #[test]
    fn captures_stop_at_the_next_literal() {
        let m = cap("{tf}.parquet", "1h.parquet").expect("matches");
        assert_eq!(m.get("tf"), Some(&json!("1h")));
        assert!(cap("{tf}.parquet", "1h.csv").is_none());
        assert!(cap("{tf}.parquet", ".parquet").is_none(), "empty capture");
        let m = cap("{a}-{b}.json", "left-right.json").expect("two captures");
        assert_eq!(m.get("a"), Some(&json!("left")));
        assert_eq!(m.get("b"), Some(&json!("right")));
        assert!(cap("literal", "literal").is_some());
        assert!(cap("literal", "other").is_none());
    }

    #[test]
    fn walks_a_tree_into_rows() {
        let root = std::env::temp_dir().join(format!("cartapel-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("binance/BTCUSDT")).unwrap();
        std::fs::create_dir_all(root.join("ibkr/AAPL")).unwrap();
        std::fs::write(root.join("binance/BTCUSDT/1h.parquet"), b"xx").unwrap();
        std::fs::write(root.join("binance/BTCUSDT/1d.parquet"), b"yyy").unwrap();
        std::fs::write(root.join("binance/BTCUSDT/notes.txt"), b"skip me").unwrap();
        std::fs::write(root.join("ibkr/AAPL/1h.parquet"), b"z").unwrap();

        let mut rows = scan(&root, "{source}/{symbol}/{tf}.parquet", 100).unwrap();
        rows.sort_by_key(|r| r["path"].as_str().unwrap_or("").to_string());
        assert_eq!(rows.len(), 3, "the .txt must not match");
        let r = &rows[0];
        assert_eq!(r["source"], json!("binance"));
        assert_eq!(r["symbol"], json!("BTCUSDT"));
        assert_eq!(r["tf"], json!("1d"));
        assert_eq!(r["bytes"], json!(3));
        assert!(r["modified_ms"].as_i64().unwrap() > 0);

        let capped = scan(&root, "{source}/{symbol}/{tf}.parquet", 2).unwrap();
        assert_eq!(capped.len(), 2, "max_entries is honored");
        let _ = std::fs::remove_dir_all(&root);
    }
}
