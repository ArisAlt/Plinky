use crate::errors::Result;

pub mod local;
pub mod plink;

pub trait Transport: Send {
    /// Writes raw bytes (keystrokes, commands) directly into the PTY master.
    fn write(&mut self, data: &[u8]) -> Result<()>;

    /// Propagates terminal resize (columns, rows) to the underlying PTY.
    fn resize(&mut self, cols: u16, rows: u16) -> Result<()>;

    /// Explicitly terminates the transport and child process.
    fn kill(&mut self) -> Result<()>;

    /// Checks if the underlying process is still running.
    fn is_alive(&mut self) -> bool;
}
