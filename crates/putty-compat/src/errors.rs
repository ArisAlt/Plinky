use std::path::PathBuf;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum PuttyCompatError {
    #[error("I/O error at {path:?}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// Windows only: PuTTY keeps sessions and host keys under
    /// HKEY_CURRENT_USER, `key` is the path below it.
    #[error("Registry error at HKEY_CURRENT_USER\\{key}: {source}")]
    Registry {
        key: String,
        #[source]
        source: std::io::Error,
    },

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    /// A folder move failed and some sessions it had already saved could not
    /// be put back. Named, so the user knows which ones sit at the new path.
    #[error("Folder move failed ({cause}) and these sessions could not be restored: {}", unrestored.join(", "))]
    PartialFolderMove { cause: String, unrestored: Vec<String> },

    #[error("Corrupt session file at {path:?}: {reason}")]
    CorruptSession { path: PathBuf, reason: String },

    #[error("Invalid PPK file at {path:?}: {reason}")]
    InvalidPpk { path: PathBuf, reason: String },

    #[error("Unsupported PPK version: {0}")]
    UnsupportedPpkVersion(u8),

    #[error("Base64 decode error at {path:?}: {source}")]
    Base64Error {
        path: PathBuf,
        #[source]
        source: base64::DecodeError,
    },
}

pub type Result<T> = std::result::Result<T, PuttyCompatError>;
