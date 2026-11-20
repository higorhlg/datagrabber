//! Datagrabber backend: a Tauri app exposing PostgreSQL access to the web UI.
//!
//! - `commands`: the UI's API (thin Tauri command adapters)
//! - `db`: sessions, statement execution, introspection, DDL
//! - `storage`: connections, consoles, history, saved queries (JSON files) and keychain secrets
//! - `datagrip`: importing DataGrip data sources and their saved passwords
//! - `model`: the serialized shapes shared with the UI

mod commands;
mod datagrip;
mod db;
mod error;
mod model;
mod storage;

use db::session::Sessions;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Sessions::default())
        .invoke_handler(tauri::generate_handler![
            commands::connections::list_connections,
            commands::connections::create_connection,
            commands::connections::update_connection,
            commands::connections::delete_connection,
            commands::connections::test_connection,
            commands::connections::connect,
            commands::connections::disconnect,
            commands::connections::forget_password,
            commands::explorer::schema,
            commands::explorer::object_ddl,
            commands::queries::run_query,
            commands::queries::cancel_query,
            commands::queries::table_page,
            commands::queries::table_count,
            commands::queries::cancel_table_query,
            commands::library::list_history,
            commands::library::list_saved_queries,
            commands::library::save_query,
            commands::library::rename_saved_query,
            commands::library::delete_saved_query,
            commands::library::load_console,
            commands::library::save_console,
            commands::library::save_export,
            commands::datagrip::preview_datagrip,
            commands::datagrip::import_datagrip,
            commands::datagrip::copy_datagrip_passwords,
            commands::testing::e2e_config,
            commands::testing::e2e_log,
            commands::testing::e2e_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running datagrabber");
}
