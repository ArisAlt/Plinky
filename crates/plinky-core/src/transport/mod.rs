use crate::errors::Result;
use crate::session::flow::FlowGate;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

pub mod local;
pub mod plink;
pub mod serial;
pub mod tcp_state;

/// Handle to a PTY child whose output is being pumped by [`pump_pty_child`].
pub(crate) struct PtyChild {
    pub killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    pub alive: Arc<AtomicBool>,
    output: Arc<Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>>,
    flow: Arc<FlowGate>,
}

impl PtyChild {
    /// Adds bytes to the session's output as if the child had written them:
    /// the echo plink leaves to its terminal (plink.rs, `LocalEcho`). Sent
    /// through the reader's own sender, so it lands in order with the
    /// child's output, and charged to the flow window like it.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn inject(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let n = bytes.len();
        let guard = self.output.lock().unwrap();
        if let Some(tx) = guard.as_ref() {
            if tx.send(bytes).is_ok() {
                self.flow.charge(n);
            }
        }
    }
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
    flow: Arc<FlowGate>,
) -> PtyChild {
    let killer = child.clone_killer();
    let alive = Arc::new(AtomicBool::new(true));
    let sender = Arc::new(Mutex::new(Some(out_tx)));
    let last_output = Arc::new(AtomicU64::new(now_ms()));

    let (reader_sender, reader_last, reader_flow) = (sender.clone(), last_output.clone(), flow.clone());
    let (sender_for_echo, flow_for_echo) = (sender.clone(), flow.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            // Don't read while the page is a full window behind (ADR-006):
            // the PTY buffer fills and plink slows down instead.
            reader_flow.wait_for_room();
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    reader_last.store(now_ms(), Ordering::Relaxed);
                    let guard = reader_sender.lock().unwrap();
                    match guard.as_ref() {
                        // Charged here, at the source: if the tasks between
                        // here and the page fall behind, the reader still
                        // stops at the window instead of racing ahead.
                        Some(tx) if tx.send(buf[..n].to_vec()).is_ok() => reader_flow.charge(n),
                        // Nobody is listening, but keep draining to EOF:
                        // Windows' ClosePseudoConsole waits for the output
                        // pipe to empty, and a reader that stopped here left
                        // closing the tab (or the app) hanging.
                        _ => {}
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
        // A reader waiting for room must not outlive the process.
        flow.close();
    });

    PtyChild { killer, alive, output: sender_for_echo, flow: flow_for_echo }
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

    /// The process that makes the network connection, where there is one
    /// (plink). Used to see when its connection is up (tcp_state.rs).
    fn process_id(&self) -> Option<u32> {
        None
    }

    /// The login is over: plink now reads the session as it runs, not
    /// line by line (see PlinkTransport::begun). Only plink cares.
    fn session_begun(&mut self) {}

    /// Whether `session_begun` has happened (always, where there's no login).
    fn has_begun(&self) -> bool {
        true
    }

    /// Explicitly terminates the transport and child process.
    fn kill(&mut self) -> Result<()>;

    /// Checks if the underlying process is still running.
    fn is_alive(&mut self) -> bool;
}
