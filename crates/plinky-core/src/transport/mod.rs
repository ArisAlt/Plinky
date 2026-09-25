use crate::errors::Result;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

pub mod local;
pub mod plink;
pub mod serial;

/// Handle to a PTY child whose output is being pumped by [`pump_pty_child`].
pub(crate) struct PtyChild {
    pub killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    pub alive: Arc<AtomicBool>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Forwards a PTY child's output to `out_tx` and ends the stream when the
/// child exits -- the session manager reports a closed stream as a closed
/// session.
///
/// Ending on EOF alone wasn't enough. On Windows, ConPTY keeps the output
/// pipe open after the child exits, so a dead shell, or an SSH session whose
/// plink had quit, stayed "live" forever. On Unix the same happens while
/// anything the shell started still holds the terminal. So a second thread
/// waits on the child itself; once it has exited and output has been quiet
/// for a moment (trailing output still drains), the stream is closed.
pub(crate) fn pump_pty_child(
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    out_tx: mpsc::UnboundedSender<Vec<u8>>,
) -> PtyChild {
    let killer = child.clone_killer();
    let alive = Arc::new(AtomicBool::new(true));
    let sender = Arc::new(Mutex::new(Some(out_tx)));
    let last_output = Arc::new(AtomicU64::new(now_ms()));

    let (reader_sender, reader_last) = (sender.clone(), last_output.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    reader_last.store(now_ms(), Ordering::Relaxed);
                    let guard = reader_sender.lock().unwrap();
                    match guard.as_ref() {
                        Some(tx) if tx.send(buf[..n].to_vec()).is_ok() => {}
                        _ => break,
                    }
                }
            }
        }
        reader_sender.lock().unwrap().take();
    });

    let waiter_alive = alive.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        waiter_alive.store(false, Ordering::Relaxed);
        let deadline = now_ms() + 2000;
        while now_ms() < deadline && now_ms().saturating_sub(last_output.load(Ordering::Relaxed)) < 200 {
            std::thread::sleep(Duration::from_millis(50));
        }
        sender.lock().unwrap().take();
    });

    PtyChild { killer, alive }
}

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
