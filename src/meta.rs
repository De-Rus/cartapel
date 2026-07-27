use crate::config::{InlineSpec, TableConfig};
use crate::introspect::{DbColumn, DbTable, Kind};
use crate::sqlval::ident;
use crate::state::{AppError, AppState, CurrentUser};
use axum::extract::State;
use axum::Json;
use futures::future::Either;
use serde_json::{json, Value};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

const OPTIONS_TTL: Duration = Duration::from_secs(1800);
const OPTIONS_LIMIT: usize = 30;

/// Cap on concurrent `enum_options` DISTINCT-value queries. The shared Supabase
/// session pooler has a small client cap contended with other apps; an unbounded
/// burst on the first `/meta` load starves it. Gate every enum query here so at
/// most this many touch the pool at once.
pub const ENUM_OPTIONS_CONCURRENCY: usize = 4;
static ENUM_OPTIONS_GATE: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(ENUM_OPTIONS_CONCURRENCY));

/// The effective (owned) config for a table — its `{table}.hcl` merged onto
/// defaults, or plain defaults when unconfigured. Owned because the underlying
/// config is hot-swappable; callers pass `&cfg` where a reference is needed.
pub fn table_config(state: &AppState, table: &str) -> TableConfig {
    state.cfg().tables.get(table).cloned().unwrap_or_default()
}

/// Deployment-locale label resolution: `labels[locale]` wins, else the base
/// label. Emission-time so the frontend needs no locale logic for data labels.
pub fn localize(
    state: &AppState,
    labels: &std::collections::BTreeMap<String, String>,
    base: String,
) -> String {
    state
        .cfg()
        .cartapel
        .locale
        .as_deref()
        .and_then(|l| labels.get(l).cloned())
        .unwrap_or(base)
}

pub fn humanize(name: &str) -> String {
    name.replace('_', " ")
}

pub fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

pub fn default_widget(col: &DbColumn) -> &'static str {
    if col.fk.is_some() {
        return "fk";
    }
    match col.kind {
        Kind::Text => "text",
        Kind::Int | Kind::Float => "number",
        Kind::Bool => "toggle",
        Kind::Datetime | Kind::Date => "datetime",
        Kind::Uuid => "uuid",
        Kind::Json => "json",
        Kind::Array => "array",
        Kind::Binary => "binary",
    }
}

/// Default record title: a name-ish text column ("Ada Lovelace", never "1")
/// when one exists; otherwise the pk — a random first text column (status,
/// country…) makes a worse title than the id.
fn default_display_title(dbt: &DbTable, label: &str) -> String {
    for pref in [
        "name",
        "title",
        "full_name",
        "display_name",
        "subject",
        "symbol",
        "email",
        "username",
        "slug",
        "label",
    ] {
        if dbt
            .columns
            .iter()
            .any(|c| c.name == pref && c.kind == Kind::Text)
        {
            return format!("{{{pref}}}");
        }
    }
    // No name-ish column: "Subscription #8" reads as a record, a bare "8" doesn't.
    match &dbt.pk {
        Some(pk) => format!("{} #{{{pk}}}", capitalize(label)),
        None => format!("{{{}}}", dbt.columns[0].name),
    }
}

pub fn fk_label_col(child: &DbTable) -> String {
    for pref in ["name", "title", "symbol", "email", "label"] {
        if child
            .columns
            .iter()
            .any(|c| c.name == pref && c.kind == Kind::Text)
        {
            return pref.to_string();
        }
    }
    child
        .columns
        .iter()
        .find(|c| c.kind == Kind::Text)
        .map(|c| c.name.clone())
        .or_else(|| child.pk.clone())
        .unwrap_or_else(|| child.columns[0].name.clone())
}

/// The drill-through target for a column: an introspected forward FK, or a config
/// `relation`/`fk` field carrying an explicit `target` (config wins). Emitted ONLY
/// when the target table is exposed (configured) AND viewable by this user — so a
/// cell never links somewhere the user can't reach. `ref_column` defaults to the
/// target's primary key, then to `id`.
fn relation_target(
    state: &AppState,
    user: &CurrentUser,
    fk: Option<&(String, String)>,
    fc: Option<&crate::config::FieldConfig>,
) -> Option<(String, String)> {
    let (ref_table, ref_column) = fc
        .and_then(|f| f.params.get("target"))
        .and_then(|t| t.as_str())
        .map(|t| {
            let col = fc
                .and_then(|f| f.params.get("target_column"))
                .and_then(|c| c.as_str())
                .map(String::from)
                .or_else(|| state.resolve_table(t).and_then(|dbt| dbt.pk.clone()))
                .unwrap_or_else(|| "id".into());
            (t.to_string(), col)
        })
        .or_else(|| fk.map(|(t, c)| (t.clone(), c.clone())))?;
    if !state.cfg().tables.contains_key(&ref_table) {
        return None;
    }
    if !state.table_perms(user, &ref_table).view {
        return None;
    }
    Some((ref_table, ref_column))
}

/// Virtual (computed) columns: config fields carrying a `sql` expression whose
/// name is NOT a real column. The expression is trusted (repo-controlled config).
pub fn computed_columns<'a>(dbt: &DbTable, cfg: &'a TableConfig) -> Vec<(&'a String, &'a String)> {
    cfg.fields
        .iter()
        .filter_map(|(name, f)| f.sql.as_ref().map(|sql| (name, sql)))
        .filter(|(name, _)| dbt.column(name).is_none())
        .collect()
}

fn is_listable_column(dbt: &DbTable, cfg: &TableConfig, name: &str) -> bool {
    dbt.column(name).is_some() || cfg.fields.get(name).is_some_and(|f| f.sql.is_some())
}

/// The row-producing SELECT list, one aliased item per column plus computed
/// fields — replaces `to_jsonb(t.*)`. Rows come back typed and are materialized
/// to JSON by the dialect decoder; binary columns travel as their length only.
pub fn select_items_for(
    dbt: &DbTable,
    cfg: &TableConfig,
    dialect: crate::db::Dialect,
) -> Vec<String> {
    let item = match dialect {
        crate::db::Dialect::Pg => column_item,
        crate::db::Dialect::MySql | crate::db::Dialect::ClickHouse => column_item_mysql,
    };
    let mut out: Vec<String> = dbt.columns.iter().map(item).collect();
    for (name, sql) in computed_columns(dbt, cfg) {
        match dialect {
            crate::db::Dialect::Pg => out.push(format!("to_jsonb(({sql})) AS {}", ident(name))),
            crate::db::Dialect::MySql | crate::db::Dialect::ClickHouse => {
                out.push(format!("({sql}) AS {}", ident(name)))
            }
        }
    }
    out
}

fn column_item_mysql(c: &DbColumn) -> String {
    let id = ident(&c.name);
    match c.kind {
        Kind::Binary => format!("length(t.{id}) AS {id}"),
        _ => format!("t.{id}"),
    }
}

/// Native selection only where the Rust decode is provably byte-identical to
/// `to_jsonb`; every other type rides per-column `to_jsonb` so infinity
/// timestamps, NaN floats, composites, session-timezone rendering and json
/// normalization keep the exact old semantics by construction.
fn column_item(c: &DbColumn) -> String {
    let id = ident(&c.name);
    match c.kind {
        Kind::Binary => format!("length(t.{id}) AS {id}"),
        Kind::Int | Kind::Bool | Kind::Uuid => format!("t.{id}"),
        Kind::Json if c.udt == "jsonb" => format!("t.{id}"),
        Kind::Text
            if matches!(
                c.udt.as_str(),
                "text" | "varchar" | "bpchar" | "name" | "citext"
            ) =>
        {
            format!("t.{id}")
        }
        _ => format!("to_jsonb(t.{id}) AS {id}"),
    }
}

pub fn list_columns(dbt: &DbTable, cfg: &TableConfig) -> Vec<String> {
    if !cfg.list.columns.is_empty() {
        return cfg
            .list
            .columns
            .iter()
            .filter(|c| is_listable_column(dbt, cfg, c))
            .cloned()
            .collect();
    }
    let mut out: Vec<String> = Vec::new();
    if let Some(pk) = &dbt.pk {
        out.push(pk.clone());
    }
    for c in &dbt.columns {
        if out.len() >= 6 {
            break;
        }
        if Some(&c.name) == dbt.pk.as_ref() {
            continue;
        }
        if matches!(c.kind, Kind::Json | Kind::Binary) {
            continue;
        }
        out.push(c.name.clone());
    }
    out
}

pub fn search_columns(dbt: &DbTable, cfg: &TableConfig) -> Vec<String> {
    if !cfg.list.search.is_empty() {
        return cfg
            .list
            .search
            .iter()
            .filter(|c| dbt.column(c).is_some())
            .cloned()
            .collect();
    }
    dbt.columns
        .iter()
        .filter(|c| c.kind == Kind::Text)
        .take(4)
        .map(|c| c.name.clone())
        .collect()
}

pub fn default_sort(dbt: &DbTable, cfg: &TableConfig) -> String {
    if let Some(s) = &cfg.list.sort {
        return s.clone();
    }
    match &dbt.pk {
        Some(pk) => format!("-{pk}"),
        None => dbt.columns[0].name.clone(),
    }
}

async fn enum_options(state: &AppState, user: &CurrentUser, table: &str, col: &str) -> Value {
    let row_filter = state.row_filter(user, table);
    let key = (table.to_string(), col.to_string(), row_filter.clone());
    if let Some((at, v)) = state.options_cache.lock().unwrap().get(&key) {
        if at.elapsed() < OPTIONS_TTL {
            return v.clone();
        }
    }
    let where_sql = match &row_filter {
        Some(rf) => format!("WHERE ({rf})"),
        None => String::new(),
    };
    let pool = state.pool_for_table(table);
    let sql = format!(
        "SELECT {} AS v, count(*) AS n FROM {} {where_sql} GROUP BY 1 ORDER BY n DESC LIMIT {}",
        crate::sqlval::text_cast(pool.dialect(), &crate::sqlval::ident(col)),
        state.qualified_table(table),
        OPTIONS_LIMIT
    );
    let result = async {
        let _permit = ENUM_OPTIONS_GATE.acquire().await.ok()?;
        let binds = crate::sqlval::Binds::for_dialect(pool.dialect());
        let rows = crate::db::read_only_json_rows(pool, &sql, &binds, 4000)
            .await
            .ok()?;
        Some(
            rows.into_iter()
                .filter_map(|r| {
                    let v = r.get("v")?.as_str()?.to_string();
                    let n = r.get("n").and_then(Value::as_i64).unwrap_or(0);
                    Some(json!({ "value": v, "label": v, "count": n }))
                })
                .collect::<Vec<_>>(),
        )
    }
    .await;
    let value = Value::Array(result.unwrap_or_default());
    state
        .options_cache
        .lock()
        .unwrap()
        .insert(key, (Instant::now(), value.clone()));
    value
}

async fn filter_meta(
    state: &AppState,
    user: &CurrentUser,
    key: &str,
    dbt: &DbTable,
    cfg: &TableConfig,
) -> Vec<Value> {
    let masked = state.masked_columns(user, key);
    let entry_futs = cfg.list.filters.iter().filter_map(|name| {
        if let Some(def) = cfg.list.filter_defs.get(name) {
            let v = json!({ "name": name, "label": def.label, "type": "custom", "options": [] });
            return Some(Either::Left(std::future::ready(Some(v))));
        }
        if masked.contains(name) {
            return None;
        }
        let col = dbt.column(name)?;
        let fc = cfg.fields.get(name);
        let label = localize(
            state,
            fc.map(|f| &f.labels).unwrap_or(&Default::default()),
            fc.and_then(|f| f.label.clone())
                .unwrap_or_else(|| capitalize(&humanize(name))),
        );
        let ops = filter_ops(col.kind);
        match col.kind {
            Kind::Bool => Some(Either::Left(std::future::ready(Some(
                json!({ "name": name, "label": label, "type": "bool", "ops": ops, "options": [] }),
            )))),
            Kind::Datetime | Kind::Date => Some(Either::Left(std::future::ready(Some(
                json!({ "name": name, "label": label, "type": "date", "ops": ops, "options": [] }),
            )))),
            Kind::Text | Kind::Int | Kind::Uuid => Some(Either::Right(async move {
                let options = enum_options(state, user, key, name).await;
                Some(json!({ "name": name, "label": label, "type": "enum", "ops": ops, "options": options }))
            })),
            _ => Some(Either::Left(std::future::ready(Some(
                json!({ "name": name, "label": label, "type": "value", "ops": ops, "options": [] }),
            )))),
        }
    });
    futures::future::join_all(entry_futs)
        .await
        .into_iter()
        .flatten()
        .collect()
}

/// Detail form sections. Empty when nothing is configured (frontend renders flat).
fn detail_sections(dbt: &DbTable, cfg: &TableConfig) -> Vec<Value> {
    let all: Vec<String> = dbt
        .columns
        .iter()
        .map(|c| c.name.clone())
        .chain(
            computed_columns(dbt, cfg)
                .into_iter()
                .map(|(n, _)| n.clone()),
        )
        .collect();
    let known = |f: &String| all.contains(f);

    struct Sec {
        title: String,
        fields: Vec<String>,
        span: Option<u8>,
        collapsible: bool,
    }
    let mut sections: Vec<Sec> = Vec::new();
    for s in &cfg.detail.sections {
        let fields: Vec<String> = s.fields.iter().filter(|f| known(f)).cloned().collect();
        sections.push(Sec {
            title: s.title.clone(),
            fields,
            span: s.span,
            collapsible: s.collapsible,
        });
    }
    for name in &all {
        if let Some(group) = cfg.fields.get(name).and_then(|f| f.group.clone()) {
            if let Some(sec) = sections.iter_mut().find(|s| s.title == group) {
                if !sec.fields.contains(name) {
                    sec.fields.push(name.clone());
                }
            } else {
                sections.push(Sec {
                    title: group,
                    fields: vec![name.clone()],
                    span: None,
                    collapsible: false,
                });
            }
        }
    }
    if sections.is_empty() {
        return vec![];
    }
    let placed: Vec<String> = sections.iter().flat_map(|s| s.fields.clone()).collect();
    let leftover: Vec<String> = all.into_iter().filter(|c| !placed.contains(c)).collect();
    if !leftover.is_empty() {
        sections.push(Sec {
            title: "Other".into(),
            fields: leftover,
            span: None,
            collapsible: false,
        });
    }
    sections
        .into_iter()
        .map(|s| json!({ "title": s.title, "fields": s.fields, "span": s.span, "collapsible": s.collapsible }))
        .collect()
}

fn column_meta(
    state: &AppState,
    user: &CurrentUser,
    key: &str,
    dbt: &DbTable,
    cfg: &TableConfig,
) -> Vec<Value> {
    let masked = state.masked_columns(user, key);
    let mut out: Vec<Value> = dbt
        .columns
        .iter()
        .map(|c| {
            let fc = cfg.fields.get(&c.name);
            let is_masked = masked.contains(&c.name);
            let widget = fc
                .and_then(|f| f.widget.clone())
                .unwrap_or_else(|| default_widget(c).to_string());
            let readonly = Some(&c.name) == dbt.pk.as_ref()
                || is_masked
                || fc.map(|f| f.readonly).unwrap_or(false)
                || cfg.edit.readonly.contains(&c.name)
                || c.kind == Kind::Binary;
            let fk = c.fk.as_ref().and_then(|(ft, _)| {
                let child = state.resolve_table(ft)?;
                Some(json!({ "table": ft, "label_col": fk_label_col(child) }))
            });
            let mut params = fc.map(|f| f.params.clone()).unwrap_or_default();
            if let Some(img) = fc.and_then(|f| f.image.as_ref()) {
                params.insert("uploadable".into(), json!(!readonly));
                params.insert("max_px".into(), json!(img.max_px));
            }
            let mut m = json!({
                "name": c.name,
                "label": localize(
                    state,
                    fc.map(|f| &f.labels).unwrap_or(&Default::default()),
                    fc.and_then(|f| f.label.clone()).unwrap_or_else(|| humanize(&c.name)),
                ),
                "kind": c.kind,
                "nullable": c.nullable,
                "has_default": c.has_default,
                "widget": widget,
                "params": Value::Object(params),
                "readonly": readonly,
                "masked": is_masked,
                "fk": fk,
            });
            apply_presentation(&mut m, fc);
            if let Some((ref_table, ref_column)) = relation_target(state, user, c.fk.as_ref(), fc) {
                let obj = m.as_object_mut().unwrap();
                obj.insert("ref_table".into(), json!(ref_table));
                obj.insert("ref_column".into(), json!(ref_column));
            }
            m
        })
        .collect();
    for (name, _) in computed_columns(dbt, cfg) {
        let fc = cfg.fields.get(name);
        let is_masked = masked.contains(name);
        let mut m = json!({
            "name": name,
            "label": localize(
                state,
                fc.map(|f| &f.labels).unwrap_or(&Default::default()),
                fc.and_then(|f| f.label.clone()).unwrap_or_else(|| humanize(name)),
            ),
            "kind": "text",
            "nullable": true,
            "has_default": false,
            "widget": fc.and_then(|f| f.widget.clone()).unwrap_or_else(|| "text".into()),
            "params": Value::Object(fc.map(|f| f.params.clone()).unwrap_or_default()),
            "readonly": true,
            "computed": true,
            "masked": is_masked,
            "fk": Value::Null,
        });
        apply_presentation(&mut m, fc);
        if let Some((ref_table, ref_column)) = relation_target(state, user, None, fc) {
            let obj = m.as_object_mut().unwrap();
            obj.insert("ref_table".into(), json!(ref_table));
            obj.insert("ref_column".into(), json!(ref_column));
        }
        out.push(m);
    }
    out
}

/// Fold a field's presentation hints (`format`/`prefix`/`suffix`/`truncate`/
/// `display`/`href` and the pre-parsed `color`) into a column meta object.
fn apply_presentation(m: &mut Value, fc: Option<&crate::config::FieldConfig>) {
    let Some(fc) = fc else { return };
    let obj = m.as_object_mut().unwrap();
    if let Some(v) = &fc.format {
        obj.insert("format".into(), json!(v));
    }
    if let Some(v) = &fc.prefix {
        obj.insert("prefix".into(), json!(v));
    }
    if let Some(v) = &fc.suffix {
        obj.insert("suffix".into(), json!(v));
    }
    if let Some(v) = fc.truncate {
        obj.insert("truncate".into(), json!(v));
    }
    if let Some(v) = &fc.display {
        obj.insert("display".into(), json!(v));
    }
    if let Some(v) = &fc.href {
        obj.insert("href".into(), json!(v));
    }
    if let Some(color) = &fc.color {
        obj.insert("color".into(), color.normalized());
    }
}

fn filter_ops(kind: Kind) -> Vec<&'static str> {
    match kind {
        Kind::Int | Kind::Float | Kind::Datetime | Kind::Date => {
            vec![
                "eq", "ne", "gt", "gte", "lt", "lte", "in", "between", "isnull",
            ]
        }
        Kind::Text | Kind::Uuid => vec!["eq", "ne", "contains", "in", "isnull"],
        Kind::Bool => vec!["eq", "isnull"],
        _ => vec!["eq", "isnull"],
    }
}

pub struct ResolvedInline {
    pub child: String,
    pub fk_col: String,
    pub label: String,
    pub columns: Vec<String>,
    pub can_create: bool,
    pub can_delete: bool,
}

/// Zero-config inlines: every configured table with an introspected FK into
/// `parent` becomes an inline on the parent's detail page.
fn auto_inline_specs(state: &AppState, parent_key: &str, parent_phys: &str) -> Vec<InlineSpec> {
    let cfg = state.cfg();
    cfg.tables
        .keys()
        .filter(|child| child.as_str() != parent_key)
        .filter(|child| {
            state.resolve_table(child).is_some_and(|ct| {
                ct.columns
                    .iter()
                    .any(|c| c.fk.as_ref().is_some_and(|(ft, _)| ft == parent_phys))
            })
        })
        .map(|child| InlineSpec::Table(child.clone()))
        .collect()
}

pub fn resolve_inlines(state: &AppState, user: &CurrentUser, table: &str) -> Vec<ResolvedInline> {
    let cfg = table_config(state, table);
    let Some(dbt) = state.resolve_table(table) else {
        return vec![];
    };
    let specs = if !cfg.relations.inlines.is_empty() || cfg.relations.auto == Some(false) {
        cfg.relations.inlines.clone()
    } else {
        auto_inline_specs(state, table, &dbt.name)
    };
    let mut out = Vec::new();
    for spec in &specs {
        let (child, fk_col, label, columns, want_create, want_delete) = match spec {
            InlineSpec::Table(t) => (t.clone(), None, None, Vec::new(), None, None),
            InlineSpec::Full {
                table,
                fk_col,
                label,
                columns,
                can_create,
                can_delete,
            } => (
                table.clone(),
                fk_col.clone(),
                label.clone(),
                columns.clone(),
                *can_create,
                *can_delete,
            ),
        };
        let Some(child_t) = state.resolve_table(&child) else {
            continue;
        };
        let fk_col = fk_col
            .or_else(|| {
                child_t
                    .columns
                    .iter()
                    .find(|c| c.fk.as_ref().is_some_and(|(ft, _)| ft == &dbt.name))
                    .map(|c| c.name.clone())
            })
            .or_else(|| {
                let singular = dbt.name.strip_suffix('s').unwrap_or(&dbt.name);
                let guesses = [format!("{}_id", dbt.name), format!("{singular}_id")];
                guesses
                    .iter()
                    .find(|g| child_t.column(g).is_some())
                    .cloned()
            });
        let Some(fk_col) = fk_col else { continue };
        let label = label.unwrap_or_else(|| capitalize(&humanize(&child)));
        let child_perms = state.table_perms(user, &child);
        if !child_perms.view {
            continue;
        }
        out.push(ResolvedInline {
            child,
            fk_col,
            label,
            columns,
            can_create: want_create.unwrap_or(true) && child_perms.create,
            can_delete: want_delete.unwrap_or(true) && child_perms.delete,
        });
    }
    out
}

pub async fn table_meta(state: &AppState, user: &CurrentUser, table: &str) -> Option<Value> {
    let dbt = state.resolve_table(table)?;
    let cfg = table_config(state, table);
    let cfg = &cfg;
    let perms = state.table_perms(user, table);
    if !perms.view {
        return None;
    }
    let actions_allowed = state.allowed_actions(user, table);
    let actions: Vec<Value> = cfg
        .actions
        .iter()
        .filter(|(n, _)| actions_allowed.contains(n))
        .map(|(n, a)| {
            json!({
                "name": n, "label": localize(state, &a.labels, a.label.clone()),
                "danger": a.danger, "confirm": a.confirm, "kind": a.kind,
            })
        })
        .collect();
    let inlines: Vec<Value> = resolve_inlines(state, user, table)
        .into_iter()
        .map(|i| {
            json!({
                "table": i.child,
                "fk_col": i.fk_col,
                "label": i.label,
                "columns": i.columns,
                "can_create": i.can_create,
                "can_delete": i.can_delete,
            })
        })
        .collect();
    let read_only = dbt.is_view || dbt.pk.is_none();
    let label = localize(
        state,
        &cfg.labels,
        cfg.label.clone().unwrap_or_else(|| humanize(table)),
    );
    Some(json!({
        "name": table,
        "label": label,
        "label_plural": localize(state, &cfg.labels_plural, cfg.label_plural.clone().unwrap_or_else(|| capitalize(&humanize(table)))),
        "group": state.cfg().table_group_label(table),
        "pk": dbt.pk,
        "read_only": read_only,
        "columns": column_meta(state, user, table, dbt, cfg),
        "list": {
            "columns": list_columns(dbt, cfg),
            "search": search_columns(dbt, cfg),
            "filters": filter_meta(state, user, table, dbt, cfg).await,
            "default_sort": default_sort(dbt, cfg),
            "per_page": cfg.list.per_page.or(state.cfg().cartapel.per_page).unwrap_or(100),
        },
        "display_title": cfg.display.title.clone().unwrap_or_else(|| default_display_title(dbt, &label)),
        "detail": {
            "mode": cfg.detail.mode,
            "columns": cfg.detail.columns,
            "tabs": cfg.detail.tabs,
            "stats": cfg.detail.stats,
            "sidebar": cfg.detail.sidebar.as_ref().map(|s| json!({ "fields": s.fields })),
        },
        "sections": detail_sections(dbt, cfg),
        "inlines": inlines,
        "actions": actions,
        "perms": {
            "read": perms.view,
            "write": perms.update,
            "update": perms.update,
            "create": perms.create,
            "delete": perms.delete,
            "actions": actions_allowed,
        },
    }))
}

/// Derive the ordered sidebar nav purely from the folder-groups (`_group.hcl`) and
/// each table's folder membership. `groups` is pre-sorted by `(order, label)`;
/// `order` is the visible tables in display order. A group with no visible members
/// is skipped; any visible table not in a folder falls into a trailing "Ungrouped".
pub(crate) fn derive_nav_groups(
    groups: &[crate::config::LoadedGroup],
    sources: &std::collections::BTreeMap<String, crate::config::TableSource>,
    order: &[&str],
) -> Vec<Value> {
    let mut placed: std::collections::BTreeSet<&str> = Default::default();
    let mut out: Vec<Value> = Vec::new();
    for g in groups {
        let mut members: Vec<&str> = order
            .iter()
            .copied()
            .filter(|t| sources.get(*t).and_then(|s| s.group.as_deref()) == Some(g.slug.as_str()))
            .filter(|t| !placed.contains(*t))
            .collect();
        if members.is_empty() {
            continue;
        }
        let rank = |t: &str| {
            g.table_order
                .iter()
                .position(|n| n == t)
                .unwrap_or(usize::MAX)
        };
        members.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)));
        for m in &members {
            placed.insert(m);
        }
        out.push(json!({ "slug": g.slug, "label": g.label, "icon": g.icon, "nav": g.nav, "tables": members }));
    }
    let leftover: Vec<&str> = order
        .iter()
        .copied()
        .filter(|t| !placed.contains(*t))
        .collect();
    if !leftover.is_empty() {
        out.push(json!({ "slug": Value::Null, "label": "Ungrouped", "icon": Value::Null, "nav": Value::Null, "tables": leftover }));
    }
    out
}

/// The custom pages a user may see, each carrying its group-qualified folder-derived
/// `id` and the group *label* (not slug). Shared by `meta_handler` and its tests.
pub(crate) fn pages_meta(cfg: &crate::config::ConfigDir, user: &CurrentUser) -> Vec<Value> {
    cfg.pages
        .iter()
        .filter(|p| user.may(&p.roles, crate::state::Access::Everyone))
        .map(|p| {
            let group = p.group.as_deref().and_then(|slug| cfg.group_label(slug));
            json!({
                "id": p.id(), "slug": p.slug, "label": p.label,
                "group": group, "icon": p.icon, "roles": p.roles,
            })
        })
        .collect()
}

fn nav_groups(state: &AppState, tables: &[Value]) -> Vec<Value> {
    let order: Vec<&str> = tables.iter().filter_map(|t| t["name"].as_str()).collect();
    let cfg = state.cfg();
    derive_nav_groups(&cfg.groups, &cfg.table_sources, &order)
}

/// Unauthenticated branding for the login screen — only public identity
/// (brand, logo, theme, locale/strings). No tables, no user data.
#[cfg(test)]
mod nav_tests {
    use super::{derive_nav_groups, pages_meta};
    use crate::state::CurrentUser;

    /// The emitted page JSON carries the group *label* ("Overview", not the slug
    /// "overview") and the group-qualified folder-derived `id` ("overview/cache").
    #[test]
    fn page_meta_emits_group_label_and_qualified_id() {
        let dir = std::path::Path::new("../admin");
        if !dir.exists() {
            return;
        }
        let cfg = crate::config::load(Some(dir)).expect("load admin");
        let admin = CurrentUser {
            email: "a@x.io".into(),
            role: "admin".into(),
        };
        let pages = pages_meta(&cfg, &admin);
        let cache = pages
            .iter()
            .find(|p| p["slug"] == "cache")
            .expect("cache page emitted");
        assert_eq!(
            cache["id"], "overview/cache",
            "id is group-qualified, folder-derived"
        );
        assert_eq!(
            cache["group"], "Overview",
            "group is the LABEL, not the slug"
        );
        assert_eq!(
            cache["module"], "screens/overview/cache/cache.tsx",
            "module is the admin-relative path"
        );
        assert_eq!(cache["roles"], serde_json::json!(["ops"]));
    }

    /// A declarative page (widgets, no module) is emitted with `module = null` and
    /// `declarative = true`; a role-gated one is hidden from the wrong role but
    /// shown to an admin.
    #[test]
    fn pages_meta_is_group_qualified_and_role_gated() {
        use crate::config::{ConfigDir, LoadedGroup, LoadedPage};
        let mut cfg = ConfigDir::default();
        cfg.groups.push(LoadedGroup {
            slug: "overview".into(),
            labels: Default::default(),
            label: "Overview".into(),
            icon: None,
            order: 0,
            table_order: vec![],
            nav: None,
        });
        cfg.pages.push(LoadedPage {
            slug: "fleet".into(),
            group: Some("overview".into()),
            label: "Fleet".into(),
            columns: Some(4),
            widgets: vec![],
            icon: Some("satellite".into()),
            roles: vec!["ops".into()],
        });

        let ops = CurrentUser {
            email: "o@x.io".into(),
            role: "ops".into(),
        };
        let seen = pages_meta(&cfg, &ops);
        assert_eq!(seen.len(), 1);
        assert_eq!(
            seen[0]["id"], "overview/fleet",
            "id is group-qualified, folder-derived"
        );
        assert_eq!(
            seen[0]["group"], "Overview",
            "group is the LABEL, not the slug"
        );

        let viewer = CurrentUser {
            email: "v@x.io".into(),
            role: "viewer".into(),
        };
        assert!(
            pages_meta(&cfg, &viewer).is_empty(),
            "role-gated page hidden"
        );

        let admin = CurrentUser {
            email: "a@x.io".into(),
            role: "admin".into(),
        };
        assert_eq!(
            pages_meta(&cfg, &admin).len(),
            1,
            "admin sees role-gated page"
        );
    }

    /// The nav derived from the shipped `admin/**` folders matches the intended
    /// group order, labels, icons, and membership — the invariant that the
    /// folders=groups reorg must keep equivalent to the old `group {}` blocks.
    #[test]
    fn shipped_folders_derive_the_expected_nav() {
        let dir = std::path::Path::new("../admin");
        if !dir.exists() {
            return;
        }
        let cfg = crate::config::load(Some(dir)).expect("load admin");
        let order: Vec<&str> = cfg.tables.keys().map(String::as_str).collect();
        let nav = derive_nav_groups(&cfg.groups, &cfg.table_sources, &order);

        // (label, icon, member set). Overview is empty → absent from the nav.
        let expected: &[(&str, &str, &[&str])] = &[
            (
                "Bots & live",
                "bot",
                &[
                    "bots",
                    "bot_signals",
                    "bot_notifications",
                    "bot_symbol_cursor",
                    "bot_journal",
                ],
            ),
            (
                "Paper trading",
                "file-text",
                &[
                    "paper_account",
                    "paper_position",
                    "paper_order",
                    "paper_fill",
                    "paper_funding",
                    "paper_equity",
                ],
            ),
            (
                "Market data",
                "trending-up",
                &[
                    "instruments",
                    "exchanges",
                    "universes",
                    "funding_rates",
                    "md_symbol_hits",
                    "logos",
                ],
            ),
            (
                "Stock prices & ingest",
                "database",
                &["stock_snapshot", "stock_backfill", "ingest_runs"],
            ),
            (
                "Fundamentals · SEC",
                "landmark",
                &[
                    "companies",
                    "company_tickers",
                    "concepts",
                    "facts",
                    "ratios",
                ],
            ),
            ("Watchlists", "star", &["watchlists", "watchlist_items"]),
            (
                "User data",
                "user",
                &[
                    "user_scripts",
                    "script_favorites",
                    "chart_layouts",
                    "chart_drawings",
                    "user_settings",
                ],
            ),
            (
                "Billing & entitlements",
                "credit-card",
                &[
                    "subscriptions",
                    "subscription_events",
                    "entitlement_overrides",
                    "ai_chat_usage",
                ],
            ),
            (
                "Marketplace",
                "shopping-bag",
                &[
                    "marketplace_scripts",
                    "marketplace_installs",
                    "marketplace_ratings",
                    "marketplace_favorites",
                    "users",
                ],
            ),
        ];

        assert_eq!(nav.len(), expected.len(), "group count + order:\n{nav:#?}");
        for (got, (label, icon, members)) in nav.iter().zip(expected) {
            assert_eq!(got["label"], *label, "group label + order");
            assert_eq!(got["icon"], *icon, "group icon");
            let got_members: Vec<&str> = got["tables"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            assert_eq!(got_members, members.to_vec(), "members of {label} in order");
        }
    }

    #[test]
    fn table_order_sorts_members_listed_first_then_alphabetical() {
        use crate::config::{LoadedGroup, TableSource};
        use std::collections::BTreeMap;

        let groups = vec![LoadedGroup {
            slug: "g".into(),
            labels: Default::default(),
            label: "G".into(),
            icon: None,
            order: 0,
            table_order: vec!["c".into(), "a".into(), "ghost".into()],
            nav: None,
        }];
        let mut sources: BTreeMap<String, TableSource> = BTreeMap::new();
        for t in ["a", "b", "c"] {
            sources.insert(
                t.into(),
                TableSource {
                    path: std::path::PathBuf::new(),
                    group: Some("g".into()),
                },
            );
        }
        let order = ["a", "b", "c"];
        let nav = derive_nav_groups(&groups, &sources, &order);

        let members: Vec<&str> = nav[0]["tables"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(members, vec!["c", "a", "b"]);
    }
}

#[cfg(test)]
mod relation_tests {
    use super::column_meta;
    use crate::config::{ConfigDir, RoleConfig, TableConfig};
    use crate::introspect::{DbColumn, DbTable, Kind, Schema};
    use crate::state::{AppState, CurrentUser};
    use crate::store::Store;
    use std::sync::Arc;

    fn id_col() -> DbColumn {
        DbColumn {
            name: "id".into(),
            udt: "int8".into(),
            elem_udt: None,
            kind: Kind::Int,
            nullable: false,
            has_default: true,
            fk: None,
        }
    }

    fn fk_col(name: &str, ref_table: &str) -> DbColumn {
        DbColumn {
            name: name.into(),
            udt: "int8".into(),
            elem_udt: None,
            kind: Kind::Int,
            nullable: true,
            has_default: false,
            fk: Some((ref_table.into(), "id".into())),
        }
    }

    fn table(name: &str, columns: Vec<DbColumn>) -> DbTable {
        DbTable {
            name: name.into(),
            schema: "public".into(),
            source: String::new(),
            is_view: false,
            extra_unique: false,
            pk: Some("id".into()),
            columns,
        }
    }

    /// `orders.bot_id` → `bots` (exposed), `orders.hidden_id` → `secret` (NOT exposed).
    fn schema() -> Schema {
        let mut s = Schema::default();
        s.tables.insert(
            "orders".into(),
            table(
                "orders",
                vec![
                    id_col(),
                    fk_col("bot_id", "bots"),
                    fk_col("hidden_id", "secret"),
                ],
            ),
        );
        s.tables
            .insert("bots".into(), table("bots", vec![id_col()]));
        s.tables
            .insert("secret".into(), table("secret", vec![id_col()]));
        s
    }

    fn cfg() -> ConfigDir {
        let mut c = ConfigDir::default();
        c.tables.insert("orders".into(), TableConfig::default());
        c.tables.insert("bots".into(), TableConfig::default());
        c
    }

    fn state(cfg: ConfigDir) -> Arc<AppState> {
        let pg = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://x")
            .unwrap();
        Arc::new(AppState {
            pools: Default::default(),
            dbs: Default::default(),
            pg: crate::db::DbPool::Pg(pg),
            schema: "public".into(),
            db: schema(),
            cfg: arc_swap::ArcSwap::from_pointee(cfg),
            config_dir: None,
            store: Store::open_memory(),
            base_path: String::new(),
            http: reqwest::Client::new(),
            secure_cookies: false,
            secret_key: [7u8; 32],
            webhook_secret: None,
            options_cache: Default::default(),
            files_cache: Default::default(),
            login_limiter: Default::default(),
            config_write_lock: Default::default(),
        })
    }

    fn relation<'a>(cols: &'a [serde_json::Value], name: &str) -> Option<(&'a str, &'a str)> {
        let c = cols.iter().find(|c| c["name"] == name)?;
        Some((
            c.get("ref_table")?.as_str()?,
            c.get("ref_column")?.as_str()?,
        ))
    }

    #[tokio::test]
    async fn introspected_fk_emits_relation_when_target_exposed_and_viewable() {
        let state = state(cfg());
        let admin = CurrentUser {
            email: "a@x.io".into(),
            role: "admin".into(),
        };
        let dbt = state.db.tables.get("orders").unwrap();
        let cols = column_meta(&state, &admin, "orders", dbt, &TableConfig::default());
        assert_eq!(
            relation(&cols, "bot_id"),
            Some(("bots", "id")),
            "exposed+viewable target links"
        );
    }

    #[tokio::test]
    async fn fk_to_unexposed_target_emits_no_relation() {
        let state = state(cfg());
        let admin = CurrentUser {
            email: "a@x.io".into(),
            role: "admin".into(),
        };
        let dbt = state.db.tables.get("orders").unwrap();
        let cols = column_meta(&state, &admin, "orders", dbt, &TableConfig::default());
        assert_eq!(
            relation(&cols, "hidden_id"),
            None,
            "target 'secret' is not configured"
        );
    }

    #[tokio::test]
    async fn fk_target_not_viewable_by_role_emits_no_relation() {
        let mut c = cfg();
        let mut role = RoleConfig::default();
        role.tables.insert("orders".into(), "read".into());
        c.auth.roles.insert("viewer".into(), role);
        let state = state(c);
        let viewer = CurrentUser {
            email: "v@x.io".into(),
            role: "viewer".into(),
        };
        let dbt = state.db.tables.get("orders").unwrap();
        let cols = column_meta(&state, &viewer, "orders", dbt, &TableConfig::default());
        assert_eq!(
            relation(&cols, "bot_id"),
            None,
            "viewer can't view bots → no drill-through link"
        );
    }

    #[tokio::test]
    async fn config_target_wins_over_introspected_fk() {
        let state = state(cfg());
        let admin = CurrentUser {
            email: "a@x.io".into(),
            role: "admin".into(),
        };
        let mut tc = TableConfig::default();
        let mut fc = crate::config::FieldConfig::default();
        fc.params.insert("target".into(), serde_json::json!("bots"));
        tc.fields.insert("bot_id".into(), fc);
        let dbt = state.db.tables.get("orders").unwrap();
        let cols = column_meta(&state, &admin, "orders", dbt, &tc);
        assert_eq!(
            relation(&cols, "bot_id"),
            Some(("bots", "id")),
            "config target resolves + pk default"
        );
    }
}

#[cfg(test)]
mod gate_tests {
    use super::{ENUM_OPTIONS_CONCURRENCY, ENUM_OPTIONS_GATE};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn gate_caps_concurrent_holders() {
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let tasks: Vec<_> = (0..64)
            .map(|_| {
                let live = live.clone();
                let peak = peak.clone();
                tokio::spawn(async move {
                    let _permit = ENUM_OPTIONS_GATE.acquire().await.unwrap();
                    let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    live.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for t in tasks {
            t.await.unwrap();
        }
        assert!(peak.load(Ordering::SeqCst) <= ENUM_OPTIONS_CONCURRENCY);
    }
}

pub async fn public_branding_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    let cfg = state.cfg();
    Json(json!({
        "brand": state.brand(),
        "brand_logo": cfg.cartapel.brand_logo,
        "theme": cfg.cartapel.theme,
        "locale": cfg.cartapel.locale,
        "strings": cfg.cartapel.strings,
        "base_path": state.base_path,
    }))
}

pub async fn meta_handler(
    State(state): State<Arc<AppState>>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let table_futs = state.visible_tables(&user).into_iter().map(|t| {
        let state = state.clone();
        let user = user.clone();
        async move { table_meta(&state, &user, &t).await }
    });
    let tables: Vec<Value> = futures::future::join_all(table_futs)
        .await
        .into_iter()
        .flatten()
        .collect();
    let cfg = state.cfg();
    let pages = pages_meta(&cfg, &user);
    let nav = nav_groups(&state, &tables);
    let variables = variables_meta(&state, &user).await;
    Ok(Json(json!({
        "brand": state.brand(),
        "brand_logo": cfg.cartapel.brand_logo,
        "theme": cfg.cartapel.theme,
        "locale": cfg.cartapel.locale,
        "strings": cfg.cartapel.strings,
        "base_path": state.base_path,
        "tables": tables,
        "nav": nav,
        "group_nav": cfg.cartapel.group_nav,
        "pages": pages,
        "variables": variables,
        "user": { "email": user.email, "role": user.role },
        "has_dashboard": !cfg.dashboard.widgets.is_empty(),
        "roles": state.effective_role_names(),
        "can_manage_access": user.is_admin(),
        "can_customize": state.can_customize(&user),
    })))
}

/// The in-scope template variables with their option sets resolved server-side,
/// for the URL-backed var-bar. `query`-backed options are run read-only here so
/// the browser only ever sees the value list, never the SQL.
async fn variables_meta(state: &AppState, user: &CurrentUser) -> Vec<Value> {
    let vars: Vec<(String, crate::config::Variable)> = {
        let cfg = state.cfg();
        cfg.variables
            .iter()
            .filter(|(_, v)| user.may(&v.roles, crate::state::Access::Everyone))
            .map(|(n, v)| (n.clone(), v.clone()))
            .collect()
    };
    let mut out = Vec::new();
    for (name, var) in vars {
        let options = crate::vars::option_pairs(state, &var)
            .await
            .unwrap_or_default();
        out.push(json!({
            "name": name,
            "label": var.label.clone().unwrap_or_else(|| name.clone()),
            "type": var.var_type.clone().unwrap_or_else(|| "text".into()),
            "kind": var.kind.clone().unwrap_or_else(|| "single".into()),
            "default": var.default,
            "options": options,
        }));
    }
    out
}

/// Pre-populate `options_cache` for every visible table so the first real `/meta`
/// hits a warm cache. Reuses the same `table_meta` path (hence the same
/// `ENUM_OPTIONS_CONCURRENCY` gate) as the handler; errors are already swallowed
/// per-query, so this can never fail. Warms the admin view (no row filter) — the
/// broadest, most-shared cache keys.
pub async fn warm_options_cache(state: &AppState) {
    let user = CurrentUser {
        email: String::new(),
        role: "admin".into(),
    };
    let futs = state.visible_tables(&user).into_iter().map(|t| {
        let user = &user;
        async move {
            table_meta(state, user, &t).await;
        }
    });
    futures::future::join_all(futs).await;
}
