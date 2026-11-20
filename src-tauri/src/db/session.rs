//! Open database sessions. Each open connection holds two PostgreSQL connections:
//! a "console" that runs the user's SQL (so SET, BEGIN/COMMIT and temp tables persist between
//! runs, with no timeouts), and a "meta" one for introspection, DDL and table tabs, which keeps
//! working while a console query runs and is bounded by lock and statement timeouts.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use postgres_native_tls::MakeTlsConnector;
use tokio::sync::Mutex;
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::error::SqlState;
use tokio_postgres::{CancelToken, Client, Config, SimpleQueryMessage};

use crate::error::{CommandError, CommandResult};
use crate::model::{ConnectionConfig, SslMode};
use crate::storage::secrets;

const READ_ONLY_SQL: &str = "set session characteristics as transaction read only";

/// Seconds the meta connection waits for a table lock before giving up.
pub const META_LOCK_TIMEOUT_SECS: u32 = 5;
/// Seconds any single meta statement (preview, page, count, introspection, DDL) may run.
pub const META_STATEMENT_TIMEOUT_SECS: u32 = 30;

/// Guards for the meta connection, which runs everything the explorer and table tabs do without
/// the user typing SQL: never queue behind a lock (e.g. a migration's ALTER TABLE) for more than
/// a few seconds, and never run longer than half a minute.
fn meta_guards_sql() -> String {
    format!("set lock_timeout = '{META_LOCK_TIMEOUT_SECS}s'; set statement_timeout = '{META_STATEMENT_TIMEOUT_SECS}s'")
}

pub struct Session {
    pub config: ConnectionConfig,
    pub console: Mutex<Client>,
    pub meta: Client,
    pub cancel: CancelToken,
    /// Cancels what the meta connection is running (a slow table page, count or introspection).
    pub meta_cancel: CancelToken,
    pub tls: MakeTlsConnector,
    pub server_version: String,
    broken: Arc<AtomicBool>,
}

impl Session {
    /// True once either underlying connection has closed or failed.
    pub fn is_broken(&self) -> bool {
        self.broken.load(Ordering::SeqCst)
    }
}

/// All open sessions, keyed by connection id.
#[derive(Default)]
pub struct Sessions {
    open: StdMutex<HashMap<String, Arc<Session>>>,
}

/// Builds the TLS connector for a mode. Only verify-full checks certificates and hostnames,
/// matching libpq's prefer/require semantics.
fn tls_connector(mode: SslMode) -> CommandResult<MakeTlsConnector> {
    let mut builder = native_tls::TlsConnector::builder();
    if mode != SslMode::VerifyFull {
        builder.danger_accept_invalid_certs(true).danger_accept_invalid_hostnames(true);
    }
    let connector = builder.build().map_err(|e| CommandError::new(format!("TLS setup failed: {e}")))?;
    Ok(MakeTlsConnector::new(connector))
}

/// Translates a saved connection into tokio-postgres settings.
fn pg_config(config: &ConnectionConfig, password: &str) -> Config {
    let mut pg = Config::new();
    pg.host(&config.host)
        .port(config.port)
        .dbname(&config.database)
        .user(&config.user)
        .password(password)
        .application_name("datagrabber")
        .connect_timeout(Duration::from_secs(10))
        .keepalives(true)
        .ssl_mode(match config.ssl_mode {
            SslMode::Disable => PgSslMode::Disable,
            SslMode::Prefer => PgSslMode::Prefer,
            SslMode::Require | SslMode::VerifyFull => PgSslMode::Require,
        });
    pg
}

/// Opens one connection, drives it on a background task, and applies read-only mode when configured.
/// `broken` flips to true when the connection ends.
async fn open_client(
    config: &ConnectionConfig,
    password: &str,
    tls: &MakeTlsConnector,
    broken: Arc<AtomicBool>,
) -> Result<Client, tokio_postgres::Error> {
    let (client, connection) = pg_config(config, password).connect(tls.clone()).await?;
    tokio::spawn(async move {
        let _ = connection.await;
        broken.store(true, Ordering::SeqCst);
    });
    if config.read_only {
        client.batch_execute(READ_ONLY_SQL).await?;
    }
    Ok(client)
}

/// Describes a tokio-postgres error with the server's message when there is one.
pub fn describe_pg_error(error: &tokio_postgres::Error) -> String {
    if let Some(db) = error.as_db_error() {
        return db.message().to_string();
    }
    let mut message = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(inner) = source {
        message.push_str(": ");
        message.push_str(&inner.to_string());
        source = inner.source();
    }
    message
}

/// Maps a connection failure; authentication failures ask the UI for a password.
fn connect_error(error: tokio_postgres::Error) -> CommandError {
    let message = describe_pg_error(&error);
    let auth_failed = error.code() == Some(&SqlState::INVALID_PASSWORD) || message.contains("password");
    if auth_failed { CommandError::needs_password(message) } else { CommandError::new(format!("Could not connect: {message}")) }
}

/// Picks the password: the one the user just typed, else the keychain.
fn resolve_password(config: &ConnectionConfig, supplied: Option<String>) -> CommandResult<String> {
    if let Some(password) = supplied {
        return Ok(password);
    }
    let saved = if config.password_saved { secrets::get(&config.id)? } else { None };
    saved.ok_or_else(|| CommandError::needs_password("Password required"))
}

/// Reads the server version from a connected client.
async fn server_version(client: &Client) -> Result<String, tokio_postgres::Error> {
    let messages = client.simple_query("show server_version").await?;
    Ok(messages
        .iter()
        .find_map(|m| match m {
            SimpleQueryMessage::Row(row) => row.get(0).map(str::to_string),
            _ => None,
        })
        .unwrap_or_default())
}

/// Checks that a connection works without keeping it open.
pub async fn test(config: &ConnectionConfig, password: Option<String>) -> CommandResult<String> {
    let password = resolve_password(config, password)?;
    let tls = tls_connector(config.ssl_mode)?;
    let client = open_client(config, &password, &tls, Arc::new(AtomicBool::new(false))).await.map_err(connect_error)?;
    server_version(&client).await.map_err(connect_error)
}

impl Sessions {
    /// Returns the open session for a connection, or a not-connected error.
    pub fn get(&self, id: &str) -> CommandResult<Arc<Session>> {
        let session = self.open.lock().unwrap().get(id).cloned().ok_or_else(|| CommandError::not_connected("Not connected"))?;
        if session.is_broken() {
            return Err(CommandError::not_connected("The connection was lost. Reconnect to continue."));
        }
        Ok(session)
    }

    /// Whether a usable session exists.
    pub fn is_connected(&self, id: &str) -> bool {
        self.open.lock().unwrap().get(id).is_some_and(|s| !s.is_broken())
    }

    /// Opens (or reuses) the session for a connection.
    pub async fn open(&self, config: ConnectionConfig, password: Option<String>) -> CommandResult<Arc<Session>> {
        if let Ok(session) = self.get(&config.id) {
            return Ok(session);
        }
        let password = resolve_password(&config, password)?;
        let tls = tls_connector(config.ssl_mode)?;
        let broken = Arc::new(AtomicBool::new(false));
        let console = open_client(&config, &password, &tls, broken.clone()).await.map_err(connect_error)?;
        let meta = open_client(&config, &password, &tls, broken.clone()).await.map_err(connect_error)?;
        meta.batch_execute(&meta_guards_sql()).await.map_err(connect_error)?;
        let server_version = server_version(&console).await.map_err(connect_error)?;
        let session = Arc::new(Session {
            cancel: console.cancel_token(),
            meta_cancel: meta.cancel_token(),
            console: Mutex::new(console),
            meta,
            tls,
            server_version,
            broken,
            config,
        });
        self.open.lock().unwrap().insert(session.config.id.clone(), session.clone());
        Ok(session)
    }

    /// Closes a session; dropping both clients ends their connections.
    pub fn close(&self, id: &str) {
        self.open.lock().unwrap().remove(id);
    }

    /// Asks the server to cancel what the meta connection is running (table tab Stop button).
    pub async fn cancel_meta(&self, id: &str) -> CommandResult<()> {
        let session = self.get(id)?;
        session.meta_cancel.cancel_query(session.tls.clone()).await.map_err(|e| CommandError::new(describe_pg_error(&e)))
    }

    /// Asks the server to cancel what the console connection is running.
    pub async fn cancel(&self, id: &str) -> CommandResult<()> {
        let session = self.get(id)?;
        session.cancel.cancel_query(session.tls.clone()).await.map_err(|e| CommandError::new(describe_pg_error(&e)))
    }
}
