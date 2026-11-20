//! Running console statements and loading table pages.

use tauri::State;

use super::connection_lost;
use crate::db::query::{self, TablePageRequest};
use crate::db::session::Sessions;
use crate::error::{CommandError, CommandResult};
use crate::model::{RunResponse, TablePageResponse};
use crate::storage::history;

const DEFAULT_MAX_ROWS: usize = 500;
const MAX_MAX_ROWS: usize = 100_000;

/// Runs one statement on the connection's console and records it in history.
/// SQL errors are returned as data (`ok: false`), not as command failures.
#[tauri::command]
pub async fn run_query(id: String, sql: String, max_rows: Option<usize>, sessions: State<'_, Sessions>) -> CommandResult<RunResponse> {
    if sql.trim().is_empty() {
        return Err(CommandError::new("Nothing to run"));
    }
    let session = sessions.get(&id)?;
    let max_rows = max_rows.filter(|n| *n > 0).unwrap_or(DEFAULT_MAX_ROWS).min(MAX_MAX_ROWS);
    let outcome = query::run_statement(&session, &sql, max_rows).await;
    if session.is_broken() {
        return Err(connection_lost());
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

/// Cancels the statement running on the connection's console.
#[tauri::command]
pub async fn cancel_query(id: String, sessions: State<'_, Sessions>) -> CommandResult<()> {
    sessions.cancel(&id).await
}

/// Loads a page of a table or view for a table tab. SQL errors (e.g. in the filter) are data.
#[tauri::command]
pub async fn table_page(id: String, request: TablePageRequest, sessions: State<'_, Sessions>) -> CommandResult<TablePageResponse> {
    let session = sessions.get(&id)?;
    let sql = query::table_page_sql(&request);
    let outcome = query::fetch_table_page(&session, &request).await;
    if session.is_broken() {
        return Err(connection_lost());
    }
    Ok(match outcome {
        Ok(result) => TablePageResponse::Ok { ok: true, result, sql },
        Err(error) => TablePageResponse::Err { ok: false, error, sql },
    })
}

/// Counts the rows matching a table tab's filter.
#[tauri::command]
pub async fn table_count(
    id: String,
    schema: String,
    table: String,
    filter: Option<String>,
    sessions: State<'_, Sessions>,
) -> CommandResult<u64> {
    let session = sessions.get(&id)?;
    query::count_table_rows(&session, &schema, &table, &filter).await.map_err(|e| CommandError::new(e.message))
}

/// Stops a slow table page, count or schema load (anything on the meta connection).
#[tauri::command]
pub async fn cancel_table_query(id: String, sessions: State<'_, Sessions>) -> CommandResult<()> {
    sessions.cancel_meta(&id).await
}
