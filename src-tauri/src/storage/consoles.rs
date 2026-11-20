//! Console text per connection (consoles/<connection id>.sql). Callers check that the connection
//! exists first, so ids are known UUIDs and cannot point outside the folder.

use crate::error::CommandResult;

fn path(connection_id: &str) -> String {
    format!("consoles/{connection_id}.sql")
}

/// The saved console text, or an empty string for a new console.
pub fn load(connection_id: &str) -> CommandResult<String> {
    super::read_text(&path(connection_id))
}

pub fn save(connection_id: &str, text: &str) -> CommandResult<()> {
    super::write_text(&path(connection_id), text)
}

pub fn remove(connection_id: &str) -> CommandResult<()> {
    super::remove(&path(connection_id))
}
