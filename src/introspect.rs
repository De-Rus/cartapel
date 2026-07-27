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
    /// The table has a unique key beyond the primary key. MySQL's upsert fires
    /// on ANY unique key — an import row could silently rewrite an unrelated
    /// row — so upserts are refused there when this is set.
    pub extra_unique: bool,
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
            extra_unique: false,
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

pub fn kind_of_mysql(data_type: &str, column_type: &str) -> Kind {
    match data_type {
        "tinyint" if column_type.starts_with("tinyint(1)") => Kind::Bool,
        "tinyint" | "smallint" | "mediumint" | "int" | "bigint" | "year" | "bit" => Kind::Int,
        "decimal" | "float" | "double" => Kind::Float,
        "date" => Kind::Date,
        "datetime" | "timestamp" => Kind::Datetime,
        "json" => Kind::Json,
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => Kind::Binary,
        _ => Kind::Text,
    }
}

/// One MySQL database == one schema; the pool's current database is the scope.
pub async fn introspect_mysql(pool: &sqlx::MySqlPool) -> Result<Schema, sqlx::Error> {
    let cols = sqlx::query(
        r#"SELECT CAST(c.TABLE_NAME AS CHAR) AS table_name,
                  CAST(c.COLUMN_NAME AS CHAR) AS column_name,
                  CAST(c.DATA_TYPE AS CHAR) AS data_type,
                  CAST(c.COLUMN_TYPE AS CHAR) AS column_type,
                  (c.IS_NULLABLE = 'YES') AS nullable,
                  (c.COLUMN_DEFAULT IS NOT NULL OR c.EXTRA LIKE '%auto_increment%') AS has_default,
                  (t.TABLE_TYPE = 'VIEW') AS is_view,
                  (c.COLUMN_KEY = 'PRI') AS is_pk
           FROM information_schema.COLUMNS c
           JOIN information_schema.TABLES t
             ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
           WHERE c.TABLE_SCHEMA = DATABASE()
           ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"#,
    )
    .fetch_all(pool)
    .await?;

    let fks = sqlx::query(
        r#"SELECT CAST(TABLE_NAME AS CHAR) AS table_name,
                  CAST(COLUMN_NAME AS CHAR) AS column_name,
                  CAST(REFERENCED_TABLE_NAME AS CHAR) AS f_table,
                  CAST(REFERENCED_COLUMN_NAME AS CHAR) AS f_col
           FROM information_schema.KEY_COLUMN_USAGE
           WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL"#,
    )
    .fetch_all(pool)
    .await?;

    let db_name: String = sqlx::query_scalar("SELECT CAST(DATABASE() AS CHAR)")
        .fetch_one(pool)
        .await?;

    let extra_uniques: std::collections::BTreeSet<String> = sqlx::query(
        r#"SELECT DISTINCT CAST(TABLE_NAME AS CHAR) AS table_name
           FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'"#,
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|r| r.get("table_name"))
    .collect();

    for r in sqlx::query(
        r#"SELECT CAST(TABLE_NAME AS CHAR) AS t, CAST(ENGINE AS CHAR) AS e
           FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND ENGINE IS NOT NULL AND ENGINE <> 'InnoDB'"#,
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    {
        tracing::warn!(
            "table {} uses engine {} — no transactions, edits lose their atomicity guard",
            r.get::<String, _>("t"),
            r.get::<String, _>("e")
        );
    }

    // MariaDB stores `json` as longtext + an auto-named CHECK (json_valid(col));
    // the constraint name is the column name. Empty on MySQL (native json type).
    let json_checks: std::collections::BTreeSet<(String, String)> = sqlx::query(
        r#"SELECT CAST(TABLE_NAME AS CHAR) AS table_name,
                  CAST(CONSTRAINT_NAME AS CHAR) AS column_name
           FROM information_schema.CHECK_CONSTRAINTS
           WHERE CONSTRAINT_SCHEMA = DATABASE() AND LEVEL = 'Column'
             AND CHECK_CLAUSE LIKE '%json_valid%'"#,
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|r| (r.get("table_name"), r.get("column_name")))
    .collect();

    let mut fk_map: BTreeMap<(String, String), (String, String)> = BTreeMap::new();
    for r in &fks {
        fk_map.insert(
            (r.get("table_name"), r.get("column_name")),
            (r.get("f_table"), r.get("f_col")),
        );
    }

    let mut pk_count: BTreeMap<String, u32> = BTreeMap::new();
    for r in &cols {
        if r.get::<i64, _>("is_pk") != 0 {
            *pk_count.entry(r.get("table_name")).or_default() += 1;
        }
    }

    let mut out = Schema::default();
    for r in &cols {
        let table: String = r.get("table_name");
        let name: String = r.get("column_name");
        let data_type: String = r.get("data_type");
        let column_type: String = r.get("column_type");
        let is_view = r.get::<i64, _>("is_view") != 0;
        let is_pk = r.get::<i64, _>("is_pk") != 0;
        let entry = out.tables.entry(table.clone()).or_insert_with(|| DbTable {
            name: table.clone(),
            schema: db_name.clone(),
            source: String::new(),
            is_view,
            pk: None,
            extra_unique: extra_uniques.contains(&table),
            columns: Vec::new(),
        });
        if is_pk && pk_count.get(&table) == Some(&1) {
            entry.pk = Some(name.clone());
        }
        let mut kind = kind_of_mysql(&data_type, &column_type);
        if kind == Kind::Text
            && data_type == "longtext"
            && json_checks.contains(&(table.clone(), name.clone()))
        {
            kind = Kind::Json;
        }
        entry.columns.push(DbColumn {
            fk: fk_map.get(&(table.clone(), name.clone())).cloned(),
            kind,
            udt: column_type,
            elem_udt: None,
            name,
            nullable: r.get::<i64, _>("nullable") != 0,
            has_default: r.get::<i64, _>("has_default") != 0,
        });
    }
    Ok(out)
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
            extra_unique: false,
            columns: vec![],
        }
    }

    #[test]
    fn mysql_kind_mapping() {
        assert_eq!(kind_of_mysql("tinyint", "tinyint(1)"), Kind::Bool);
        assert_eq!(kind_of_mysql("tinyint", "tinyint(4)"), Kind::Int);
        assert_eq!(kind_of_mysql("bigint", "bigint(20) unsigned"), Kind::Int);
        assert_eq!(kind_of_mysql("decimal", "decimal(10,2)"), Kind::Float);
        assert_eq!(kind_of_mysql("bit", "bit(1)"), Kind::Int);
        assert_eq!(kind_of_mysql("bit", "bit(8)"), Kind::Int);
        assert_eq!(kind_of_mysql("datetime", "datetime"), Kind::Datetime);
        assert_eq!(kind_of_mysql("json", "json"), Kind::Json);
        assert_eq!(kind_of_mysql("longblob", "longblob"), Kind::Binary);
        assert_eq!(kind_of_mysql("enum", "enum('a','b')"), Kind::Text);
        assert_eq!(kind_of_mysql("varchar", "varchar(60)"), Kind::Text);
    }

    /// Introspection against a live MySQL/MariaDB (CARTAPEL_TEST_MYSQL), using
    /// the WordPress-shaped fixture the Phase-0 rig carries.
    #[tokio::test]
    async fn mysql_introspects_wordpress_shaped_tables() {
        let Ok(url) = std::env::var("CARTAPEL_TEST_MYSQL") else {
            eprintln!("CARTAPEL_TEST_MYSQL not set — mysql introspection test skipped");
            return;
        };
        let pool = sqlx::MySqlPool::connect(&url).await.unwrap();
        let schema = introspect_mysql(&pool).await.unwrap();
        let posts = schema.tables.get("wp_posts").expect("wp_posts fixture");
        assert_eq!(posts.pk.as_deref(), Some("ID"));
        let id = posts.column("ID").unwrap();
        assert_eq!(id.kind, Kind::Int);
        assert!(id.udt.contains("unsigned"));
        assert!(id.has_default, "auto_increment counts as a default");
        assert_eq!(posts.column("ping_status").unwrap().kind, Kind::Bool);
        assert_eq!(posts.column("post_status").unwrap().kind, Kind::Text);
        assert_eq!(posts.column("meta").unwrap().kind, Kind::Json);
        assert_eq!(posts.column("post_date").unwrap().kind, Kind::Datetime);
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
