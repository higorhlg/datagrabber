//! Saved connections, passwords and opening/closing sessions.

use serde::Deserialize;
use tauri::State;

use crate::db::session::{self, Sessions};
use crate::error::CommandResult;
use crate::model::{ConnectInfo, ConnectionConfig, ConnectionInput, ConnectionSummary, TestInfo};
use crate::storage::{connections, consoles, saved, secrets};

/// Optional password typed by the user, and whether to keep it in the keychain.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChoice {
    pub password: Option<String>,
    pub save_password: Option<bool>,
}

/// Stores or forgets the keychain password per the user's choice (only when a password was given).
fn remember_password(connection: &ConnectionConfig, choice: &PasswordChoice) -> CommandResult<()> {
    let (Some(password), Some(save)) = (&choice.password, choice.save_password) else {
        return Ok(());
    };
    if save {
        secrets::set(&connection.id, password)?;
    } else {
        secrets::delete(&connection.id)?;
    }
    connections::set_password_saved(&connection.id, save)
}

#[tauri::command]
pub fn list_connections(sessions: State<'_, Sessions>) -> CommandResult<Vec<ConnectionSummary>> {
    Ok(connections::list()?.into_iter().map(|config| ConnectionSummary { connected: sessions.is_connected(&config.id), config }).collect())
}

#[tauri::command]
pub fn create_connection(input: ConnectionInput, choice: Option<PasswordChoice>) -> CommandResult<ConnectionConfig> {
    let saved = connections::save(input, None)?;
    remember_password(&saved, &choice.unwrap_or_default())?;
    connections::get(&saved.id)
}

/// Updates a connection; its open session is closed so the next use picks up the new settings.
#[tauri::command]
pub fn update_connection(
    id: String,
    input: ConnectionInput,
    choice: Option<PasswordChoice>,
    sessions: State<'_, Sessions>,
) -> CommandResult<ConnectionConfig> {
    let saved = connections::save(input, Some(&id))?;
    sessions.close(&id);
    remember_password(&saved, &choice.unwrap_or_default())?;
    connections::get(&saved.id)
}

/// Deletes a connection together with its console file, saved queries and keychain password.
#[tauri::command]
pub fn delete_connection(id: String, sessions: State<'_, Sessions>) -> CommandResult<()> {
    connections::get(&id)?;
    sessions.close(&id);
    secrets::delete(&id)?;
    consoles::remove(&id)?;
    saved::delete_for_connection(&id)?;
    connections::delete(&id)
}

/// Checks connection settings (saved or unsaved) without keeping a session open.
#[tauri::command]
pub async fn test_connection(input: ConnectionInput, id: Option<String>, password: Option<String>) -> CommandResult<TestInfo> {
    let existing = id.as_deref().map(connections::get).transpose()?;
    let config = connections::to_config(connections::validate(input)?, existing.as_ref());
    Ok(TestInfo { server_version: session::test(&config, password).await? })
}

/// Opens (or reuses) a session; with a typed password, optionally remembers it once it works.
#[tauri::command]
pub async fn connect(id: String, choice: Option<PasswordChoice>, sessions: State<'_, Sessions>) -> CommandResult<ConnectInfo> {
    let choice = choice.unwrap_or_default();
    let config = connections::get(&id)?;
    let session = sessions.open(config.clone(), choice.password.clone()).await?;
    remember_password(&config, &choice)?;
    Ok(ConnectInfo { server_version: session.server_version.clone() })
}

#[tauri::command]
pub fn disconnect(id: String, sessions: State<'_, Sessions>) {
    sessions.close(&id);
}

#[tauri::command]
pub fn forget_password(id: String) -> CommandResult<()> {
    secrets::delete(&id)?;
    connections::set_password_saved(&id, false)
}
