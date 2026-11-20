//! Exported result files written to the user's Downloads folder.

use std::path::{Path, PathBuf};

use crate::error::{CommandError, CommandResult};

/// Replaces path separators and control characters so a suggested name stays a plain file name.
fn safe_file_name(name: &str) -> String {
    name.chars().map(|c| if c == '/' || c == '\\' || c.is_control() { '_' } else { c }).collect()
}

/// First free path for `name` in `dir`, adding -1, -2… before the extension instead of overwriting.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let (stem, extension) = name.rsplit_once('.').unwrap_or((name, "txt"));
    let mut path = dir.join(name);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}.{extension}"));
        n += 1;
    }
    path
}

/// Writes `contents` to ~/Downloads under a safe, non-clashing name; returns the path written.
pub fn save_to_downloads(file_name: &str, contents: &str) -> CommandResult<String> {
    let downloads = dirs::download_dir().ok_or_else(|| CommandError::new("No Downloads folder found"))?;
    let path = free_path(&downloads, &safe_file_name(file_name));
    std::fs::write(&path, contents)?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_names_inside_the_folder_and_never_overwrites() {
        assert_eq!(safe_file_name("../etc/passwd"), ".._etc_passwd");
        let dir = std::env::temp_dir().join(format!("dg-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("rows.csv"), "x").unwrap();
        assert_eq!(free_path(&dir, "rows.csv"), dir.join("rows-1.csv"));
        assert_eq!(free_path(&dir, "new.csv"), dir.join("new.csv"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
