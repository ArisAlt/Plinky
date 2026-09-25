use crate::errors::Result;

pub mod local;
pub mod plink;
pub mod serial;

pub trait Transport: Send {
    /// Asserts (`true`) or releases (`false`) a line break condition. Only a
    /// serial line can do this; plink has no break interface (ADR-005).
    fn set_break(&mut self, _on: bool) -> Result<()> {
        Err(crate::errors::PlinkyError::ProcessError(
            "Send Break is only supported on serial sessions".into(),
        ))
    }

    /// Writes raw bytes (keystrokes, commands) directly into the PTY master.
    fn write(&mut self, data: &[u8]) -> Result<()>;

    /// Propagates terminal resize (columns, rows) to the underlying PTY.
    fn resize(&mut self, cols: u16, rows: u16) -> Result<()>;

    /// Explicitly terminates the transport and child process.
    fn kill(&mut self) -> Result<()>;

    /// Checks if the underlying process is still running.
    fn is_alive(&mut self) -> bool;
}
