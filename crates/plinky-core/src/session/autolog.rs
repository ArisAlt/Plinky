//! Automatic session logs: every session, or the ones that ask, logged to
//! `<log folder>/<session folder>/<session name>/<YYYY-MM-DD_HH-MM-SS>.log`.
//!
//! The owner asked for a persistent log that needs no click each time, on
//! for all sessions or for chosen ones, filed by folder and session. The
//! choice lives in two places: the global setting here (a file of the
//! backend's own, since a GNS3 console starts before the page that keeps
//! the other settings exists), and each saved session's `PlinkyAutoLog`
//! (`1` always, `0` never, absent: follow the global setting).

use std::path::{Path, PathBuf};

use super::log::LogMode;

/// The global logging setting, saved as `logging.json` in the app's data
/// folder.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct LoggingSettings {
    /// Log every session that doesn't say otherwise.
    pub enabled: bool,
    /// Where logs go; `None` is the default folder (Documents/Thyrion Logs).
    pub dir: Option<PathBuf>,
    pub mode: LogMode,
}

impl Default for LoggingSettings {
    fn default() -> Self {
        Self { enabled: false, dir: None, mode: LogMode::Printable }
    }
}

impl LoggingSettings {
    /// The settings in `file`, or the defaults when there are none or they
    /// don't read: a broken settings file must not stop a session.
    pub fn load(file: &Path) -> Self {
        std::fs::read(file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(file, json)
    }
}

/// A session's own say (`PlinkyAutoLog`): `Some(true)` always, `Some(false)`
/// never, `None` follow the global setting.
pub fn session_choice(extra: &std::collections::BTreeMap<String, String>) -> Option<bool> {
    match extra.get("PlinkyAutoLog").map(|v| v.trim()) {
        Some("1") => Some(true),
        Some("0") => Some(false),
        _ => None,
    }
}

/// Whether a session is logged automatically.
pub fn wanted(settings: &LoggingSettings, session: Option<bool>) -> bool {
    session.unwrap_or(settings.enabled)
}

/// The folder sessions that aren't saved go under (GNS3 consoles, quick
/// connects, the local shell).
pub const UNSAVED_FOLDER: &str = "Unsaved";

/// One folder or file name, safe on Windows and Linux: no path separators or
/// characters Windows refuses, no trailing dots or spaces, and none of
/// Windows' reserved device names (a log folder called "CON" can't be made).
pub fn safe_part(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '_') {
        return "session".to_string();
    }
    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    if reserved { format!("{trimmed}_") } else { trimmed }
}

/// A local time, as the file name shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

impl Stamp {
    /// Now, on this machine's clock: the time people search their logs by.
    pub fn now_local() -> Self {
        use chrono::{Datelike, Timelike};
        let t = chrono::Local::now();
        Self { year: t.year(), month: t.month(), day: t.day(), hour: t.hour(), minute: t.minute(), second: t.second() }
    }

    fn file_name(&self) -> String {
        format!(
            "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }
}

/// `<dir>/<folder>/<session>/<YYYY-MM-DD_HH-MM-SS>.log`. A nested folder
/// ("Lab/Core") becomes nested directories; a session with no folder, or
/// one that isn't saved, goes under its own or [`UNSAVED_FOLDER`]. Two logs
/// in the same second (a quick Reconnect) don't share a file: the second
/// gets `_2`, and so on.
pub fn log_path(dir: &Path, folder: Option<&str>, session: &str, at: Stamp) -> PathBuf {
    let mut path = dir.to_path_buf();
    let folder = folder.map(str::trim).filter(|f| !f.is_empty()).unwrap_or(UNSAVED_FOLDER);
    for part in folder.split(['/', '\\']).map(str::trim).filter(|p| !p.is_empty()) {
        path.push(safe_part(part));
    }
    path.push(safe_part(session));
    let stem = at.file_name();
    let mut candidate = path.join(format!("{stem}.log"));
    let mut n = 2;
    while candidate.exists() {
        candidate = path.join(format!("{stem}_{n}.log"));
        n += 1;
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: Stamp = Stamp { year: 2026, month: 10, day: 14, hour: 16, minute: 5, second: 33 };

    #[test]
    fn a_saved_session_is_filed_by_folder_then_session_then_time() {
        let p = log_path(Path::new("/logs"), Some("Lab"), "Core R1", AT);
        assert_eq!(p, Path::new("/logs/Lab/Core R1/2026-10-14_16-05-33.log"));
    }

    #[test]
    fn nested_folders_become_nested_directories() {
        let p = log_path(Path::new("/logs"), Some("Lab/Core\\West"), "R1", AT);
        assert_eq!(p, Path::new("/logs/Lab/Core/West/R1/2026-10-14_16-05-33.log"));
    }

    #[test]
    fn a_session_with_no_folder_goes_under_unsaved() {
        assert_eq!(log_path(Path::new("/logs"), None, "R1", AT), Path::new("/logs/Unsaved/R1/2026-10-14_16-05-33.log"));
        assert_eq!(log_path(Path::new("/logs"), Some("  "), "R1", AT), Path::new("/logs/Unsaved/R1/2026-10-14_16-05-33.log"));
    }

    #[test]
    fn names_windows_refuses_are_made_safe() {
        // A GNS3 title or a typed session name can hold any of these.
        assert_eq!(safe_part("R1: core/edge?"), "R1_ core_edge_");
        assert_eq!(safe_part("core."), "core");
        assert_eq!(safe_part("CON"), "CON_");
        assert_eq!(safe_part("com1.log"), "com1.log_");
        assert_eq!(safe_part("Console"), "Console");
        assert_eq!(safe_part("..."), "session");
        assert_eq!(safe_part("///"), "session");
    }

    #[test]
    fn two_logs_in_the_same_second_get_different_files() {
        let dir = tempfile::tempdir().unwrap();
        let first = log_path(dir.path(), Some("Lab"), "R1", AT);
        std::fs::create_dir_all(first.parent().unwrap()).unwrap();
        std::fs::write(&first, b"x").unwrap();
        let second = log_path(dir.path(), Some("Lab"), "R1", AT);
        assert_eq!(second.file_name().unwrap(), "2026-10-14_16-05-33_2.log");
    }

    #[test]
    fn a_session_s_own_choice_wins_over_the_global_setting() {
        let on = LoggingSettings { enabled: true, ..Default::default() };
        let off = LoggingSettings::default();
        let extra = |v: Option<&str>| v.map(|v| [("PlinkyAutoLog".to_string(), v.to_string())].into_iter().collect()).unwrap_or_default();
        assert!(wanted(&on, session_choice(&extra(None))));
        assert!(!wanted(&off, session_choice(&extra(None))));
        assert!(wanted(&off, session_choice(&extra(Some("1")))));
        assert!(!wanted(&on, session_choice(&extra(Some("0")))));
        // Anything else is no choice.
        assert!(wanted(&on, session_choice(&extra(Some("maybe")))));
    }

    #[test]
    fn settings_survive_a_save_and_a_broken_file_reads_as_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("logging.json");
        assert_eq!(LoggingSettings::load(&file), LoggingSettings::default());
        let s = LoggingSettings { enabled: true, dir: Some(dir.path().join("logs")), mode: LogMode::All };
        s.save(&file).unwrap();
        assert_eq!(LoggingSettings::load(&file), s);
        std::fs::write(&file, b"{ not json").unwrap();
        assert_eq!(LoggingSettings::load(&file), LoggingSettings::default());
    }
}
