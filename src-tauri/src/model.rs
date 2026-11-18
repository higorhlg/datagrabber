//! Data shapes shared with the UI (mirrored in shared/types.ts). Serialized as camelCase.

use serde::{Deserialize, Serialize};

/// How TLS is negotiated, mirroring libpq's sslmode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    /// Plain TCP.
    Disable,
    /// TLS without certificate verification when the server offers it, plain TCP otherwise.
    Prefer,
    /// TLS without certificate verification.
    Require,
    /// TLS with certificate and hostname verification.
    VerifyFull,
}

/// A saved connection. Passwords are never part of it; they live in the OS keychain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub ssl_mode: SslMode,
    /// Every session starts with read-only transactions. A guard rail, not a permission boundary.
    pub read_only: bool,
    pub color: String,
    /// True when the keychain holds a password for this connection.
    #[serde(default)]
    pub password_saved: bool,
    /// DataGrip data source uuid, so re-imports update instead of duplicating.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub datagrip_uuid: Option<String>,
}

/// Editable connection fields, as sent by the connection form.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub datagrip_uuid: Option<String>,
}

/// A connection plus live session state, as listed in the sidebar.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    #[serde(flatten)]
    pub config: ConnectionConfig,
    pub connected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub not_null: bool,
    pub default: Option<String>,
    pub primary_key: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub unique: bool,
    pub primary: bool,
    pub definition: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub definition: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationInfo {
    pub name: String,
    /// table, view, materialized view, partitioned table or foreign table.
    pub kind: &'static str,
    pub estimated_rows: Option<i64>,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInfo {
    pub name: String,
    /// Identity arguments, e.g. "customer_id integer, since date".
    pub arguments: String,
    /// function, procedure, aggregate or window.
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    pub relations: Vec<RelationInfo>,
    pub sequences: Vec<String>,
    pub routines: Vec<RoutineInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSchema {
    pub schemas: Vec<SchemaInfo>,
    pub search_path: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ResultColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
}

/// Result of one statement. Cell values are PostgreSQL's text representation, or null.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    /// True when more rows existed than the requested maximum.
    pub truncated: bool,
    /// Leading keyword(s) of the statement, e.g. "SELECT" or "INSERT".
    pub command: String,
    /// Rows returned or affected; None when the result was truncated.
    pub row_count: Option<u64>,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
    pub message: String,
    pub code: Option<String>,
    /// 1-based character offset into the statement, as reported by PostgreSQL.
    pub position: Option<u32>,
    pub detail: Option<String>,
    pub hint: Option<String>,
}

/// Outcome of loading a page of a table: the result (or SQL error) plus the SQL that produced it.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum TablePageResponse {
    Ok { ok: bool, result: QueryResult, sql: String },
    Err { ok: bool, error: QueryError, sql: String },
}

/// A query the user starred to rerun later, scoped to one connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub sql: String,
    pub created_at: String,
}

/// Outcome of running a statement: SQL errors are data for the UI, not command failures.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum RunResponse {
    Ok { ok: bool, result: QueryResult },
    Err { ok: bool, error: QueryError },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub connection_id: String,
    pub sql: String,
    pub at: String,
    pub duration_ms: u64,
    pub ok: bool,
    pub row_count: Option<u64>,
}

/// A DataGrip data source as seen by the importer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatagripCandidate {
    pub uuid: String,
    pub name: String,
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub user: Option<String>,
    pub ssl_mode: Option<SslMode>,
    pub importable: bool,
    pub reason: Option<String>,
    pub existing_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub server_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestInfo {
    pub server_version: String,
}
