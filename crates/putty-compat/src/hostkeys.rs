use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

use crate::errors::{PuttyCompatError, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostKeyEntry {
    pub key_type: String,
    pub host: String,
    pub port: u16,
    pub raw_key: String,
}

/// PuTTY for Unix's host key file. PuTTY for Windows keeps host keys in the
/// registry instead, which is where [`list_host_keys`] reads them there.
pub fn hostkeys_path() -> PathBuf {
    if let Ok(val) = std::env::var("PUTTYDIR") {
        let p = PathBuf::from(val);
        let s = p.join("sshhostkeys");
        if s.is_file() {
            return s;
        }
    }

    if let Ok(val) = std::env::var("XDG_CONFIG_HOME") {
        let s = PathBuf::from(val).join("putty").join("sshhostkeys");
        if s.is_file() {
            return s;
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".putty").join("sshhostkeys");
    }

    PathBuf::from(".putty/sshhostkeys")
}

pub fn list_host_keys() -> Result<Vec<HostKeyEntry>> {
    #[cfg(windows)]
    return crate::registry::list_host_keys_in(crate::registry::HOST_KEYS_KEY);
    #[cfg(not(windows))]
    return list_host_keys_from(&hostkeys_path());
}

pub fn list_host_keys_from(path: &Path) -> Result<Vec<HostKeyEntry>> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let file = File::open(path).map_err(|e| PuttyCompatError::Io {
        path: path.to_path_buf(),
        source: e,
    })?;

    let reader = BufReader::new(file);
    let mut entries = Vec::new();

    for line in reader.lines() {
        let line = line.map_err(|e| PuttyCompatError::Io {
            path: path.to_path_buf(),
            source: e,
        })?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some((target, raw_key)) = trimmed.split_once(char::is_whitespace) {
            if let Some((key_type, port, host)) = parse_host_key_target(target) {
                entries.push(HostKeyEntry {
                    key_type,
                    host: host.to_string(),
                    port,
                    raw_key: raw_key.trim().to_string(),
                });
            }
        }
    }

    Ok(entries)
}

/// Splits PuTTY's `<key_type>@<port>:<hostname>`, the start of a file line
/// and the whole of a registry value name (where the host is escaped).
pub(crate) fn parse_host_key_target(target: &str) -> Option<(String, u16, &str)> {
    let (key_type, rest) = target.split_once('@')?;
    let (port_str, host) = rest.split_once(':')?;
    let port = port_str.parse::<u16>().unwrap_or(22);
    Some((key_type.to_string(), port, host))
}
