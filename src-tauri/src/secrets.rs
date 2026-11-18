//! Connection passwords in the OS keychain (service "datagrabber", account = connection id).
//! With DATAGRABBER_SECRETS=memory they stay in process memory instead, which tests use so they
//! never touch the real keychain.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::error::{CommandError, CommandResult};

const SERVICE: &str = "datagrabber";

fn memory() -> Option<&'static Mutex<HashMap<String, String>>> {
    static STORE: OnceLock<Option<Mutex<HashMap<String, String>>>> = OnceLock::new();
    STORE
        .get_or_init(|| (std::env::var("DATAGRABBER_SECRETS").as_deref() == Ok("memory")).then(|| Mutex::new(HashMap::new())))
        .as_ref()
}

fn entry(id: &str) -> CommandResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, id).map_err(|e| CommandError::new(format!("Keychain unavailable: {e}")))
}

/// Returns the saved password, or None when nothing is stored.
pub fn get(id: &str) -> CommandResult<Option<String>> {
    if let Some(store) = memory() {
        return Ok(store.lock().unwrap().get(id).cloned());
    }
    match entry(id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CommandError::new(format!("Could not read the keychain: {e}"))),
    }
}

/// Saves (or replaces) the password.
pub fn set(id: &str, password: &str) -> CommandResult<()> {
    if let Some(store) = memory() {
        store.lock().unwrap().insert(id.to_string(), password.to_string());
        return Ok(());
    }
    entry(id)?.set_password(password).map_err(|e| CommandError::new(format!("Could not save to the keychain: {e}")))
}

/// Deletes the password if one is stored.
pub fn delete(id: &str) -> CommandResult<()> {
    if let Some(store) = memory() {
        store.lock().unwrap().remove(id);
        return Ok(());
    }
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(CommandError::new(format!("Could not update the keychain: {e}"))),
    }
}
