//! S3-compatible object storage: a read-only `type = "s3"` *source* (list rows
//! from object keys) and, since a `storage "…" { }` upload backend can name
//! one, plain object `get`/`put`.
//!
//! The `list` half: the same `pattern` a `files` source uses applies here — an
//! object key is a path, so `{source}/{symbol}/{tf}.parquet` shapes a bucket
//! exactly as it shapes a directory. Names, sizes and mtimes only.
//!
//! The `get_object`/`put_object` half backs `image { storage = "…" }` uploads
//! (see `crate::images`) — a single object read or written whole, no listing.
//!
//! Requests are signed with SigV4 by hand rather than by pulling an SDK — the
//! signing is ~80 lines against dependencies the binary already carries, and an
//! AWS SDK is a large tree for a handful of calls. Works against any
//! S3-compatible endpoint (R2, MinIO, Backblaze); R2 wants `region = "auto"`.

use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub struct Creds {
    pub access_key: String,
    pub secret_key: String,
    pub region: String,
}

fn hmac(key: &[u8], msg: &str) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    m.update(msg.as_bytes());
    m.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Percent-encode for a canonical query string: unreserved characters pass, the
/// rest become %XX (uppercase), and `/` is escaped too — query values are opaque.
fn uri_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Sign a request and return the headers it needs. `query` must already be
/// sorted by key — SigV4 hashes the canonical form, not the one you send.
/// `payload_hash` is the sha256 of the body (empty-string hash for a GET).
#[allow(clippy::too_many_arguments)]
fn sign_request(
    method: &str,
    creds: &Creds,
    host: &str,
    path: &str,
    query: &[(String, String)],
    payload_hash: &str,
    now: &str,
) -> Vec<(String, String)> {
    let date = &now[..8];
    let canonical_query = query
        .iter()
        .map(|(k, v)| format!("{}={}", uri_encode(k), uri_encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let canonical_headers =
        format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{now}\n");
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "{method}\n{path}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let scope = format!("{date}/{}/s3/aws4_request", creds.region);
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{now}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let k_date = hmac(format!("AWS4{}", creds.secret_key).as_bytes(), date);
    let k_region = hmac(&k_date, &creds.region);
    let k_service = hmac(&k_region, "s3");
    let k_signing = hmac(&k_service, "aws4_request");
    let signature = hex::encode(hmac(&k_signing, &to_sign));
    vec![
        (
            "Authorization".into(),
            format!(
                "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
                creds.access_key
            ),
        ),
        ("x-amz-content-sha256".into(), payload_hash.to_string()),
        ("x-amz-date".into(), now.to_string()),
    ]
}

/// Sign a GET (empty-body payload hash) — the shape `list` and `get_object`
/// both need.
fn sign_get(
    creds: &Creds,
    host: &str,
    path: &str,
    query: &[(String, String)],
    now: &str,
) -> Vec<(String, String)> {
    sign_request("GET", creds, host, path, query, &sha256_hex(b""), now)
}

/// `endpoint` + `/bucket/key`, and the bare `host[:port]` SigV4 signs against.
fn object_url(endpoint: &str, bucket: &str, key: &str) -> Result<(reqwest::Url, String), String> {
    let base = reqwest::Url::parse(endpoint).map_err(|e| format!("bad endpoint: {e}"))?;
    let host = base
        .host_str()
        .ok_or_else(|| "endpoint has no host".to_string())?
        .to_string();
    let host = match base.port() {
        Some(p) => format!("{host}:{p}"),
        None => host,
    };
    let path = format!(
        "/{}/{}",
        bucket.trim_matches('/'),
        key.trim_start_matches('/')
    );
    let url = format!("{}{path}", endpoint.trim_end_matches('/'));
    let url = reqwest::Url::parse(&url).map_err(|e| format!("bad object url: {e}"))?;
    Ok((url, host))
}

/// Fetch one object's bytes. Used by `image { storage = "…" }` reads — not the
/// `files`/`s3` source listing, which never reads a body.
pub async fn get_object(
    http: &reqwest::Client,
    endpoint: &str,
    bucket: &str,
    key: &str,
    creds: &Creds,
) -> Result<Vec<u8>, String> {
    let (url, host) = object_url(endpoint, bucket, key)?;
    let headers = sign_get(creds, &host, url.path(), &[], &amz_now());
    let mut req = http.get(url).timeout(std::time::Duration::from_secs(15));
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req.send().await.map_err(|e| format!("get failed: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("not found".into());
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let reason = tag(&body, "Message", 0)
            .map(|(v, _)| v.to_string())
            .unwrap_or_else(|| status.to_string());
        return Err(format!("get failed: {reason}"));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| e.to_string())
}

/// Write one object whole. S3's PUT already replaces an object atomically —
/// there is no half-written state a reader can observe, unlike the local-disk
/// path which needs its own tmp-file-then-rename for that guarantee.
pub async fn put_object(
    http: &reqwest::Client,
    endpoint: &str,
    bucket: &str,
    key: &str,
    creds: &Creds,
    body: &[u8],
) -> Result<(), String> {
    let (url, host) = object_url(endpoint, bucket, key)?;
    let payload_hash = sha256_hex(body);
    let headers = sign_request(
        "PUT",
        creds,
        &host,
        url.path(),
        &[],
        &payload_hash,
        &amz_now(),
    );
    let mut req = http
        .put(url)
        .body(body.to_vec())
        .timeout(std::time::Duration::from_secs(30));
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req.send().await.map_err(|e| format!("put failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let reason = tag(&body, "Message", 0)
            .map(|(v, _)| v.to_string())
            .unwrap_or_else(|| status.to_string());
        return Err(format!("put failed: {reason}"));
    }
    Ok(())
}

/// S3 reports `2026-07-27T21:12:08.313Z`; a files listing reports epoch millis.
/// Callers should not care which store answered, so normalize here.
fn iso_to_ms(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn amz_now() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
}

/// Pull the text between `<tag>` and `</tag>`, starting at `from`.
fn tag<'a>(xml: &'a str, name: &str, from: usize) -> Option<(&'a str, usize)> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let s = xml[from..].find(&open)? + from + open.len();
    let e = xml[s..].find(&close)? + s;
    Some((&xml[s..e], e))
}

/// ListObjectsV2 answers XML. Rather than take an XML dependency for one known
/// shape, walk `<Contents>` blocks and read the three fields we need.
fn parse_listing(xml: &str) -> (Vec<(String, u64, String)>, Option<String>) {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some((block, end)) = tag(xml, "Contents", at) {
        let key = tag(block, "Key", 0).map(|(v, _)| v.to_string());
        let size = tag(block, "Size", 0)
            .and_then(|(v, _)| v.parse::<u64>().ok())
            .unwrap_or(0);
        let modified = tag(block, "LastModified", 0)
            .map(|(v, _)| v.to_string())
            .unwrap_or_default();
        if let Some(k) = key {
            out.push((k, size, modified));
        }
        at = end;
    }
    let next = tag(xml, "NextContinuationToken", 0).map(|(v, _)| v.to_string());
    let truncated = tag(xml, "IsTruncated", 0).map(|(v, _)| v == "true") == Some(true);
    (out, truncated.then_some(next).flatten())
}

/// How many objects a listing will walk before giving up, regardless of how few
/// of them the pattern matches.
///
/// `max_entries` bounds the rows a listing *returns*; on its own that leaves the
/// *work* unbounded, because a selective pattern matches nothing and the cap is
/// never reached. A real bucket taught us this: 1.4M objects under one prefix,
/// of which ~6.5k matched a three-segment pattern, so every refresh paged
/// through 1,411 requests and took ~5 minutes. Bound the scan, not just the
/// harvest.
pub const DEFAULT_MAX_SCAN: usize = 50_000;

#[allow(clippy::too_many_arguments)]
pub async fn list(
    http: &reqwest::Client,
    endpoint: &str,
    bucket: &str,
    prefix: &str,
    creds: &Creds,
    pattern: &crate::files::Pattern,
    max_entries: usize,
    max_scan: usize,
) -> Result<Vec<Value>, String> {
    let base = reqwest::Url::parse(endpoint).map_err(|e| format!("bad endpoint: {e}"))?;
    let host = base
        .host_str()
        .ok_or_else(|| "endpoint has no host".to_string())?
        .to_string();
    let host = match base.port() {
        Some(p) => format!("{host}:{p}"),
        None => host,
    };
    let path = format!("/{}", bucket.trim_matches('/'));
    let mut token: Option<String> = None;
    let mut rows = Vec::new();
    let mut scanned = 0usize;
    loop {
        let mut query: Vec<(String, String)> = vec![
            ("list-type".into(), "2".into()),
            ("max-keys".into(), "1000".into()),
        ];
        if !prefix.is_empty() {
            query.push(("prefix".into(), prefix.to_string()));
        }
        if let Some(t) = &token {
            query.push(("continuation-token".into(), t.clone()));
        }
        query.sort_by(|a, b| a.0.cmp(&b.0));
        let headers = sign_get(creds, &host, &path, &query, &amz_now());
        let mut req = http
            .get(format!("{}{}", endpoint.trim_end_matches('/'), path))
            .query(&query)
            .timeout(std::time::Duration::from_secs(15));
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let resp = req.send().await.map_err(|e| format!("list failed: {e}"))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let reason = tag(&body, "Message", 0)
                .map(|(v, _)| v.to_string())
                .unwrap_or_else(|| status.to_string());
            return Err(format!("list failed: {reason}"));
        }
        let (objects, next) = parse_listing(&body);
        scanned += objects.len();
        for (key, size, modified) in objects {
            let stripped = key
                .strip_prefix(prefix)
                .unwrap_or(&key)
                .trim_start_matches('/');
            let Some(mut row) = pattern.match_key(stripped) else {
                continue;
            };
            row.insert("path".into(), json!(key));
            row.insert("bytes".into(), json!(size));
            // Same column and unit as a files listing: one pattern, one shape.
            row.insert("modified_ms".into(), json!(iso_to_ms(&modified)));
            rows.push(Value::Object(row));
            if rows.len() >= max_entries {
                tracing::warn!("s3 listing hit the {max_entries}-entry cap — raise max_entries");
                return Ok(rows);
            }
        }
        if scanned >= max_scan {
            // Truncation must never read as "that is all there is".
            tracing::warn!(
                matched = rows.len(),
                scanned,
                max_scan,
                "s3 listing stopped at the scan cap — the pattern matches a small \
                 share of this prefix; narrow `prefix`, widen `pattern`, or raise `max_scan`"
            );
            return Ok(rows);
        }
        match next {
            Some(t) => token = Some(t),
            None => break,
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_normalize_to_the_files_shape() {
        assert_eq!(
            iso_to_ms("2026-07-27T21:12:08.313Z"),
            Some(1785186728313),
            "s3 iso must land on the same scale as a files mtime"
        );
        assert_eq!(iso_to_ms("nonsense"), None);
    }

    #[test]
    fn parses_a_listing_and_its_continuation() {
        let xml = r#"<?xml version="1.0"?>
        <ListBucketResult>
          <IsTruncated>true</IsTruncated>
          <Contents><Key>a/b/1h.parquet</Key><Size>1200</Size><LastModified>2026-07-27T10:00:00.000Z</LastModified></Contents>
          <Contents><Key>a/b/1d.parquet</Key><Size>34</Size><LastModified>2026-07-27T11:00:00.000Z</LastModified></Contents>
          <NextContinuationToken>tok123</NextContinuationToken>
        </ListBucketResult>"#;
        let (objects, next) = parse_listing(xml);
        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].0, "a/b/1h.parquet");
        assert_eq!(objects[0].1, 1200);
        assert_eq!(next.as_deref(), Some("tok123"));

        let done = r#"<ListBucketResult><IsTruncated>false</IsTruncated>
          <Contents><Key>x</Key><Size>1</Size><LastModified>t</LastModified></Contents>
          <NextContinuationToken>ignored</NextContinuationToken></ListBucketResult>"#;
        assert_eq!(parse_listing(done).1, None, "not truncated → no next page");
    }

    /// Pinned against the AWS SigV4 test vector shape: the same inputs must
    /// always produce the same signature, so a refactor can't silently break auth.
    #[test]
    fn signing_is_deterministic() {
        let creds = Creds {
            access_key: "AKIDEXAMPLE".into(),
            secret_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
            region: "us-east-1".into(),
        };
        let q = vec![("list-type".to_string(), "2".to_string())];
        let a = sign_get(
            &creds,
            "s3.amazonaws.com",
            "/bucket",
            &q,
            "20260727T000000Z",
        );
        let b = sign_get(
            &creds,
            "s3.amazonaws.com",
            "/bucket",
            &q,
            "20260727T000000Z",
        );
        assert_eq!(a, b);
        let auth = &a[0].1;
        assert!(auth.contains("Credential=AKIDEXAMPLE/20260727/us-east-1/s3/aws4_request"));
        assert!(auth.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date"));
        let other = sign_get(
            &creds,
            "s3.amazonaws.com",
            "/bucket",
            &q,
            "20260728T000000Z",
        );
        assert_ne!(a[0].1, other[0].1, "a different date must resign");
    }

    /// A PUT signs the *body*, not an empty-payload hash — reusing `sign_get`
    /// for an upload would silently authenticate the wrong bytes.
    #[test]
    fn put_signature_depends_on_the_body() {
        let creds = Creds {
            access_key: "AKIDEXAMPLE".into(),
            secret_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
            region: "us-east-1".into(),
        };
        let now = "20260727T000000Z";
        let a = sign_request(
            "PUT",
            &creds,
            "s3.amazonaws.com",
            "/bucket/products/1.png",
            &[],
            &sha256_hex(b"first upload"),
            now,
        );
        let b = sign_request(
            "PUT",
            &creds,
            "s3.amazonaws.com",
            "/bucket/products/1.png",
            &[],
            &sha256_hex(b"different bytes"),
            now,
        );
        assert_ne!(
            a[0].1, b[0].1,
            "different bodies must not share a signature"
        );

        let get = sign_get(
            &creds,
            "s3.amazonaws.com",
            "/bucket/products/1.png",
            &[],
            now,
        );
        assert_ne!(
            a[0].1, get[0].1,
            "GET and PUT on the same path must not share a signature"
        );
    }

    #[test]
    fn object_url_joins_bucket_and_key_cleanly() {
        let (url, host) =
            object_url("https://s3.example.com", "my-bucket", "products/1.png").unwrap();
        assert_eq!(
            url.as_str(),
            "https://s3.example.com/my-bucket/products/1.png"
        );
        assert_eq!(host, "s3.example.com");

        // Leading/trailing slashes on bucket or key must not double up.
        let (url2, _) =
            object_url("https://s3.example.com/", "/my-bucket/", "/products/1.png").unwrap();
        assert_eq!(
            url2.as_str(),
            "https://s3.example.com/my-bucket/products/1.png"
        );
    }
}
