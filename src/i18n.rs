//! Author-text localization: the labels a config *writes* (group, table, field,
//! page and panel names, section titles…) rendered in the viewer's language.
//!
//! Two layers, cheapest first: an inline `labels = { es = "…" }` on the block
//! wins; otherwise the locale's dictionary in `config/i18n/<locale>.hcl` maps
//! the base text to a translation (`"Billing" = "Facturación"`); otherwise the
//! base text. One dictionary per language, keyed by the text itself, so a
//! config is written once and translated in one file — and anything not yet
//! translated reads as written, never as a blank or a key.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::config::ConfigDir;

/// The language a response renders author text in, with that language's
/// dictionary. Built once per request from the `X-Cartapel-Locale` header and
/// the instance default; `Default` is "no locale": every base text as written.
#[derive(Clone, Debug, Default)]
pub struct Loc {
    tag: Option<String>,
    dict: Option<Arc<BTreeMap<String, String>>>,
}

impl Loc {
    pub fn new(tag: Option<String>, cfg: &ConfigDir) -> Self {
        let dict = tag.as_deref().and_then(|t| cfg.i18n.get(t).cloned());
        Loc { tag, dict }
    }

    /// The instance default, for code paths with no request in hand.
    pub fn instance(cfg: &ConfigDir) -> Self {
        Self::new(cfg.cartapel.locale.clone(), cfg)
    }

    /// The viewer's header when it looks like a language tag, else the
    /// instance default.
    pub fn for_request(headers: &axum::http::HeaderMap, state: &crate::state::AppState) -> Self {
        let cfg = state.cfg();
        Self::new(
            header_locale(headers).or_else(|| cfg.cartapel.locale.clone()),
            &cfg,
        )
    }

    #[cfg(test)]
    pub fn only(tag: &str) -> Self {
        Loc {
            tag: Some(tag.into()),
            dict: None,
        }
    }

    #[cfg(test)]
    pub fn with_dict(tag: &str, dict: BTreeMap<String, String>) -> Self {
        Loc {
            tag: Some(tag.into()),
            dict: Some(Arc::new(dict)),
        }
    }

    pub fn tag(&self) -> Option<&str> {
        self.tag.as_deref()
    }

    /// `base` through the dictionary, or as written.
    pub fn t(&self, base: String) -> String {
        self.dict
            .as_ref()
            .and_then(|d| d.get(&base).cloned())
            .unwrap_or(base)
    }

    /// The block's own `labels[locale]`, else `base` through the dictionary.
    pub fn pick(&self, labels: &BTreeMap<String, String>, base: String) -> String {
        self.tag
            .as_deref()
            .and_then(|t| labels.get(t).cloned())
            .unwrap_or_else(|| self.t(base))
    }
}

/// The viewer's pick from the `X-Cartapel-Locale` header, when it looks like a
/// language tag. A header the frontend never sets means "instance default".
pub fn header_locale(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get("x-cartapel-locale")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 16
                && v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
        .map(str::to_owned)
}

/// One `config/i18n/<locale>.hcl`: a single `labels = { "base" = "translation" }`
/// map. An empty translation is "not translated yet" — `cartapel i18n extract`
/// writes those as stubs — and is dropped so the base text shows.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DictionaryFile {
    #[serde(default)]
    labels: BTreeMap<String, String>,
}

pub fn parse_dictionary(raw: &str) -> Result<BTreeMap<String, String>, hcl::Error> {
    let file: DictionaryFile = hcl::from_str(raw)?;
    Ok(file
        .labels
        .into_iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .collect())
}

/// Every piece of author text the panel can render, in config order, each
/// once: what a translator has to cover. With a live schema, the column names
/// the panel humanizes for tables that give them no `label` are included too.
pub fn author_strings(cfg: &ConfigDir, schema: Option<&crate::introspect::Schema>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut push = |s: String| {
        if !s.trim().is_empty() && seen.insert(s.clone()) {
            out.push(s);
        }
    };
    for g in &cfg.groups {
        push(g.label.clone());
    }
    push("Ungrouped".into());
    for (name, tc) in &cfg.tables {
        push(
            tc.label
                .clone()
                .unwrap_or_else(|| crate::meta::humanize(name)),
        );
        push(
            tc.label_plural
                .clone()
                .unwrap_or_else(|| crate::meta::capitalize(&crate::meta::humanize(name))),
        );
        let dbt = schema.and_then(|s| {
            s.find(
                tc.from.schema.as_deref(),
                tc.from.table.as_deref().unwrap_or(name),
            )
        });
        if let Some(dbt) = dbt {
            for c in &dbt.columns {
                push(
                    tc.fields
                        .get(&c.name)
                        .and_then(|f| f.label.clone())
                        .unwrap_or_else(|| crate::meta::humanize(&c.name)),
                );
            }
        }
        for (col, f) in &tc.fields {
            push(
                f.label
                    .clone()
                    .unwrap_or_else(|| crate::meta::humanize(col)),
            );
        }
        for def in tc.list.filter_defs.values() {
            push(def.label.clone());
        }
        for a in tc.actions.values() {
            push(a.label.clone());
        }
        for s in &tc.detail.sections {
            push(s.title.clone());
        }
        for spec in &tc.relations.inlines {
            if let crate::config::InlineSpec::Full { label: Some(l), .. } = spec {
                push(l.clone());
            }
        }
    }
    let mut panels: Vec<&crate::config::PanelConfig> = cfg.dashboard.widgets.iter().collect();
    for p in &cfg.pages {
        push(p.label.clone());
        panels.extend(p.widgets.iter());
    }
    for w in panels {
        push(w.label.clone());
        if let Some(c) = &w.compare_label {
            push(c.clone());
        }
        for c in &w.columns {
            if let Some(l) = &c.label {
                push(l.clone());
            }
        }
    }
    for (name, v) in &cfg.variables {
        push(v.label.clone().unwrap_or_else(|| name.clone()));
    }
    out
}

fn hcl_quote(s: &str) -> String {
    let mut q = String::with_capacity(s.len() + 2);
    q.push('"');
    for ch in s.chars() {
        match ch {
            '"' => q.push_str("\\\""),
            '\\' => q.push_str("\\\\"),
            '\n' => q.push_str("\\n"),
            '$' => q.push_str("$${"),
            _ => q.push(ch),
        }
    }
    q.push('"');
    // `$${` is how HCL escapes a template start; a lone `$` needs nothing, so
    // undo the escape where no `{` follows.
    q.replace("$${", "$").replace("${", "$${")
}

/// The `config/i18n/<locale>.hcl` stub for everything `locale` has not
/// translated yet: one `"base" = ""` line per missing text, in config order.
pub fn extract(
    cfg: &ConfigDir,
    schema: Option<&crate::introspect::Schema>,
    locale: &str,
) -> (String, usize, usize) {
    let have = cfg.i18n.get(locale);
    let all = author_strings(cfg, schema);
    let missing: Vec<&String> = all
        .iter()
        .filter(|s| !have.is_some_and(|d| d.contains_key(*s)))
        .collect();
    let mut out = String::new();
    out.push_str(&format!(
        "# {locale}: {} of {} author strings still untranslated. Fill the right-hand\n# side; an empty value keeps the original text. Save as config/i18n/{locale}.hcl\n# (merge into the existing file's `labels` map if there is one).\nlabels = {{\n",
        missing.len(),
        all.len()
    ));
    for s in &missing {
        out.push_str(&format!("  {} = \"\"\n", hcl_quote(s)));
    }
    out.push_str("}\n");
    (out, missing.len(), all.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    /// A language tag is taken as sent; anything else — missing, empty, or not
    /// tag-shaped — is ignored, so the instance default applies.
    #[test]
    fn header_is_a_language_tag_or_nothing() {
        let mut h = HeaderMap::new();
        assert_eq!(header_locale(&h), None);
        h.insert("x-cartapel-locale", "en".parse().unwrap());
        assert_eq!(header_locale(&h).as_deref(), Some("en"));
        h.insert("x-cartapel-locale", " pt-BR ".parse().unwrap());
        assert_eq!(header_locale(&h).as_deref(), Some("pt-BR"));
        h.insert("x-cartapel-locale", "en; drop table".parse().unwrap());
        assert_eq!(header_locale(&h), None);
        h.insert("x-cartapel-locale", "".parse().unwrap());
        assert_eq!(header_locale(&h), None);
        h.insert(
            "x-cartapel-locale",
            "a-very-long-tag-nobody-uses".parse().unwrap(),
        );
        assert_eq!(header_locale(&h), None);
    }

    /// Inline `labels` beat the dictionary, the dictionary beats the base text,
    /// and a locale nobody translated reads as written.
    #[test]
    fn pick_prefers_inline_then_dictionary_then_base() {
        let dict = BTreeMap::from([
            ("Customer".to_string(), "Cliente".to_string()),
            ("Billing".to_string(), "Facturación".to_string()),
        ]);
        let es = Loc::with_dict("es", dict);
        let inline = BTreeMap::from([("es".to_string(), "Comprador".to_string())]);
        assert_eq!(es.pick(&inline, "Customer".into()), "Comprador");
        assert_eq!(es.pick(&BTreeMap::new(), "Customer".into()), "Cliente");
        assert_eq!(es.t("Billing".into()), "Facturación");
        assert_eq!(es.t("Orders".into()), "Orders");
        let fr = Loc::only("fr");
        assert_eq!(fr.pick(&inline, "Customer".into()), "Customer");
        assert_eq!(Loc::default().pick(&inline, "Customer".into()), "Customer");
    }

    #[test]
    fn dictionary_drops_empty_translations() {
        let d = parse_dictionary(
            "labels = {\n  \"Billing\" = \"Facturación\"\n  \"Orders\" = \"\"\n}\n",
        )
        .unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d["Billing"], "Facturación");
    }

    #[test]
    fn extract_lists_what_is_missing_in_config_order() {
        let mut cfg = ConfigDir::default();
        cfg.groups.push(crate::config::LoadedGroup {
            slug: "sales".into(),
            label: "Sales".into(),
            labels: Default::default(),
            icon: None,
            order: 0,
            table_order: vec![],
            nav: None,
        });
        let tc = crate::config::TableConfig {
            label: Some("order".into()),
            label_plural: Some("Orders".into()),
            ..Default::default()
        };
        cfg.tables.insert("orders".into(), tc);
        cfg.i18n.insert(
            "es".into(),
            Arc::new(BTreeMap::from([(
                "Orders".to_string(),
                "Pedidos".to_string(),
            )])),
        );
        let (out, missing, all) = extract(&cfg, None, "es");
        assert_eq!((missing, all), (3, 4));
        let lines: Vec<&str> = out
            .lines()
            .filter(|l| l.starts_with("  "))
            .map(str::trim)
            .collect();
        assert_eq!(
            lines,
            vec![
                "\"Sales\" = \"\"",
                "\"Ungrouped\" = \"\"",
                "\"order\" = \"\""
            ]
        );
        let reparsed = parse_dictionary(&out).unwrap();
        assert!(
            reparsed.is_empty(),
            "stubs are empty, so they translate nothing yet"
        );
    }

    #[test]
    fn quoting_survives_the_round_trip() {
        let text = "Say \"hi\" to ${user} \\ friends";
        let out = format!("labels = {{ {} = {} }}\n", hcl_quote(text), hcl_quote(text));
        let d = parse_dictionary(&out).unwrap();
        assert_eq!(d.get(text).map(String::as_str), Some(text));
    }
}
