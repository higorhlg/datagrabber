//! Saved connections (connections.json).

use super::{read_json, write_json};
use crate::error::{CommandError, CommandResult};
use crate::model::{ConnectionConfig, ConnectionInput};

const FILE: &str = "connections.json";
const DEFAULT_COLOR: &str = "#64748b";

/// Serializes read-modify-write cycles on connections.json across concurrent commands.
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Lists saved connections in name order.
pub fn list() -> CommandResult<Vec<ConnectionConfig>> {
    let mut connections: Vec<ConnectionConfig> = read_json(FILE, Vec::new())?;
    connections.sort_by_key(|c| c.name.to_lowercase());
    Ok(connections)
}

/// Loads one connection, failing when the id is unknown.
pub fn get(id: &str) -> CommandResult<ConnectionConfig> {
    list()?.into_iter().find(|c| c.id == id).ok_or_else(|| CommandError::new(format!("Unknown connection {id}")))
}

/// Validates form input, trimming text fields.
pub fn validate(mut input: ConnectionInput) -> CommandResult<ConnectionInput> {
    for (label, value) in
        [("name", &mut input.name), ("host", &mut input.host), ("database", &mut input.database), ("user", &mut input.user)]
    {
        *value = value.trim().to_string();
        if value.is_empty() {
            return Err(CommandError::new(format!("{label} is required")));
        }
    }
    if input.port == 0 {
        return Err(CommandError::new("port must be 1-65535"));
    }
    Ok(input)
}

/// Builds a config from input, keeping id and password flag of an existing connection.
pub fn to_config(input: ConnectionInput, existing: Option<&ConnectionConfig>) -> ConnectionConfig {
    ConnectionConfig {
        id: existing.map(|c| c.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name: input.name,
        host: input.host,
        port: input.port,
        database: input.database,
        user: input.user,
        ssl_mode: input.ssl_mode,
        read_only: input.read_only,
        color: input.color.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| DEFAULT_COLOR.to_string()),
        password_saved: existing.is_some_and(|c| c.password_saved),
        datagrip_uuid: input.datagrip_uuid.or_else(|| existing.and_then(|c| c.datagrip_uuid.clone())),
    }
}

/// Creates a connection, or replaces the editable fields of an existing one.
pub fn save(input: ConnectionInput, id: Option<&str>) -> CommandResult<ConnectionConfig> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let input = validate(input)?;
    let mut connections = list()?;
    let existing = match id {
        Some(id) => {
            Some(connections.iter().find(|c| c.id == id).cloned().ok_or_else(|| CommandError::new(format!("Unknown connection {id}")))?)
        }
        None => None,
    };
    let saved = to_config(input, existing.as_ref());
    connections.retain(|c| c.id != saved.id);
    connections.push(saved.clone());
    write_json(FILE, &connections)?;
    Ok(saved)
}

/// Records whether the keychain holds a password for this connection.
pub fn set_password_saved(id: &str, saved: bool) -> CommandResult<()> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let connections: Vec<ConnectionConfig> =
        list()?.into_iter().map(|c| if c.id == id { ConnectionConfig { password_saved: saved, ..c } } else { c }).collect();
    write_json(FILE, &connections)
}

/// Removes a connection from the saved list. Does not touch the keychain.
pub fn delete(id: &str) -> CommandResult<()> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let connections: Vec<ConnectionConfig> = list()?.into_iter().filter(|c| c.id != id).collect();
    write_json(FILE, &connections)
}
