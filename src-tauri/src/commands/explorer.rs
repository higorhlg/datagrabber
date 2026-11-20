//! Database structure for the explorer tree, and object DDL.

use tauri::State;

use crate::db::session::Sessions;
use crate::db::{ddl, introspect};
use crate::error::CommandResult;
use crate::model::DatabaseSchema;

#[tauri::command]
pub async fn schema(id: String, sessions: State<'_, Sessions>) -> CommandResult<DatabaseSchema> {
    let session = sessions.get(&id)?;
    introspect::introspect(&session).await
}

/// DDL of an explorer object; `kind` is "relation", "sequence" or "routine".
#[tauri::command]
pub async fn object_ddl(
    id: String,
    schema: String,
    name: String,
    kind: String,
    arguments: Option<String>,
    sessions: State<'_, Sessions>,
) -> CommandResult<String> {
    let session = sessions.get(&id)?;
    ddl::object_ddl(&session, &schema, &name, &kind, arguments.as_deref()).await
}
