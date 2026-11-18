//! Imports connection metadata from a DataGrip project (.idea/dataSources.xml + dataSources.local.xml).
//! DataGrip's encrypted password store is never opened: passwords are asked on first connect.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::error::{CommandError, CommandResult};
use crate::model::{ConnectionConfig, ConnectionInput, DatagripCandidate, SslMode};

/// Default DataGrip project metadata folder.
pub fn default_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join("DataGripProjects").join(".idea")
}

/// Child element text of a data-source element, trimmed; None when absent or empty.
fn child_text(node: roxmltree::Node, name: &str) -> Option<String> {
    node.children()
        .find(|c| c.has_tag_name(name))
        .and_then(|c| c.text())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// A data source's fields that matter for import.
struct XmlDataSource {
    uuid: String,
    name: String,
    driver: Option<String>,
    jdbc_url: Option<String>,
    user: Option<String>,
}

/// Parses every data-source element of a DataGrip XML document.
fn parse_data_sources(xml: &str) -> CommandResult<Vec<XmlDataSource>> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| CommandError::new(format!("Invalid DataGrip XML: {e}")))?;
    Ok(doc
        .descendants()
        .filter(|n| n.has_tag_name("data-source"))
        .map(|n| XmlDataSource {
            uuid: n.attribute("uuid").unwrap_or_default().to_string(),
            name: n.attribute("name").unwrap_or_default().to_string(),
            driver: child_text(n, "driver-ref"),
            jdbc_url: child_text(n, "jdbc-url"),
            user: child_text(n, "user-name"),
        })
        .collect())
}

/// Reads one DataGrip XML file; a missing optional file yields no data sources.
fn read_data_sources(path: &Path, required: bool) -> CommandResult<Vec<XmlDataSource>> {
    match std::fs::read_to_string(path) {
        Ok(xml) => parse_data_sources(&xml),
        Err(e) if !required && e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(CommandError::new(format!("Cannot read {}: {e}", path.display()))),
    }
}

/// Host, port, database and URL options of a PostgreSQL JDBC URL.
#[derive(Debug, PartialEq)]
pub struct JdbcTarget {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub ssl_mode: Option<SslMode>,
    pub user: Option<String>,
}

/// Parses `jdbc:postgresql://host[:port][/database][?params]`. Returns None for other drivers
/// and for multi-host URLs.
pub fn parse_postgres_jdbc_url(url: &str) -> Option<JdbcTarget> {
    let rest = url.trim().strip_prefix("jdbc:postgresql://")?;
    let (address_and_db, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (address, database) = address_and_db.split_once('/').unwrap_or((address_and_db, ""));
    if address.is_empty() || address.contains(',') {
        return None;
    }
    let (host, port) = if let Some(bracketed) = address.strip_prefix('[') {
        let (host, after) = bracketed.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(port) => port.parse().ok()?,
            None => 5432,
        };
        (host, port)
    } else {
        match address.rsplit_once(':') {
            Some((host, port)) => (host, port.parse().ok()?),
            None => (address, 5432),
        }
    };
    let params: HashMap<&str, &str> = query.split('&').filter_map(|pair| pair.split_once('=')).collect();
    let ssl_mode = match params.get("sslmode").copied() {
        Some("disable") => Some(SslMode::Disable),
        Some("prefer" | "allow") => Some(SslMode::Prefer),
        Some("require") => Some(SslMode::Require),
        Some("verify-ca" | "verify-full") => Some(SslMode::VerifyFull),
        _ if params.get("ssl") == Some(&"true") => Some(SslMode::Require),
        _ => None,
    };
    Some(JdbcTarget {
        host: host.to_string(),
        port,
        database: if database.is_empty() { "postgres".to_string() } else { database.to_string() },
        ssl_mode,
        user: params.get("user").map(|u| u.to_string()),
    })
}

/// Picks a sidebar color from environment words in a name: prod → red, qa/staging → amber, dev → green.
pub fn color_for_name(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let has_word = |word: &str| lower.split(|c: char| !c.is_ascii_alphanumeric()).any(|part| part == word);
    if lower.contains("prod") {
        "#dc2626"
    } else if has_word("qa") || has_word("uat") || lower.contains("stag") {
        "#d97706"
    } else if lower.contains("dev") || lower.contains("local") {
        "#16a34a"
    } else {
        "#64748b"
    }
}

/// Builds an import candidate from the shared and local halves of a data source.
fn to_candidate(shared: &XmlDataSource, local: Option<&XmlDataSource>, existing: &[ConnectionConfig]) -> DatagripCandidate {
    let driver = shared.driver.clone().unwrap_or_else(|| "unknown".to_string());
    let mut candidate = DatagripCandidate {
        uuid: shared.uuid.clone(),
        name: if shared.name.is_empty() { shared.uuid.clone() } else { shared.name.clone() },
        driver: driver.clone(),
        host: None,
        port: None,
        database: None,
        user: None,
        ssl_mode: None,
        importable: false,
        reason: None,
        existing_id: existing.iter().find(|c| c.datagrip_uuid.as_deref() == Some(&shared.uuid)).map(|c| c.id.clone()),
    };
    if driver != "postgresql" {
        candidate.reason = Some(format!("Driver \"{driver}\" is not supported yet (PostgreSQL only)"));
        return candidate;
    }
    let Some(target) = shared.jdbc_url.as_deref().and_then(parse_postgres_jdbc_url) else {
        candidate.reason = Some("JDBC URL is missing or not a single-host PostgreSQL URL".to_string());
        return candidate;
    };
    candidate.user = local.and_then(|l| l.user.clone()).or(target.user);
    candidate.host = Some(target.host);
    candidate.port = Some(target.port);
    candidate.database = Some(target.database);
    candidate.ssl_mode = target.ssl_mode;
    candidate.importable = candidate.user.is_some();
    if !candidate.importable {
        candidate.reason = Some("No user name saved in DataGrip".to_string());
    }
    candidate
}

/// Lists the data sources of a DataGrip project folder as import candidates.
pub fn preview(dir: &Path, existing: &[ConnectionConfig]) -> CommandResult<Vec<DatagripCandidate>> {
    let shared = read_data_sources(&dir.join("dataSources.xml"), true)?;
    let local = read_data_sources(&dir.join("dataSources.local.xml"), false)?;
    let local_by_uuid: HashMap<&str, &XmlDataSource> = local.iter().map(|l| (l.uuid.as_str(), l)).collect();
    Ok(shared.iter().map(|s| to_candidate(s, local_by_uuid.get(s.uuid.as_str()).copied(), existing)).collect())
}

/// Connection fields for an importable candidate. Production-looking names start read-only;
/// remote hosts default to sslmode prefer unless the URL says otherwise.
pub fn candidate_to_input(candidate: &DatagripCandidate) -> ConnectionInput {
    let host = candidate.host.clone().unwrap_or_default();
    let is_local = host == "localhost" || host == "127.0.0.1" || host == "::1";
    ConnectionInput {
        name: candidate.name.clone(),
        port: candidate.port.unwrap_or(5432),
        database: candidate.database.clone().unwrap_or_else(|| "postgres".to_string()),
        user: candidate.user.clone().unwrap_or_default(),
        ssl_mode: candidate.ssl_mode.unwrap_or(if is_local { SslMode::Disable } else { SslMode::Prefer }),
        read_only: candidate.name.to_lowercase().contains("prod"),
        color: Some(color_for_name(&candidate.name).to_string()),
        datagrip_uuid: Some(candidate.uuid.clone()),
        host,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_jdbc_urls() {
        assert_eq!(
            parse_postgres_jdbc_url("jdbc:postgresql://db.example.com:6543/orders?sslmode=require&user=app"),
            Some(JdbcTarget { host: "db.example.com".into(), port: 6543, database: "orders".into(), ssl_mode: Some(SslMode::Require), user: Some("app".into()) })
        );
        assert_eq!(
            parse_postgres_jdbc_url("jdbc:postgresql://localhost/app"),
            Some(JdbcTarget { host: "localhost".into(), port: 5432, database: "app".into(), ssl_mode: None, user: None })
        );
        assert_eq!(parse_postgres_jdbc_url("jdbc:postgresql://a:1,b:2/x"), None);
        assert_eq!(parse_postgres_jdbc_url("jdbc:mysql://h/x"), None);
    }

    #[test]
    fn picks_environment_colors() {
        assert_eq!(color_for_name("SHOP_PROD_ORDERS"), "#dc2626");
        assert_eq!(color_for_name("sub qa"), "#d97706");
        assert_eq!(color_for_name("engine-qa"), "#d97706");
        assert_eq!(color_for_name("fulfillment-dev"), "#16a34a");
        assert_eq!(color_for_name("quality"), "#64748b");
    }

    #[test]
    fn joins_shared_and_local_halves() {
        let dir = std::env::temp_dir().join(format!("dg-import-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("dataSources.xml"),
            r#"<project version="4"><component name="DataSourceManagerImpl">
                <data-source source="LOCAL" name="shop prod" uuid="u1"><driver-ref>postgresql</driver-ref><jdbc-url>jdbc:postgresql://db.test:5432/shop</jdbc-url></data-source>
                <data-source source="LOCAL" name="cache" uuid="u2"><driver-ref>redis</driver-ref><jdbc-url>jdbc:redis://x</jdbc-url></data-source>
            </component></project>"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("dataSources.local.xml"),
            r#"<project version="4"><component name="dataSourceStorageLocal"><data-source name="shop prod" uuid="u1"><user-name>reader</user-name></data-source></component></project>"#,
        )
        .unwrap();
        let candidates = preview(&dir, &[]).unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(candidates[0].importable);
        assert_eq!(candidates[0].user.as_deref(), Some("reader"));
        assert!(!candidates[1].importable);
        let input = candidate_to_input(&candidates[0]);
        assert!(input.read_only);
        assert_eq!(input.ssl_mode, SslMode::Prefer);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
