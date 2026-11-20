//! Hooks for the in-app end-to-end self-test (web/src/testing/selftest.ts). Inert unless the app
//! is launched with DATAGRABBER_E2E by dev/e2e.ts.

/// Self-test configuration, present only when the app is launched with DATAGRABBER_E2E set.
#[tauri::command]
pub fn e2e_config() -> Option<serde_json::Value> {
    std::env::var("DATAGRABBER_E2E").ok().and_then(|raw| serde_json::from_str(&raw).ok())
}

/// Prints a self-test progress line immediately (the runner watches for markers).
#[tauri::command]
pub fn e2e_log(line: String) {
    println!("[e2e] {line}");
}

/// Receives the self-test outcome, prints it and exits with a matching status code.
#[tauri::command]
pub fn e2e_report(ok: bool, log: Vec<String>, app: tauri::AppHandle) {
    for line in &log {
        println!("[e2e] {line}");
    }
    println!("[e2e] {}", if ok { "PASS" } else { "FAIL" });
    app.exit(if ok { 0 } else { 1 });
}
