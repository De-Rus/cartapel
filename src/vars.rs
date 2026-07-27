use crate::config::Variable;
use crate::interp::VarType;
use crate::state::{AppError, AppState, CurrentUser};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

/// The resolved variable environment for one request: the declared type of every
/// in-scope variable (for [`crate::interp::interpolate`]) and its chosen value
/// (from `v_<name>` params, default-filled). `ident`-typed values are additionally
/// constrained to the variable's option set here, since they are inlined unquoted.
#[derive(Default)]
pub struct Resolved {
    pub types: BTreeMap<String, VarType>,
    pub values: BTreeMap<String, String>,
}

fn visible(var: &Variable, user: &CurrentUser) -> bool {
    user.may(&var.roles, crate::state::Access::Everyone)
}

/// Read the option VALUES of a `query`-backed variable (first column), read-only.
async fn option_values(state: &AppState, var: &Variable) -> Result<Vec<String>, AppError> {
    let Some(sql) = &var.query else {
        return Ok(var.options.clone());
    };
    let rows =
        crate::db::config_query_rows(state.pool_for(var.source.as_deref()), sql, &[], 1000, 8000)
            .await?;
    Ok(rows
        .into_iter()
        .filter_map(|o| {
            o.values().next().map(|first| match first {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
        })
        .collect())
}

/// The option set as `{value, label}` for the var-bar. `query` vars run their SQL
/// (first column = value, optional second = label); static `options` map 1:1.
pub async fn option_pairs(state: &AppState, var: &Variable) -> Result<Vec<Value>, AppError> {
    if var.query.is_none() {
        return Ok(var
            .options
            .iter()
            .map(|o| serde_json::json!({ "value": o, "label": o }))
            .collect());
    }
    let sql = var.query.as_ref().unwrap();
    let rows =
        crate::db::config_query_rows(state.pool_for(var.source.as_deref()), sql, &[], 1000, 8000)
            .await?;
    Ok(rows
        .into_iter()
        .filter_map(|obj| {
            let mut it = obj.values();
            let value = it.next()?;
            let label = it.next().unwrap_or(value);
            let as_str = |x: &Value| match x {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            Some(serde_json::json!({ "value": as_str(value), "label": as_str(label) }))
        })
        .collect())
}

/// Resolve every in-scope global variable's value from the request. A supplied
/// value outside a static option set — or outside a query set for an `ident` var —
/// is a hard 400, never a silent fallback.
pub async fn resolve(
    state: &AppState,
    user: &CurrentUser,
    params: &HashMap<String, String>,
) -> Result<Resolved, AppError> {
    let cfg = state.cfg();
    let mut types = BTreeMap::new();
    let mut values = BTreeMap::new();
    for (name, var) in cfg.variables.iter() {
        if !visible(var, user) {
            continue;
        }
        let ty = var.resolved_type();
        let supplied = params.get(&format!("v_{name}")).cloned();
        let value = match supplied {
            Some(v) => {
                if !var.options.is_empty() && !var.options.contains(&v) {
                    return Err(AppError::bad(format!(
                        "variable {name}: {v:?} is not an allowed value"
                    )));
                }
                if ty == VarType::Ident && var.options.is_empty() {
                    let set = option_values(state, var).await?;
                    if !set.contains(&v) {
                        return Err(AppError::bad(format!(
                            "variable {name}: {v:?} is not an allowed value"
                        )));
                    }
                }
                v
            }
            None => var
                .default
                .clone()
                .or_else(|| var.options.first().cloned())
                .unwrap_or_default(),
        };
        types.insert(name.clone(), ty);
        values.insert(name.clone(), value);
    }
    Ok(Resolved { types, values })
}
