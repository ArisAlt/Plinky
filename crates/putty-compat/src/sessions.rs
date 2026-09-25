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

pub fn escape_session_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len() * 3);
    for b in name.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' => {
                out.push(*b as char);
            }
            byte => {
                out.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    out
}

pub fn unescape_session_name(filename: &str) -> String {
    let bytes = filename.as_bytes();
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
    String::from_utf8_lossy(&out).to_string()
}

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

pub fn list_sessions() -> Result<Vec<SessionRef>> {
    list_sessions_in(&session_dir())
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

    sessions.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(sessions)
}

pub fn read_session(name: &str) -> Result<PuttySession> {
    read_session_in(&session_dir(), name)
}

pub fn read_session_in(dir: &Path, name: &str) -> Result<PuttySession> {
    let filename = escape_session_name(name);
    let path = dir.join(&filename);
    if !path.exists() {
        return Err(PuttyCompatError::SessionNotFound(name.to_string()));
    }
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
            let key = k.trim().to_string();
            let val = v.trim().to_string();
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
    }

    Ok(session)
}

pub fn write_session(session: &PuttySession) -> Result<()> {
    write_session_in(&session_dir(), session)
}

pub fn write_session_in(dir: &Path, session: &PuttySession) -> Result<()> {
    fs::create_dir_all(dir).map_err(|e| PuttyCompatError::Io {
        path: dir.to_path_buf(),
        source: e,
    })?;

    let filename = escape_session_name(&session.name);
    let target_path = dir.join(&filename);

    if target_path.exists() {
        let bak_path = dir.join(format!("{}.bak", filename));
        let _ = fs::copy(&target_path, &bak_path);
    }

    let temp_file = tempfile::Builder::new()
        .prefix(".plinky-session-")
        .tempfile_in(dir)
        .map_err(|e| PuttyCompatError::Io {
            path: dir.to_path_buf(),
            source: e,
        })?;

    let mut writer = std::io::BufWriter::new(temp_file.as_file());

    writeln!(writer, "HostName={}", session.host_name).map_err(|e| PuttyCompatError::Io {
        path: target_path.clone(),
        source: e,
    })?;
    writeln!(writer, "PortNumber={}", session.port_number).map_err(|e| PuttyCompatError::Io {
        path: target_path.clone(),
        source: e,
    })?;
    writeln!(writer, "UserName={}", session.user_name).map_err(|e| PuttyCompatError::Io {
        path: target_path.clone(),
        source: e,
    })?;
    writeln!(writer, "Protocol={}", session.protocol).map_err(|e| PuttyCompatError::Io {
        path: target_path.clone(),
        source: e,
    })?;
    writeln!(writer, "PublicKeyFile={}", session.public_key_file).map_err(|e| {
        PuttyCompatError::Io {
            path: target_path.clone(),
            source: e,
        }
    })?;
    writeln!(writer, "LogFileName={}", session.log_file_name).map_err(|e| {
        PuttyCompatError::Io {
            path: target_path.clone(),
            source: e,
        }
    })?;

    for (k, v) in &session.extra {
        writeln!(writer, "{}={}", k, v).map_err(|e| PuttyCompatError::Io {
            path: target_path.clone(),
            source: e,
        })?;
    }

    writer.flush().map_err(|e| PuttyCompatError::Io {
        path: target_path.clone(),
        source: e,
    })?;
    drop(writer);

    temp_file
        .as_file()
        .sync_all()
        .map_err(|e| PuttyCompatError::Io {
            path: target_path.clone(),
            source: e,
        })?;

    temp_file.persist(&target_path).map_err(|e| PuttyCompatError::Io {
        path: target_path.clone(),
        source: e.error,
    })?;

    Ok(())
}
