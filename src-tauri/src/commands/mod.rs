//! Tauri commands: the UI's whole backend API (mirrored by web/src/lib/api.ts). Each command is a
//! thin adapter that validates input, calls into `db`, `storage` or `datagrip`, and maps the outcome.

pub mod connections;
pub mod datagrip;
pub mod explorer;
pub mod library;
pub mod queries;
pub mod testing;

use crate::error::CommandError;

/// Error for a session whose connection dropped while a command ran.
fn connection_lost() -> CommandError {
    CommandError::not_connected("The connection was lost. Reconnect to continue.")
}
