//! Starred queries (saved_queries.json), kept per connection so good commands are easy to rerun.

use std::sync::Mutex;

use crate::error::{CommandError, CommandResult};
use crate::model::SavedQuery;
use crate::store::{read_json, write_json};

const FILE: &str = "saved_queries.json";

static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Lists one connection's saved queries, most recently saved first.
pub fn list(connection_id: &str) -> CommandResult<Vec<SavedQuery>> {
    let all: Vec<SavedQuery> = read_json(FILE, Vec::new())?;
    Ok(all.into_iter().rev().filter(|q| q.connection_id == connection_id).collect())
}

/// Saves a query under a name. Saving the same SQL twice for a connection renames the existing entry.
pub fn save(connection_id: &str, name: &str, sql: &str) -> CommandResult<SavedQuery> {
    let (name, sql) = (name.trim(), sql.trim());
    if sql.is_empty() {
        return Err(CommandError::new("Nothing to save"));
    }
    let _guard = WRITE_LOCK.lock().unwrap();
    let mut all: Vec<SavedQuery> = read_json(FILE, Vec::new())?;
    let name = if name.is_empty() { default_name(sql) } else { name.to_string() };
    if let Some(existing) = all.iter_mut().find(|q| q.connection_id == connection_id && q.sql == sql) {
        existing.name = name;
        let saved = existing.clone();
        write_json(FILE, &all)?;
        return Ok(saved);
    }
    let saved = SavedQuery {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: connection_id.to_string(),
        name,
        sql: sql.to_string(),
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    all.push(saved.clone());
    write_json(FILE, &all)?;
    Ok(saved)
}

/// Renames a saved query.
pub fn rename(id: &str, name: &str) -> CommandResult<()> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let mut all: Vec<SavedQuery> = read_json(FILE, Vec::new())?;
    let query = all.iter_mut().find(|q| q.id == id).ok_or_else(|| CommandError::new("Saved query not found"))?;
    query.name = name.trim().to_string();
    write_json(FILE, &all)
}

/// Deletes a saved query.
pub fn delete(id: &str) -> CommandResult<()> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let all: Vec<SavedQuery> = read_json(FILE, Vec::new())?;
    write_json(FILE, &all.into_iter().filter(|q| q.id != id).collect::<Vec<_>>())
}

/// Deletes every saved query of a connection (used when the connection is deleted).
pub fn delete_for_connection(connection_id: &str) -> CommandResult<()> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let all: Vec<SavedQuery> = read_json(FILE, Vec::new())?;
    write_json(FILE, &all.into_iter().filter(|q| q.connection_id != connection_id).collect::<Vec<_>>())
}

/// Name for a query saved without one: its first meaningful line, shortened.
fn default_name(sql: &str) -> String {
    let line = sql.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("--")).unwrap_or(sql);
    let short: String = line.chars().take(60).collect();
    if line.chars().count() > 60 { format!("{short}…") } else { short }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_renames_dedupes_and_deletes() {
        let home = std::env::temp_dir().join(format!("dg-saved-{}", std::process::id()));
        // SAFETY: this is the only test in the crate that reads the data directory.
        unsafe { std::env::set_var("DATAGRABBER_HOME", &home) };
        let first = save("conn-a", "", "-- top customers\nselect * from customers order by spend desc").unwrap();
        assert_eq!(first.name, "select * from customers order by spend desc");
        let again = save("conn-a", "Top customers", "-- top customers\nselect * from customers order by spend desc").unwrap();
        assert_eq!(again.id, first.id);
        save("conn-b", "Other", "select 1").unwrap();
        assert_eq!(list("conn-a").unwrap().len(), 1);
        assert_eq!(list("conn-a").unwrap()[0].name, "Top customers");
        rename(&first.id, "Best customers").unwrap();
        assert_eq!(list("conn-a").unwrap()[0].name, "Best customers");
        delete(&first.id).unwrap();
        assert!(list("conn-a").unwrap().is_empty());
        delete_for_connection("conn-b").unwrap();
        assert!(list("conn-b").unwrap().is_empty());
        std::fs::remove_dir_all(home).unwrap();
    }
}
