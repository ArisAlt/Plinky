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
    list_host_keys_from(&hostkeys_path())
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
            let raw_key = raw_key.trim().to_string();
            // Format: <key_type>@<port>:<hostname>
            if let Some((key_type, rest)) = target.split_once('@') {
                if let Some((port_str, host)) = rest.split_once(':') {
                    let port = port_str.parse::<u16>().unwrap_or(22);
                    entries.push(HostKeyEntry {
                        key_type: key_type.to_string(),
                        host: host.to_string(),
                        port,
                        raw_key,
                    });
                }
            }
        }
    }

    Ok(entries)
}
