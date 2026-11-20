//! Per-connection history, saved queries, console text, and exports.

use crate::error::CommandResult;
use crate::model::{HistoryEntry, SavedQuery};
use crate::storage::{connections, consoles, exports, history, saved};

const HISTORY_LIMIT: usize = 200;

#[tauri::command]
pub fn list_history(id: String) -> CommandResult<Vec<HistoryEntry>> {
    history::list(&id, HISTORY_LIMIT)
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
pub fn load_console(id: String) -> CommandResult<String> {
    connections::get(&id)?;
    consoles::load(&id)
}

#[tauri::command]
pub fn save_console(id: String, text: String) -> CommandResult<()> {
    connections::get(&id)?;
    consoles::save(&id, &text)
}

/// Writes exported results to ~/Downloads and returns the path written.
#[tauri::command]
pub fn save_export(file_name: String, contents: String) -> CommandResult<String> {
    exports::save_to_downloads(&file_name, &contents)
}
