//! Runs one statement on a session's console connection with a row cap.
//!
//! Row-returning queries (SELECT/VALUES/TABLE/read-only WITH) go through a server-side cursor
//! (`DECLARE … FETCH n`), so the server stops after the cap instead of streaming a whole table.
//! Values come back in PostgreSQL's text format, exactly as psql would print them. Outside a
//! user transaction the cursor is wrapped in its own BEGIN/COMMIT; inside one it joins it, so a
//! transaction the user opened is never committed behind their back. Everything else runs as a
//! plain simple query whose extra rows are read and discarded.

use std::time::Instant;

use futures_util::{StreamExt, pin_mut};
use tokio_postgres::error::ErrorPosition;
use tokio_postgres::{Client, SimpleQueryMessage, SimpleQueryRow};

use crate::model::{QueryError, QueryResult, ResultColumn};
use crate::ddl::quote_ident;
use crate::session::{Session, describe_pg_error};

const CURSOR: &str = "datagrabber_cursor";
/// True inside a transaction block: there, the transaction started before this statement did.
const IN_TRANSACTION_PROBE: &str = "select now() <> statement_timestamp()";

/// Words of the statement with leading comments skipped, lower-cased.
fn words(sql: &str) -> Vec<String> {
    strip_leading_comments(sql)
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// Skips whitespace, `--` comments and (nested) block comments at the start of a statement.
fn strip_leading_comments(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, tail)| tail).trim_start();
        } else if rest.starts_with("/*") {
            let mut depth = 0usize;
            let mut end = rest.len();
            let bytes = rest.as_bytes();
            let mut i = 0;
            while i + 1 < bytes.len() {
                if &bytes[i..i + 2] == b"/*" {
                    depth += 1;
                    i += 2;
                } else if &bytes[i..i + 2] == b"*/" {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        end = i;
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            rest = rest[end..].trim_start();
        } else {
            return rest;
        }
    }
}

/// Command label for the results bar: the leading keyword, two words for DDL ("CREATE TABLE").
pub fn command_label(sql: &str) -> String {
    let words = words(sql);
    let take = match words.first().map(String::as_str) {
        Some("create" | "alter" | "drop") => 2,
        _ => 1,
    };
    words.iter().take(take).map(|w| w.to_uppercase()).collect::<Vec<_>>().join(" ")
}

/// Whether a statement can run inside `DECLARE CURSOR`: plain queries without data-modifying
/// CTEs or SELECT INTO.
pub fn cursor_safe(sql: &str) -> bool {
    let words = words(sql);
    let modifies = words.iter().any(|w| matches!(w.as_str(), "insert" | "update" | "delete" | "merge" | "into"));
    match words.first().map(String::as_str) {
        Some("select" | "values" | "table" | "with") => !modifies,
        _ => false,
    }
}

/// Displays tokio-postgres internal type names the way people write them (`_text` → `text[]`).
fn display_type(name: &str) -> String {
    match name.strip_prefix('_') {
        Some(element) => format!("{element}[]"),
        None => name.to_string(),
    }
}

/// Converts a tokio-postgres error, shifting the error position by the length of any SQL
/// prepended to the user's statement.
fn to_query_error(error: &tokio_postgres::Error, prefix_chars: u32) -> QueryError {
    let Some(db) = error.as_db_error() else {
        return QueryError { message: describe_pg_error(error), code: None, position: None, detail: None, hint: None };
    };
    let position = match db.position() {
        Some(ErrorPosition::Original(p)) => p.checked_sub(prefix_chars).filter(|p| *p >= 1),
        _ => None,
    };
    QueryError {
        message: db.message().to_string(),
        code: Some(db.code().code().to_string()),
        position,
        detail: db.detail().map(str::to_string),
        hint: db.hint().map(str::to_string),
    }
}

fn row_values(row: &SimpleQueryRow) -> Vec<Option<String>> {
    (0..row.len()).map(|i| row.get(i).map(str::to_string)).collect()
}

/// Runs a statement through a cursor, fetching at most `max_rows + 1` rows to detect truncation.
async fn run_with_cursor(client: &Client, sql: &str, max_rows: usize, in_transaction: bool) -> Result<(Vec<Vec<Option<String>>>, bool), QueryError> {
    let begin = if in_transaction { "" } else { "BEGIN;\n" };
    let prefix = format!("{begin}DECLARE {CURSOR} NO SCROLL CURSOR FOR\n");
    let batch = format!("{prefix}{sql}\n;\nFETCH FORWARD {} FROM {CURSOR};\nCLOSE {CURSOR}{}", max_rows + 1, if in_transaction { "" } else { ";\nCOMMIT" });
    match client.simple_query(&batch).await {
        Ok(messages) => {
            let mut rows: Vec<Vec<Option<String>>> = messages
                .iter()
                .filter_map(|m| match m {
                    SimpleQueryMessage::Row(row) => Some(row_values(row)),
                    _ => None,
                })
                .collect();
            let truncated = rows.len() > max_rows;
            rows.truncate(max_rows);
            Ok((rows, truncated))
        }
        Err(error) => {
            if !in_transaction {
                let _ = client.batch_execute("ROLLBACK").await;
            }
            Err(to_query_error(&error, prefix.chars().count() as u32))
        }
    }
}

/// Runs a statement as a simple query, keeping the last result set and at most `max_rows` rows.
async fn run_simple(client: &Client, sql: &str, max_rows: usize) -> Result<(Vec<String>, Vec<Vec<Option<String>>>, bool, u64), QueryError> {
    let stream = client.simple_query_raw(sql).await.map_err(|e| to_query_error(&e, 0))?;
    pin_mut!(stream);
    let (mut names, mut rows, mut truncated, mut count) = (Vec::new(), Vec::new(), false, 0);
    while let Some(message) = stream.next().await {
        match message.map_err(|e| to_query_error(&e, 0))? {
            SimpleQueryMessage::RowDescription(columns) => {
                names = columns.iter().map(|c| c.name().to_string()).collect();
                rows.clear();
                truncated = false;
            }
            SimpleQueryMessage::Row(row) if rows.len() < max_rows => rows.push(row_values(&row)),
            SimpleQueryMessage::Row(_) => truncated = true,
            SimpleQueryMessage::CommandComplete(n) => count = n,
            _ => {}
        }
    }
    Ok((names, rows, truncated, count))
}

/// Whether the server is in a transaction block (including a failed one) on this connection.
async fn in_transaction(client: &Client) -> bool {
    match client.simple_query(IN_TRANSACTION_PROBE).await {
        Ok(messages) => messages.iter().any(|m| matches!(m, SimpleQueryMessage::Row(row) if row.get(0) == Some("t"))),
        Err(_) => true,
    }
}

/// Runs one statement on the console connection. SQL errors come back as `QueryError` data.
pub async fn run_statement(session: &Session, sql: &str, max_rows: usize) -> Result<QueryResult, QueryError> {
    let started = Instant::now();
    let client = session.console.lock().await;
    let prepared = client.prepare(sql).await;
    let multiple_statements = matches!(&prepared, Err(e) if describe_pg_error(e).contains("multiple commands"));
    let statement = match prepared {
        Ok(statement) => Some(statement),
        Err(_) if multiple_statements => None,
        Err(error) => return Err(to_query_error(&error, 0)),
    };
    let typed_columns: Vec<ResultColumn> = statement
        .as_ref()
        .map(|s| s.columns().iter().map(|c| ResultColumn { name: c.name().to_string(), type_name: display_type(c.type_().name()) }).collect())
        .unwrap_or_default();
    drop(statement);

    let (columns, rows, truncated, count) = if !typed_columns.is_empty() && cursor_safe(sql) {
        let in_tx = in_transaction(&client).await;
        let (rows, truncated) = run_with_cursor(&client, sql, max_rows, in_tx).await?;
        let count = rows.len() as u64;
        (typed_columns, rows, truncated, count)
    } else {
        let (names, rows, truncated, count) = run_simple(&client, sql, max_rows).await?;
        let columns = if names.len() == typed_columns.len() { typed_columns } else { names.into_iter().map(|name| ResultColumn { name, type_name: String::new() }).collect() };
        (columns, rows, truncated, count)
    };
    Ok(QueryResult {
        columns,
        rows,
        truncated,
        command: command_label(sql),
        row_count: (!truncated).then_some(count),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// A page of a table or view as shown in a table tab.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePageRequest {
    pub schema: String,
    pub table: String,
    /// Boolean SQL expression for WHERE, as typed in the filter bar.
    #[serde(default)]
    pub filter: Option<String>,
    /// ORDER BY list, as typed in the order bar or built from header clicks.
    #[serde(default)]
    pub order_by: Option<String>,
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// FROM/WHERE part shared by page and count queries. User text sits on its own lines so a
/// trailing `--` comment cannot swallow the rest of the query.
fn table_source(schema: &str, table: &str, filter: &Option<String>) -> String {
    let mut sql = format!("from {}.{}", quote_ident(schema), quote_ident(table));
    if let Some(filter) = non_empty(filter) {
        sql.push_str(&format!("\nwhere (\n{filter}\n)"));
    }
    sql
}

/// Builds the SELECT for a table page, fetching one extra row to detect a next page.
pub fn table_page_sql(request: &TablePageRequest) -> String {
    let mut sql = format!("select *\n{}", table_source(&request.schema, &request.table, &request.filter));
    if let Some(order_by) = non_empty(&request.order_by) {
        sql.push_str(&format!("\norder by\n{order_by}\n"));
    }
    sql.push_str(&format!("\nlimit {} offset {}", request.limit + 1, request.offset));
    sql
}

/// Explains the meta connection's protective timeouts in plain words.
fn explain_meta_timeouts(mut error: QueryError) -> QueryError {
    match error.code.as_deref() {
        Some("55P03") => {
            error.message = format!(
                "The table is locked by another session (for example a migration), so this stopped after {}s instead of waiting.",
                crate::session::META_LOCK_TIMEOUT_SECS
            );
            error.hint = Some("Try again in a moment, or check pg_locks / pg_stat_activity for the blocker.".to_string());
        }
        Some("57014") if error.message.contains("statement timeout") => {
            error.message = format!("Stopped after {}s to avoid a long-running query.", crate::session::META_STATEMENT_TIMEOUT_SECS);
            error.hint = Some("Add a filter, sort by an indexed column, or run it from a console (no time limit, cancellable).".to_string());
        }
        Some("57014") => {
            error.message = "Stopped.".to_string();
            error.hint = None;
        }
        _ => {}
    }
    error
}

/// Prepares generated SQL to validate it is a single statement and learn its column types.
/// Positions are dropped because they point into the generated SQL, not the user's text.
async fn prepare_generated(client: &Client, sql: &str) -> Result<Vec<ResultColumn>, QueryError> {
    let statement = client.prepare(sql).await.map_err(|error| {
        let mut query_error = to_query_error(&error, 0);
        query_error.position = None;
        if query_error.message.contains("multiple commands") {
            query_error.message = "Filter and ORDER BY must be single expressions (no semicolons).".to_string();
        }
        query_error
    })?;
    Ok(statement.columns().iter().map(|c| ResultColumn { name: c.name().to_string(), type_name: display_type(c.type_().name()) }).collect())
}

/// Loads one page of a table on the meta connection, so table tabs never touch a console's
/// session or transaction and are bounded by the meta lock/statement timeouts.
pub async fn fetch_table_page(session: &Session, request: &TablePageRequest) -> Result<QueryResult, QueryError> {
    let started = Instant::now();
    let sql = table_page_sql(request);
    let columns = prepare_generated(&session.meta, &sql).await.map_err(explain_meta_timeouts)?;
    let (_, rows, truncated, _) = run_simple(&session.meta, &sql, request.limit).await.map_err(explain_meta_timeouts)?;
    let count = rows.len() as u64;
    Ok(QueryResult { columns, rows, truncated, command: "SELECT".to_string(), row_count: Some(count), duration_ms: started.elapsed().as_millis() as u64 })
}

/// Counts the rows matching a table tab's filter.
pub async fn count_table_rows(session: &Session, schema: &str, table: &str, filter: &Option<String>) -> Result<u64, QueryError> {
    let sql = format!("select count(*)\n{}", table_source(schema, table, filter));
    prepare_generated(&session.meta, &sql).await.map_err(explain_meta_timeouts)?;
    let messages = session.meta.simple_query(&sql).await.map_err(|e| explain_meta_timeouts(to_query_error(&e, 0)))?;
    Ok(messages
        .iter()
        .find_map(|m| match m {
            SimpleQueryMessage::Row(row) => row.get(0).and_then(|v| v.parse().ok()),
            _ => None,
        })
        .unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_commands() {
        assert_eq!(command_label("  -- hi\n/* a /* b */ */ select 1"), "SELECT");
        assert_eq!(command_label("create table x (a int)"), "CREATE TABLE");
        assert_eq!(command_label("insert into t values (1)"), "INSERT");
    }

    #[test]
    fn detects_cursor_safe_statements() {
        assert!(cursor_safe("select * from orders"));
        assert!(cursor_safe("with x as (select 1) select * from x"));
        assert!(cursor_safe("values (1), (2)"));
        assert!(!cursor_safe("with d as (delete from t returning *) select * from d"));
        assert!(!cursor_safe("select * into copy from t"));
        assert!(!cursor_safe("insert into t values (1) returning *"));
        assert!(!cursor_safe("show search_path"));
        assert!(!cursor_safe("explain select 1"));
    }

    #[test]
    fn builds_table_page_sql() {
        let request = TablePageRequest {
            schema: "public".into(),
            table: "order".into(),
            filter: Some("status = 'paid' -- note".into()),
            order_by: Some(" ".into()),
            limit: 100,
            offset: 200,
        };
        assert_eq!(table_page_sql(&request), "select *\nfrom public.\"order\"\nwhere (\nstatus = 'paid' -- note\n)\nlimit 101 offset 200");
    }

    #[test]
    fn displays_array_types() {
        assert_eq!(display_type("_text"), "text[]");
        assert_eq!(display_type("int4"), "int4");
    }
}
