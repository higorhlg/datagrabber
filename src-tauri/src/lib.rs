mod commands;
mod connections;
mod datagrip;
mod ddl;
mod error;
mod history;
mod introspect;
mod model;
mod password_import;
mod query;
mod saved;
mod secrets;
mod session;
mod store;

#[cfg(test)]
mod integration_tests;

use session::Sessions;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Sessions::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::create_connection,
            commands::update_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::forget_password,
            commands::schema,
            commands::run_query,
            commands::cancel_query,
            commands::table_page,
            commands::table_count,
            commands::object_ddl,
            commands::list_saved_queries,
            commands::save_query,
            commands::rename_saved_query,
            commands::delete_saved_query,
            commands::list_history,
            commands::load_console,
            commands::save_console,
            commands::preview_datagrip,
            commands::import_datagrip,
            commands::copy_datagrip_passwords,
            commands::save_export,
            commands::e2e_config,
            commands::e2e_log,
            commands::e2e_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running datagrabber");
}
