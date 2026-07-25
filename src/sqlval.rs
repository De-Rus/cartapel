use crate::introspect::{DbColumn, Kind};
use crate::state::AppError;
use serde_json::Value;

pub struct Binds {
    pub values: Vec<Option<String>>,
}

impl Binds {
    pub fn new() -> Self {
        Self { values: Vec::new() }
    }

    pub fn push(&mut self, v: Option<String>) -> usize {
        self.values.push(v);
        self.values.len()
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

pub fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', ""))
}

/// SET/INSERT expression for a column: a text bind cast to the column's type.
pub fn value_expr(col: &DbColumn, value: &Value, binds: &mut Binds) -> Result<String, AppError> {
    if value.is_null() {
        if !col.nullable {
            return Err(AppError::bad(format!("{} is not nullable", col.name)));
        }
        let n = binds.push(None);
        return Ok(format!("${n}::{}", cast_of(col)));
    }
    match col.kind {
        Kind::Json => {
            let n = binds.push(Some(value.to_string()));
            Ok(format!("${n}::{}", col.udt))
        }
        Kind::Array => {
            let Value::Array(_) = value else {
                return Err(AppError::bad(format!("{} expects an array", col.name)));
            };
            let elem = col.elem_udt.clone().unwrap_or_else(|| "text".into());
            let n = binds.push(Some(value.to_string()));
            Ok(format!(
                "(SELECT coalesce(array_agg(v.value::{elem}), '{{}}'::{elem}[]) FROM jsonb_array_elements_text(${n}::jsonb) v)"
            ))
        }
        Kind::Binary => Err(AppError::bad(format!(
            "{} is binary and not editable",
            col.name
        ))),
        _ => {
            let text = match value {
                Value::String(s) => s.clone(),
                Value::Bool(b) => b.to_string(),
                Value::Number(x) => x.to_string(),
                _ => return Err(AppError::bad(format!("unsupported value for {}", col.name))),
            };
            let n = binds.push(Some(text));
            Ok(format!("${n}::{}", cast_of(col)))
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

/// A single-quoted SQL string literal (for trusted config-derived keys only).
pub fn sql_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// WHERE pk = $n from its URL string form.
pub fn pk_predicate(pk_col: &DbColumn, pk: &str, binds: &mut Binds) -> String {
    let n = binds.push(Some(pk.to_string()));
    format!("{} = ${n}::{}", ident(&pk_col.name), pk_col.udt)
}

/// Post-process a to_jsonb row: mask fields, shrink bytea to a size marker.
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
            if let Value::String(s) = &v {
                let bytes = s
                    .strip_prefix("\\x")
                    .map(|h| h.len() / 2)
                    .unwrap_or(s.len());
                *v = serde_json::json!({ "__bytes__": bytes });
            }
        }
    }
}
