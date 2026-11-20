//! Importing DataGrip data sources and copying their saved passwords.

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::datagrip::{self, passwords};
use crate::db::session::Sessions;
use crate::error::{CommandError, CommandResult};
use crate::model::{ConnectionConfig, DatagripCandidate};
use crate::storage::{connections, secrets};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatagripPreview {
    dir: String,
    candidates: Vec<DatagripCandidate>,
}

/// Resolves the DataGrip folder the user typed (supporting `~/`), defaulting to ~/DataGripProjects/.idea.
fn datagrip_dir(dir: Option<String>) -> PathBuf {
    match dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) {
        Some(d) if d.starts_with("~/") => dirs::home_dir().unwrap_or_default().join(&d[2..]),
        Some(d) => PathBuf::from(d),
        None => datagrip::default_dir(),
    }
}

#[tauri::command]
pub fn preview_datagrip(dir: Option<String>) -> CommandResult<DatagripPreview> {
    let dir = datagrip_dir(dir);
    let candidates = datagrip::preview(&dir, &connections::list()?)?;
    Ok(DatagripPreview { dir: dir.display().to_string(), candidates })
}

/// Imports the chosen data sources. Re-importing updates host/port/database/user/name and keeps
/// the user's own read-only, color and TLS choices.
#[tauri::command]
pub fn import_datagrip(uuids: Vec<String>, dir: Option<String>, sessions: State<'_, Sessions>) -> CommandResult<Vec<ConnectionConfig>> {
    let candidates = datagrip::preview(&datagrip_dir(dir), &connections::list()?)?;
    let mut imported = Vec::new();
    for candidate in candidates.iter().filter(|c| c.importable && uuids.contains(&c.uuid)) {
        let mut input = datagrip::candidate_to_input(candidate);
        if let Some(existing_id) = &candidate.existing_id {
            let existing = connections::get(existing_id)?;
            input.read_only = existing.read_only;
            input.color = Some(existing.color);
            input.ssl_mode = existing.ssl_mode;
            sessions.close(existing_id);
        }
        imported.push(connections::save(input, candidate.existing_id.as_deref())?);
    }
    Ok(imported)
}

/// Copies passwords DataGrip saved in the OS keychain into this app's keychain entries.
/// With `ids`, only those connections (replacing saved passwords); without, every imported
/// connection that has no saved password yet. Runs off the main thread because macOS may show an
/// access prompt for each DataGrip item and wait for the user.
#[tauri::command]
pub async fn copy_datagrip_passwords(ids: Option<Vec<String>>) -> CommandResult<Vec<passwords::PasswordCopyResult>> {
    tokio::task::spawn_blocking(move || {
        let all = connections::list()?;
        let explicit = ids.is_some();
        let chosen: Vec<ConnectionConfig> = match &ids {
            Some(ids) => all.into_iter().filter(|c| ids.contains(&c.id)).collect(),
            None => all.into_iter().filter(|c| c.datagrip_uuid.is_some()).collect(),
        };
        Ok(passwords::copy_passwords(&chosen, explicit, secrets::read_external, |connection, password| {
            secrets::set(&connection.id, password)?;
            connections::set_password_saved(&connection.id, true)
        }))
    })
    .await
    .map_err(|e| CommandError::new(e.to_string()))?
}
