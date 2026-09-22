use thiserror::Error;

#[derive(Error, Debug)]
pub enum PlinkyError {
    #[error("PTY error: {0}")]
    PtyError(String),

    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Process error: {0}")]
    ProcessError(String),

    #[error("Transport error: {0}")]
    TransportError(String),

    #[error("PreAuth error: {0}")]
    PreAuthError(String),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("PuTTY compatibility error: {0}")]
    PuttyCompatError(#[from] putty_compat::errors::PuttyCompatError),
}

pub type Result<T> = std::result::Result<T, PlinkyError>;
