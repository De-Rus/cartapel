use serde::Serialize;
use sqlx::PgPool;
use sqlx::Row;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Text,
    Int,
    Float,
    Bool,
    Datetime,
    Date,
    Uuid,
    Json,
    Array,
    Binary,
}

#[derive(Debug, Clone)]
pub struct DbColumn {
    pub name: String,
    pub udt: String,
    pub elem_udt: Option<String>,
    pub kind: Kind,
    pub nullable: bool,
    pub has_default: bool,
    pub fk: Option<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct DbTable {
    pub name: String,
    pub schema: String,
    pub source: String,
    pub is_view: bool,
    pub pk: Option<String>,
    pub columns: Vec<DbColumn>,
}

impl DbTable {
    pub fn column(&self, name: &str) -> Option<&DbColumn> {
        self.columns.iter().find(|c| c.name == name)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Schema {
    pub tables: BTreeMap<String, DbTable>,
}

impl Schema {
    /// Locate a physical table by its `name`, optionally pinned to `schema`. The
    /// map is keyed by bare name (or `schema.table` on cross-schema collisions),
    /// so a `from { schema = … }` override must match on the struct fields, not
    /// the key. Without a schema, the first table of that name wins.
    pub fn find(&self, schema: Option<&str>, name: &str) -> Option<&DbTable> {
        if let Some(sch) = schema {
            return self
                .tables
                .values()
                .find(|t| t.name == name && t.schema == sch);
        }
        self.tables
            .get(name)
            .or_else(|| self.tables.values().find(|t| t.name == name))
    }
}

pub fn kind_of(udt: &str) -> Kind {
    match udt {
        "int2" | "int4" | "int8" | "oid" => Kind::Int,
        "float4" | "float8" | "numeric" => Kind::Float,
        "bool" => Kind::Bool,
        "timestamp" | "timestamptz" => Kind::Datetime,
        "date" => Kind::Date,
        "uuid" => Kind::Uuid,
        "json" | "jsonb" => Kind::Json,
        "bytea" => Kind::Binary,
        u if u.starts_with('_') => Kind::Array,
        _ => Kind::Text,
    }
}

pub async fn introspect(pool: &PgPool, schemas: &[String]) -> Result<Schema, sqlx::Error> {
    let schemas = schemas.to_vec();
    let cols = sqlx::query(
        r#"SELECT c.table_schema, c.table_name, c.column_name, c.udt_name,
                  c.is_nullable = 'YES' AS nullable,
                  c.column_default IS NOT NULL OR c.is_identity = 'YES' AS has_default,
                  t.table_type = 'VIEW' AS is_view
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
           WHERE c.table_schema = ANY($1)
           ORDER BY c.table_schema, c.table_name, c.ordinal_position"#,
    )
    .bind(&schemas)
    .fetch_all(pool)
    .await?;

    let pks = sqlx::query(
        r#"SELECT tc.table_schema, tc.table_name, kcu.column_name,
                  count(*) OVER (PARTITION BY tc.table_schema, tc.table_name) AS n
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
           WHERE tc.table_schema = ANY($1) AND tc.constraint_type = 'PRIMARY KEY'"#,
    )
    .bind(&schemas)
    .fetch_all(pool)
    .await?;

    let fks = sqlx::query(
        r#"SELECT kcu.table_schema, kcu.table_name, kcu.column_name,
                  ccu.table_schema AS f_schema, ccu.table_name AS f_table, ccu.column_name AS f_col
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
           WHERE tc.table_schema = ANY($1) AND tc.constraint_type = 'FOREIGN KEY'"#,
    )
    .bind(&schemas)
    .fetch_all(pool)
    .await?;

    let uniques = sqlx::query(
        r#"SELECT ns.nspname AS table_schema, t.relname AS table_name, a.attname AS column_name
           FROM pg_index i
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_namespace ns ON ns.oid = t.relnamespace
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
           WHERE ns.nspname = ANY($1) AND i.indisunique AND i.indnkeyatts = 1
             AND i.indpred IS NULL AND i.indexprs IS NULL AND a.attnotnull
           ORDER BY t.relname, i.indisprimary DESC, a.attname"#,
    )
    .bind(&schemas)
    .fetch_all(pool)
    .await?;

    // A bare table name is the key when it appears in only one scanned schema;
    // when it collides across schemas every instance keys as "schema.table".
    let mut name_schemas: BTreeMap<String, std::collections::BTreeSet<String>> = BTreeMap::new();
    for r in &cols {
        let sch: String = r.get("table_schema");
        let table: String = r.get("table_name");
        name_schemas.entry(table).or_default().insert(sch);
    }
    let key_of = |sch: &str, table: &str| -> String {
        if name_schemas.get(table).map(|s| s.len()).unwrap_or(1) > 1 {
            format!("{sch}.{table}")
        } else {
            table.to_string()
        }
    };

    let mut single_pk: BTreeMap<(String, String), Option<String>> = BTreeMap::new();
    for r in &pks {
        let key = (
            r.get::<String, _>("table_schema"),
            r.get::<String, _>("table_name"),
        );
        let col: String = r.get("column_name");
        let n: i64 = r.get("n");
        let entry = single_pk.entry(key).or_insert(None);
        *entry = if n == 1 { Some(col) } else { None };
    }
    for r in &uniques {
        let key = (
            r.get::<String, _>("table_schema"),
            r.get::<String, _>("table_name"),
        );
        let col: String = r.get("column_name");
        single_pk
            .entry(key)
            .or_insert(Some(col.clone()))
            .get_or_insert(col);
    }

    let mut fk_map: BTreeMap<(String, String, String), (String, String)> = BTreeMap::new();
    for r in &fks {
        let f_key = key_of(
            &r.get::<String, _>("f_schema"),
            &r.get::<String, _>("f_table"),
        );
        fk_map.insert(
            (
                r.get("table_schema"),
                r.get("table_name"),
                r.get("column_name"),
            ),
            (f_key, r.get("f_col")),
        );
    }

    let mut schema_out = Schema::default();
    for r in &cols {
        let sch: String = r.get("table_schema");
        let table: String = r.get("table_name");
        let name: String = r.get("column_name");
        let udt: String = r.get("udt_name");
        let is_view: bool = r.get("is_view");
        let kind = kind_of(&udt);
        let elem_udt = udt.strip_prefix('_').map(|s| s.to_string());
        let key = key_of(&sch, &table);
        let entry = schema_out.tables.entry(key).or_insert_with(|| DbTable {
            name: table.clone(),
            schema: sch.clone(),
            source: String::new(),
            is_view,
            pk: single_pk
                .get(&(sch.clone(), table.clone()))
                .cloned()
                .flatten(),
            columns: Vec::new(),
        });
        entry.columns.push(DbColumn {
            fk: fk_map
                .get(&(sch.clone(), table.clone(), name.clone()))
                .cloned(),
            name,
            udt,
            elem_udt,
            kind,
            nullable: r.get("nullable"),
            has_default: r.get("has_default"),
        });
    }
    Ok(schema_out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(name: &str, schema: &str) -> DbTable {
        DbTable {
            name: name.into(),
            schema: schema.into(),
            source: String::new(),
            is_view: false,
            pk: None,
            columns: vec![],
        }
    }

    #[test]
    fn find_resolves_by_name_and_optional_schema() {
        let mut s = Schema::default();
        s.tables.insert("bots".into(), t("bots", "markets"));
        s.tables
            .insert("public.orders".into(), t("orders", "public"));
        s.tables.insert("shop.orders".into(), t("orders", "shop"));

        assert_eq!(
            s.find(None, "bots").map(|d| d.schema.as_str()),
            Some("markets")
        );
        assert_eq!(
            s.find(Some("markets"), "bots").map(|d| d.schema.as_str()),
            Some("markets")
        );
        assert!(
            s.find(Some("public"), "bots").is_none(),
            "schema pin must not match a different schema"
        );

        assert_eq!(
            s.find(Some("shop"), "orders").map(|d| d.schema.as_str()),
            Some("shop")
        );
        assert_eq!(
            s.find(Some("public"), "orders").map(|d| d.schema.as_str()),
            Some("public")
        );
        assert!(s.find(None, "missing").is_none());
    }
}
