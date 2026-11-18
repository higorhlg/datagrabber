use serde::Serialize;

/// Error returned to the UI by every command. The flags let the UI react without parsing messages:
/// `needs_password` opens the password prompt, `not_connected` triggers a reconnect.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub message: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub needs_password: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub not_connected: bool,
}

impl CommandError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), needs_password: false, not_connected: false }
    }

    pub fn needs_password(message: impl Into<String>) -> Self {
        Self { needs_password: true, ..Self::new(message) }
    }

    pub fn not_connected(message: impl Into<String>) -> Self {
        Self { not_connected: true, ..Self::new(message) }
    }
}

impl From<std::io::Error> for CommandError {
    fn from(error: std::io::Error) -> Self {
        Self::new(error.to_string())
    }
}

impl From<serde_json::Error> for CommandError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(error.to_string())
    }
}

pub type CommandResult<T> = Result<T, CommandError>;
