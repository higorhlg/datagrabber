//! Tauri commands called by the UI (see web/src/api.ts).

use std::path::PathBuf;

use serde::Deserialize;
use tauri::State;

use crate::error::{CommandError, CommandResult};
use crate::model::{
    ConnectInfo, ConnectionConfig, ConnectionInput, ConnectionSummary, DatabaseSchema, DatagripCandidate, HistoryEntry, RunResponse, SavedQuery,
    TablePageResponse, TestInfo,
};
use crate::query::TablePageRequest;
use crate::session::Sessions;
use crate::{connections, datagrip, ddl, history, introspect, query, saved, secrets, store};

const DEFAULT_MAX_ROWS: usize = 500;
const MAX_MAX_ROWS: usize = 100_000;

/// Optional password typed by the user, and whether to keep it in the keychain.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChoice {
    pub password: Option<String>,
    pub save_password: Option<bool>,
}

/// Stores or forgets the keychain password per the user's choice, once the password is known to work
/// (or, when saving a form, as typed).
fn remember_password(connection: &ConnectionConfig, choice: &PasswordChoice) -> CommandResult<()> {
    let (Some(password), Some(save)) = (&choice.password, choice.save_password) else { return Ok(()) };
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

#[tauri::command]
pub fn update_connection(id: String, input: ConnectionInput, choice: Option<PasswordChoice>, sessions: State<'_, Sessions>) -> CommandResult<ConnectionConfig> {
    let saved = connections::save(input, Some(&id))?;
    sessions.close(&id);
    remember_password(&saved, &choice.unwrap_or_default())?;
    connections::get(&saved.id)
}

/// Deletes a connection together with its console file, saved queries and keychain password.
#[tauri::command]
pub fn delete_connection(id: String, sessions: State<'_, Sessions>) -> CommandResult<()> {
    let path = console_path(&id)?;
    sessions.close(&id);
    secrets::delete(&id)?;
    store::remove(&path)?;
    saved::delete_for_connection(&id)?;
    connections::delete(&id)
}

#[tauri::command]
pub async fn test_connection(input: ConnectionInput, id: Option<String>, password: Option<String>) -> CommandResult<TestInfo> {
    let existing = id.as_deref().map(connections::get).transpose()?;
    let config = connections::to_config(connections::validate(input)?, existing.as_ref());
    Ok(TestInfo { server_version: crate::session::test(&config, password).await? })
}

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

#[tauri::command]
pub async fn schema(id: String, sessions: State<'_, Sessions>) -> CommandResult<DatabaseSchema> {
    let session = sessions.get(&id)?;
    introspect::introspect(&session).await
}

#[tauri::command]
pub async fn run_query(id: String, sql: String, max_rows: Option<usize>, sessions: State<'_, Sessions>) -> CommandResult<RunResponse> {
    if sql.trim().is_empty() {
        return Err(CommandError::new("Nothing to run"));
    }
    let session = sessions.get(&id)?;
    let max_rows = max_rows.filter(|n| *n > 0).unwrap_or(DEFAULT_MAX_ROWS).min(MAX_MAX_ROWS);
    let outcome = query::run_statement(&session, &sql, max_rows).await;
    if session.is_broken() {
        return Err(CommandError::not_connected("The connection was lost. Reconnect to continue."));
    }
    Ok(match outcome {
        Ok(result) => {
            history::record(&id, &sql, result.duration_ms, true, result.row_count)?;
            RunResponse::Ok { ok: true, result }
        }
        Err(error) => {
            history::record(&id, &sql, 0, false, None)?;
            RunResponse::Err { ok: false, error }
        }
    })
}

/// Loads a page of a table or view for a table tab. SQL errors (e.g. in the filter) are data.
#[tauri::command]
pub async fn table_page(id: String, request: TablePageRequest, sessions: State<'_, Sessions>) -> CommandResult<TablePageResponse> {
    let session = sessions.get(&id)?;
    let sql = query::table_page_sql(&request);
    let outcome = query::fetch_table_page(&session, &request).await;
    if session.is_broken() {
        return Err(CommandError::not_connected("The connection was lost. Reconnect to continue."));
    }
    Ok(match outcome {
        Ok(result) => TablePageResponse::Ok { ok: true, result, sql },
        Err(error) => TablePageResponse::Err { ok: false, error, sql },
    })
}

/// Counts the rows matching a table tab's filter.
#[tauri::command]
pub async fn table_count(id: String, schema: String, table: String, filter: Option<String>, sessions: State<'_, Sessions>) -> CommandResult<u64> {
    let session = sessions.get(&id)?;
    query::count_table_rows(&session, &schema, &table, &filter).await.map_err(|e| CommandError::new(e.message))
}

/// DDL of an explorer object; `kind` is "relation", "sequence" or "routine".
#[tauri::command]
pub async fn object_ddl(id: String, schema: String, name: String, kind: String, arguments: Option<String>, sessions: State<'_, Sessions>) -> CommandResult<String> {
    let session = sessions.get(&id)?;
    ddl::object_ddl(&session, &schema, &name, &kind, arguments.as_deref()).await
}

#[tauri::command]
pub fn list_saved_queries(id: String) -> CommandResult<Vec<SavedQuery>> {
    saved::list(&id)
}

#[tauri::command]
pub fn save_query(id: String, name: String, sql: String) -> CommandResult<SavedQuery> {
    connections::get(&id)?;
    saved::save(&id, &name, &sql)
}

#[tauri::command]
pub fn rename_saved_query(query_id: String, name: String) -> CommandResult<()> {
    saved::rename(&query_id, &name)
}

#[tauri::command]
pub fn delete_saved_query(query_id: String) -> CommandResult<()> {
    saved::delete(&query_id)
}

#[tauri::command]
pub async fn cancel_query(id: String, sessions: State<'_, Sessions>) -> CommandResult<()> {
    sessions.cancel(&id).await
}

#[tauri::command]
pub fn list_history(id: String) -> CommandResult<Vec<HistoryEntry>> {
    history::list(&id, 200)
}

/// Console files are named after the connection id; ids are validated so they cannot escape the folder.
fn console_path(id: &str) -> CommandResult<String> {
    connections::get(id)?;
    Ok(format!("consoles/{id}.sql"))
}

#[tauri::command]
pub fn load_console(id: String) -> CommandResult<String> {
    store::read_text(&console_path(&id)?)
}

#[tauri::command]
pub fn save_console(id: String, text: String) -> CommandResult<()> {
    store::write_text(&console_path(&id)?, &text)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatagripPreview {
    dir: String,
    candidates: Vec<DatagripCandidate>,
}

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

/// Writes exported results to ~/Downloads, adding a numeric suffix instead of overwriting.
/// Returns the path written.
#[tauri::command]
pub fn save_export(file_name: String, contents: String) -> CommandResult<String> {
    let safe: String = file_name.chars().map(|c| if c == '/' || c == '\\' || c.is_control() { '_' } else { c }).collect();
    let downloads = dirs::download_dir().ok_or_else(|| CommandError::new("No Downloads folder found"))?;
    let (stem, extension) = safe.rsplit_once('.').unwrap_or((&safe, "txt"));
    let mut path = downloads.join(&safe);
    let mut n = 1;
    while path.exists() {
        path = downloads.join(format!("{stem}-{n}.{extension}"));
        n += 1;
    }
    std::fs::write(&path, contents)?;
    Ok(path.display().to_string())
}

/// UI self-test configuration, present only when the app is launched with DATAGRABBER_E2E set.
#[tauri::command]
pub fn e2e_config() -> Option<serde_json::Value> {
    std::env::var("DATAGRABBER_E2E").ok().and_then(|raw| serde_json::from_str(&raw).ok())
}

/// Prints a self-test progress line immediately (the runner watches for markers).
#[tauri::command]
pub fn e2e_log(line: String) {
    println!("[e2e] {line}");
}

/// Receives the UI self-test outcome, prints it and exits with a matching status code.
#[tauri::command]
pub fn e2e_report(ok: bool, log: Vec<String>, app: tauri::AppHandle) {
    for line in &log {
        println!("[e2e] {line}");
    }
    println!("[e2e] {}", if ok { "PASS" } else { "FAIL" });
    app.exit(if ok { 0 } else { 1 });
}
