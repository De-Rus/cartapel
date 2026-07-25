use std::collections::BTreeMap;

/// The declared value-type of a template variable. It decides how a `{{var}}`
/// occurrence is substituted: every type EXCEPT `Ident` becomes a bound `$N`
/// parameter (never string-concatenated), so a value can never break out of its
/// literal. `Ident` names a column/table — which cannot be a bind parameter — so
/// it is validated against `^[A-Za-z0-9_]+$` and emitted UNQUOTED; anything else
/// is rejected before it reaches the query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VarType {
    Text,
    Int,
    Float,
    Ident,
}

impl VarType {
    pub fn parse(s: &str) -> Option<VarType> {
        Some(match s {
            "text" => VarType::Text,
            "int" => VarType::Int,
            "float" => VarType::Float,
            "ident" => VarType::Ident,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum BoundVal {
    Text(String),
    Int(i64),
    Float(f64),
}

fn is_ident(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Rewrite every `{{name}}` in `sql` into a positional `$N` placeholder (or, for
/// an `Ident` variable, an inline validated identifier), returning the rewritten
/// SQL and the ordered bound values. Each occurrence binds independently.
///
/// Errors — loud, never a silent passthrough — on: an unknown variable name, a
/// missing supplied value, an `Ident` value that is not `^[A-Za-z0-9_]+$`, or an
/// `Int`/`Float` value that does not parse. An unterminated `{{` is left verbatim.
pub fn interpolate(
    sql: &str,
    types: &BTreeMap<String, VarType>,
    supplied: &BTreeMap<String, String>,
) -> Result<(String, Vec<BoundVal>), String> {
    let mut out = String::with_capacity(sql.len());
    let mut binds: Vec<BoundVal> = Vec::new();
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(close) = sql[i + 2..].find("}}") {
                let name = sql[i + 2..i + 2 + close].trim();
                let ty = types
                    .get(name)
                    .copied()
                    .ok_or_else(|| format!("unknown template variable {{{{{name}}}}}"))?;
                let value = supplied
                    .get(name)
                    .ok_or_else(|| format!("no value supplied for {{{{{name}}}}}"))?;
                match ty {
                    VarType::Ident => {
                        if !is_ident(value) {
                            return Err(format!(
                                "variable {name}: {value:?} is not a valid identifier"
                            ));
                        }
                        out.push_str(value);
                    }
                    VarType::Int => {
                        let n: i64 = value
                            .trim()
                            .parse()
                            .map_err(|_| format!("variable {name}: {value:?} is not an integer"))?;
                        binds.push(BoundVal::Int(n));
                        out.push('$');
                        out.push_str(&binds.len().to_string());
                    }
                    VarType::Float => {
                        let n: f64 = value
                            .trim()
                            .parse()
                            .map_err(|_| format!("variable {name}: {value:?} is not a number"))?;
                        binds.push(BoundVal::Float(n));
                        out.push('$');
                        out.push_str(&binds.len().to_string());
                    }
                    VarType::Text => {
                        binds.push(BoundVal::Text(value.clone()));
                        out.push('$');
                        out.push_str(&binds.len().to_string());
                    }
                }
                i += 2 + close + 2;
                continue;
            }
        }
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&sql[i..i + ch_len]);
        i += ch_len;
    }
    Ok((out, binds))
}

/// Bind the interpolation output onto a positional sqlx query, in order.
pub fn bind_all<'q>(
    mut q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    binds: &'q [BoundVal],
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    for b in binds {
        q = match b {
            BoundVal::Text(s) => q.bind(s.as_str()),
            BoundVal::Int(n) => q.bind(*n),
            BoundVal::Float(f) => q.bind(*f),
        };
    }
    q
}

fn utf8_len(first: u8) -> usize {
    match first {
        b if b < 0x80 => 1,
        b if b >> 5 == 0b110 => 2,
        b if b >> 4 == 0b1110 => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types(pairs: &[(&str, VarType)]) -> BTreeMap<String, VarType> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }
    fn supplied(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn text_and_int_become_bound_params_in_order() {
        let (sql, binds) = interpolate(
            "SELECT * FROM t WHERE venue = {{venue}} AND days > {{days}}",
            &types(&[("venue", VarType::Text), ("days", VarType::Int)]),
            &supplied(&[("venue", "BINANCE"), ("days", "30")]),
        )
        .unwrap();
        assert_eq!(sql, "SELECT * FROM t WHERE venue = $1 AND days > $2");
        assert_eq!(
            binds,
            vec![BoundVal::Text("BINANCE".into()), BoundVal::Int(30)]
        );
    }

    #[test]
    fn injection_value_stays_a_bound_param() {
        let (sql, binds) = interpolate(
            "WHERE v = {{v}}",
            &types(&[("v", VarType::Text)]),
            &supplied(&[("v", "x'; DROP TABLE users;--")]),
        )
        .unwrap();
        assert_eq!(sql, "WHERE v = $1");
        assert_eq!(
            binds,
            vec![BoundVal::Text("x'; DROP TABLE users;--".into())]
        );
    }

    #[test]
    fn ident_is_inlined_only_when_safe() {
        let (sql, binds) = interpolate(
            "ORDER BY {{col}}",
            &types(&[("col", VarType::Ident)]),
            &supplied(&[("col", "created_at")]),
        )
        .unwrap();
        assert_eq!(sql, "ORDER BY created_at");
        assert!(binds.is_empty());

        let err = interpolate(
            "ORDER BY {{col}}",
            &types(&[("col", VarType::Ident)]),
            &supplied(&[("col", "created_at; DROP TABLE t")]),
        )
        .unwrap_err();
        assert!(err.contains("not a valid identifier"), "{err}");
    }

    #[test]
    fn unknown_variable_is_a_loud_error() {
        let err = interpolate("SELECT {{ghost}}", &types(&[]), &supplied(&[])).unwrap_err();
        assert!(err.contains("unknown template variable"), "{err}");
    }

    #[test]
    fn non_numeric_int_value_rejected() {
        let err = interpolate(
            "x > {{n}}",
            &types(&[("n", VarType::Int)]),
            &supplied(&[("n", "not-a-number")]),
        )
        .unwrap_err();
        assert!(err.contains("not an integer"), "{err}");
    }

    #[test]
    fn repeated_var_binds_each_occurrence() {
        let (sql, binds) = interpolate(
            "a = {{v}} OR b = {{v}}",
            &types(&[("v", VarType::Int)]),
            &supplied(&[("v", "5")]),
        )
        .unwrap();
        assert_eq!(sql, "a = $1 OR b = $2");
        assert_eq!(binds, vec![BoundVal::Int(5), BoundVal::Int(5)]);
    }

    #[test]
    fn unterminated_braces_left_verbatim() {
        let (sql, binds) = interpolate("SELECT {{ from t", &types(&[]), &supplied(&[])).unwrap();
        assert_eq!(sql, "SELECT {{ from t");
        assert!(binds.is_empty());
    }
}
