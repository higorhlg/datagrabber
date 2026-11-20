//! Copies connection passwords that DataGrip saved in the OS keychain (macOS Keychain, or the
//! Secret Service on Linux) into Datagrabber's own keychain entries. Values move from one keychain
//! item to another inside this process; they are never returned to the UI or logged. The OS asks
//! the user to allow (macOS) or unlock (Linux) access to DataGrip's items.

use serde::Serialize;

use crate::error::CommandResult;
use crate::model::ConnectionConfig;
use crate::storage::secrets::ExternalSecret;

/// Keychain service name DataGrip (IntelliJ Platform) uses for a data source's password.
pub fn datagrip_keychain_service(data_source_uuid: &str) -> String {
    format!("IntelliJ Platform DB \u{2014} {data_source_uuid}")
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PasswordCopyResult {
    pub id: String,
    pub name: String,
    /// copied, already-saved, not-found, not-imported, unavailable or error.
    pub status: &'static str,
    pub message: Option<String>,
}

/// Copies DataGrip passwords for the given connections.
///
/// `explicit` means the user picked these connections, so ones that already have a saved password
/// are overwritten; otherwise they are skipped. `read` looks up a keychain item (service, account)
/// and `save` stores the password for a connection.
pub fn copy_passwords(
    connections: &[ConnectionConfig],
    explicit: bool,
    read: impl Fn(&str, &str) -> ExternalSecret,
    mut save: impl FnMut(&ConnectionConfig, &str) -> CommandResult<()>,
) -> Vec<PasswordCopyResult> {
    connections
        .iter()
        .map(|connection| {
            let result = |status: &'static str, message: Option<String>| PasswordCopyResult {
                id: connection.id.clone(),
                name: connection.name.clone(),
                status,
                message,
            };
            let Some(uuid) = &connection.datagrip_uuid else {
                return result("not-imported", Some("Not imported from DataGrip".to_string()));
            };
            if connection.password_saved && !explicit {
                return result("already-saved", None);
            }
            match read(&datagrip_keychain_service(uuid), &connection.user) {
                ExternalSecret::Found(password) => match save(connection, &password) {
                    Ok(()) => result("copied", None),
                    Err(error) => result("error", Some(error.message)),
                },
                ExternalSecret::NotFound => result("not-found", Some("DataGrip has no saved password for this user".to_string())),
                ExternalSecret::Unavailable(message) => result("unavailable", Some(message)),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SslMode;

    fn connection(id: &str, uuid: Option<&str>, password_saved: bool) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: format!("db-{id}"),
            host: "db.test".into(),
            port: 5432,
            database: "app".into(),
            user: "reader".into(),
            ssl_mode: SslMode::Prefer,
            read_only: false,
            color: String::new(),
            password_saved,
            datagrip_uuid: uuid.map(str::to_string),
        }
    }

    #[test]
    fn copies_found_passwords_and_reports_the_rest() {
        let connections = [
            connection("a", Some("u-a"), false),
            connection("b", Some("u-b"), false),
            connection("c", Some("u-c"), true),
            connection("d", None, false),
            connection("e", Some("u-e"), false),
        ];
        let read = |service: &str, account: &str| {
            assert_eq!(account, "reader");
            match service {
                "IntelliJ Platform DB \u{2014} u-a" | "IntelliJ Platform DB \u{2014} u-c" => ExternalSecret::Found("s3cret".into()),
                "IntelliJ Platform DB \u{2014} u-e" => ExternalSecret::Unavailable("User canceled".into()),
                _ => ExternalSecret::NotFound,
            }
        };
        let mut saved = Vec::new();
        let results = copy_passwords(&connections, false, read, |c, password| {
            saved.push((c.id.clone(), password.to_string()));
            Ok(())
        });
        let statuses: Vec<_> = results.iter().map(|r| (r.id.as_str(), r.status)).collect();
        assert_eq!(
            statuses,
            vec![("a", "copied"), ("b", "not-found"), ("c", "already-saved"), ("d", "not-imported"), ("e", "unavailable")]
        );
        assert_eq!(saved, vec![("a".to_string(), "s3cret".to_string())]);
        assert!(results.iter().all(|r| !format!("{r:?}").contains("s3cret")), "results must never carry the password");
    }

    #[test]
    fn explicit_requests_replace_saved_passwords() {
        let connections = [connection("c", Some("u-c"), true)];
        let results = copy_passwords(&connections, true, |_, _| ExternalSecret::Found("new".into()), |_, _| Ok(()));
        assert_eq!(results[0].status, "copied");
    }
}
