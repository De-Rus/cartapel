use crate::introspect::{DbColumn, Kind};
use crate::state::AppError;
use serde_json::Value;

pub struct Binds {
    pub values: Vec<Option<String>>,
    dialect: crate::db::Dialect,
}

impl Binds {
    pub fn for_dialect(dialect: crate::db::Dialect) -> Self {
        Self {
            values: Vec::new(),
            dialect,
        }
    }

    /// Bind a value and return its SQL placeholder in this dialect.
    pub fn ph(&mut self, v: Option<String>) -> String {
        self.values.push(v);
        match self.dialect {
            crate::db::Dialect::Pg => format!("${}", self.values.len()),
            crate::db::Dialect::MySql => "?".into(),
        }
    }

    /// A placeholder carrying the column's type: `$n::udt` on Postgres; bare `?`
    /// on MySQL, whose comparisons coerce text operands to the column type.
    pub fn typed(&mut self, v: Option<String>, udt: &str) -> String {
        let p = self.ph(v);
        match self.dialect {
            crate::db::Dialect::Pg => format!("{p}::{udt}"),
            crate::db::Dialect::MySql => p,
        }
    }

    pub fn dialect(&self) -> crate::db::Dialect {
        self.dialect
    }

    pub fn query<'a>(
        &'a self,
        sql: &'a str,
    ) -> sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments> {
        let mut q = sqlx::query(sql);
        for v in &self.values {
            q = q.bind(v.as_deref());
        }
        q
    }
}

/// The left side of a pk IN-list: Postgres compares as text (pre-existing
/// shape); MySQL compares the raw column so the index stays usable — its
/// per-value coercion handles int and text pks alike.
pub fn pk_in_lhs(dialect: crate::db::Dialect, pk_ident: &str) -> String {
    match dialect {
        crate::db::Dialect::Pg => format!("{pk_ident}::text"),
        crate::db::Dialect::MySql => pk_ident.to_string(),
    }
}

/// `expr` rendered as text in this dialect (Postgres `::text`, MySQL CAST).
pub fn text_cast(dialect: crate::db::Dialect, expr: &str) -> String {
    match dialect {
        crate::db::Dialect::Pg => format!("{expr}::text"),
        crate::db::Dialect::MySql => format!("CAST({expr} AS CHAR)"),
    }
}

/// Case-insensitive substring match: ILIKE on Postgres; LOWER LIKE LOWER on
/// MySQL (whose LIKE is only case-insensitive on CI collations).
pub fn ilike_clause(dialect: crate::db::Dialect, expr: &str, ph: &str) -> String {
    match dialect {
        crate::db::Dialect::Pg => format!("{expr}::text ILIKE {ph}"),
        crate::db::Dialect::MySql => format!("LOWER(CAST({expr} AS CHAR)) LIKE LOWER({ph})"),
    }
}

/// One ORDER BY term with NULLS LAST semantics in both dialects.
pub fn order_term(dialect: crate::db::Dialect, expr: &str, dir: &str) -> String {
    match dialect {
        crate::db::Dialect::Pg => format!("{expr} {dir} NULLS LAST"),
        crate::db::Dialect::MySql => format!("({expr} IS NULL), {expr} {dir}"),
    }
}

pub fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// SET/INSERT expression for a column: a text bind cast to the column's type.
pub fn value_expr(col: &DbColumn, value: &Value, binds: &mut Binds) -> Result<String, AppError> {
    if value.is_null() {
        if !col.nullable {
            return Err(AppError::bad(format!("{} is not nullable", col.name)));
        }
        return Ok(binds.typed(None, &cast_of(col)));
    }
    match col.kind {
        Kind::Json => {
            let p = binds.typed(Some(value.to_string()), &col.udt);
            Ok(p)
        }
        Kind::Array => {
            if binds.dialect() == crate::db::Dialect::MySql {
                return Err(AppError::bad(format!(
                    "{} is an array column — arrays do not exist on MySQL",
                    col.name
                )));
            }
            let Value::Array(_) = value else {
                return Err(AppError::bad(format!("{} expects an array", col.name)));
            };
            let elem = col.elem_udt.clone().unwrap_or_else(|| "text".into());
            let n = binds.ph(Some(value.to_string()));
            Ok(format!(
                "(SELECT coalesce(array_agg(v.value::{elem}), '{{}}'::{elem}[]) FROM jsonb_array_elements_text({n}::jsonb) v)"
            ))
        }
        Kind::Binary => Err(AppError::bad(format!(
            "{} is binary and not editable",
            col.name
        ))),
        Kind::Bool if binds.dialect() == crate::db::Dialect::MySql => {
            let text = match value {
                Value::Bool(true) => "1",
                Value::Bool(false) => "0",
                Value::String(s) if s == "true" || s == "1" => "1",
                Value::String(s) if s == "false" || s == "0" => "0",
                _ => return Err(AppError::bad(format!("unsupported value for {}", col.name))),
            };
            Ok(binds.ph(Some(text.into())))
        }
        _ => {
            let text = match value {
                Value::String(s) => s.clone(),
                Value::Bool(b) => b.to_string(),
                Value::Number(x) => x.to_string(),
                _ => return Err(AppError::bad(format!("unsupported value for {}", col.name))),
            };
            let p = binds.typed(Some(text), &cast_of(col));
            Ok(p)
        }
    }
}

pub fn cast_of(col: &DbColumn) -> String {
    match col.kind {
        Kind::Array => format!(
            "{}[]",
            col.elem_udt.clone().unwrap_or_else(|| "text".into())
        ),
        _ => col.udt.clone(),
    }
}

/// WHERE pk = <typed bind> from its URL string form. Numeric pks are validated
/// here: MySQL would otherwise coerce "1abc" to 1 with only a warning and the
/// request would silently hit the wrong row.
pub fn pk_predicate(pk_col: &DbColumn, pk: &str, binds: &mut Binds) -> Result<String, AppError> {
    match pk_col.kind {
        Kind::Int if pk.trim().parse::<i128>().is_err() => {
            return Err(AppError::bad(format!("{pk:?} is not a valid id")));
        }
        Kind::Float if pk.trim().parse::<f64>().is_err() => {
            return Err(AppError::bad(format!("{pk:?} is not a valid id")));
        }
        _ => {}
    }
    let p = binds.typed(Some(pk.to_string()), &pk_col.udt);
    Ok(format!("{} = {p}", ident(&pk_col.name)))
}

/// Post-process a materialized row: mask fields, shrink bytea to a size marker.
/// Binary columns arrive as their `length()` (a number); a hex string is still
/// accepted for values that reach here through older audit snapshots.
pub fn present_row(row: &mut Value, masked: &[String], binary_cols: &[String]) {
    let Value::Object(map) = row else { return };
    for m in masked {
        if let Some(v) = map.get_mut(m) {
            if !v.is_null() {
                let hint = match &v {
                    Value::String(s) => s.chars().take(3).collect::<String>(),
                    _ => String::new(),
                };
                *v = Value::String(format!("{hint}\u{2026}"));
            }
        }
    }
    for b in binary_cols {
        if let Some(v) = map.get_mut(b) {
            match &v {
                Value::Number(n) => {
                    *v = serde_json::json!({ "__bytes__": n.as_i64().unwrap_or(0) });
                }
                Value::String(s) => {
                    let bytes = s
                        .strip_prefix("\\x")
                        .map(|h| h.len() / 2)
                        .unwrap_or(s.len());
                    *v = serde_json::json!({ "__bytes__": bytes });
                }
                _ => {}
            }
        }
    }
}
