//! Integration tests against a real PostgreSQL. Start one with `pnpm real-db` and run
//! `DATAGRABBER_TEST_PG=54330 cargo test`. Without that variable these tests are skipped.

use std::time::Duration;

use super::query::run_statement;
use super::session::{Sessions, test};
use crate::model::{ConnectionConfig, SslMode};

const PASSWORD: &str = "it-password";

/// Serializes tests that create/drop schemas or read the whole catalog: a concurrent DROP makes
/// catalog functions such as pg_get_indexdef fail on objects that vanish mid-query.
static CATALOG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn port() -> Option<u16> {
    std::env::var("DATAGRABBER_TEST_PG").ok().and_then(|p| p.parse().ok())
}

fn config(id: &str, read_only: bool) -> ConnectionConfig {
    ConnectionConfig {
        id: id.to_string(),
        name: id.to_string(),
        host: "127.0.0.1".to_string(),
        port: port().unwrap_or(5432),
        database: "postgres".to_string(),
        user: "postgres".to_string(),
        ssl_mode: SslMode::Prefer,
        read_only,
        color: String::new(),
        password_saved: false,
        datagrip_uuid: None,
    }
}

macro_rules! require_pg {
    () => {
        if port().is_none() {
            eprintln!("skipped: set DATAGRABBER_TEST_PG");
            return;
        }
    };
}

async fn rows(sessions: &Sessions, id: &str, sql: &str) -> Vec<Vec<Option<String>>> {
    let session = sessions.get(id).unwrap();
    run_statement(&session, sql, 100).await.unwrap_or_else(|e| panic!("{sql}: {}", e.message)).rows
}

#[tokio::test]
async fn prefer_falls_back_to_plain_tcp_and_wrong_password_asks_again() {
    require_pg!();
    assert!(!test(&config("t", false), Some(PASSWORD.into())).await.unwrap().is_empty());
    let error = test(&config("t", false), Some("wrong".into())).await.unwrap_err();
    assert!(error.needs_password, "{}", error.message);
}

#[tokio::test]
async fn read_only_applies_per_connection() {
    require_pg!();
    let sessions = Sessions::default();
    sessions.open(config("ro", true), Some(PASSWORD.into())).await.unwrap();
    sessions.open(config("rw", false), Some(PASSWORD.into())).await.unwrap();
    rows(&sessions, "rw", "create table if not exists ro_check (x int)").await;
    let error = run_statement(&sessions.get("ro").unwrap(), "insert into ro_check values (1)", 10).await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("25006"));
    rows(&sessions, "rw", "insert into ro_check values (1)").await;
    let meta = sessions.get("ro").unwrap().meta.query("show transaction_read_only", &[]).await.unwrap();
    assert_eq!(meta[0].get::<_, String>(0), "on");
}

#[tokio::test]
async fn caps_rows_with_a_cursor_and_reports_truncation() {
    require_pg!();
    let sessions = Sessions::default();
    sessions.open(config("cap", false), Some(PASSWORD.into())).await.unwrap();
    let session = sessions.get("cap").unwrap();
    let result = run_statement(&session, "select g, g::text || 'x' as label from generate_series(1, 5000000) g", 100).await.unwrap();
    assert_eq!(result.rows.len(), 100);
    assert!(result.truncated);
    assert_eq!(result.row_count, None);
    assert_eq!(result.columns[0].type_name, "int4");
    assert_eq!(result.rows[0], vec![Some("1".to_string()), Some("1x".to_string())]);
    assert!(result.duration_ms < 2000, "cursor should stop early, took {}ms", result.duration_ms);
    let small = run_statement(&session, "select null::text as n, array['a','b'] as arr", 100).await.unwrap();
    assert_eq!(small.rows, vec![vec![None, Some("{a,b}".to_string())]]);
    assert_eq!(small.row_count, Some(1));
    assert_eq!(small.columns[1].type_name, "text[]");
}

#[tokio::test]
async fn never_commits_a_transaction_the_user_opened() {
    require_pg!();
    let sessions = Sessions::default();
    sessions.open(config("tx", false), Some(PASSWORD.into())).await.unwrap();
    rows(&sessions, "tx", "create table if not exists tx_check (x int)").await;
    rows(&sessions, "tx", "truncate tx_check").await;
    rows(&sessions, "tx", "begin").await;
    rows(&sessions, "tx", "insert into tx_check values (42)").await;
    assert_eq!(rows(&sessions, "tx", "select x from tx_check").await, vec![vec![Some("42".to_string())]]);
    rows(&sessions, "tx", "rollback").await;
    assert!(rows(&sessions, "tx", "select x from tx_check").await.is_empty());
}

#[tokio::test]
async fn errors_keep_the_session_usable_and_point_at_the_statement() {
    require_pg!();
    let sessions = Sessions::default();
    sessions.open(config("err", false), Some(PASSWORD.into())).await.unwrap();
    let session = sessions.get("err").unwrap();
    let error = run_statement(&session, "select nope from pg_class", 10).await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("42703"));
    assert_eq!(error.position, Some(8));
    let runtime = run_statement(&session, "select 1/0", 10).await.unwrap_err();
    assert_eq!(runtime.code.as_deref(), Some("22012"));
    assert_eq!(rows(&sessions, "err", "select 1").await, vec![vec![Some("1".to_string())]]);
    let multi = run_statement(&session, "select 1; select 2 as two", 10).await.unwrap();
    assert_eq!(multi.rows, vec![vec![Some("2".to_string())]]);
    let insert = run_statement(&session, "create temp table t_ins as select 1 as x", 10).await.unwrap();
    assert_eq!(insert.command, "CREATE TEMP");
}

#[tokio::test]
async fn cancel_stops_a_running_query() {
    require_pg!();
    let sessions = std::sync::Arc::new(Sessions::default());
    sessions.open(config("cancel", false), Some(PASSWORD.into())).await.unwrap();
    let running = {
        let sessions = sessions.clone();
        tokio::spawn(async move { run_statement(&sessions.get("cancel").unwrap(), "select pg_sleep(30)", 10).await })
    };
    tokio::time::sleep(Duration::from_millis(400)).await;
    sessions.cancel("cancel").await.unwrap();
    let error = running.await.unwrap().unwrap_err();
    assert_eq!(error.code.as_deref(), Some("57014"));
    assert_eq!(rows(&sessions, "cancel", "select 1").await, vec![vec![Some("1".to_string())]]);
}

#[tokio::test]
async fn introspects_tables_columns_and_keys() {
    require_pg!();
    let _catalog = CATALOG_LOCK.lock().await;
    let sessions = Sessions::default();
    sessions.open(config("meta", false), Some(PASSWORD.into())).await.unwrap();
    rows(&sessions, "meta", "create schema if not exists it_shop").await;
    rows(&sessions, "meta", "create table if not exists it_shop.items (id serial primary key, name text not null, price numeric(10,2))")
        .await;
    rows(&sessions, "meta", "create or replace view it_shop.cheap as select * from it_shop.items where price < 5").await;
    let schema = super::introspect::introspect(&sessions.get("meta").unwrap()).await.unwrap();
    let shop = schema.schemas.iter().find(|s| s.name == "it_shop").expect("schema listed");
    let items = shop.relations.iter().find(|r| r.name == "items").unwrap();
    assert_eq!(items.kind, "table");
    assert!(items.columns[0].primary_key);
    assert_eq!(items.columns[2].type_name, "numeric(10,2)");
    assert_eq!(shop.relations.iter().find(|r| r.name == "cheap").unwrap().kind, "view");
    assert_eq!(schema.search_path, vec!["public".to_string()]);
}

/// Creates a small shop schema named `schema` (each test uses its own, as tests run in parallel).
async fn seed_shop(sessions: &Sessions, id: &str, schema: &str) {
    for template in [
        "drop schema if exists it_explorer cascade",
        "create schema it_explorer",
        "create table it_explorer.customer (id serial primary key, email text not null unique, created_at timestamptz default now())",
        "comment on table it_explorer.customer is 'People who buy things'",
        "create table it_explorer.\"order\" (id bigint generated always as identity primary key, customer_id int not null references it_explorer.customer(id), status text check (status in ('paid','refunded')), total numeric(10,2))",
        "create index order_status_idx on it_explorer.\"order\" (status)",
        "create view it_explorer.paid_orders as select * from it_explorer.\"order\" where status = 'paid'",
        "create sequence it_explorer.invoice_seq start 1000",
        "create function it_explorer.order_count(c int) returns bigint language sql as $$ select count(*) from it_explorer.\"order\" where customer_id = c $$",
        "insert into it_explorer.customer (email) select 'c' || g || '@test' from generate_series(1, 3) g",
        "insert into it_explorer.\"order\" (customer_id, status, total) select 1 + g % 3, case when g % 4 = 0 then 'refunded' else 'paid' end, g * 1.5 from generate_series(1, 250) g",
    ] {
        rows(sessions, id, &template.replace("it_explorer", schema)).await;
    }
}

#[tokio::test]
async fn explorer_lists_indexes_keys_sequences_and_routines() {
    require_pg!();
    let _catalog = CATALOG_LOCK.lock().await;
    let sessions = Sessions::default();
    sessions.open(config("explorer", false), Some(PASSWORD.into())).await.unwrap();
    seed_shop(&sessions, "explorer", "it_tree").await;
    let schema = super::introspect::introspect(&sessions.get("explorer").unwrap()).await.unwrap();
    let shop = schema.schemas.iter().find(|s| s.name == "it_tree").unwrap();
    let order = shop.relations.iter().find(|r| r.name == "order").unwrap();
    assert_eq!(order.foreign_keys.len(), 1);
    assert!(order.foreign_keys[0].definition.contains("REFERENCES it_tree.customer(id)"));
    assert!(order.indexes.iter().any(|i| i.primary));
    assert!(order.indexes.iter().any(|i| i.name == "order_status_idx" && !i.unique));
    assert_eq!(shop.sequences, vec!["customer_id_seq".to_string(), "invoice_seq".to_string(), "order_id_seq".to_string()]);
    assert_eq!(shop.routines.len(), 1);
    assert_eq!(shop.routines[0].arguments, "c integer");
}

#[tokio::test]
async fn table_pages_filter_sort_page_and_count() {
    require_pg!();
    let _catalog = CATALOG_LOCK.lock().await;
    let sessions = Sessions::default();
    sessions.open(config("pages", false), Some(PASSWORD.into())).await.unwrap();
    seed_shop(&sessions, "pages", "it_pages").await;
    let session = sessions.get("pages").unwrap();
    let request = |filter: &str, order_by: &str, offset: usize| super::query::TablePageRequest {
        schema: "it_pages".into(),
        table: "order".into(),
        filter: Some(filter.into()),
        order_by: Some(order_by.into()),
        limit: 100,
        offset,
    };
    let first = super::query::fetch_table_page(&session, &request("status = 'paid'", "id desc", 0)).await.unwrap();
    assert_eq!(first.rows.len(), 100);
    assert!(first.truncated);
    assert_eq!(first.rows[0][0].as_deref(), Some("250"));
    assert_eq!(first.columns[0].type_name, "int8");
    let last = super::query::fetch_table_page(&session, &request("status = 'paid'", "id desc", 100)).await.unwrap();
    assert_eq!(last.rows.len(), 88);
    assert!(!last.truncated);
    let count = super::query::count_table_rows(&session, "it_pages", "order", &Some("status = 'paid'".into())).await.unwrap();
    assert_eq!(count, 188);
    let injected =
        super::query::fetch_table_page(&session, &request("true); delete from it_pages.\"order\"; select (1", "", 0)).await.unwrap_err();
    assert!(injected.message.contains("single expressions"), "{}", injected.message);
    assert_eq!(super::query::count_table_rows(&session, "it_pages", "order", &None).await.unwrap(), 250);
    let bad = super::query::fetch_table_page(&session, &request("nope = 1", "", 0)).await.unwrap_err();
    assert_eq!(bad.code.as_deref(), Some("42703"));
}

#[tokio::test]
async fn generates_ddl_for_tables_views_sequences_and_routines() {
    require_pg!();
    let _catalog = CATALOG_LOCK.lock().await;
    let sessions = Sessions::default();
    sessions.open(config("ddl", false), Some(PASSWORD.into())).await.unwrap();
    seed_shop(&sessions, "ddl", "it_ddl").await;
    let session = sessions.get("ddl").unwrap();
    let table = super::ddl::object_ddl(&session, "it_ddl", "order", "relation", None).await.unwrap();
    assert!(table.starts_with("create table it_ddl.\"order\"\n("), "{table}");
    assert!(table.contains("id bigint generated always as identity not null"), "{table}");
    assert!(table.contains("constraint order_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES it_ddl.customer(id)"), "{table}");
    assert!(table.contains("CREATE INDEX order_status_idx ON it_ddl.\"order\" USING btree (status);"), "{table}");
    let customer = super::ddl::object_ddl(&session, "it_ddl", "customer", "relation", None).await.unwrap();
    assert!(customer.contains("comment on table it_ddl.customer is 'People who buy things';"), "{customer}");
    let view = super::ddl::object_ddl(&session, "it_ddl", "paid_orders", "relation", None).await.unwrap();
    assert!(view.starts_with("create or replace view it_ddl.paid_orders as\n"), "{view}");
    let sequence = super::ddl::object_ddl(&session, "it_ddl", "invoice_seq", "sequence", None).await.unwrap();
    assert!(sequence.contains("start with 1000"), "{sequence}");
    let routine = super::ddl::object_ddl(&session, "it_ddl", "order_count", "routine", Some("c integer")).await.unwrap();
    assert!(routine.starts_with("CREATE OR REPLACE FUNCTION it_ddl.order_count(c integer)"), "{routine}");
}

#[tokio::test]
async fn table_tabs_give_up_on_locked_tables_instead_of_hanging() {
    require_pg!();
    let _catalog = CATALOG_LOCK.lock().await;
    let sessions = Sessions::default();
    sessions.open(config("locker", false), Some(PASSWORD.into())).await.unwrap();
    sessions.open(config("viewer", false), Some(PASSWORD.into())).await.unwrap();
    rows(&sessions, "locker", "create table if not exists lock_check (x int)").await;
    rows(&sessions, "locker", "begin").await;
    rows(&sessions, "locker", "lock table lock_check in access exclusive mode").await;
    let started = std::time::Instant::now();
    let request = super::query::TablePageRequest {
        schema: "public".into(),
        table: "lock_check".into(),
        filter: None,
        order_by: None,
        limit: 100,
        offset: 0,
    };
    let error = super::query::fetch_table_page(&sessions.get("viewer").unwrap(), &request).await.unwrap_err();
    let waited = started.elapsed();
    rows(&sessions, "locker", "rollback").await;
    assert_eq!(error.code.as_deref(), Some("55P03"), "{}", error.message);
    assert!(error.message.contains("locked by another session"), "{}", error.message);
    assert!(waited < Duration::from_secs(8), "gave up after {waited:?}");
    let count = super::query::count_table_rows(&sessions.get("viewer").unwrap(), "public", "lock_check", &None).await.unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn meta_statements_stop_after_the_time_limit() {
    require_pg!();
    let sessions = Sessions::default();
    sessions.open(config("slow", false), Some(PASSWORD.into())).await.unwrap();
    let meta = &sessions.get("slow").unwrap().meta;
    let timeouts = meta.query("select current_setting('lock_timeout'), current_setting('statement_timeout')", &[]).await.unwrap();
    assert_eq!((timeouts[0].get::<_, String>(0), timeouts[0].get::<_, String>(1)), ("5s".to_string(), "30s".to_string()));
    let console = sessions.get("slow").unwrap();
    let console_timeout = run_statement(&console, "show statement_timeout", 10).await.unwrap();
    assert_eq!(console_timeout.rows, vec![vec![Some("0".to_string())]], "consoles keep no time limit");
}

#[tokio::test]
async fn stop_cancels_a_slow_table_page() {
    require_pg!();
    let sessions = std::sync::Arc::new(Sessions::default());
    sessions.open(config("stop", false), Some(PASSWORD.into())).await.unwrap();
    let running = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            let request = super::query::TablePageRequest {
                schema: "pg_catalog".into(),
                table: "pg_class".into(),
                filter: Some("pg_sleep(20) is not null".into()),
                order_by: None,
                limit: 10,
                offset: 0,
            };
            super::query::fetch_table_page(&sessions.get("stop").unwrap(), &request).await
        })
    };
    tokio::time::sleep(Duration::from_millis(400)).await;
    let started = std::time::Instant::now();
    sessions.cancel_meta("stop").await.unwrap();
    let error = running.await.unwrap().unwrap_err();
    assert_eq!(error.code.as_deref(), Some("57014"));
    assert!(started.elapsed() < Duration::from_secs(3));
    let after = super::query::count_table_rows(&sessions.get("stop").unwrap(), "pg_catalog", "pg_am", &None).await.unwrap();
    assert!(after > 0, "meta connection usable after a stop");
}
