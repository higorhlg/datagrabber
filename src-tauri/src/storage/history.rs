//! Executed-statement history (history.json), newest MAX_ENTRIES kept across all connections.

use std::sync::Mutex;

use super::{read_json, write_json};
use crate::error::CommandResult;
use crate::model::HistoryEntry;

const FILE: &str = "history.json";
const MAX_ENTRIES: usize = 2000;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Appends a run to the history file. Writes are serialized so concurrent runs never drop entries.
pub fn record(connection_id: &str, sql: &str, duration_ms: u64, ok: bool, row_count: Option<u64>) -> CommandResult<()> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let mut entries: Vec<HistoryEntry> = read_json(FILE, Vec::new())?;
    entries.push(HistoryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: connection_id.to_string(),
        sql: sql.to_string(),
        at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        duration_ms,
        ok,
        row_count,
    });
    let excess = entries.len().saturating_sub(MAX_ENTRIES);
    write_json(FILE, &entries[excess..])
}

/// Lists one connection's history, newest first.
pub fn list(connection_id: &str, limit: usize) -> CommandResult<Vec<HistoryEntry>> {
    let entries: Vec<HistoryEntry> = read_json(FILE, Vec::new())?;
    Ok(entries.into_iter().rev().filter(|e| e.connection_id == connection_id).take(limit).collect())
}
