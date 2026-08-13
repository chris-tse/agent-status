use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn diagnostic_logs_directory() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "Could not locate the home directory for diagnostic logs".to_string())?;
    Ok(PathBuf::from(home).join("Library/Application Support/Ambient Status Dashboard/logs"))
}

pub fn open_diagnostic_logs_at(
    directory: &Path,
    open: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the diagnostic log directory: {error}"))?;
    open(directory)?;
    Ok(directory.to_path_buf())
}

pub fn open_diagnostic_logs() -> Result<PathBuf, String> {
    let directory = diagnostic_logs_directory()?;
    open_diagnostic_logs_at(&directory, |path| {
        let status = Command::new("/usr/bin/open")
            .arg(path)
            .status()
            .map_err(|error| format!("Could not open diagnostic logs: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "Could not open diagnostic logs: /usr/bin/open exited with {status}"
            ))
        }
    })
}
