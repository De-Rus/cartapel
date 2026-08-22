use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::marker::PhantomData;
use std::path::Path;

/// Serialize an `Option<T>` as an HCL block when `Some`, or nothing when `None`.
/// Pair with `#[serde(skip_serializing_if = "Option::is_none")]`.
fn ser_opt_block<S, T>(value: &Option<T>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
    T: Serialize,
{
    match value {
        Some(inner) => hcl::ser::block(inner, serializer),
        None => serializer.serialize_none(),
    }
}

/// Deserialize a repeated *unlabeled* HCL block (`section { .. }`) into a `Vec`.
/// HCL cannot tell a single block from a one-element list at the syntax level, so
/// hcl-rs surfaces one block as a map and many as a sequence. This accepts both.
fn de_block_seq<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct V<T>(PhantomData<T>);
    impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for V<T> {
        type Value = Vec<T>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a block or a list of blocks")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, seq: A) -> Result<Vec<T>, A::Error> {
            Deserialize::deserialize(serde::de::value::SeqAccessDeserializer::new(seq))
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(self, map: A) -> Result<Vec<T>, A::Error> {
            let one = T::deserialize(serde::de::value::MapAccessDeserializer::new(map))?;
            Ok(vec![one])
        }
    }
    deserializer.deserialize_any(V(PhantomData))
}

/// One entry of `strings`: a replacement for every locale, or a per-locale map.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum StringOverride {
    Every(String),
    PerLocale(BTreeMap<String, String>),
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CartapelConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brand: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brand_logo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    /// Built-in UI string overrides. A flat entry (`new_record = "Add {label}"`)
    /// applies in every locale; an entry keyed by a locale code holds that
    /// locale's overrides (`es = { new_record = "Añadir {label}" }`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub strings: BTreeMap<String, StringOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_page: Option<u32>,
    /// Default sidebar mode for folder-groups: `page` (one entry → tabbed group)
    /// or `expanded` (default — every table listed). Per-group `_group.hcl` `nav`
    /// overrides this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_nav: Option<String>,
    /// App-level signing root for session cookies. REQUIRED. Supports env
    /// interpolation (`env:NAME` / `${NAME}`); overridden by the
    /// `CARTAPEL_SECRET_KEY` env var. When absent everywhere, cartapel refuses to
    /// start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_key: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_block"
    )]
    pub theme: Option<ThemeConfig>,
    #[serde(
        default,
        rename = "source",
        skip_serializing_if = "BTreeMap::is_empty",
        serialize_with = "hcl::ser::labeled_block"
    )]
    pub sources: BTreeMap<String, NamedSource>,
    /// Hardening: disable the dashboard builder's ad-hoc SQL preview (which runs
    /// admin-supplied `SELECT`s). Set on a sensitive or public instance so even an
    /// admin can't run arbitrary read-SQL against the database.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub disable_sql_preview: bool,
    /// Hardening: disable outbound webhook actions (an admin-defined server-side
    /// HTTP call — an SSRF surface). Set on a sensitive or public instance.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub disable_webhooks: bool,
}

/// Resolve `env:NAME` / `${NAME}` references in a config value to the env var.
pub fn resolve_env(raw: &str) -> Option<String> {
    if let Some(name) = raw.strip_prefix("env:") {
        return std::env::var(name).ok();
    }
    if let Some(rest) = raw.strip_prefix("${").and_then(|r| r.strip_suffix('}')) {
        return std::env::var(rest).ok();
    }
    Some(raw.to_string())
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct ThemeConfig {
    /// Named base theme the frontend ships: "cartapel" (default) | "django".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// Shorthand accent override (wins over the preset's accent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_btn: Option<String>,
    /// Per-mode CSS custom-property overrides (token name → value), applied
    /// on top of the preset. Keys are cartapel token names without the `--`
    /// prefix (e.g. `page`, `surface`, `ink`, `accent`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub light: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub dark: BTreeMap<String, String>,
    /// Force a single mode: "light" | "dark" | "auto" (default auto).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Per-mode brand logo (http/data URL or a bundle asset filename served under
    /// `/static/`). Overrides the top-level `brand_logo` for that mode; falls back
    /// to it when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_light: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_dark: Option<String>,
}

/// A `_group.hcl` file: the definition of the sidebar group whose members are the
/// table configs sitting in the same folder. The folder name is the group's stable
/// key; this carries only presentation (`label`, `icon`) and ordering (`order`).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GroupConfig {
    pub label: String,
    /// Per-locale label overrides, e.g. `labels = { es = "Cliente" }` — the
    /// deployment's `[cartapel].locale` picks one, `label` is the fallback.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub order: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub table_order: Vec<String>,
    /// Sidebar mode for this group: `page` = one nav entry that opens the group's
    /// primary table with its sibling tables as tabs; `expanded` = list every
    /// table as its own entry. Falls back to `[cartapel].group_nav`, then `expanded`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav: Option<String>,
}

/// A group loaded from a `_group.hcl`, tagged with the folder (slug) it came from.
#[derive(Debug, Clone)]
pub struct LoadedGroup {
    pub slug: String,
    pub label: String,
    pub labels: BTreeMap<String, String>,
    pub icon: Option<String>,
    pub order: i64,
    pub table_order: Vec<String>,
    pub nav: Option<String>,
}

/// Where a table config was loaded from: the exact file path (for write-back) and
/// the folder/group slug it belongs to (`None` for a root-level table config).
#[derive(Debug, Clone)]
pub struct TableSource {
    pub path: std::path::PathBuf,
    pub group: Option<String>,
}

/// A `page.hcl` file: one custom full-screen module. Both `slug` (the page
/// folder's name) and `group` (the enclosing group folder) are folder-derived,
/// so neither appears here — `deny_unknown_fields` rejects a stray one.
/// A page is EITHER scripted (`module` — a Preact `.tsx`/`.js` bundle) OR
/// declarative (`panel {}` blocks rendered server-side). Exactly one; a page
/// with widgets must not set `module`, and vice versa.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PageConfig {
    pub label: String,
    /// Per-locale label overrides, e.g. `labels = { es = "Flota" }` — the
    /// viewer's locale picks one, `label` is the fallback.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Position among the pages of its group (lower first; ties by label).
    /// Without it pages sit alphabetically — fine for a list, wrong for a
    /// "read this first" order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<u8>,
    /// Re-run this page's panels on a clock, e.g. `refresh = "30s"`. Accepts
    /// `30s` / `5m` / a bare number of seconds; anything under the floor is
    /// raised to it, because a dashboard is not a tick feed and every poll
    /// re-runs every panel's SQL. May be a `{{variable}}` (`off` = no clock),
    /// so the reader picks the cadence from the page's variable bar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<String>,
    #[serde(
        default,
        rename = "panel",
        skip_serializing_if = "Vec::is_empty",
        serialize_with = "hcl::ser::block",
        deserialize_with = "de_block_seq"
    )]
    pub widgets: Vec<PanelConfig>,
}

/// The floor below which a dashboard stops being a dashboard: every poll
/// re-runs every panel's SQL, so a 1-second page is a load generator aimed at
/// the production database. Values under this are raised, not rejected —
/// the intent ("as live as sensible") is honored.
pub const MIN_REFRESH_SECS: u64 = 5;

/// `"30s"` / `"5m"` / `"45"` → seconds. `None` for absent or unparseable, so a
/// typo leaves a static page rather than an accidental hammer.
pub fn refresh_secs(spec: Option<&str>) -> Option<u64> {
    let raw = spec?.trim();
    if raw.is_empty() {
        return None;
    }
    let (digits, mult) = match raw.chars().last() {
        Some('s') => (&raw[..raw.len() - 1], 1),
        Some('m') => (&raw[..raw.len() - 1], 60),
        Some('h') => (&raw[..raw.len() - 1], 3600),
        _ => (raw, 1),
    };
    let n: u64 = digits.trim().parse().ok()?;
    if n == 0 {
        return None;
    }
    Some((n * mult).max(MIN_REFRESH_SECS))
}

/// A page loaded from a `page.hcl`, tagged with its folder-derived `slug` (the
/// page folder name) and `group` (the enclosing group folder slug, `None` when
/// the page folder sits directly under the config root).
#[derive(Debug, Clone)]
pub struct LoadedPage {
    pub slug: String,
    pub group: Option<String>,
    pub label: String,
    pub labels: BTreeMap<String, String>,
    pub order: i64,
    pub columns: Option<u8>,
    pub refresh: Option<String>,
    pub widgets: Vec<PanelConfig>,
    pub icon: Option<String>,
    pub roles: Vec<String>,
}

impl LoadedPage {
    /// Canonical, folder-derived page identity: `<group-slug>/<page-slug>` for a
    /// grouped page, or the bare `<page-slug>` for one directly under the root.
    pub fn id(&self) -> String {
        match &self.group {
            Some(group) => format!("{group}/{}", self.slug),
            None => self.slug.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NamedQuery {
    pub sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<String>,
}

/// A `queries.hcl` file: a bag of `query "name" { sql roles }` blocks living in
/// any folder under the config root. Every file's blocks merge into one global
/// registry ([`ConfigDir::queries`]); a name defined in two files is a load error.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QueriesFile {
    #[serde(
        default,
        rename = "query",
        skip_serializing_if = "BTreeMap::is_empty",
        serialize_with = "hcl::ser::labeled_block"
    )]
    pub queries: BTreeMap<String, NamedQuery>,
}

/// A template variable: a named, URL-backed value a page/query binds via
/// `{{name}}`. Its option set is a static `options` list or a read-only `query`
/// (first column = value, optional second = label). Values reach SQL as bound
/// parameters (see [`crate::interp`]); an `ident`-typed value names a column/table
/// and is regex-validated + inlined. See `.claude/plans/cartapel-grafana-customization.md`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Variable {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// `single` (default) or `multi`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// `text` (default) | `int` | `float` | `ident`.
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub var_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Data source for `query` (a `source` alias); default = primary. With a
    /// `files`/`s3` source, set `field` instead of `query` and the options are
    /// that column's distinct values in the listing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<String>,
}

impl Variable {
    pub fn resolved_type(&self) -> crate::interp::VarType {
        self.var_type
            .as_deref()
            .and_then(crate::interp::VarType::parse)
            .unwrap_or(crate::interp::VarType::Text)
    }
    /// `type = "window"` is sugar for the common time-window selector: an
    /// `int` variable with 7/30/90-day options, "30" default and a "Window"
    /// label — each overridable by declaring the field yourself.
    fn normalize(&mut self) {
        if self.var_type.as_deref() == Some("window") {
            self.var_type = Some("int".into());
            if self.options.is_empty() && self.query.is_none() {
                self.options = vec!["7".into(), "30".into(), "90".into()];
            }
            if self.default.is_none() {
                self.default = Some("30".into());
            }
            if self.label.is_none() {
                self.label = Some("Window".into());
            }
        }
    }

    fn validate(&self, name: &str) -> Result<(), String> {
        let sources = [
            self.query.is_some(),
            self.field.is_some(),
            !self.options.is_empty(),
        ]
        .iter()
        .filter(|x| **x)
        .count();
        if sources != 1 {
            return Err(format!(
                "variable \"{name}\": set exactly one of `query`, `field` or `options`"
            ));
        }
        if self.field.is_some() && self.source.is_none() {
            return Err(format!(
                "variable \"{name}\": `field` reads a listing, so it needs a `source`"
            ));
        }
        if let Some(t) = &self.var_type {
            if crate::interp::VarType::parse(t).is_none() {
                return Err(format!(
                    "variable \"{name}\": unknown type `{t}` (text|int|float|ident)"
                ));
            }
        }
        if let Some(k) = &self.kind {
            if k == "multi" {
                return Err(format!(
                    "variable \"{name}\": kind=multi is not supported yet"
                ));
            }
            if k != "single" {
                return Err(format!(
                    "variable \"{name}\": kind must be `single`, got `{k}`"
                ));
            }
        }
        if !self.options.is_empty() {
            if let Some(def) = &self.default {
                if !self.options.contains(def) {
                    return Err(format!(
                        "variable \"{name}\": default `{def}` is not in options"
                    ));
                }
            }
        }
        Ok(())
    }
}

/// A `variables.hcl` file: a bag of `variable "name" { … }` blocks. Mirrors
/// [`QueriesFile`]; every file merges into [`ConfigDir::variables`]; a dup name
/// is a load error.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VariablesFile {
    #[serde(
        default,
        rename = "variable",
        skip_serializing_if = "BTreeMap::is_empty",
        serialize_with = "hcl::ser::labeled_block"
    )]
    pub variables: BTreeMap<String, Variable>,
}

/// A named external data source.
///
/// `type = "grafana"`: `url` is a Grafana instance and `token_env` names the
/// env var holding a service-account token (Viewer is enough). A panel then
/// names a Grafana datasource (`ds`, by name or uid) and an `expr` in that
/// datasource's language — PromQL, LogQL or TraceQL — and cartapel asks
/// through Grafana's datasource proxy, so one token reaches every backend and
/// the browser never sees Grafana at all. See [`crate::grafana`].
///
/// `type = "http"`: cartapel proxies a server-side GET to `url` (optionally
/// `url/<rest>`), attaching a secret read from `token_env` under `header`
/// (default `x-admin-token`). The secret never reaches the browser.
///
/// `type = "files"`: a directory listing under `root`, shaped by `pattern` —
/// each `{name}` in the pattern captures a path segment as a column, so
/// `{source}/{symbol}/{tf}.parquet` turns a cache tree into rows. Metadata
/// only: names, sizes and mtimes, never file contents.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NamedSource {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub url: String,
    /// `files`: the directory the listing is confined to. Supports `env:NAME`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// `files`: path template whose `{name}` segments become columns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    /// `s3`: the S3-compatible endpoint, bucket, region and the env vars that
    /// hold the credentials. R2 wants `region = "auto"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_key_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_key_env: Option<String>,
    /// `files`/`s3`: how long a listing is reused before rescanning (default
    /// 60s) — walking a deep tree or paging a bucket is expensive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_entries: Option<usize>,
    /// `s3` only: how many objects a refresh may walk before stopping, however
    /// few of them the pattern matches. Guards a selective pattern over a large
    /// prefix from turning every refresh into a full bucket walk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_scan: Option<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub schemas: Vec<String>,
    #[serde(default)]
    pub primary: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<String>,
}

impl NamedSource {
    pub fn is_postgres(&self) -> bool {
        self.kind == "postgres"
    }

    pub fn is_mysql(&self) -> bool {
        self.kind == "mysql" || self.kind == "mariadb"
    }

    pub fn is_clickhouse(&self) -> bool {
        self.kind == "clickhouse"
    }

    pub fn is_files(&self) -> bool {
        self.kind == "files"
    }

    pub fn is_s3(&self) -> bool {
        self.kind == "s3"
    }

    pub fn is_grafana(&self) -> bool {
        self.kind == "grafana"
    }

    /// Sources that produce rows from a key pattern rather than from SQL.
    pub fn is_listing(&self) -> bool {
        self.is_files() || self.is_s3()
    }
}

impl NamedSource {
    /// The implicit source a bare `--db` / `CARTAPEL_DB` run gets when no
    /// config declares one — the URL's scheme picks the engine.
    pub fn from_url(url: &str) -> Self {
        let kind = if url.starts_with("mysql://") || url.starts_with("mariadb://") {
            "mysql"
        } else {
            "postgres"
        };
        Self {
            kind: kind.into(),
            url: url.into(),
            endpoint: None,
            bucket: None,
            region: None,
            prefix: None,
            access_key_env: None,
            secret_key_env: None,
            max_scan: None,
            root: None,
            pattern: None,
            ttl_secs: None,
            max_entries: None,
            schemas: Vec::new(),
            primary: true,
            token_env: None,
            header: None,
            roles: Vec::new(),
        }
    }
}

impl ConfigDir {
    pub fn primary_source(&self) -> Option<(&str, &NamedSource)> {
        let sql = || {
            self.sources
                .iter()
                .filter(|(_, s)| s.is_postgres() || s.is_mysql())
        };
        sql()
            .find(|(_, s)| s.primary)
            .or_else(|| sql().next())
            .map(|(n, s)| (n.as_str(), s))
    }
}

/// A `sources.hcl` file: a bag of `source "alias" { type url … }` blocks; mirrors
/// [`QueriesFile`]. Every file's blocks merge into [`ConfigDir::sources`]; an alias
/// defined in two files is a load error.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourcesFile {
    #[serde(
        default,
        rename = "source",
        skip_serializing_if = "BTreeMap::is_empty",
        serialize_with = "hcl::ser::labeled_block"
    )]
    pub sources: BTreeMap<String, NamedSource>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TableFrom {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
}

impl TableFrom {
    pub fn is_empty(&self) -> bool {
        self.source.is_none() && self.schema.is_none() && self.table.is_none()
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TableConfig {
    #[serde(
        default,
        skip_serializing_if = "TableFrom::is_empty",
        serialize_with = "hcl::ser::block"
    )]
    pub from: TableFrom,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_plural: Option<String>,
    /// Per-locale label overrides, e.g. `labels = { es = "Cliente" }` — the
    /// deployment's `[cartapel].locale` picks one, `label` is the fallback.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels_plural: BTreeMap<String, String>,
    #[serde(
        default,
        skip_serializing_if = "ListConfig::is_empty",
        serialize_with = "hcl::ser::block"
    )]
    pub list: ListConfig,
    #[serde(
        default,
        skip_serializing_if = "DisplayConfig::is_empty",
        serialize_with = "hcl::ser::block"
    )]
    pub display: DisplayConfig,
    #[serde(
        default,
        skip_serializing_if = "DetailConfig::is_empty",
        serialize_with = "hcl::ser::block"
    )]
    pub detail: DetailConfig,
    #[serde(
        default,
        skip_serializing_if = "EditConfig::is_empty",
        serialize_with = "hcl::ser::block"
    )]
    pub edit: EditConfig,
    #[serde(
        default,
        skip_serializing_if = "RelationsConfig::is_empty",
        serialize_with = "hcl::ser::block"
    )]
    pub relations: RelationsConfig,
    #[serde(
        default,
        skip_serializing_if = "TablePermissions::is_default",
        serialize_with = "hcl::ser::block"
    )]
    pub permissions: TablePermissions,
    #[serde(
        default,
        rename = "field",
        skip_serializing_if = "BTreeMap::is_empty",
        serialize_with = "hcl::ser::labeled_block"
    )]
    pub fields: BTreeMap<String, FieldConfig>,
    #[serde(
        default,
        rename = "action",
        skip_serializing_if = "BTreeMap::is_empty",
        serialize_with = "hcl::ser::labeled_block"
    )]
    pub actions: BTreeMap<String, ActionConfig>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ListConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub search: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_page: Option<u32>,
    #[serde(
        default,
        rename = "filter_def",
        skip_serializing_if = "BTreeMap::is_empty",
        serialize_with = "hcl::ser::labeled_block"
    )]
    pub filter_defs: BTreeMap<String, CustomFilter>,
}

impl ListConfig {
    fn is_empty(&self) -> bool {
        self.columns.is_empty()
            && self.search.is_empty()
            && self.filters.is_empty()
            && self.sort.is_none()
            && self.per_page.is_none()
            && self.filter_defs.is_empty()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CustomFilter {
    pub label: String,
    pub sql: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DisplayConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl DisplayConfig {
    fn is_empty(&self) -> bool {
        self.title.is_none()
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DetailConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<u8>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub tabs: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stats: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_block"
    )]
    pub sidebar: Option<DetailSidebar>,
    #[serde(
        default,
        rename = "section",
        skip_serializing_if = "Vec::is_empty",
        serialize_with = "hcl::ser::block",
        deserialize_with = "de_block_seq"
    )]
    pub sections: Vec<DetailSection>,
}

impl DetailConfig {
    fn is_empty(&self) -> bool {
        self.sections.is_empty()
            && self.mode.is_none()
            && self.columns.is_none()
            && !self.tabs
            && self.stats.is_empty()
            && self.sidebar.is_none()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DetailSidebar {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DetailSection {
    pub title: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<u8>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub collapsible: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FieldConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Per-locale label overrides, e.g. `labels = { es = "Cliente" }` — the
    /// deployment's `[cartapel].locale` picks one, `label` is the fallback.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub widget: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub readonly: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub masked: bool,
    /// Trusted SQL expression marking this as a VIRTUAL read-only column
    /// (name not present in the DB table). Selected as `(<sql>) AS "<name>"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    /// A computed (`sql`) field is display-only unless `sortable`; then list sort
    /// orders by the expression (or by [`FieldConfig::sort_by`] if set).
    #[serde(default, skip_serializing_if = "is_false")]
    pub sortable: bool,
    /// Sort a computed field by another (real) column instead of its expression —
    /// like Django's `@admin.display(ordering=…)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_by: Option<String>,
    /// Detail form section this field belongs to (alternative to `[detail.sections]`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub params: serde_json::Map<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_color"
    )]
    pub color: Option<ColorSpec>,
}

const FORMAT_VOCAB: &[&str] = &[
    "currency", "percent", "date", "datetime", "number", "bytes", "duration",
];
const COLUMN_FORMAT_VOCAB: &[&str] = &[
    "money", "currency", "percent", "pct", "number", "num", "bytes", "duration", "dur", "date",
    "datetime", "rel",
];
/// What a stat tile can actually render (`fmtByFormat`). Anything else silently
/// falls through to compact-number formatting, which is how `format = "rel"`
/// turned a timestamp into "1785,3 M" on a live dashboard.
const PANEL_FORMAT_VOCAB: &[&str] = &["number", "money", "percent", "duration", "bytes"];

const COLOR_STRATEGIES: &[&str] = &["sign", "positive", "negative", "stale"];
const COLOR_CLASSES: &[&str] = &["good", "warning", "critical", "neutral", "accent", "muted"];

fn ser_opt_color<S>(value: &Option<ColorSpec>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match value {
        None => serializer.serialize_none(),
        Some(ColorSpec::Named(name)) => serializer.serialize_str(name),
        Some(rules @ ColorSpec::Rules { .. }) => hcl::ser::block(rules, serializer),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ColorSpec {
    Named(String),
    Rules {
        #[serde(
            rename = "rule",
            deserialize_with = "de_color_rules",
            serialize_with = "ser_color_rules"
        )]
        rules: Vec<ColorRule>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ColorRule {
    pub when: String,
    pub class: String,
}

/// A `when` expression parsed into a closed set of comparisons — never an open
/// evaluator. Built once at load; `meta` emits its normalized form.
#[derive(Debug, Clone, PartialEq)]
pub enum ColorOp {
    Gt(f64),
    Gte(f64),
    Lt(f64),
    Lte(f64),
    Eq(String),
    Between(f64, f64),
}

pub fn parse_color_when(raw: &str) -> Result<ColorOp, String> {
    let s = raw.trim();
    let num = |rest: &str| -> Result<f64, String> {
        rest.trim()
            .parse::<f64>()
            .map_err(|_| format!("color rule `{raw}`: expected a number"))
    };
    if let Some(rest) = s.strip_prefix("between:") {
        let (lo, hi) = rest
            .split_once(',')
            .ok_or_else(|| format!("color rule `{raw}`: between wants `between:LO,HI`"))?;
        return Ok(ColorOp::Between(num(lo)?, num(hi)?));
    }
    if let Some(rest) = s.strip_prefix(">=") {
        return Ok(ColorOp::Gte(num(rest)?));
    }
    if let Some(rest) = s.strip_prefix("<=") {
        return Ok(ColorOp::Lte(num(rest)?));
    }
    if let Some(rest) = s.strip_prefix('>') {
        return Ok(ColorOp::Gt(num(rest)?));
    }
    if let Some(rest) = s.strip_prefix('<') {
        return Ok(ColorOp::Lt(num(rest)?));
    }
    if let Some(rest) = s.strip_prefix('=') {
        return Ok(ColorOp::Eq(rest.to_string()));
    }
    Err(format!("color rule `{raw}`: unparseable condition"))
}

impl ColorOp {
    fn normalized(&self) -> serde_json::Value {
        match self {
            ColorOp::Gt(n) => serde_json::json!({ "op": "gt", "num": n }),
            ColorOp::Gte(n) => serde_json::json!({ "op": "gte", "num": n }),
            ColorOp::Lt(n) => serde_json::json!({ "op": "lt", "num": n }),
            ColorOp::Lte(n) => serde_json::json!({ "op": "lte", "num": n }),
            ColorOp::Eq(s) => serde_json::json!({ "op": "eq", "str": s }),
            ColorOp::Between(lo, hi) => {
                serde_json::json!({ "op": "between", "num": lo, "num2": hi })
            }
        }
    }
}

impl ColorSpec {
    /// Validate at load: named strategy in the allowlist, every rule's `when`
    /// parseable and `class` in the allowlist. Loud error otherwise.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            ColorSpec::Named(name) => {
                if !COLOR_STRATEGIES.contains(&name.as_str()) {
                    return Err(format!("unknown color strategy `{name}`"));
                }
            }
            ColorSpec::Rules { rules } => {
                for r in rules {
                    parse_color_when(&r.when)?;
                    if !COLOR_CLASSES.contains(&r.class.as_str()) {
                        return Err(format!("unknown color class `{}`", r.class));
                    }
                }
            }
        }
        Ok(())
    }

    /// The pre-parsed form `meta` emits: `{strategy}` for a named strategy or
    /// `{rules:[{op,num?,num2?,str?,class}]}` for the rule DSL.
    pub fn normalized(&self) -> serde_json::Value {
        match self {
            ColorSpec::Named(name) => serde_json::json!({ "strategy": name }),
            ColorSpec::Rules { rules } => {
                let out: Vec<serde_json::Value> = rules
                    .iter()
                    .filter_map(|r| {
                        let mut v = parse_color_when(&r.when).ok()?.normalized();
                        v.as_object_mut()
                            .unwrap()
                            .insert("class".into(), serde_json::json!(r.class));
                        Some(v)
                    })
                    .collect();
                serde_json::json!({ "rules": out })
            }
        }
    }
}

fn de_color_rules<'de, D>(deserializer: D) -> Result<Vec<ColorRule>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Body {
        class: String,
    }
    struct V;
    impl<'de> serde::de::Visitor<'de> for V {
        type Value = Vec<ColorRule>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("labeled rule blocks")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Vec<ColorRule>, A::Error> {
            let mut out = Vec::new();
            while let Some((when, body)) = map.next_entry::<String, Body>()? {
                out.push(ColorRule {
                    when,
                    class: body.class,
                });
            }
            Ok(out)
        }
    }
    deserializer.deserialize_map(V)
}

fn ser_color_rules<S>(rules: &[ColorRule], serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    let map: serde_json::Map<String, serde_json::Value> = rules
        .iter()
        .map(|r| (r.when.clone(), serde_json::json!({ "class": r.class })))
        .collect();
    hcl::ser::labeled_block(&map, serializer)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImageConfig {
    pub dir: String,
    /// Real column holding the filename. Empty when `name_sql` supplies it.
    #[serde(default)]
    pub name_col: String,
    /// A scalar SQL expression (correlated to the row via the `t` alias) that
    /// yields the filename — for an image joined from a related table. Exactly
    /// one of name_col / name_sql must be set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_sql: Option<String>,
    /// Related table an upload writes to (upsert), so a `name_sql` image is
    /// editable — the file belongs to that table, not this one. Absent ⇒ the
    /// join is read-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_to: Option<String>,
    /// `target_col = parent_col` — how the upload locates/creates the target row
    /// from this row's values. Also names the filename (`<vals joined by _>.png`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub write_key: BTreeMap<String, String>,
    /// Constant target columns set when the upload INSERTs a new target row
    /// (e.g. `status = "ok"`). Ignored on UPDATE.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub write_defaults: BTreeMap<String, String>,
    #[serde(default = "default_max_px", skip_serializing_if = "is_default_max_px")]
    pub max_px: u32,
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub normalize: bool,
}

fn default_max_px() -> u32 {
    256
}

fn is_default_max_px(px: &u32) -> bool {
    *px == default_max_px()
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EditConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub readonly: Vec<String>,
}

impl EditConfig {
    fn is_empty(&self) -> bool {
        self.readonly.is_empty()
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RelationsConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inlines: Vec<InlineSpec>,
    /// `auto = false` opts out of the zero-config inlines derived from
    /// introspected reverse FKs when no `inlines` are declared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto: Option<bool>,
}

impl RelationsConfig {
    fn is_empty(&self) -> bool {
        self.inlines.is_empty() && self.auto.is_none()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum InlineSpec {
    Table(String),
    Full {
        table: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fk_col: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        columns: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        can_create: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        can_delete: Option<bool>,
        /// Rows per page for this inline (default 50).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pp: Option<u32>,
        /// Grid columns this inline occupies in the detail's inline row — set
        /// two inlines to `span = 1` under a 2-column detail to sit them
        /// side by side. Default: full width.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        span: Option<u8>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TablePermissions {
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub create: bool,
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub delete: bool,
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub write: bool,
    /// Bulk CSV/JSON extraction. Separate from `write` because a table can be
    /// safe to read a page at a time and unsafe to carry out of the building.
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub export: bool,
}

impl Default for TablePermissions {
    fn default() -> Self {
        Self {
            create: true,
            delete: true,
            write: true,
            export: true,
        }
    }
}

impl TablePermissions {
    fn is_default(&self) -> bool {
        self.create && self.delete && self.write
    }
}

fn default_true() -> bool {
    true
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_true(b: &bool) -> bool {
    *b
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ActionConfig {
    pub label: String,
    /// Per-locale label overrides, e.g. `labels = { es = "Cliente" }` — the
    /// deployment's `[cartapel].locale` picks one, `label` is the fallback.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,

    pub kind: ActionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub danger: bool,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub set: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionKind {
    Update,
    Delete,
    Webhook,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthConfig {
    /// Anonymous sessions act as this role — no login required (kiosk mode /
    /// public dashboards / the hosted demo). Omit to require login for
    /// everything. Must name `admin` or a defined role (load error otherwise);
    /// think carefully before pointing it at anything with write access.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_role: Option<String>,
    #[serde(
        default,
        rename = "role",
        skip_serializing_if = "BTreeMap::is_empty",
        serialize_with = "hcl::ser::labeled_block"
    )]
    pub roles: BTreeMap<String, RoleConfig>,
}

#[derive(Debug, Clone, Default, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct RoleConfig {
    /// May open Personalizar and edit TABLE configs (visual, raw HCL and their
    /// version history) — config authorship, so grant it to trusted power users
    /// only. Groups, dashboard, discover and access stay admin-only.
    #[serde(default, skip_serializing_if = "is_false")]
    pub customize: bool,
    /// Parent role this one inherits from: the parent resolves first, then this
    /// role's own entries override per key (`actions` union). Chains are allowed;
    /// cycles and unknown parents are load errors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tables: BTreeMap<String, String>,
    /// Granular per-table CRUD that REFINES the coarse `tables` level. An entry
    /// overrides per-capability; an unset (`None`) capability falls back to what
    /// the coarse level grants. Every resulting capability is still intersected
    /// with the table config ceiling + the read-only-table gate.
    #[serde(
        default,
        rename = "perm",
        skip_serializing_if = "BTreeMap::is_empty",
        serialize_with = "hcl::ser::labeled_block"
    )]
    pub perms: BTreeMap<String, TablePerm>,
    /// Per-table whitelist of columns this role may edit. When present for a
    /// table, any column NOT listed is rejected on write (in addition to the
    /// masked / readonly / pk / computed rejections). Absent = no restriction.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub editable: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub masked: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub row_filter: BTreeMap<String, String>,
}

/// Fine-grained per-capability override for one table. Every field is optional:
/// `None` means "defer to the coarse `tables` level"; `Some(b)` forces it.
#[derive(Debug, Clone, Default, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct TablePerm {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DashboardConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<u8>,
    /// Re-run this page's panels on a clock, e.g. `refresh = "30s"`. Accepts
    /// `30s` / `5m` / a bare number of seconds; anything under the floor is
    /// raised to it, because a dashboard is not a tick feed and every poll
    /// re-runs every panel's SQL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<String>,
    #[serde(
        default,
        rename = "panel",
        skip_serializing_if = "Vec::is_empty",
        serialize_with = "hcl::ser::block",
        deserialize_with = "de_block_seq"
    )]
    pub widgets: Vec<PanelConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PanelConfig {
    #[serde(rename = "type")]
    pub kind: PanelKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    /// A panel reads from exactly one origin: inline `sql`, a named `query`,
    /// an http/grafana `source`, or a configured `table`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Grafana sources: the datasource (name or uid) and the query in its own
    /// language (PromQL/LogQL/TraceQL). A stat asks for the value now; a chart
    /// or table asks over `range` (default `1h`) at `step` (default ~200
    /// points), and `spark` on a stat is a second expr drawn over `range`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ds: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    /// Sub-path appended to the source's url, and where its rows live in the
    /// response (a dotted path; omit when the payload is the array itself).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows_at: Option<String>,
    /// A configured table slug: the panel renders that screen's list — its
    /// columns, widgets and permissions — instead of raw query rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    /// Listing panels only: fold the rows before rendering. `group_by` names
    /// the column to group on (omit for a single total row) and `agg` lists
    /// `count`, `count_distinct:col`, `sum:col`, `min:col` or `max:col`,
    /// each optionally `as <alias>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agg: Vec<String>,
    /// A stat tile's aggregate over a listing, e.g. `value = "sum:bytes"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// Keep only rows matching these `column = value` pairs; a value may be a
    /// `{{variable}}`, and an empty one filters nothing.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub filter: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<String>,
    /// Rows per page inside the panel (default 50).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pp: Option<u32>,
    /// Show a search box over the rows the panel carries.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub search: bool,
    /// Clicking a row opens it: every field of the row, in full, beneath it —
    /// the columns show what to scan, the row holds the rest (a raw log line,
    /// a stack, an id). Table panels without a `link` only.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub expand: bool,
    /// Columns the panel offers as dropdown filters, e.g. `filter_by = ["source"]`.
    /// The choices are the values actually present in the rows, so no list is
    /// configured and none can go stale. Unlike a `variable`, the control belongs
    /// to the panel and narrows nothing else on the page.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filter_by: Vec<String>,
    /// How many rows the panel keeps at all — the payload it carries. Paging
    /// happens within these, so raising it is what shows more of a big listing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compare_sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compare_label: Option<String>,
    /// Read-only SQL returning an ordered series (a numeric `v` per row) that the
    /// stat tile draws as an inline sparkline. Stat widgets only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spark: Option<String>,
    /// Which delta direction is favorable: `"up"` (default) paints a rising value
    /// green, `"down"` paints a falling value green (e.g. errors, latency).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub good_when: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert_above: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert_below: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Per-field presentation for a `table` panel; empty derives fields from
    /// the result-row keys (rendered via the linked table's field meta).
    #[serde(
        default,
        rename = "field",
        skip_serializing_if = "Vec::is_empty",
        serialize_with = "hcl::ser::block",
        deserialize_with = "de_block_seq"
    )]
    pub columns: Vec<PanelField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PanelField {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<u32>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub badge: BTreeMap<String, String>,
    /// In-cell dataviz for a numeric field: `bar` = proportional data bar behind
    /// the value; `heat` = cell tinted by magnitude. Scaled per-field over the
    /// panel's rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    /// Hue for `badge`-less dataviz (`display`): accent (default) / green / red /
    /// orange / blue / violet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
    /// Let a long text wrap onto several lines instead of clipping it — a log
    /// line or an error wants reading, not an ellipsis.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub wrap: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PanelKind {
    Stat,
    Chart,
    Table,
    Iframe,
}

#[derive(Debug, Clone, Default)]
pub struct ConfigDir {
    pub cartapel: CartapelConfig,
    pub auth: AuthConfig,
    pub dashboard: DashboardConfig,
    pub tables: BTreeMap<String, TableConfig>,
    /// Named read-only queries merged from every `queries.hcl` under the config
    /// root, served flat at `/query/:name`.
    pub queries: BTreeMap<String, NamedQuery>,
    /// Named external data sources merged from every `sources.hcl`, proxied
    /// server-side at `/source/:name`.
    pub sources: BTreeMap<String, NamedSource>,
    /// Template variables merged from every `variables.hcl`, bound into query/panel
    /// SQL via `{{name}}`. See [`Variable`].
    pub variables: BTreeMap<String, Variable>,
    /// Sidebar groups discovered from `_group.hcl` folders, sorted by `(order, label)`.
    pub groups: Vec<LoadedGroup>,
    /// Custom pages discovered from `page.hcl` folders, in load order.
    pub pages: Vec<LoadedPage>,
    /// Per-table provenance: where each table config was loaded from and which
    /// folder/group it belongs to. Keyed by the same key as `tables`.
    pub table_sources: BTreeMap<String, TableSource>,
}

impl ConfigDir {
    /// The presentation label of a folder-group, by its folder slug, in the
    /// instance locale.
    #[cfg(test)]
    pub fn group_label(&self, slug: &str) -> Option<String> {
        self.group_label_in(slug, self.cartapel.locale.as_deref())
    }

    /// The presentation label of a folder-group in one locale: `labels[locale]`
    /// wins, else the base label.
    pub fn group_label_in(&self, slug: &str, locale: Option<&str>) -> Option<String> {
        self.groups.iter().find(|g| g.slug == slug).map(|g| {
            locale
                .and_then(|l| g.labels.get(l).cloned())
                .unwrap_or_else(|| g.label.clone())
        })
    }

    /// The label of the folder-group a table belongs to, if any, in the
    /// instance locale.
    #[cfg(test)]
    pub fn table_group_label(&self, table: &str) -> Option<String> {
        self.table_group_label_in(table, self.cartapel.locale.as_deref())
    }

    /// The label of the folder-group a table belongs to, in one locale.
    pub fn table_group_label_in(&self, table: &str, locale: Option<&str>) -> Option<String> {
        let slug = self.table_sources.get(table)?.group.as_deref()?;
        self.group_label_in(slug, locale)
    }
}

/// Reject two labeled blocks that share `(identifier, label)` within the same
/// body, recursively. hcl-rs silently MERGES such blocks into one garbled value
/// (e.g. a second `field "secret"` erases the first's `masked = true`), so this
/// must run before `hcl::from_str`. Unlabeled repeated blocks (`section`, `group`,
/// `page`, `widget`) are legal and ordered — they are walked but never rejected.
pub fn reject_duplicate_labels(hcl_text: &str) -> Result<(), String> {
    use hcl_edit::structure::Body;

    fn walk(body: &Body) -> Result<(), String> {
        let mut seen: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();
        for block in body.blocks() {
            if block.is_labeled() {
                let ident = block.ident.as_str().to_string();
                let label = block
                    .labels
                    .iter()
                    .map(|l| l.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                if !seen.insert((ident.clone(), label.clone())) {
                    return Err(format!(
                        "duplicate block: {ident} \"{label}\" defined twice"
                    ));
                }
            }
            walk(&block.body)?;
        }
        Ok(())
    }

    let body: Body = hcl_edit::parser::parse_body(hcl_text).map_err(|e| e.to_string())?;
    walk(&body)
}

/// Recursively collect every `*.hcl` file under `dir`, sorted for deterministic
/// load order.
fn collect_hcl(dir: &Path, out: &mut Vec<std::path::PathBuf>) -> Result<(), String> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("reading {}: {e}", dir.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    entries.sort();
    for path in entries {
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("reading {}: {e}", path.display()))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            collect_hcl(&path, out)?;
        } else if path.extension().is_some_and(|x| x == "hcl") {
            out.push(path);
        }
    }
    Ok(())
}

/// Load-time validation of a parsed table config: the `format` vocab and every
/// field's `color` (named strategy or the rule DSL) must be well-formed.
fn validate_table_config(tc: &TableConfig) -> Result<(), String> {
    for (name, f) in &tc.fields {
        if let Some(img) = &f.image {
            if img.write_to.is_some() {
                // Related-table image: name_sql reads, name_col names the
                // filename column IN the target, write_key locates the row.
                if img.name_sql.is_none() || img.name_col.is_empty() || img.write_key.is_empty() {
                    return Err(format!(
                        "field \"{name}\": image `write_to` needs `name_sql`, `name_col` (the target's filename column) and a non-empty `write_key`"
                    ));
                }
            } else if img.name_col.is_empty() == img.name_sql.is_none() {
                return Err(format!(
                    "field \"{name}\": image needs exactly one of `name_col` or `name_sql`"
                ));
            }
        }
        if let Some(fmt) = &f.format {
            if !FORMAT_VOCAB.contains(&fmt.as_str()) {
                return Err(format!("field \"{name}\": unknown format `{fmt}`"));
            }
        }
        if let Some(color) = &f.color {
            color
                .validate()
                .map_err(|e| format!("field \"{name}\": {e}"))?;
        }
    }
    Ok(())
}

/// Load-time validation of widgets: every declared table `column`'s `format`
/// must be in the column-format vocab.
pub(crate) fn validate_panel_fields(widgets: &[PanelConfig]) -> Result<(), String> {
    for w in widgets {
        if w.expr.is_some() && (w.ds.is_none() || w.source.is_none()) {
            return Err(format!(
                "panel \"{}\": `expr` needs a grafana `source` and a `ds` (datasource name or uid)",
                w.label
            ));
        }
        for (what, val) in [("range", &w.range), ("step", &w.step)] {
            if let Some(v) = val.as_deref().filter(|v| !v.contains("{{")) {
                crate::grafana::parse_duration(v)
                    .map_err(|e| format!("panel \"{}\": {what}: {e}", w.label))?;
            }
        }
        if let Some(fmt) = &w.format {
            if !PANEL_FORMAT_VOCAB.contains(&fmt.as_str()) {
                return Err(format!(
                    "panel \"{}\": unknown format `{fmt}` — a tile renders {}",
                    w.label,
                    PANEL_FORMAT_VOCAB.join(", ")
                ));
            }
        }
        for c in &w.columns {
            if let Some(fmt) = &c.format {
                if !COLUMN_FORMAT_VOCAB.contains(&fmt.as_str()) {
                    return Err(format!(
                        "widget \"{}\", column \"{}\": unknown format `{fmt}`",
                        w.label, c.key
                    ));
                }
            }
            if let Some(d) = &c.display {
                if !["bar", "heat"].contains(&d.as_str()) {
                    return Err(format!(
                        "widget \"{}\", column \"{}\": unknown display `{d}` (bar|heat)",
                        w.label, c.key
                    ));
                }
            }
        }
    }
    Ok(())
}

/// The reserved top-level folder holding the globals (`cartapel.hcl`, `auth.hcl`,
/// `dashboard.hcl`) and shared `widgets/` assets — never a screen/group.
pub const RESERVED_DIR: &str = "config";

/// `module` used to point a page at a JS bundle. Pages are declarative now, so
/// a bundle carrying it must fail naming its replacement — serde's "unknown
/// field" would be technically true and useless.
fn reject_page_module(raw: &str, path: &Path) -> Result<(), String> {
    let has_module = raw
        .lines()
        .map(str::trim_start)
        .any(|l| l.starts_with("module") && l.contains('='));
    if !has_module {
        return Ok(());
    }
    Err(format!(
        "{}: `module` is gone — a page is a grid of `panel {{}}` blocks now, and a panel reads inline `sql`, a named `query`, a configured `table` or a `source`",
        path.display()
    ))
}

pub fn load(dir: Option<&Path>) -> Result<ConfigDir, String> {
    let mut cfg = ConfigDir::default();
    let Some(dir) = dir else { return Ok(cfg) };
    if !dir.exists() {
        return Err(format!("config directory {} does not exist", dir.display()));
    }
    let mut files = Vec::new();
    collect_hcl(dir, &mut files)?;
    let mut page_ids: BTreeMap<String, std::path::PathBuf> = BTreeMap::new();
    let mut page_slugs: BTreeMap<String, std::path::PathBuf> = BTreeMap::new();
    let mut group_paths: BTreeMap<String, std::path::PathBuf> = BTreeMap::new();
    let mut query_sources: BTreeMap<String, std::path::PathBuf> = BTreeMap::new();
    let mut source_files: BTreeMap<String, std::path::PathBuf> = BTreeMap::new();
    let mut variable_sources: BTreeMap<String, std::path::PathBuf> = BTreeMap::new();
    for path in files {
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("reading {}: {e}", path.display()))?;
        let stem = path.file_stem().unwrap().to_string_lossy().to_string();
        reject_duplicate_labels(&raw).map_err(|e| format!("{}: {e}", path.display()))?;
        let ctx = |e: hcl::Error| format!("{}: {e}", path.display());
        let parent = path.parent().unwrap_or(dir);
        let at_root = parent == dir;
        let folder = (!at_root)
            .then(|| parent.file_name().map(|n| n.to_string_lossy().to_string()))
            .flatten();
        let under_base = path
            .strip_prefix(dir)
            .ok()
            .and_then(|rel| rel.components().next())
            .is_some_and(|c| c.as_os_str() == RESERVED_DIR);
        let in_base = under_base && parent.file_name().is_some_and(|n| n == RESERVED_DIR);
        if under_base {
            match stem.as_str() {
                "cartapel" if in_base => cfg.cartapel = hcl::from_str(&raw).map_err(ctx)?,
                "auth" if in_base => cfg.auth = hcl::from_str(&raw).map_err(ctx)?,
                "dashboard" if in_base => {
                    let dc: DashboardConfig = hcl::from_str(&raw).map_err(ctx)?;
                    validate_panel_fields(&dc.widgets)
                        .map_err(|e| format!("{}: {e}", path.display()))?;
                    cfg.dashboard = dc;
                }
                _ => {
                    return Err(format!(
                        "misplaced config in reserved config folder: {} — config holds only cartapel.hcl, auth.hcl, dashboard.hcl and the widgets/ assets",
                        path.display()
                    ));
                }
            }
            continue;
        }
        match stem.as_str() {
            "_group" => {
                let Some(slug) = folder else { continue };
                if slug.starts_with('_') {
                    tracing::warn!(
                        "ignoring _group.hcl in reserved folder {}; folders named with a leading underscore are never sidebar groups",
                        path.display()
                    );
                    continue;
                }
                let g: GroupConfig = hcl::from_str(&raw).map_err(ctx)?;
                if let Some(prev) = group_paths.get(&slug) {
                    return Err(format!(
                        "duplicate group \"{slug}\": {} and {} — a group lives in ONE folder",
                        prev.display(),
                        path.display()
                    ));
                }
                group_paths.insert(slug.clone(), path.clone());
                cfg.groups.push(LoadedGroup {
                    slug,
                    label: g.label,
                    labels: g.labels,
                    icon: g.icon,
                    order: g.order,
                    table_order: g.table_order,
                    nav: g.nav,
                });
            }
            "queries" => {
                let qf: QueriesFile = hcl::from_str(&raw).map_err(ctx)?;
                for (name, q) in qf.queries {
                    if let Some(prev) = query_sources.get(&name) {
                        return Err(format!(
                            "duplicate query \"{name}\": {} and {}",
                            prev.display(),
                            path.display()
                        ));
                    }
                    query_sources.insert(name.clone(), path.clone());
                    cfg.queries.insert(name, q);
                }
            }
            "variables" => {
                let vf: VariablesFile = hcl::from_str(&raw).map_err(ctx)?;
                for (name, mut v) in vf.variables {
                    v.normalize();
                    v.validate(&name)
                        .map_err(|e| format!("{}: {e}", path.display()))?;
                    if let Some(prev) = variable_sources.get(&name) {
                        return Err(format!(
                            "duplicate variable \"{name}\": {} and {}",
                            prev.display(),
                            path.display()
                        ));
                    }
                    variable_sources.insert(name.clone(), path.clone());
                    cfg.variables.insert(name, v);
                }
            }
            "sources" => {
                let sf: SourcesFile = hcl::from_str(&raw).map_err(ctx)?;
                for (name, s) in sf.sources {
                    if let Some(prev) = source_files.get(&name) {
                        return Err(format!(
                            "duplicate source \"{name}\": {} and {}",
                            prev.display(),
                            path.display()
                        ));
                    }
                    source_files.insert(name.clone(), path.clone());
                    cfg.sources.insert(name, s);
                }
            }
            "page" => {
                let Some(slug) = folder else { continue };
                if parent.join("_group.hcl").exists() {
                    tracing::warn!(
                        "page {} sits directly in a group folder; put it in its own subfolder or it takes the group's name and becomes ungrouped",
                        path.display()
                    );
                }
                let group = parent
                    .parent()
                    .filter(|gp| gp.join("_group.hcl").exists())
                    .and_then(|gp| gp.file_name().map(|n| n.to_string_lossy().to_string()));
                reject_page_module(&raw, &path)?;
                let p: PageConfig = hcl::from_str(&raw).map_err(ctx)?;
                if p.widgets.is_empty() {
                    return Err(format!(
                        "{}: a page needs at least one `panel {{}}` block — pages are declarative (a panel can read `sql`, a named `query`, a configured `table` or a `source`)",
                        path.display()
                    ));
                }
                validate_panel_fields(&p.widgets)
                    .map_err(|e| format!("{}: {e}", path.display()))?;
                if let Some(prev) = page_slugs.get(&slug) {
                    return Err(format!(
                        "duplicate page slug \"{slug}\": {} and {}",
                        prev.display(),
                        path.display()
                    ));
                }
                page_slugs.insert(slug.clone(), path.clone());
                let page = LoadedPage {
                    slug,
                    group,
                    label: p.label,
                    labels: p.labels,
                    order: p.order.unwrap_or(0),
                    columns: p.columns,
                    refresh: p.refresh,
                    widgets: p.widgets,
                    icon: p.icon,
                    roles: p.roles,
                };
                let id = page.id();
                if let Some(prev) = page_ids.get(&id) {
                    return Err(format!(
                        "duplicate page id \"{id}\": {} and {}",
                        prev.display(),
                        path.display()
                    ));
                }
                page_ids.insert(id, path.clone());
                cfg.pages.push(page);
            }
            "screen" => {
                let Some(slug) = folder.clone() else { continue };
                let group = parent
                    .parent()
                    .filter(|gp| gp.join("_group.hcl").exists())
                    .and_then(|gp| gp.file_name().map(|n| n.to_string_lossy().to_string()));

                #[derive(Deserialize, Default)]
                struct Peek {
                    #[serde(default)]
                    module: Option<String>,
                    #[serde(default, rename = "panel", deserialize_with = "de_block_seq")]
                    panels: Vec<PanelConfig>,
                }
                let peek: Peek = hcl::from_str(&raw).map_err(ctx)?;
                if peek.module.is_some() {
                    reject_page_module(&raw, &path)?;
                }
                let is_page = !peek.panels.is_empty();

                if is_page {
                    let p: PageConfig = hcl::from_str(&raw).map_err(ctx)?;
                    validate_panel_fields(&p.widgets)
                        .map_err(|e| format!("{}: {e}", path.display()))?;
                    if let Some(prev) = page_slugs.get(&slug) {
                        return Err(format!(
                            "duplicate screen slug \"{slug}\": {} and {}",
                            prev.display(),
                            path.display()
                        ));
                    }
                    page_slugs.insert(slug.clone(), path.clone());
                    let page = LoadedPage {
                        slug,
                        group,
                        label: p.label,
                        labels: p.labels,
                        order: p.order.unwrap_or(0),
                        columns: p.columns,
                        refresh: p.refresh,
                        widgets: p.widgets,
                        icon: p.icon,
                        roles: p.roles,
                    };
                    let id = page.id();
                    if let Some(prev) = page_ids.get(&id) {
                        return Err(format!(
                            "duplicate screen id \"{id}\": {} and {}",
                            prev.display(),
                            path.display()
                        ));
                    }
                    page_ids.insert(id, path.clone());
                    cfg.pages.push(page);
                } else {
                    if let Some(prev) = cfg.table_sources.get(&slug) {
                        return Err(format!(
                            "duplicate table config for \"{slug}\": {} and {}",
                            prev.path.display(),
                            path.display()
                        ));
                    }
                    let tc: TableConfig = hcl::from_str(&raw).map_err(ctx)?;
                    validate_table_config(&tc).map_err(|e| format!("{}: {e}", path.display()))?;
                    cfg.tables.insert(slug.clone(), tc);
                    cfg.table_sources.insert(
                        slug,
                        TableSource {
                            path: path.clone(),
                            group,
                        },
                    );
                }
            }
            _ => {
                // Under screens/ the file set is closed (screen/_group/queries/
                // variables/sources) — a stray stem there is a typo, not a table.
                let under_screens = path
                    .strip_prefix(dir)
                    .ok()
                    .and_then(|rel| rel.components().next())
                    .is_some_and(|c| c.as_os_str() == "screens");
                if under_screens {
                    return Err(format!(
                        "{}: unexpected file under screens/ — a table is a folder with a screen.hcl; valid stems are screen, page, _group, queries, variables, sources",
                        path.display()
                    ));
                }
                if let Some(prev) = cfg.table_sources.get(&stem) {
                    return Err(format!(
                        "duplicate table config for \"{stem}\": {} and {}",
                        prev.path.display(),
                        path.display()
                    ));
                }
                let tc: TableConfig = hcl::from_str(&raw).map_err(ctx)?;
                validate_table_config(&tc).map_err(|e| format!("{}: {e}", path.display()))?;
                cfg.tables.insert(stem.clone(), tc);
                cfg.table_sources.insert(
                    stem,
                    TableSource {
                        path: path.clone(),
                        group: folder,
                    },
                );
            }
        }
    }
    // cartapel.hcl's central `source` blocks join the registry (dup-checked vs sources.hcl).
    for (name, s) in cfg.cartapel.sources.clone() {
        if let Some(prev) = source_files.get(&name) {
            return Err(format!(
                "duplicate source \"{name}\": {} and cartapel.hcl",
                prev.display()
            ));
        }
        cfg.sources.insert(name, s);
    }
    cfg.groups
        .sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.label.cmp(&b.label)));
    // Pages follow their group's `order`, then their own — the sidebar lists
    // them in this sequence, so a group can say "read this first".
    let group_rank: BTreeMap<String, (i64, String)> = cfg
        .groups
        .iter()
        .map(|g| (g.slug.clone(), (g.order, g.label.clone())))
        .collect();
    cfg.pages.sort_by(|a, b| {
        let ra = a.group.as_ref().and_then(|g| group_rank.get(g));
        let rb = b.group.as_ref().and_then(|g| group_rank.get(g));
        ra.cmp(&rb)
            .then(a.order.cmp(&b.order))
            .then_with(|| a.label.cmp(&b.label))
    });
    // A table/query pinned to a source must name a real, postgres one — otherwise
    // resolution silently falls back to the primary and reads the wrong database.
    for (table, tc) in &cfg.tables {
        if let Some(alias) = &tc.from.source {
            match cfg.sources.get(alias) {
                None => {
                    return Err(format!(
                        "table \"{table}\": from.source \"{alias}\" is not a defined source"
                    ))
                }
                Some(s) if !s.is_postgres() && !s.is_mysql() && !s.is_clickhouse() => {
                    return Err(format!(
                        "table \"{table}\": from.source \"{alias}\" is not a database source"
                    ))
                }
                _ => {}
            }
        }
    }
    for (name, q) in &cfg.queries {
        if let Some(alias) = &q.source {
            match cfg.sources.get(alias) {
                None => {
                    return Err(format!(
                        "query \"{name}\": source \"{alias}\" is not a defined source"
                    ))
                }
                Some(s) if !s.is_postgres() && !s.is_mysql() && !s.is_clickhouse() => {
                    return Err(format!(
                        "query \"{name}\": source \"{alias}\" is not a database source"
                    ))
                }
                _ => {}
            }
        }
    }
    for (name, var) in &cfg.variables {
        if let Some(alias) = &var.source {
            match cfg.sources.get(alias) {
                None => {
                    return Err(format!(
                        "variable \"{name}\": source \"{alias}\" is not a defined source"
                    ))
                }
                // A `field` variable reads a listing; a `query` one needs SQL.
                Some(s) if var.field.is_some() && !s.is_listing() => {
                    return Err(format!(
                        "variable \"{name}\": `field` reads a listing, but source \"{alias}\" is a {} source",
                        s.kind
                    ))
                }
                Some(s)
                    if var.field.is_none()
                        && !s.is_postgres()
                        && !s.is_mysql()
                        && !s.is_clickhouse() =>
                {
                    return Err(format!(
                        "variable \"{name}\": source \"{alias}\" is not a database source"
                    ))
                }
                _ => {}
            }
        }
    }
    for (name, s) in &cfg.sources {
        if s.is_listing() && s.pattern.is_none() {
            return Err(format!(
                "source \"{name}\": a {} source needs a pattern, e.g. \"{{dir}}/{{file}}.csv\"",
                s.kind
            ));
        }
        if s.is_files() && s.root.is_none() {
            return Err(format!("source \"{name}\": a files source needs a root"));
        }
        if s.is_s3() {
            for (key, val) in [
                ("endpoint", &s.endpoint),
                ("bucket", &s.bucket),
                ("access_key_env", &s.access_key_env),
                ("secret_key_env", &s.secret_key_env),
            ] {
                if val.is_none() {
                    return Err(format!("source \"{name}\": an s3 source needs {key}"));
                }
            }
        }
        if !s.is_listing() && s.url.is_empty() {
            return Err(format!("source \"{name}\": missing url"));
        }
    }
    validate_role_inheritance(&cfg.auth.roles)?;
    if let Some(pr) = &cfg.auth.public_role {
        let known = pr
            .split(',')
            .map(str::trim)
            .all(|p| p == "admin" || cfg.auth.roles.contains_key(p));
        if !known {
            return Err(format!("auth: public_role \"{pr}\" names an unknown role"));
        }
    }
    Ok(cfg)
}

/// Every `extends` must name an existing config role and the chains must be
/// acyclic — a broken hierarchy silently granting nothing is worse than a
/// startup error.
pub fn validate_role_inheritance(roles: &BTreeMap<String, RoleConfig>) -> Result<(), String> {
    for (name, role) in roles {
        let mut seen = vec![name.as_str()];
        let mut cur = role;
        while let Some(parent) = cur.extends.as_deref() {
            if !roles.contains_key(parent) {
                return Err(format!(
                    "role \"{name}\": extends unknown role \"{parent}\""
                ));
            }
            if seen.contains(&parent) {
                return Err(format!(
                    "role \"{name}\": inheritance cycle through \"{parent}\""
                ));
            }
            seen.push(parent);
            cur = &roles[parent];
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detail_json_model_from_builder_round_trips_to_hcl() {
        let model = serde_json::json!({
            "detail": {
                "mode": "page",
                "columns": 1,
                "stats": ["install_count", "rating_avg"],
                "sidebar": { "fields": ["id", "owner_id"] },
                "section": [
                    { "title": "Identity", "fields": ["name", "kind"] },
                    { "title": "Content", "fields": ["summary", "source"] }
                ]
            }
        });
        let tc: TableConfig =
            serde_json::from_value(model).expect("builder JSON model deserializes");
        assert_eq!(tc.detail.mode.as_deref(), Some("page"));
        assert_eq!(tc.detail.columns, Some(1));
        assert_eq!(tc.detail.stats, vec!["install_count", "rating_avg"]);
        assert_eq!(
            tc.detail.sidebar.as_ref().unwrap().fields,
            vec!["id", "owner_id"]
        );
        assert_eq!(tc.detail.sections.len(), 2);
        assert_eq!(tc.detail.sections[1].title, "Content");

        let hcl = hcl::to_string(&tc).unwrap();
        let back: TableConfig = hcl::from_str(&hcl).expect("generated HCL parses back");
        assert_eq!(back.detail.stats, tc.detail.stats);
        assert_eq!(back.detail.sections.len(), 2);
    }

    #[test]
    fn table_config_hcl_round_trip_is_idempotent() {
        let src = r#"
label = "bot"

list {
  columns = ["name", "mode", "status"]
  search  = ["name"]
  filters = ["mode"]
  sort    = "-created_at"
  filter_def "needs_attention" {
    label = "Needs attention"
    sql   = "t.mode <> 'off'"
  }
}

field "mode" {
  widget = "badge"
  params = { colors = { off = "gray", live = "green" } }
}

field "signals_24h" {
  label  = "Signals 24h"
  sql    = "(SELECT count(*) FROM x)"
  widget = "custom:minibar"
  params = { field = "signals_24h", max = 50 }
}

detail {
  section {
    title  = "Identity"
    fields = ["name", "id"]
  }
  section {
    title  = "Runtime"
    fields = ["mode", "status"]
  }
}

edit {
  readonly = ["id", "created_at"]
}

relations {
  inlines = ["bot_signals"]
}

permissions {
  create = false
  delete = false
}

action "pause" {
  label   = "Pause"
  kind    = "update"
  set     = { mode = "off" }
  confirm = "Pause?"
  danger  = true
}
"#;
        let a: TableConfig = hcl::from_str(src).expect("parse pretty HCL");
        // Section order is load-bearing and must survive.
        assert_eq!(a.detail.sections[0].title, "Identity");
        assert_eq!(a.detail.sections[1].title, "Runtime");
        assert!(a.list.filter_defs.contains_key("needs_attention"));
        assert_eq!(a.actions["pause"].set.get("mode").unwrap(), "off");
        assert!(!a.permissions.create);
        // An unstated ceiling stays open — adding `export` must not silently
        // break every table that never mentioned it.
        assert!(a.permissions.export, "export defaults to allowed");
        let gated: TableConfig =
            hcl::from_str("permissions {\n  export = false\n}\n").expect("parse");
        assert!(!gated.permissions.export);
        // A live page must never be able to ask for a poll faster than the floor.
        assert_eq!(refresh_secs(Some("30s")), Some(30));
        assert_eq!(refresh_secs(Some("5m")), Some(300));
        assert_eq!(refresh_secs(Some("45")), Some(45));
        assert_eq!(
            refresh_secs(Some("1s")),
            Some(MIN_REFRESH_SECS),
            "raised to the floor"
        );
        assert_eq!(refresh_secs(None), None);
        assert_eq!(refresh_secs(Some("")), None);
        assert_eq!(refresh_secs(Some("0s")), None, "zero is off, not infinite");
        assert_eq!(
            refresh_secs(Some("soon")),
            None,
            "a typo leaves a static page"
        );

        let out = hcl::to_string(&a).expect("serialize");
        let b: TableConfig = hcl::from_str(&out).expect("re-parse serialized");
        assert_eq!(
            serde_json::to_value(&a).unwrap(),
            serde_json::to_value(&b).unwrap(),
            "parse -> serialize -> parse must be identity",
        );
        // Serialize is stable (fixed point).
        assert_eq!(out, hcl::to_string(&b).unwrap());
    }

    #[test]
    fn phase4_presentation_round_trips() {
        let src = r#"
field "pnl" {
  format = "currency"
  prefix = "$"
  color  = "sign"
}

field "win_rate" {
  format   = "percent"
  suffix   = "%"
  truncate = 40
  color {
    rule ">0"          { class = "good" }
    rule "<0"          { class = "critical" }
    rule "between:1,2" { class = "warning" }
    rule "=n/a"        { class = "muted" }
  }
}

field "name" {
  display = "{first_name} {last_name}"
  href    = "https://x/{id}"
}

detail {
  mode    = "drawer"
  columns = 2
  tabs    = true
  sidebar {
    fields = ["id", "created_at"]
  }
  section {
    title       = "Identity"
    fields      = ["name", "id"]
    span        = 2
    collapsible = true
  }
}

relations {
  inlines = [
    { table = "bot_signals", columns = ["ts", "kind"], can_create = false, can_delete = true },
  ]
}
"#;
        let a: TableConfig = hcl::from_str(src).expect("parse pretty HCL");

        match &a.fields["pnl"].color {
            Some(ColorSpec::Named(n)) => assert_eq!(n, "sign"),
            other => panic!("expected named color, got {other:?}"),
        }
        match &a.fields["win_rate"].color {
            Some(ColorSpec::Rules { rules }) => {
                assert_eq!(rules.len(), 4);
                assert_eq!(rules[0].when, ">0");
                assert_eq!(rules[2].when, "between:1,2");
            }
            other => panic!("expected rules color, got {other:?}"),
        }
        assert_eq!(a.detail.mode.as_deref(), Some("drawer"));
        assert_eq!(a.detail.columns, Some(2));
        assert!(a.detail.tabs);
        assert_eq!(
            a.detail.sidebar.as_ref().unwrap().fields,
            vec!["id", "created_at"]
        );
        assert_eq!(a.detail.sections[0].span, Some(2));
        assert!(a.detail.sections[0].collapsible);
        match &a.relations.inlines[0] {
            InlineSpec::Full {
                columns,
                can_create,
                can_delete,
                ..
            } => {
                assert_eq!(columns, &vec!["ts".to_string(), "kind".to_string()]);
                assert_eq!(*can_create, Some(false));
                assert_eq!(*can_delete, Some(true));
            }
            other => panic!("expected full inline, got {other:?}"),
        }

        let out = hcl::to_string(&a).expect("serialize");
        let b: TableConfig = hcl::from_str(&out).expect("re-parse serialized");
        assert_eq!(
            serde_json::to_value(&a).unwrap(),
            serde_json::to_value(&b).unwrap(),
            "parse -> serialize -> parse must be identity (incl. color rule order)",
        );
        assert_eq!(
            out,
            hcl::to_string(&b).unwrap(),
            "serialize is a fixed point"
        );
    }

    #[test]
    fn phase4_load_validation_is_loud() {
        let bad_format = fresh_root("bad-format");
        std::fs::write(
            bad_format.join("t.hcl"),
            "field \"x\" { format = \"bogus\" }\n",
        )
        .unwrap();
        let err = load(Some(&bad_format)).expect_err("bad format errors");
        assert!(err.contains("unknown format `bogus`"), "{err}");
        let _ = std::fs::remove_dir_all(&bad_format);

        let bad_class = fresh_root("bad-class");
        std::fs::write(
            bad_class.join("t.hcl"),
            "field \"x\" {\n  color {\n    rule \">0\" {\n      class = \"nope\"\n    }\n  }\n}\n",
        )
        .unwrap();
        let err = load(Some(&bad_class)).expect_err("bad class errors");
        assert!(err.contains("unknown color class `nope`"), "{err}");
        let _ = std::fs::remove_dir_all(&bad_class);

        let bad_when = fresh_root("bad-when");
        std::fs::write(
            bad_when.join("t.hcl"),
            "field \"x\" {\n  color {\n    rule \"~~\" {\n      class = \"good\"\n    }\n  }\n}\n",
        )
        .unwrap();
        let err = load(Some(&bad_when)).expect_err("bad when errors");
        assert!(err.contains("unparseable"), "{err}");
        let _ = std::fs::remove_dir_all(&bad_when);

        let bad_strategy = fresh_root("bad-strategy");
        std::fs::write(
            bad_strategy.join("t.hcl"),
            "field \"x\" { color = \"rainbow\" }\n",
        )
        .unwrap();
        let err = load(Some(&bad_strategy)).expect_err("bad strategy errors");
        assert!(err.contains("unknown color strategy `rainbow`"), "{err}");
        let _ = std::fs::remove_dir_all(&bad_strategy);
    }

    #[test]
    fn color_when_parser_covers_the_grammar() {
        assert_eq!(parse_color_when(">0").unwrap(), ColorOp::Gt(0.0));
        assert_eq!(parse_color_when(">=5").unwrap(), ColorOp::Gte(5.0));
        assert_eq!(parse_color_when("<-1").unwrap(), ColorOp::Lt(-1.0));
        assert_eq!(parse_color_when("<=2.5").unwrap(), ColorOp::Lte(2.5));
        assert_eq!(
            parse_color_when("=stale").unwrap(),
            ColorOp::Eq("stale".into())
        );
        assert_eq!(
            parse_color_when("between:1,3").unwrap(),
            ColorOp::Between(1.0, 3.0)
        );
        assert!(parse_color_when("~~").is_err());
        assert!(parse_color_when(">abc").is_err());
        assert!(parse_color_when("between:1").is_err());
    }

    #[test]
    fn auth_and_dashboard_round_trip() {
        let auth: AuthConfig = hcl::from_str(
            r#"
role "support" {
  tables = { "*" = "read" }
  masked = { subscriptions = ["wallet"] }
  row_filter = { user_settings = "t.key NOT ILIKE '%secret%'" }
  perm "bots" {
    view   = true
    update = false
  }
}
"#,
        )
        .expect("parse auth");
        assert!(auth.roles.contains_key("support"));
        let r = &auth.roles["support"];
        assert_eq!(r.tables.get("*").unwrap(), "read");
        assert_eq!(r.perms["bots"].view, Some(true));
        let out = hcl::to_string(&auth).unwrap();
        let auth2: AuthConfig = hcl::from_str(&out).unwrap();
        assert_eq!(
            serde_json::to_value(&auth).unwrap(),
            serde_json::to_value(&auth2).unwrap()
        );

        let dash: DashboardConfig = hcl::from_str(
            r#"
panel {
  type  = "stat"
  label = "Bots"
  sql   = "SELECT count(*) AS v FROM bots"
}
panel {
  type        = "stat"
  label       = "Halted"
  sql         = "SELECT count(*) AS v FROM bots WHERE status = 'halted'"
  spark       = "SELECT count(*) AS v FROM bots GROUP BY 1"
  good_when   = "down"
  alert_above = 0
  roles       = ["ops"]
}
"#,
        )
        .expect("parse dashboard");
        assert_eq!(dash.widgets.len(), 2);
        assert_eq!(dash.widgets[0].label, "Bots");
        assert_eq!(dash.widgets[1].good_when.as_deref(), Some("down"));
        assert!(dash.widgets[1].spark.is_some());
        let out = hcl::to_string(&dash).unwrap();
        let dash2: DashboardConfig = hcl::from_str(&out).unwrap();
        assert_eq!(
            serde_json::to_value(&dash.widgets).unwrap(),
            serde_json::to_value(&dash2.widgets).unwrap(),
            "widget order preserved",
        );
    }

    /// `strings` takes a flat override (every locale) next to a locale-keyed map
    /// (that locale only), and both survive a write-back unchanged.
    #[test]
    fn strings_flat_and_per_locale_round_trip() {
        let sc: CartapelConfig = hcl::from_str(
            r#"
locale  = "en"
strings = {
  new_record = "Add {label}"
  es = { new_record = "Añadir {label}", logout = "Chao" }
}
"#,
        )
        .expect("parse strings");
        assert_eq!(
            sc.strings.get("new_record"),
            Some(&StringOverride::Every("Add {label}".into()))
        );
        assert_eq!(
            sc.strings.get("es"),
            Some(&StringOverride::PerLocale(BTreeMap::from([
                ("new_record".to_string(), "Añadir {label}".to_string()),
                ("logout".to_string(), "Chao".to_string()),
            ])))
        );
        let out = hcl::to_string(&sc).unwrap();
        let sc2: CartapelConfig = hcl::from_str(&out).unwrap();
        assert_eq!(
            serde_json::to_value(&sc).unwrap(),
            serde_json::to_value(&sc2).unwrap()
        );
    }

    #[test]
    fn cartapel_globals_round_trip() {
        let sc: CartapelConfig = hcl::from_str(
            r#"
brand = "acme"
per_page = 100

theme {
  preset = "cartapel"
  light  = { page = "hsl(1)" }
}

source "main" {
  type    = "postgres"
  url     = "env:CARTAPEL_DB"
  schemas = ["markets", "marketplace"]
  primary = true
}
"#,
        )
        .expect("parse cartapel");
        let src = sc.sources.get("main").expect("main source");
        assert!(src.primary && src.is_postgres());
        assert_eq!(src.schemas, vec!["markets", "marketplace"]);
        let out = hcl::to_string(&sc).unwrap();
        let sc2: CartapelConfig = hcl::from_str(&out).unwrap();
        assert_eq!(
            serde_json::to_value(&sc).unwrap(),
            serde_json::to_value(&sc2).unwrap(),
            "cartapel globals round-trip",
        );
    }

    /// A `page.hcl` file body parses into `PageConfig` and round-trips;
    /// `slug`/`group`/`id` are folder-derived so they never appear in the file and
    /// `deny_unknown_fields` rejects a stray one.
    #[test]
    fn page_config_round_trip() {
        let p: PageConfig = hcl::from_str(
            r#"
label  = "Operations"
icon   = "satellite"
roles  = ["ops"]
"#,
        )
        .expect("parse page");
        assert_eq!(p.label, "Operations");
        assert_eq!(p.icon.as_deref(), Some("satellite"));
        assert_eq!(p.roles, vec!["ops"]);
        let out = hcl::to_string(&p).unwrap();
        let p2: PageConfig = hcl::from_str(&out).unwrap();
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::to_value(&p2).unwrap(),
            "page file body round-trips",
        );

        assert!(
            hcl::from_str::<PageConfig>("label = \"X\"\ngroup = \"Ops\"\n").is_err(),
            "a stray folder-derived `group` is rejected",
        );
        assert!(
            hcl::from_str::<PageConfig>("label = \"X\"\nslug = \"x\"\n").is_err(),
            "a stray folder-derived `slug` is rejected",
        );
        assert!(
            hcl::from_str::<PageConfig>("label = \"X\"\nid = \"x\"\n").is_err(),
            "a stray folder-derived `id` is rejected",
        );
    }

    /// A `_group.hcl` parses into `GroupConfig` and round-trips.
    #[test]
    fn group_config_round_trip() {
        let g: GroupConfig = hcl::from_str("label = \"Bots & live\"\nicon = \"bot\"\norder = 1\n")
            .expect("parse group");
        assert_eq!(g.label, "Bots & live");
        assert_eq!(g.icon.as_deref(), Some("bot"));
        assert_eq!(g.order, 1);
        let out = hcl::to_string(&g).unwrap();
        let g2: GroupConfig = hcl::from_str(&out).unwrap();
        assert_eq!(g.label, g2.label);
        assert_eq!(g.order, g2.order);

        // A group with no icon and default order still parses.
        let g3: GroupConfig = hcl::from_str("label = \"Overview\"\n").expect("minimal group");
        assert_eq!(g3.order, 0);
        assert!(g3.icon.is_none());
    }

    /// The optional stable `id` is accepted (and skipped when absent) on a
    /// dashboard widget.
    #[test]
    fn widget_id_is_optional_and_round_trips() {
        let with: PanelConfig = hcl::from_str(
            "type = \"stat\"\nlabel = \"Bots\"\nid = \"total-bots\"\nsql = \"SELECT 1 AS v\"\n",
        )
        .expect("parse widget with id");
        assert_eq!(with.id.as_deref(), Some("total-bots"));

        let without: PanelConfig =
            hcl::from_str("type = \"stat\"\nlabel = \"Bots\"\nsql = \"SELECT 1 AS v\"\n")
                .expect("parse widget without id");
        assert!(without.id.is_none());
        assert!(
            !hcl::to_string(&without).unwrap().contains("id"),
            "absent id is not emitted"
        );

        let out = hcl::to_string(&with).unwrap();
        let back: PanelConfig = hcl::from_str(&out).unwrap();
        assert_eq!(with.id, back.id);
    }

    #[test]
    fn dashboard_grid_layout_round_trips() {
        let dash: DashboardConfig = hcl::from_str(
            r#"
columns = 3

panel {
  type     = "stat"
  label    = "Bots"
  sql      = "SELECT count(*) AS v FROM bots"
  w        = 2
  h        = 1
  category = "Fleet"
}
panel {
  type  = "chart"
  label = "Signals"
  sql   = "SELECT t, v FROM signals"
  w     = 4
  h     = 2
}
"#,
        )
        .expect("parse grid dashboard");
        assert_eq!(dash.columns, Some(3));
        assert_eq!(dash.widgets[0].w, Some(2));
        assert_eq!(dash.widgets[0].h, Some(1));
        assert_eq!(dash.widgets[0].category.as_deref(), Some("Fleet"));
        assert_eq!(dash.widgets[1].w, Some(4));
        assert_eq!(dash.widgets[1].category, None);

        let out = hcl::to_string(&dash).unwrap();
        let dash2: DashboardConfig = hcl::from_str(&out).unwrap();
        assert_eq!(
            serde_json::to_value(&dash).unwrap(),
            serde_json::to_value(&dash2).unwrap(),
            "grid layout fields round-trip",
        );
        assert_eq!(
            out,
            hcl::to_string(&dash2).unwrap(),
            "serialize is a fixed point"
        );

        let bare: PanelConfig =
            hcl::from_str("type = \"stat\"\nlabel = \"X\"\nsql = \"SELECT 1 AS v\"\n").unwrap();
        let bare_out = hcl::to_string(&bare).unwrap();
        assert!(!bare_out.contains("w ="), "absent span is not emitted");
        assert!(
            !bare_out.contains("category"),
            "absent category is not emitted"
        );
    }

    #[test]
    fn declarative_page_widget_columns_parse_validate_and_round_trip() {
        let p: PageConfig = hcl::from_str(
            r#"
label   = "Ops"
icon    = "satellite"
roles   = ["ops"]
columns = 4

panel {
  type  = "table"
  label = "Bots"
  sql   = "SELECT id, name, status FROM bots"
  link  = "bots"
  field {
    key   = "name"
    label = "Bot"
  }
  field {
    key   = "status"
    label = "Status"
    badge = { active = "green", off = "gray" }
  }
  field {
    key    = "n"
    align  = "r"
    format = "num"
    max    = 220
  }
}
"#,
        )
        .expect("parse declarative page");
        assert_eq!(p.label, "Ops");
        assert_eq!(p.roles, vec!["ops"]);
        let w = &p.widgets[0];
        assert_eq!(w.columns.len(), 3);
        assert_eq!(w.columns[0].label.as_deref(), Some("Bot"));
        assert_eq!(
            w.columns[1].badge.get("active").map(String::as_str),
            Some("green")
        );
        assert_eq!(w.columns[2].align.as_deref(), Some("r"));
        assert_eq!(w.columns[2].max, Some(220));
        validate_panel_fields(&p.widgets).expect("valid formats");

        let out = hcl::to_string(&p).unwrap();
        let p2: PageConfig = hcl::from_str(&out).unwrap();
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::to_value(&p2).unwrap(),
            "widget columns round-trip",
        );
    }

    #[test]
    fn image_field_needs_exactly_one_name_source() {
        let with_image = |img: ImageConfig| -> Result<(), String> {
            let mut tc = TableConfig::default();
            tc.fields.insert(
                "logo".into(),
                FieldConfig {
                    image: Some(img),
                    ..Default::default()
                },
            );
            validate_table_config(&tc)
        };
        let base = || ImageConfig {
            dir: "/d".into(),
            name_col: String::new(),
            name_sql: None,
            write_to: None,
            write_key: Default::default(),
            write_defaults: Default::default(),
            max_px: 128,
            normalize: true,
        };
        assert!(with_image(ImageConfig {
            name_col: "file".into(),
            ..base()
        })
        .is_ok());
        assert!(with_image(ImageConfig {
            name_sql: Some("(SELECT f FROM l)".into()),
            ..base()
        })
        .is_ok());
        assert!(with_image(base()).is_err(), "neither is a load error");
        assert!(
            with_image(ImageConfig {
                name_col: "file".into(),
                name_sql: Some("(SELECT 1)".into()),
                ..base()
            })
            .is_err(),
            "both is a load error"
        );
        // Write-through: needs name_sql + name_col (target's filename col) + write_key.
        let mut key = BTreeMap::new();
        key.insert("symbol".to_string(), "symbol".to_string());
        assert!(
            with_image(ImageConfig {
                name_sql: Some("(SELECT f FROM l)".into()),
                name_col: "filename".into(),
                write_to: Some("logos".into()),
                write_key: key.clone(),
                ..base()
            })
            .is_ok(),
            "complete write-through is valid"
        );
        assert!(
            with_image(ImageConfig {
                name_sql: Some("(SELECT f FROM l)".into()),
                write_to: Some("logos".into()),
                write_key: key,
                ..base()
            })
            .is_err(),
            "write_to without name_col (target filename column) is a load error"
        );
    }

    #[test]
    fn a_table_can_wrap_a_field_and_expand_its_rows() {
        let hcl = r#"
panel {
  type   = "table"
  label  = "Lines"
  source = "grafana"
  ds     = "loki"
  expr   = "{level=\"error\"}"
  range  = "{{window}}"
  expand = true
  field {
    key  = "message"
    wrap = true
  }
}
"#;
        let dash: DashboardConfig = hcl::from_str(hcl).unwrap();
        let w = &dash.widgets[0];
        assert!(w.expand);
        assert!(w.columns[0].wrap);
        validate_panel_fields(&dash.widgets).expect("a templated range is not parsed at load");
    }

    #[test]
    fn a_grafana_expr_needs_its_source_and_datasource() {
        let hcl = r#"
panel {
  type  = "stat"
  label = "Bots"
  expr  = "sum(bots_active)"
}
"#;
        let dash: DashboardConfig = hcl::from_str(hcl).unwrap();
        let err = validate_panel_fields(&dash.widgets).unwrap_err();
        assert!(
            err.contains("`expr` needs a grafana `source` and a `ds`"),
            "{err}"
        );

        let hcl = r#"
panel {
  type   = "chart"
  label  = "Bots"
  source = "grafana"
  ds     = "prometheus"
  expr   = "sum(bots_active)"
  range  = "6 fortnights"
}
"#;
        let dash: DashboardConfig = hcl::from_str(hcl).unwrap();
        assert!(validate_panel_fields(&dash.widgets)
            .unwrap_err()
            .contains("range"));
    }

    #[test]
    fn validate_panel_fields_rejects_unknown_format() {
        let dc: DashboardConfig = hcl::from_str(
            "panel {\n  type = \"table\"\n  label = \"X\"\n  sql = \"SELECT 1\"\n  field {\n    key = \"a\"\n    format = \"bogus\"\n  }\n}\n",
        )
        .unwrap();
        assert!(
            validate_panel_fields(&dc.widgets).is_err(),
            "unknown column format is a load error"
        );
    }

    #[test]
    fn reject_duplicate_labels_catches_dupes() {
        assert!(reject_duplicate_labels(
            "field \"secret\" { masked = true }\nfield \"secret\" { label = \"Secret\" }\n"
        )
        .is_err());
        assert!(reject_duplicate_labels("role \"ops\" { }\nrole \"ops\" { }\n").is_err());
        assert!(reject_duplicate_labels(
            "role \"ops\" {\n  perm \"bots\" { view = true }\n  perm \"bots\" { view = false }\n}\n"
        )
        .is_err());
        assert!(reject_duplicate_labels(
            "list {\n  filter_def \"a\" { label = \"A\" sql = \"1\" }\n  filter_def \"a\" { label = \"B\" sql = \"2\" }\n}\n"
        )
        .is_err());
    }

    #[test]
    fn reject_duplicate_labels_allows_legal_repeats() {
        assert!(reject_duplicate_labels(
            "detail {\n  section { title = \"A\" }\n  section { title = \"B\" }\n}\n"
        )
        .is_ok());
        assert!(
            reject_duplicate_labels("group { label = \"A\" }\ngroup { label = \"B\" }\n").is_ok()
        );
        assert!(reject_duplicate_labels(
            "field \"a\" { masked = true }\nfield \"b\" { masked = true }\n"
        )
        .is_ok());
    }

    #[test]
    fn shipped_demo_configs_have_no_duplicate_labels() {
        let dir = std::path::Path::new("demo/admin");
        let mut files = Vec::new();
        collect_hcl(dir, &mut files).unwrap();
        for path in &files {
            let raw = std::fs::read_to_string(path).unwrap();
            reject_duplicate_labels(&raw).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        }
        // Layout-relative: every `_group.hcl` plus the three root globals get
        // read, so adding a table cannot quietly leave files unchecked.
        let groups = files
            .iter()
            .filter(|p| p.file_stem().unwrap() == "_group")
            .count();
        assert_eq!(groups, 5, "one _group.hcl per screens/ folder");
        for g in ["cartapel", "auth", "dashboard"] {
            assert!(
                files.iter().any(|p| p.file_stem().unwrap() == g
                    && p.parent().unwrap().file_name().unwrap() == "config"),
                "config/{g}.hcl checked",
            );
        }
    }

    /// The shipped demo `admin/**/*.hcl` files all parse into their config
    /// structs, and grouping comes from the folder `_group.hcl` files.
    #[test]
    fn shipped_demo_configs_load() {
        let dir = std::path::Path::new("demo/admin");
        let cfg = load(Some(dir)).expect("demo configs load");
        assert!(
            cfg.tables.contains_key("orders"),
            "orders table config present"
        );
        assert!(!cfg.groups.is_empty(), "folder groups present");
        assert!(
            !cfg.tables.contains_key("dashboard"),
            "folder dashboard.hcl is not a table"
        );
        assert_eq!(
            cfg.table_sources
                .get("orders")
                .and_then(|s| s.group.as_deref()),
            Some("sales"),
            "orders is sourced from the sales folder",
        );
        assert_eq!(cfg.table_group_label("orders").as_deref(), Some("Sales"));
        assert!(
            cfg.auth.roles.contains_key("support"),
            "support role present"
        );
        assert!(
            !cfg.dashboard.widgets.is_empty(),
            "global dashboard widgets present"
        );
        assert_eq!(cfg.group_label("overview").as_deref(), Some("Overview"));
    }

    /// `variables.hcl` blocks merge globally (like queries), carry their declared
    /// type, and fail load loudly on a contradictory spec.
    #[test]
    fn variables_load_merge_and_validate() {
        let ok = fresh_root("vars");
        std::fs::write(
            ok.join("variables.hcl"),
            "variable \"venue\" {\n  options = [\"A\", \"B\"]\n  default = \"A\"\n}\nvariable \"days\" {\n  type = \"int\"\n  options = [\"7\", \"30\"]\n  default = \"30\"\n}\n",
        )
        .unwrap();
        let cfg = load(Some(&ok)).expect("variables load");
        assert!(cfg.variables.contains_key("venue"));
        assert_eq!(
            cfg.variables["days"].resolved_type(),
            crate::interp::VarType::Int
        );
        let _ = std::fs::remove_dir_all(&ok);

        let both = fresh_root("vars-both");
        std::fs::write(
            both.join("variables.hcl"),
            "variable \"x\" {\n  query = \"SELECT 1\"\n  options = [\"a\"]\n}\n",
        )
        .unwrap();
        let err = load(Some(&both)).expect_err("query+options is contradictory");
        assert!(err.contains("exactly one of"), "{err}");
        let _ = std::fs::remove_dir_all(&both);

        let bad_default = fresh_root("vars-def");
        std::fs::write(
            bad_default.join("variables.hcl"),
            "variable \"x\" {\n  options = [\"a\"]\n  default = \"z\"\n}\n",
        )
        .unwrap();
        let err = load(Some(&bad_default)).expect_err("default outside options errors");
        assert!(err.contains("not in options"), "{err}");
        let _ = std::fs::remove_dir_all(&bad_default);
    }

    /// A `screen.hcl` (folder = slug) is the unified screen file: it loads as a
    /// PAGE when it declares `module`/`panel`, else as a TABLE keyed by the folder.
    #[test]
    fn screen_hcl_dispatches_table_or_page_by_content() {
        let root = fresh_root("screen");
        let bots = root.join("bots");
        std::fs::create_dir_all(&bots).unwrap();
        std::fs::write(bots.join("screen.hcl"), "label = \"Bots\"\n").unwrap();
        let ops = root.join("ops");
        std::fs::create_dir_all(&ops).unwrap();
        std::fs::write(
            ops.join("screen.hcl"),
            "label = \"Ops\"\npanel {\n  type = \"stat\"\n  label = \"X\"\n  sql = \"SELECT 1 AS v\"\n}\n",
        )
        .unwrap();

        let cfg = load(Some(&root)).expect("screens load");
        assert!(
            cfg.tables.contains_key("bots"),
            "table-mode screen keyed by its folder"
        );
        assert!(
            cfg.pages.iter().any(|p| p.slug == "ops"),
            "module screen becomes a page"
        );
        assert!(
            !cfg.tables.contains_key("ops"),
            "a page screen is not a table"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `page.hcl` slug = its folder name; group = the ENCLOSING folder iff that
    /// folder is a group (has `_group.hcl`), else the page is ungrouped.
    #[test]
    fn pages_follow_their_group_order_then_their_own() {
        let root = std::env::temp_dir().join(format!("cartapel-page-order-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let page = |label: &str, order: Option<i64>| {
            let o = order.map(|o| format!("order = {o}\n")).unwrap_or_default();
            format!("label = \"{label}\"\n{o}panel {{\n  type = \"stat\"\n  label = \"X\"\n  sql = \"SELECT 1 AS v\"\n}}\n")
        };
        for (g, order) in [("zeta", 0), ("alpha", 1)] {
            std::fs::create_dir_all(root.join(g)).unwrap();
            std::fs::write(
                root.join(g).join("_group.hcl"),
                format!("label = \"{g}\"\norder = {order}\n"),
            )
            .unwrap();
        }
        std::fs::create_dir_all(root.join("zeta").join("b")).unwrap();
        std::fs::write(
            root.join("zeta").join("b").join("page.hcl"),
            page("Second", Some(1)),
        )
        .unwrap();
        std::fs::create_dir_all(root.join("zeta").join("c")).unwrap();
        std::fs::write(
            root.join("zeta").join("c").join("page.hcl"),
            page("First", Some(0)),
        )
        .unwrap();
        std::fs::create_dir_all(root.join("alpha").join("a")).unwrap();
        std::fs::write(
            root.join("alpha").join("a").join("page.hcl"),
            page("Later group", None),
        )
        .unwrap();

        let cfg = load(Some(&root)).expect("temp admin loads");
        let labels: Vec<&str> = cfg.pages.iter().map(|p| p.label.as_str()).collect();
        assert_eq!(
            labels,
            ["First", "Second", "Later group"],
            "group order beats folder name, page order beats label"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn page_slug_and_group_are_folder_derived() {
        let root = std::env::temp_dir().join(format!("cartapel-page-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let grouped = root.join("foo");
        std::fs::create_dir_all(grouped.join("bar")).unwrap();
        std::fs::write(
            grouped.join("_group.hcl"),
            "label = \"Foo group\"\norder = 3\n",
        )
        .unwrap();
        std::fs::write(
            grouped.join("bar").join("page.hcl"),
            "label = \"Bar\"\npanel {\n  type = \"stat\"\n  label = \"X\"\n  sql = \"SELECT 1 AS v\"\n}\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("baz")).unwrap();
        std::fs::write(
            root.join("baz").join("page.hcl"),
            "label = \"Baz\"\npanel {\n  type = \"stat\"\n  label = \"X\"\n  sql = \"SELECT 1 AS v\"\n}\n",
        )
        .unwrap();

        let cfg = load(Some(&root)).expect("temp admin loads");
        let bar = cfg
            .pages
            .iter()
            .find(|p| p.slug == "bar")
            .expect("bar page");
        assert_eq!(
            bar.group.as_deref(),
            Some("foo"),
            "group = enclosing group folder slug"
        );
        assert_eq!(cfg.group_label("foo").as_deref(), Some("Foo group"));

        let baz = cfg
            .pages
            .iter()
            .find(|p| p.slug == "baz")
            .expect("baz page");
        assert_eq!(
            baz.group, None,
            "page folder directly under root is ungrouped"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A `page.hcl` with `panel {}` blocks is a declarative page: no module, its
    /// widgets and columns loaded; a scripted page keeps its module. A page that
    /// sets BOTH is a loud load error.
    #[test]
    fn declarative_page_is_discovered_and_module_xor_widgets() {
        let root = fresh_root("decl-page");
        let grouped = root.join("overview");
        std::fs::create_dir_all(grouped.join("fleet")).unwrap();
        std::fs::create_dir_all(grouped.join("cache")).unwrap();
        std::fs::write(
            grouped.join("_group.hcl"),
            "label = \"Overview\"\norder = 1\n",
        )
        .unwrap();
        std::fs::write(
            grouped.join("fleet").join("page.hcl"),
            "label = \"Fleet\"\nicon = \"satellite\"\nroles = [\"ops\"]\ncolumns = 4\npanel {\n  type = \"stat\"\n  label = \"Bots\"\n  sql = \"SELECT count(*) AS v FROM bots\"\n}\n",
        )
        .unwrap();
        std::fs::write(
            grouped.join("cache").join("page.hcl"),
            "label = \"Cache\"\npanel {\n  type = \"stat\"\n  label = \"X\"\n  sql = \"SELECT 1 AS v\"\n}\n",
        )
        .unwrap();

        let cfg = load(Some(&root)).expect("temp pages load");
        assert!(
            cfg.dashboard.widgets.is_empty(),
            "global dashboard untouched"
        );
        let fleet = cfg
            .pages
            .iter()
            .find(|p| p.slug == "fleet")
            .expect("fleet page");
        assert_eq!(fleet.id(), "overview/fleet");
        assert_eq!(fleet.group.as_deref(), Some("overview"));
        assert_eq!(fleet.roles, vec!["ops"]);
        assert!(!fleet.widgets.is_empty(), "a page is its panels");
        assert_eq!(fleet.columns, Some(4));
        assert_eq!(fleet.widgets.len(), 1);
        let cache = cfg
            .pages
            .iter()
            .find(|p| p.slug == "cache")
            .expect("cache page");
        assert!(!cache.widgets.is_empty());

        std::fs::write(
            grouped.join("fleet").join("page.hcl"),
            "label = \"Both\"\nmodule = \"x.tsx\"\n",
        )
        .unwrap();
        assert!(
            load(Some(&root)).is_err(),
            "module + widgets together is a load error"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    fn fresh_root(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("cartapel-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// Two table-config files that resolve to the same table identity (bare stem
    /// `bots` in two different folders) are a loud load error, not a silent
    /// last-wins clobber.
    #[test]
    fn duplicate_table_binding_is_a_loud_error() {
        let root = fresh_root("dup-table");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(root.join("a").join("bots.hcl"), "label = \"A\"\n").unwrap();
        std::fs::write(root.join("b").join("bots.hcl"), "label = \"B\"\n").unwrap();

        let err = load(Some(&root)).expect_err("duplicate table identity must error");
        assert!(err.contains("duplicate table config for \"bots\""), "{err}");
        assert!(
            err.contains("a/bots.hcl") && err.contains("b/bots.hcl"),
            "names both paths: {err}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A table's `from { source }` must name a defined postgres source. A typo (or
    /// an http source) is a loud load error — never a silent fall-back to primary,
    /// which would read the wrong database.
    #[test]
    fn table_from_source_must_be_a_defined_postgres_source() {
        let base = |tag| {
            let root = fresh_root(tag);
            std::fs::create_dir_all(root.join("config")).unwrap();
            std::fs::write(
                root.join("config").join("cartapel.hcl"),
                "source \"main\" {\n  type = \"postgres\"\n  url = \"env:X\"\n  primary = true\n}\nsource \"metrics\" {\n  type = \"http\"\n  url = \"http://x\"\n}\n",
            )
            .unwrap();
            root
        };

        let unknown = base("from-unknown");
        std::fs::write(unknown.join("bots.hcl"), "from { source = \"ghost\" }\n").unwrap();
        let err = load(Some(&unknown)).expect_err("unknown source errors");
        assert!(
            err.contains("bots") && err.contains("ghost") && err.contains("not a defined source"),
            "{err}"
        );
        let _ = std::fs::remove_dir_all(&unknown);

        let http = base("from-http");
        std::fs::write(http.join("bots.hcl"), "from { source = \"metrics\" }\n").unwrap();
        let err = load(Some(&http)).expect_err("http source errors");
        assert!(err.contains("not a database source"), "{err}");
        let _ = std::fs::remove_dir_all(&http);

        let ok = base("from-ok");
        std::fs::write(
            ok.join("bots.hcl"),
            "from {\n  source = \"main\"\n  schema = \"markets\"\n  table = \"bots\"\n}\n",
        )
        .unwrap();
        let cfg = load(Some(&ok)).expect("valid from loads");
        let from = &cfg.tables.get("bots").expect("bots table").from;
        assert_eq!(from.source.as_deref(), Some("main"));
        assert_eq!(from.schema.as_deref(), Some("markets"));
        assert_eq!(from.table.as_deref(), Some("bots"));
        let _ = std::fs::remove_dir_all(&ok);
    }

    /// The reserved `config` folder loads the three globals by bare stem, and holds
    /// nothing else: a stray `.hcl` directly inside it is a loud misplaced error,
    /// never a silently-loaded bogus table.
    #[test]
    fn base_folder_loads_globals_and_rejects_strays() {
        let root = fresh_root("base-folder");
        let base = root.join("config");
        std::fs::create_dir_all(base.join("widgets")).unwrap();
        std::fs::write(base.join("cartapel.hcl"), "brand = \"Acme\"\n").unwrap();
        std::fs::write(base.join("auth.hcl"), "role \"ops\" {}\n").unwrap();
        std::fs::write(
            base.join("dashboard.hcl"),
            "panel {\n  type  = \"stat\"\n  label = \"X\"\n  sql   = \"SELECT 1 AS v\"\n}\n",
        )
        .unwrap();
        std::fs::write(
            base.join("widgets").join("minibar.js"),
            "export const m = 1;",
        )
        .unwrap();

        let cfg = load(Some(&root)).expect("globals load from config");
        assert_eq!(cfg.cartapel.brand.as_deref(), Some("Acme"));
        assert!(cfg.auth.roles.contains_key("ops"));
        assert_eq!(cfg.dashboard.widgets.len(), 1);
        assert!(
            !cfg.tables.contains_key("cartapel"),
            "config globals are never tables"
        );
        assert!(cfg.groups.is_empty(), "config is never a sidebar group");

        std::fs::write(base.join("stray.hcl"), "label = \"Nope\"\n").unwrap();
        let err = load(Some(&root)).expect_err("a stray .hcl in config must error");
        assert!(
            err.contains("misplaced config in reserved config folder"),
            "{err}"
        );
        assert!(err.contains("stray.hcl"), "{err}");
        std::fs::remove_file(base.join("stray.hcl")).unwrap();

        std::fs::write(
            base.join("queries.hcl"),
            "query \"x\" { sql = \"SELECT 1\" }\n",
        )
        .unwrap();
        let err = load(Some(&root)).expect_err("config/queries.hcl must error");
        assert!(
            err.contains("misplaced config in reserved config folder"),
            "{err}"
        );
        assert!(err.contains("queries.hcl"), "{err}");
        std::fs::remove_file(base.join("queries.hcl")).unwrap();

        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("sub").join("page.hcl"), "label = \"Nope\"\n").unwrap();
        let err = load(Some(&root)).expect_err("config/sub/page.hcl must error");
        assert!(
            err.contains("misplaced config in reserved config folder"),
            "{err}"
        );
        assert!(err.contains("page.hcl"), "{err}");
        std::fs::remove_file(base.join("sub").join("page.hcl")).unwrap();

        std::fs::write(
            base.join("widgets").join("_group.hcl"),
            "label = \"Nope\"\n",
        )
        .unwrap();
        let err = load(Some(&root)).expect_err("config/widgets/_group.hcl must error");
        assert!(
            err.contains("misplaced config in reserved config folder"),
            "{err}"
        );
        assert!(err.contains("_group.hcl"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A `_group.hcl` dropped into `config` never turns the reserved folder into a
    /// sidebar group — anything but the three globals under `config` is a loud error.
    #[test]
    fn base_folder_cannot_become_a_group() {
        let root = fresh_root("base-not-group");
        let base = root.join("config");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("_group.hcl"), "label = \"Nope\"\n").unwrap();

        let err = load(Some(&root)).expect_err("config/_group.hcl must error");
        assert!(
            err.contains("misplaced config in reserved config folder"),
            "{err}"
        );
        assert!(err.contains("_group.hcl"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Two pages that resolve to the same group-qualified id (same group-folder
    /// name + same page-folder name, at different depths) are a loud load error. A
    /// same-id collision is also a same-slug collision, so the slug guard (which
    /// fires first) catches it — the qualified-id guard stays as belt-and-suspenders.
    #[test]
    fn duplicate_group_slug_is_a_loud_error() {
        let root = fresh_root("dup-page");
        let a = root.join("grp");
        std::fs::create_dir_all(a.join("ops")).unwrap();
        std::fs::write(a.join("_group.hcl"), "label = \"Grp A\"\n").unwrap();
        std::fs::write(
            a.join("ops").join("page.hcl"),
            "label = \"A\"\npanel {\n  type = \"stat\"\n  label = \"X\"\n  sql = \"SELECT 1 AS v\"\n}\n",
        )
        .unwrap();

        let b = root.join("outer").join("grp");
        std::fs::create_dir_all(b.join("ops")).unwrap();
        std::fs::write(b.join("_group.hcl"), "label = \"Grp B\"\n").unwrap();
        std::fs::write(
            b.join("ops").join("page.hcl"),
            "label = \"B\"\npanel {\n  type = \"stat\"\n  label = \"X\"\n  sql = \"SELECT 1 AS v\"\n}\n",
        )
        .unwrap();

        // Two groups sharing a slug is itself a loud error now (it forked the
        // sidebar) and fires before the page-id collision it used to cause.
        let err = load(Some(&root)).expect_err("duplicate group slug must error");
        assert!(err.contains("duplicate group \"grp\""), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Two pages sharing the same leaf slug in DIFFERENT groups both map to the
    /// same global custom-element tag `sx-page-<slug>`, so the second would fail to
    /// `define`. The loader rejects them loudly, naming both paths.
    #[test]
    fn duplicate_page_slug_across_groups_is_a_loud_error() {
        let root = fresh_root("dup-slug");
        let a = root.join("overview");
        std::fs::create_dir_all(a.join("ops")).unwrap();
        std::fs::write(a.join("_group.hcl"), "label = \"Overview\"\n").unwrap();
        std::fs::write(
            a.join("ops").join("page.hcl"),
            "label = \"A\"\npanel {\n  type = \"stat\"\n  label = \"X\"\n  sql = \"SELECT 1 AS v\"\n}\n",
        )
        .unwrap();

        let b = root.join("other");
        std::fs::create_dir_all(b.join("ops")).unwrap();
        std::fs::write(b.join("_group.hcl"), "label = \"Other\"\n").unwrap();
        std::fs::write(
            b.join("ops").join("page.hcl"),
            "label = \"B\"\npanel {\n  type = \"stat\"\n  label = \"X\"\n  sql = \"SELECT 1 AS v\"\n}\n",
        )
        .unwrap();

        let err = load(Some(&root)).expect_err("duplicate page slug must error");
        assert!(err.contains("duplicate page slug \"ops\""), "{err}");
        assert!(
            err.contains("overview/ops/page.hcl") && err.contains("other/ops/page.hcl"),
            "names both paths: {err}",
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A symlinked directory inside the config dir is NOT traversed on load, so an
    /// out-of-tree `.hcl` never becomes a tracked (writable) table source.
    #[test]
    #[cfg(unix)]
    fn symlinked_directory_is_not_followed() {
        let root = fresh_root("symlink");
        let outside = fresh_root("symlink-outside");
        std::fs::write(outside.join("evil.hcl"), "label = \"Evil\"\n").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        std::fs::write(root.join("safe.hcl"), "label = \"Safe\"\n").unwrap();

        let cfg = load(Some(&root)).expect("load ignores the symlink");
        assert!(cfg.tables.contains_key("safe"), "real files still load");
        assert!(
            !cfg.tables.contains_key("evil"),
            "symlinked-out file is not traversed"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// A `queries.hcl` in any folder is parsed and merged into the global query
    /// registry, and is never mistaken for a table config.
    #[test]
    fn queries_hcl_in_a_folder_is_loaded_into_the_registry() {
        let root = fresh_root("queries");
        let ops = root.join("overview").join("ops");
        std::fs::create_dir_all(&ops).unwrap();
        std::fs::write(
            root.join("overview").join("_group.hcl"),
            "label = \"Overview\"\n",
        )
        .unwrap();
        std::fs::write(
            ops.join("queries.hcl"),
            "query \"ops_fleet\" {\n  sql   = \"SELECT 1\"\n  roles = [\"ops\"]\n}\n",
        )
        .unwrap();

        let cfg = load(Some(&root)).expect("load");
        assert!(
            cfg.queries.contains_key("ops_fleet"),
            "query merged into registry"
        );
        assert_eq!(cfg.queries["ops_fleet"].roles, vec!["ops"]);
        assert!(
            !cfg.tables.contains_key("queries"),
            "queries.hcl is not a table config"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The same query name in two `queries.hcl` files is a loud load error naming
    /// both paths, not a silent last-wins merge.
    #[test]
    fn duplicate_query_name_across_files_is_a_loud_error() {
        let root = fresh_root("dup-query");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(
            root.join("a").join("queries.hcl"),
            "query \"ops_fleet\" { sql = \"SELECT 1\" }\n",
        )
        .unwrap();
        std::fs::write(
            root.join("b").join("queries.hcl"),
            "query \"ops_fleet\" { sql = \"SELECT 2\" }\n",
        )
        .unwrap();

        let err = load(Some(&root)).expect_err("duplicate query name must error");
        assert!(err.contains("duplicate query \"ops_fleet\""), "{err}");
        assert!(
            err.contains("a/queries.hcl") && err.contains("b/queries.hcl"),
            "names both paths: {err}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `module` is gone: a page is its panels. A bundle carrying the old key
    /// must fail loudly, naming what replaces it, rather than rendering blank.
    #[test]
    fn a_page_with_module_is_a_loud_load_error() {
        let root = fresh_root("page-module-gone");
        let ops = root.join("overview").join("ops");
        std::fs::create_dir_all(&ops).unwrap();
        std::fs::write(
            root.join("overview").join("_group.hcl"),
            "label = \"Overview\"\n",
        )
        .unwrap();
        std::fs::write(
            ops.join("screen.hcl"),
            "label = \"Operations\"\nmodule = \"ops.tsx\"\n",
        )
        .unwrap();
        let err = load(Some(&root)).expect_err("module must be refused");
        assert!(err.contains("`module` is gone"), "{err}");
        assert!(
            err.contains("panel"),
            "the error names the replacement: {err}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A page with neither panels nor module is not a blank scripted page.
    #[test]
    fn a_page_needs_panels() {
        let root = fresh_root("page-empty");
        let ops = root.join("overview").join("ops");
        std::fs::create_dir_all(&ops).unwrap();
        std::fs::write(
            root.join("overview").join("_group.hcl"),
            "label = \"Overview\"\n",
        )
        .unwrap();
        std::fs::write(ops.join("page.hcl"), "label = \"Operations\"\n").unwrap();
        let err = load(Some(&root)).expect_err("an empty page must be refused");
        assert!(err.contains("at least one"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
