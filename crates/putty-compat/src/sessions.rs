use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

use crate::errors::{PuttyCompatError, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionRef {
    pub name: String,
    pub filename: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PuttySession {
    pub name: String,
    #[serde(alias = "hostname")]
    pub host_name: String,
    #[serde(alias = "port")]
    pub port_number: u16,
    #[serde(alias = "username", default)]
    pub user_name: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(alias = "publicKeyFile", default)]
    pub public_key_file: String,
    /// Path to log raw session output to, PuTTY's own "LogFileName" key.
    /// Empty means logging is disabled -- there's no separate LogType field
    /// yet, this only implements PuTTY's simplest "All session output" mode.
    #[serde(alias = "logFileName", default)]
    pub log_file_name: String,
    #[serde(default)]
    pub extra: BTreeMap<String, String>,
}

impl Default for PuttySession {
    fn default() -> Self {
        Self {
            name: "Default Settings".to_string(),
            host_name: String::new(),
            port_number: 22,
            user_name: String::new(),
            protocol: "ssh".to_string(),
            public_key_file: String::new(),
            log_file_name: String::new(),
            extra: BTreeMap::new(),
        }
    }
}

/// The file name PuTTY for Unix saves session `name` under
/// (`make_session_filename`, PuTTY 0.85 `unix/storage.c`): letters, digits
/// and `+ - . @ _` stay literal, every other byte becomes `%XX`, and an
/// empty name is "Default Settings". It has to match byte for byte --
/// `plink -load` only opens the file under exactly this name.
pub fn escape_session_name(name: &str) -> String {
    let name = if name.is_empty() { "Default Settings" } else { name };
    let mut out = String::with_capacity(name.len() * 3);
    for b in name.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'-' | b'.' | b'@' | b'_' => {
                out.push(*b as char);
            }
            byte => {
                out.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    out
}

/// The file name Plinky used before it matched PuTTY: `+` and `@` were
/// escaped as well. Only looked for, so those sessions aren't lost.
fn legacy_session_filename(name: &str) -> String {
    escape_session_name(name)
        .replace('+', "%2B")
        .replace('@', "%40")
}

/// The file session `name` is saved in, or None if it isn't saved.
///
/// A session only found under its legacy file name is moved to PuTTY's
/// here: Plinky would otherwise list it and hand `plink -load` a name plink
/// can't open, a terminal connected to nothing. The move is a hard link
/// then an unlink, so it never replaces a file PuTTY saved meanwhile; where
/// it can't be made, the legacy file is read as it is.
fn find_session_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let path = dir.join(escape_session_name(name));
    if path.is_file() {
        return Some(path);
    }
    let legacy = dir.join(legacy_session_filename(name));
    if legacy == path || !legacy.is_file() {
        return None;
    }
    if fs::hard_link(&legacy, &path).is_ok() {
        let _ = fs::remove_file(&legacy);
        return Some(path);
    }
    Some(legacy)
}

pub fn unescape_session_name(filename: &str) -> String {
    String::from_utf8_lossy(&percent_decode(filename)).to_string()
}

/// Undoes %XX escaping, byte for byte. PuTTY's file and registry stores
/// escape different characters but decode the same way.
pub(crate) fn percent_decode(escaped: &str) -> Vec<u8> {
    let bytes = escaped.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(val) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(val);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// Where PuTTY for Unix keeps saved sessions. PuTTY for Windows has no
/// sessions directory (and ignores PUTTYDIR): there, [`list_sessions`] and
/// friends use the registry, and this path is only for the `*_in` file
/// functions.
pub fn session_dir() -> PathBuf {
    // Real PuTTY always reads $PUTTYDIR/sessions/. Falling back to $PUTTYDIR
    // itself when that subdirectory didn't exist yet meant Plinky saved
    // sessions where PuTTY (and plink -load) can't see them.
    if let Ok(val) = std::env::var("PUTTYDIR") {
        return PathBuf::from(val).join("sessions");
    }

    if let Ok(val) = std::env::var("XDG_CONFIG_HOME") {
        let s = PathBuf::from(val).join("putty").join("sessions");
        if s.is_dir() {
            return s;
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let s = PathBuf::from(home).join(".putty").join("sessions");
        return s;
    }

    PathBuf::from(".putty/sessions")
}

/// The saved sessions plink -load can open: the registry on Windows, the
/// sessions directory everywhere else.
pub fn list_sessions() -> Result<Vec<SessionRef>> {
    #[cfg(windows)]
    return crate::registry::list_sessions_in(crate::registry::SESSIONS_KEY);
    #[cfg(not(windows))]
    return list_sessions_in(&session_dir());
}

pub fn list_sessions_in(dir: &Path) -> Result<Vec<SessionRef>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(dir).map_err(|e| PuttyCompatError::Io {
        path: dir.to_path_buf(),
        source: e,
    })?;

    let mut sessions = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| PuttyCompatError::Io {
            path: dir.to_path_buf(),
            source: e,
        })?;
        let path = entry.path();
        if path.is_file() {
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                if file_name.ends_with(".bak") || file_name.starts_with('.') {
                    continue;
                }
                let name = unescape_session_name(file_name);
                sessions.push(SessionRef {
                    name,
                    filename: file_name.to_string(),
                    path,
                });
            }
        }
    }

    // Different files can decode to the same name: a legacy file next to
    // PuTTY's own for that session, say. List each name once, and point it
    // at the file read_session_in opens.
    let preference = |s: &SessionRef| {
        if s.filename == escape_session_name(&s.name) {
            0
        } else if s.filename == legacy_session_filename(&s.name) {
            1
        } else {
            2
        }
    };
    sessions.sort_by_cached_key(|s| (s.name.clone(), preference(s), s.filename.clone()));
    sessions.dedup_by(|later, kept| later.name == kept.name);
    Ok(sessions)
}

pub fn read_session(name: &str) -> Result<PuttySession> {
    #[cfg(windows)]
    return crate::registry::read_session_in(crate::registry::SESSIONS_KEY, name);
    #[cfg(not(windows))]
    return read_session_in(&session_dir(), name);
}

pub fn read_session_in(dir: &Path, name: &str) -> Result<PuttySession> {
    let path = find_session_file(dir, name)
        .ok_or_else(|| PuttyCompatError::SessionNotFound(name.to_string()))?;
    parse_session_file(&path, name)
}

pub fn parse_session_file(path: &Path, session_name: &str) -> Result<PuttySession> {
    let file = File::open(path).map_err(|e| PuttyCompatError::Io {
        path: path.to_path_buf(),
        source: e,
    })?;

    let reader = BufReader::new(file);
    let mut session = PuttySession {
        name: session_name.to_string(),
        ..Default::default()
    };

    for line in reader.lines() {
        let line = line.map_err(|e| PuttyCompatError::Io {
            path: path.to_path_buf(),
            source: e,
        })?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some((k, v)) = trimmed.split_once('=') {
            apply_setting(&mut session, k.trim().to_string(), v.trim().to_string());
        }
    }

    Ok(session)
}

/// Puts one saved `key=value` where it belongs: a first-class field, or
/// `extra` for everything Plinky doesn't model (kept for the round trip).
pub(crate) fn apply_setting(session: &mut PuttySession, key: String, val: String) {
    match key.as_str() {
        "HostName" => session.host_name = val,
        "PortNumber" => {
            if let Ok(p) = val.parse::<u16>() {
                session.port_number = p;
            } else {
                session.extra.insert(key, val);
            }
        }
        "UserName" => session.user_name = val,
        "Protocol" => session.protocol = val,
        "PublicKeyFile" => session.public_key_file = val,
        "LogFileName" => session.log_file_name = val,
        _ => {
            session.extra.insert(key, val);
        }
    }
}

/// Everything a session is saved as, in order. Both stores write exactly
/// this, so a session means the same thing whichever one it's in.
pub(crate) fn saved_settings(session: &PuttySession) -> Vec<(&str, String)> {
    let mut settings = vec![
        ("HostName", session.host_name.clone()),
        ("PortNumber", session.port_number.to_string()),
        ("UserName", session.user_name.clone()),
        ("Protocol", session.protocol.clone()),
        ("PublicKeyFile", session.public_key_file.clone()),
        ("LogFileName", session.log_file_name.clone()),
    ];
    settings.extend(session.extra.iter().map(|(k, v)| (k.as_str(), v.clone())));
    settings
}

pub fn write_session(session: &PuttySession) -> Result<()> {
    #[cfg(windows)]
    return crate::registry::write_session_in(crate::registry::SESSIONS_KEY, session);
    #[cfg(not(windows))]
    return write_session_in(&session_dir(), session);
}

pub fn write_session_in(dir: &Path, session: &PuttySession) -> Result<()> {
    fs::create_dir_all(dir).map_err(|e| PuttyCompatError::Io {
        path: dir.to_path_buf(),
        source: e,
    })?;

    let filename = escape_session_name(&session.name);
    let target_path = dir.join(&filename);
    // Normally target_path, but a legacy file that couldn't be moved yet is
    // replaced here too.
    let previous = find_session_file(dir, &session.name);

    if let Some(previous) = &previous {
        let bak_path = dir.join(format!("{}.bak", filename));
        let _ = fs::copy(previous, &bak_path);
    }

    let temp_file = tempfile::Builder::new()
        .prefix(".plinky-session-")
        .tempfile_in(dir)
        .map_err(|e| PuttyCompatError::Io {
            path: dir.to_path_buf(),
            source: e,
        })?;

    let mut writer = std::io::BufWriter::new(temp_file.as_file());
    let io_err = |source| PuttyCompatError::Io {
        path: target_path.clone(),
        source,
    };
    for (key, value) in saved_settings(session) {
        writeln!(writer, "{key}={value}").map_err(io_err)?;
    }
    writer.flush().map_err(io_err)?;
    drop(writer);

    temp_file.as_file().sync_all().map_err(io_err)?;

    temp_file.persist(&target_path).map_err(|e| PuttyCompatError::Io {
        path: target_path.clone(),
        source: e.error,
    })?;

    // Only once the new file is in place, so a failed save loses nothing.
    if let Some(legacy) = previous.filter(|p| *p != target_path) {
        let _ = fs::remove_file(legacy);
    }

    Ok(())
}

pub fn delete_session(name: &str) -> Result<()> {
    #[cfg(windows)]
    return crate::registry::delete_session_in(crate::registry::SESSIONS_KEY, name);
    #[cfg(not(windows))]
    return delete_session_in(&session_dir(), name);
}

/// Removes the session file, as PuTTY's own delete does, and a legacy-named
/// file for the same name too: left behind, it would list the session again
/// with its old settings. A `.bak` from an earlier save is left behind.
pub fn delete_session_in(dir: &Path, name: &str) -> Result<()> {
    let mut filenames = vec![escape_session_name(name), legacy_session_filename(name)];
    filenames.dedup();
    let mut deleted = false;
    for filename in filenames {
        let path = dir.join(filename);
        match fs::remove_file(&path) {
            Ok(()) => deleted = true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(PuttyCompatError::Io { path, source: e }),
        }
    }
    if !deleted {
        return Err(PuttyCompatError::SessionNotFound(name.to_string()));
    }
    Ok(())
}
