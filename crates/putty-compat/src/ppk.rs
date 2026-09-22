use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::errors::{PuttyCompatError, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PpkHeader {
    pub version: u8,
    pub algo: String,
    pub encrypted: bool,
    pub encryption_type: String,
    pub comment: String,
    pub fingerprint: String,
    #[serde(skip)]
    pub public_key_raw: Vec<u8>,
}

pub fn looks_like_ppk(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mut reader = BufReader::new(file);
    let mut first_line = String::new();
    if reader.read_line(&mut first_line).is_err() {
        return false;
    }
    first_line.trim_start().starts_with("PuTTY-User-Key-File-")
}

pub fn read_header(path: &Path) -> Result<PpkHeader> {
    let file = File::open(path).map_err(|e| PuttyCompatError::Io {
        path: path.to_path_buf(),
        source: e,
    })?;

    let mut reader = BufReader::new(file);
    let mut line = String::new();

    // 1. First line: PuTTY-User-Key-File-<version>: <algo>
    if reader.read_line(&mut line).map_err(|e| PuttyCompatError::Io {
        path: path.to_path_buf(),
        source: e,
    })? == 0 {
        return Err(PuttyCompatError::InvalidPpk {
            path: path.to_path_buf(),
            reason: "File is empty".to_string(),
        });
    }

    let header_prefix = "PuTTY-User-Key-File-";
    let trimmed = line.trim();
    if !trimmed.starts_with(header_prefix) {
        return Err(PuttyCompatError::InvalidPpk {
            path: path.to_path_buf(),
            reason: format!("Does not start with {header_prefix}"),
        });
    }

    let rest = &trimmed[header_prefix.len()..];
    let Some((ver_str, algo_str)) = rest.split_once(':') else {
        return Err(PuttyCompatError::InvalidPpk {
            path: path.to_path_buf(),
            reason: "Missing version/algo separator ':'".to_string(),
        });
    };

    let version: u8 = ver_str.trim().parse().map_err(|_| PuttyCompatError::InvalidPpk {
        path: path.to_path_buf(),
        reason: format!("Invalid version: {ver_str}"),
    })?;

    if version != 2 && version != 3 {
        return Err(PuttyCompatError::UnsupportedPpkVersion(version));
    }

    let algo = algo_str.trim().to_string();

    let mut encryption_type = String::new();
    let mut comment = String::new();
    let mut public_lines_count: Option<usize> = None;

    // 2. Parse headers until Public-Lines
    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).map_err(|e| PuttyCompatError::Io {
            path: path.to_path_buf(),
            source: e,
        })?;
        if bytes_read == 0 {
            break;
        }

        let trimmed_line = line.trim();
        if trimmed_line.is_empty() {
            continue;
        }

        if let Some((key, val)) = trimmed_line.split_once(':') {
            let key = key.trim();
            let val = val.trim();
            match key {
                "Encryption" => encryption_type = val.to_string(),
                "Comment" => comment = val.to_string(),
                "Public-Lines" => {
                    let count: usize = val.parse().map_err(|_| PuttyCompatError::InvalidPpk {
                        path: path.to_path_buf(),
                        reason: format!("Invalid Public-Lines count: {val}"),
                    })?;
                    public_lines_count = Some(count);
                    break;
                }
                _ => {}
            }
        }
    }

    let count = public_lines_count.ok_or_else(|| PuttyCompatError::InvalidPpk {
        path: path.to_path_buf(),
        reason: "Missing 'Public-Lines' field".to_string(),
    })?;

    // 3. Read Public-Lines base64 lines
    let mut b64_pub = String::new();
    for _ in 0..count {
        line.clear();
        let bytes_read = reader.read_line(&mut line).map_err(|e| PuttyCompatError::Io {
            path: path.to_path_buf(),
            source: e,
        })?;
        if bytes_read == 0 {
            return Err(PuttyCompatError::InvalidPpk {
                path: path.to_path_buf(),
                reason: "Unexpected EOF while reading public key lines".to_string(),
            });
        }
        b64_pub.push_str(line.trim());
    }

    // 4. Decode public key and compute SHA256 fingerprint
    let public_key_raw = BASE64_STANDARD
        .decode(&b64_pub)
        .map_err(|e| PuttyCompatError::Base64Error {
            path: path.to_path_buf(),
            source: e,
        })?;

    let hash = Sha256::digest(&public_key_raw);
    let b64_hash = BASE64_STANDARD.encode(hash);
    let trimmed_hash = b64_hash.trim_end_matches('=');
    let fingerprint = format!("SHA256:{trimmed_hash}");

    let encrypted = !encryption_type.is_empty() && encryption_type.to_lowercase() != "none";

    Ok(PpkHeader {
        version,
        algo,
        encrypted,
        encryption_type,
        comment,
        fingerprint,
        public_key_raw,
    })
}
