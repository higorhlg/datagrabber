//! Connection passwords in the OS keychain (service "datagrabber", account = connection id).
//! With DATAGRABBER_SECRETS=memory they stay in process memory instead, which tests use so they
//! never touch the real keychain (and other apps' items can be faked for the end-to-end test).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::error::{CommandError, CommandResult};

const SERVICE: &str = "datagrabber";

fn memory() -> Option<&'static Mutex<HashMap<String, String>>> {
    static STORE: OnceLock<Option<Mutex<HashMap<String, String>>>> = OnceLock::new();
    STORE
        .get_or_init(|| (std::env::var("DATAGRABBER_SECRETS").as_deref() == Ok("memory")).then(|| Mutex::new(fake_external_secrets())))
        .as_ref()
}

/// In memory mode only: other applications' keychain items to pretend exist, from
/// DATAGRABBER_TEST_EXTERNAL_SECRETS (JSON `[[service, account, password], ...]`). Lets the
/// end-to-end test exercise the DataGrip password copy without a real keychain.
fn fake_external_secrets() -> HashMap<String, String> {
    let raw = std::env::var("DATAGRABBER_TEST_EXTERNAL_SECRETS").unwrap_or_default();
    let entries: Vec<(String, String, String)> = serde_json::from_str(&raw).unwrap_or_default();
    entries.into_iter().map(|(service, account, password)| (external_key(&service, &account), password)).collect()
}

fn external_key(service: &str, account: &str) -> String {
    format!("external\u{0}{service}\u{0}{account}")
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

/// Result of reading a password another application stored in the keychain.
pub enum ExternalSecret {
    Found(String),
    NotFound,
    /// The user declined the macOS access prompt, or the keychain refused for another reason.
    Unavailable(String),
}

/// Reads a password stored by another application (e.g. DataGrip) under `service` / `account`.
/// macOS shows its own prompt asking the user to allow access to that item. The value is returned
/// to the caller only; it is never logged.
pub fn read_external(service: &str, account: &str) -> ExternalSecret {
    if let Some(store) = memory() {
        return match store.lock().unwrap().get(&external_key(service, account)) {
            Some(password) => ExternalSecret::Found(password.clone()),
            None => ExternalSecret::NotFound,
        };
    }
    match keyring::Entry::new(service, account).and_then(|entry| entry.get_password()) {
        Ok(password) => ExternalSecret::Found(password),
        Err(keyring::Error::NoEntry) => read_external_by_service(service),
        Err(error) => ExternalSecret::Unavailable(error.to_string()),
    }
}

/// Fallback when no item matches the account: the first generic password with this service name,
/// whatever account it was saved under.
#[cfg(target_os = "macos")]
fn read_external_by_service(service: &str) -> ExternalSecret {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit, SearchResult};
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    let found =
        ItemSearchOptions::new().class(ItemClass::generic_password()).service(service).load_data(true).limit(Limit::Max(1)).search();
    match found {
        Ok(results) => match results.into_iter().next() {
            Some(SearchResult::Data(bytes)) => String::from_utf8(bytes)
                .map_or_else(|_| ExternalSecret::Unavailable("The saved password is not valid text".to_string()), ExternalSecret::Found),
            _ => ExternalSecret::NotFound,
        },
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => ExternalSecret::NotFound,
        Err(error) => ExternalSecret::Unavailable(error.to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
fn read_external_by_service(_service: &str) -> ExternalSecret {
    ExternalSecret::NotFound
}
