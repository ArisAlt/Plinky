//! Carries sessions saved by Plinky 0.1.0 for Windows into the registry.
//!
//! 0.1.0 kept sessions as files on every platform, the way PuTTY for Unix
//! does. plink.exe only reads HKCU\Software\SimonTatham\PuTTY\Sessions, so
//! `plink -load <name>` found nothing and every session saved in 0.1.0 on
//! Windows failed with "plink: no valid host name provided". Later builds
//! use the registry (registry.rs), which on its own would make those saved
//! sessions vanish instead; this copies them over once.
//!
//! The old folders are only read, never moved or deleted: $PUTTYDIR or
//! $XDG_CONFIG_HOME/putty can belong to another PuTTY port (MSYS2, Cygwin)
//! that still uses them. Which folders are done is kept in a marker file,
//! so a session the user later deletes from the registry doesn't come back.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::errors::Result;
use crate::sessions::{list_sessions_in, read_session_in, PuttySession};

/// PuTTY's template for new sessions. Never copied: it would replace the
/// user's own PuTTY defaults.
pub const DEFAULT_SETTINGS: &str = "Default Settings";

/// The marker file's name, in Plinky's app data folder.
pub const MARKER_FILE: &str = "legacy-sessions-imported";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ImportReport {
    pub imported: Vec<String>,
    /// Already in the destination, which wins: left exactly as it is there.
    pub skipped_existing: Vec<String>,
    /// (session, error). A folder with failures is retried next launch.
    pub failed: Vec<(String, String)>,
}

/// Copies every session in the file store `dir` into another store, never
/// overwriting one that `exists` there, and never "Default Settings".
pub fn import_file_sessions(
    dir: &Path,
    exists: impl Fn(&str) -> bool,
    mut write: impl FnMut(&PuttySession) -> Result<()>,
) -> Result<ImportReport> {
    let mut report = ImportReport::default();
    for r in list_sessions_in(dir)? {
        if r.name == DEFAULT_SETTINGS {
            continue;
        }
        if exists(&r.name) {
            report.skipped_existing.push(r.name);
            continue;
        }
        match read_session_in(dir, &r.name).and_then(|s| write(&s)) {
            Ok(()) => report.imported.push(r.name),
            Err(e) => report.failed.push((r.name, e.to_string())),
        }
    }
    Ok(report)
}

/// Every folder Plinky 0.1.0 on Windows could have saved sessions in. Its
/// session_dir() tried $PUTTYDIR/sessions, $XDG_CONFIG_HOME/putty/sessions
/// and $HOME/.putty/sessions -- Windows sets none of these by default --
/// and otherwise used a *relative* .putty/sessions: relative to wherever
/// the app was started, normally its install folder or, for the portable
/// exe, the folder it sits in. Both are checked; duplicates dropped.
pub fn legacy_session_dirs(
    var: impl Fn(&str) -> Option<String>,
    cwd: Option<&Path>,
    exe_dir: Option<&Path>,
) -> Vec<PathBuf> {
    let set = |k: &str| var(k).filter(|v| !v.is_empty());
    let mut dirs = Vec::new();
    if let Some(v) = set("PUTTYDIR") {
        dirs.push(PathBuf::from(v).join("sessions"));
    }
    if let Some(v) = set("XDG_CONFIG_HOME") {
        dirs.push(PathBuf::from(v).join("putty").join("sessions"));
    }
    if let Some(v) = set("HOME") {
        dirs.push(PathBuf::from(v).join(".putty").join("sessions"));
    }
    for base in [cwd, exe_dir].into_iter().flatten() {
        dirs.push(base.join(".putty").join("sessions"));
    }
    let mut seen = HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

fn done_dirs(marker: &Path) -> HashSet<String> {
    fs::read_to_string(marker)
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn mark_done(marker: &Path, dir: &Path) -> std::io::Result<()> {
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(marker)?;
    writeln!(f, "{}", dir.display())
}

/// Imports each of `dirs` that exists and isn't in `marker` yet. A folder
/// is marked done only when nothing in it failed.
pub fn import_legacy_sessions(
    dirs: &[PathBuf],
    marker: &Path,
    exists: impl Fn(&str) -> bool,
    mut write: impl FnMut(&PuttySession) -> Result<()>,
) -> Vec<(PathBuf, Result<ImportReport>)> {
    let done = done_dirs(marker);
    let mut out = Vec::new();
    for dir in dirs {
        if !dir.is_dir() || done.contains(&dir.display().to_string()) {
            continue;
        }
        let report = import_file_sessions(dir, &exists, &mut write);
        if matches!(&report, Ok(r) if r.failed.is_empty()) {
            // If the marker can't be written, the import simply runs again
            // next launch; with nothing overwritten, that's harmless.
            let _ = mark_done(marker, dir);
        }
        out.push((dir.clone(), report));
    }
    out
}

/// Windows: carries 0.1.0's session files into PuTTY's registry key.
#[cfg(windows)]
pub fn import_into_registry(marker: &Path) -> Vec<(PathBuf, Result<ImportReport>)> {
    let cwd = std::env::current_dir().ok();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    let dirs = legacy_session_dirs(
        |k| std::env::var(k).ok(),
        cwd.as_deref(),
        exe_dir.as_deref(),
    );
    import_into_registry_key(crate::registry::SESSIONS_KEY, &dirs, marker)
}

/// [`import_into_registry`] with the sessions key and folders given, so the
/// Windows test can use a scratch key instead of the user's PuTTY settings.
#[cfg(windows)]
pub fn import_into_registry_key(
    sessions_key: &str,
    dirs: &[PathBuf],
    marker: &Path,
) -> Vec<(PathBuf, Result<ImportReport>)> {
    use crate::registry::{read_session_in as reg_read, write_session_in as reg_write};
    import_legacy_sessions(
        dirs,
        marker,
        |name| reg_read(sessions_key, name).is_ok(),
        |s| reg_write(sessions_key, s),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::PuttyCompatError;
    use crate::sessions::write_session_in;

    fn session(name: &str, host: &str) -> PuttySession {
        let mut s = PuttySession {
            name: name.to_string(),
            host_name: host.to_string(),
            user_name: "netops".to_string(),
            ..Default::default()
        };
        s.extra
            .insert("PlinkyFolder".to_string(), "Corp 1/Site 1".to_string());
        s
    }

    /// Two file stores stand in for "0.1.0's folder" and "the registry".
    fn stores() -> (tempfile::TempDir, tempfile::TempDir) {
        (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap())
    }

    #[test]
    fn copies_new_sessions_and_leaves_existing_and_default_settings_alone() {
        let (old, reg) = stores();
        write_session_in(old.path(), &session("core/sw1", "192.0.2.1")).unwrap();
        write_session_in(old.path(), &session("edge", "192.0.2.2")).unwrap();
        write_session_in(old.path(), &session(DEFAULT_SETTINGS, "")).unwrap();
        // Already in the registry with a different host: the registry wins.
        write_session_in(reg.path(), &session("edge", "198.51.100.9")).unwrap();

        let report = import_file_sessions(
            old.path(),
            |n| read_session_in(reg.path(), n).is_ok(),
            |s| write_session_in(reg.path(), s),
        )
        .unwrap();

        assert_eq!(report.imported, vec!["core/sw1"]);
        assert_eq!(report.skipped_existing, vec!["edge"]);
        assert!(report.failed.is_empty());
        let copied = read_session_in(reg.path(), "core/sw1").unwrap();
        assert_eq!(copied.host_name, "192.0.2.1");
        assert_eq!(
            copied.extra.get("PlinkyFolder").map(String::as_str),
            Some("Corp 1/Site 1")
        );
        assert_eq!(
            read_session_in(reg.path(), "edge").unwrap().host_name,
            "198.51.100.9"
        );
        assert!(read_session_in(reg.path(), DEFAULT_SETTINGS).is_err());
    }

    #[test]
    fn a_failed_write_is_reported_and_the_rest_still_copied() {
        let (old, reg) = stores();
        write_session_in(old.path(), &session("a", "192.0.2.1")).unwrap();
        write_session_in(old.path(), &session("b", "192.0.2.2")).unwrap();
        let report = import_file_sessions(
            old.path(),
            |_| false,
            |s| {
                if s.name == "a" {
                    return Err(PuttyCompatError::SessionNotFound("registry says no".into()));
                }
                write_session_in(reg.path(), s)
            },
        )
        .unwrap();
        assert_eq!(report.imported, vec!["b"]);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].0, "a");
    }

    #[test]
    fn looks_where_0_1_0_could_have_saved_including_the_relative_fallback() {
        let none = |_: &str| None;
        let cwd = Path::new("/apps/Plinky");
        let exe = Path::new("/portable");
        assert_eq!(
            legacy_session_dirs(none, Some(cwd), Some(exe)),
            vec![cwd.join(".putty/sessions"), exe.join(".putty/sessions")]
        );
        // Started from its own folder: cwd and exe dir are the same place.
        assert_eq!(
            legacy_session_dirs(none, Some(cwd), Some(cwd)),
            vec![cwd.join(".putty/sessions")]
        );

        let vars = |k: &str| match k {
            "PUTTYDIR" => Some("/p".to_string()),
            "XDG_CONFIG_HOME" => Some("/x".to_string()),
            "HOME" => Some("/h".to_string()),
            _ => None,
        };
        assert_eq!(
            legacy_session_dirs(vars, None, None),
            vec![
                PathBuf::from("/p/sessions"),
                PathBuf::from("/x/putty/sessions"),
                PathBuf::from("/h/.putty/sessions"),
            ]
        );
    }

    #[test]
    fn runs_once_per_folder_so_a_session_deleted_later_stays_deleted() {
        let (old, reg) = stores();
        let marker_dir = tempfile::tempdir().unwrap();
        let marker = marker_dir.path().join("app").join(MARKER_FILE);
        write_session_in(old.path(), &session("core", "192.0.2.1")).unwrap();
        let dirs = vec![old.path().to_path_buf(), old.path().join("missing")];
        let run = || {
            import_legacy_sessions(
                &dirs,
                &marker,
                |n| read_session_in(reg.path(), n).is_ok(),
                |s| write_session_in(reg.path(), s),
            )
        };

        let first = run();
        assert_eq!(first.len(), 1, "a folder that doesn't exist is skipped");
        assert_eq!(first[0].1.as_ref().unwrap().imported, vec!["core"]);

        crate::sessions::delete_session_in(reg.path(), "core").unwrap();
        assert!(
            run().is_empty(),
            "the folder is done: nothing imported again"
        );
        assert!(read_session_in(reg.path(), "core").is_err());
    }

    #[test]
    fn a_folder_with_a_failure_is_tried_again_next_launch() {
        let (old, reg) = stores();
        let marker_dir = tempfile::tempdir().unwrap();
        let marker = marker_dir.path().join(MARKER_FILE);
        write_session_in(old.path(), &session("core", "192.0.2.1")).unwrap();
        let dirs = vec![old.path().to_path_buf()];

        let failing = import_legacy_sessions(
            &dirs,
            &marker,
            |_| false,
            |_| {
                Err(PuttyCompatError::SessionNotFound(
                    "registry unavailable".into(),
                ))
            },
        );
        assert_eq!(failing[0].1.as_ref().unwrap().failed.len(), 1);

        let retry = import_legacy_sessions(
            &dirs,
            &marker,
            |n| read_session_in(reg.path(), n).is_ok(),
            |s| write_session_in(reg.path(), s),
        );
        assert_eq!(retry[0].1.as_ref().unwrap().imported, vec!["core"]);
    }
}

/// The real thing on Windows: file store in, registry out, against a scratch
/// key under HKEY_CURRENT_USER -- never PuTTY's own.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use crate::registry::{read_session_in as reg_read, PUTTY_KEY};
    use crate::sessions::write_session_in;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    struct ScratchKey(String);
    impl Drop for ScratchKey {
        fn drop(&mut self) {
            let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.0);
        }
    }

    #[test]
    fn a_0_1_0_session_file_lands_in_the_registry_where_plink_looks() {
        let root = ScratchKey(format!(
            r"Software\PlinkyTest-legacy-{}",
            std::process::id()
        ));
        assert!(!root.0.starts_with(PUTTY_KEY));
        let sessions_key = format!(r"{}\Sessions", root.0);
        let old = tempfile::tempdir().unwrap();
        let marker = old.path().join(MARKER_FILE);
        let mut s = PuttySession {
            name: "core/sw1 lab".to_string(),
            host_name: "192.0.2.10".to_string(),
            port_number: 2222,
            user_name: "admin".to_string(),
            ..Default::default()
        };
        s.extra
            .insert("PlinkyFolder".to_string(), "Corp 1/Site 1".to_string());
        let dir = old.path().join(".putty").join("sessions");
        write_session_in(&dir, &s).unwrap();

        let out = import_into_registry_key(&sessions_key, &[dir.clone()], &marker);
        assert_eq!(out[0].1.as_ref().unwrap().imported, vec!["core/sw1 lab"]);
        let back = reg_read(&sessions_key, "core/sw1 lab").unwrap();
        assert_eq!(back.host_name, "192.0.2.10");
        assert_eq!(
            back.port_number, 2222,
            "PortNumber must come back as the number, not 22"
        );
        assert_eq!(
            back.extra.get("PlinkyFolder").map(String::as_str),
            Some("Corp 1/Site 1")
        );
        assert!(import_into_registry_key(&sessions_key, &[dir], &marker).is_empty());
    }
}
