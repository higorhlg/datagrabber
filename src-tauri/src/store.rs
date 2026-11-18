//! Files under the data directory (~/.datagrabber, or $DATAGRABBER_HOME): connections.json,
//! history.json and consoles/<connection id>.sql. Writes are atomic (temp file + rename) and
//! owner-only, because consoles and history may contain sensitive SQL.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Serialize, de::DeserializeOwned};

use crate::error::CommandResult;

/// Resolves the data directory.
pub fn data_dir() -> PathBuf {
    std::env::var_os("DATAGRABBER_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".datagrabber"))
}

/// Reads a JSON file, returning `fallback` when it does not exist yet.
pub fn read_json<T: DeserializeOwned>(relative: &str, fallback: T) -> CommandResult<T> {
    match fs::read_to_string(data_dir().join(relative)) {
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(fallback),
        Err(error) => Err(error.into()),
    }
}

/// Writes a JSON file atomically.
pub fn write_json<T: Serialize + ?Sized>(relative: &str, value: &T) -> CommandResult<()> {
    write_text(relative, &serde_json::to_string_pretty(value)?)
}

/// Reads a text file, returning an empty string when it does not exist yet.
pub fn read_text(relative: &str) -> CommandResult<String> {
    match fs::read_to_string(data_dir().join(relative)) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.into()),
    }
}

/// Writes a text file atomically with mode 0600, creating parent folders with mode 0700.
pub fn write_text(relative: &str, contents: &str) -> CommandResult<()> {
    let target = data_dir().join(relative);
    create_private_dirs(target.parent().unwrap_or(Path::new(".")))?;
    let temp = target.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&temp)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    fs::rename(&temp, &target)?;
    Ok(())
}

/// Creates a directory tree, restricting each newly created directory to the owner.
fn create_private_dirs(dir: &Path) -> CommandResult<()> {
    if dir.exists() {
        return Ok(());
    }
    if let Some(parent) = dir.parent() {
        create_private_dirs(parent)?;
    }
    fs::create_dir(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Deletes a file in the data directory if it exists.
pub fn remove(relative: &str) -> CommandResult<()> {
    match fs::remove_file(data_dir().join(relative)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}
