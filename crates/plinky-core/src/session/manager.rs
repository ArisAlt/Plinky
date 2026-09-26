use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, broadcast};
use crate::errors::{PlinkyError, Result};
use crate::transport::Transport;
use crate::transport::local::LocalTransport;
use crate::transport::plink::PlinkTransport;
use crate::session::flow::{FlowGate, OUTPUT_WINDOW};
use crate::session::state_machine::{PreAuthStateMachine, PreAuthAction, SessionState, HostKeyPromptInfo, CloseReason};
use crate::session::ring_buffer::ScrollbackRingBuffer;


#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AttachInfo {
    pub session_id: String,
    pub replay_data: Vec<u8>,
    pub truncated: bool,
    pub is_live: bool,
    /// Set when the session is still waiting on a host-key decision. The
    /// prompt event is broadcast once, so a view attaching later (tab was
    /// in the background) needs it here to re-show the dialog.
    pub pending_prompt: Option<HostKeyPromptInfo>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub enum PromptAnswer {
    AcceptAndStore,
    AcceptOnce,
    Reject,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PromptEvent {
    pub session_id: String,
    pub prompt: HostKeyPromptInfo,
}

pub struct ActiveSession {
    pub id: String,
    pub name: String,
    pub transport: Box<dyn Transport>,
    pub state_machine: PreAuthStateMachine,
    pub scrollback: ScrollbackRingBuffer,
    pub subscriber: Arc<Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>>,
    /// Written to disk as output arrives (see `session::log`).
    pub log: Option<super::log::SessionLog>,
    /// How far the attached page is behind (ADR-006). Shared with the
    /// transport's reader, which waits on it.
    pub flow: Arc<FlowGate>,
    /// Unique per spawned process. A session id can be reused after a close,
    /// so a reader task checks this before touching the map entry -- keyed
    /// by id alone, a closed session's trailing output and EOF landed on its
    /// successor.
    pub instance: u64,
    /// Answers the jump host's and the final host's password prompts, for a
    /// session through a jump host (see `jump_login`). Dropped once Live.
    pub jump_login: Option<super::jump_login::JumpLogin>,
}

static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct SessionRegistry {
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
    prompt_tx: broadcast::Sender<PromptEvent>,
    sync_router: Arc<Mutex<crate::sync::router::SyncInputRouter>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        let (prompt_tx, _) = broadcast::channel(64);
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            prompt_tx,
            sync_router: Arc::new(Mutex::new(crate::sync::router::SyncInputRouter::new())),
        }
    }

    /// Subscribes to host key prompt events across all active sessions.
    pub fn subscribe_prompts(&self) -> broadcast::Receiver<PromptEvent> {
        self.prompt_tx.subscribe()
    }

    /// Spawns a local shell session.
    pub fn create_local_session(
        &self,
        id: &str,
        name: &str,
        log_file_name: Option<String>,
        cols: u16,
        rows: u16,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
    ) -> Result<()> {
        let (raw_tx, raw_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let flow = Arc::new(FlowGate::new(OUTPUT_WINDOW));
        let transport = LocalTransport::spawn(cols, rows, raw_tx, flow.clone())?;
        self.register_live_session(id, name, Box::new(transport), raw_rx, log_file_name, out_tx, flow)
    }

    /// Opens a serial console session with the native transport (ADR-005).
    pub fn create_serial_session(
        &self,
        id: &str,
        name: &str,
        config: &crate::transport::serial::SerialConfig,
        log_file_name: Option<String>,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
    ) -> Result<()> {
        let (raw_tx, raw_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let transport = crate::transport::serial::SerialTransport::open(config, raw_tx)?;
        // A serial line can't outrun the page (115200 baud is ~11 KB/s), so
        // its reader doesn't wait; the gate only keeps the accounting uniform.
        let flow = Arc::new(FlowGate::new(OUTPUT_WINDOW));
        self.register_live_session(id, name, Box::new(transport), raw_rx, log_file_name, out_tx, flow)
    }

    /// Holds a line break for `duration` (serial sessions only). The map lock
    /// is released while the break is held so other sessions' output isn't
    /// stalled for the whole break.
    pub async fn send_break(&self, id: &str, duration: std::time::Duration) -> Result<()> {
        {
            let mut lock = self.sessions.lock().unwrap();
            let session = lock.get_mut(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;
            session.transport.set_break(true)?;
        }
        tokio::time::sleep(duration).await;
        let mut lock = self.sessions.lock().unwrap();
        let session = lock.get_mut(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;
        session.transport.set_break(false)
    }

    /// Registers a session with no pre-auth phase (local shell, serial line):
    /// every byte is terminal output from the start, so it begins Live.
    #[allow(clippy::too_many_arguments)]
    fn register_live_session(
        &self,
        id: &str,
        name: &str,
        transport: Box<dyn Transport>,
        mut raw_rx: mpsc::UnboundedReceiver<Vec<u8>>,
        log_file_name: Option<String>,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
        flow: Arc<FlowGate>,
    ) -> Result<()> {
        let log_file = log_file_name
            .as_deref()
            .filter(|p| !p.is_empty())
            .and_then(|p| super::log::SessionLog::open(std::path::Path::new(p), super::log::LogMode::All).ok());

        let id_owned = id.to_string();
        let subscriber = Arc::new(Mutex::new(Some(out_tx)));
        let sub_clone = subscriber.clone();
        let registry_clone = self.clone();
        let id_for_task = id.to_string();
        let instance = NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed);
        let flow_for_task = flow.clone();

        let reader = async move {
            // Whether the loop's end has already been accounted for (Closed
            // action sent its own notice, or the session was removed). If
            // not, raw_rx hit EOF: the process exited on its own.
            let mut reported = false;
            while let Some(chunk) = raw_rx.recv().await {
                let action = {
                    let mut lock = registry_clone.sessions.lock().unwrap();
                    if let Some(session) = lock.get_mut(&id_for_task).filter(|s| s.instance == instance) {
                        session.scrollback.push(&chunk);
                        // PuTTY-style "all session output" logging: every raw
                        // byte the PTY produces, regardless of PreAuth/Live
                        // state -- a failed write just leaves the session
                        // running, it never blocks the connection.
                        if let Some(log) = session.log.as_mut() {
                            // A log that can't be written any more (disk
                            // full, drive gone) is closed, not retried per
                            // chunk; the session carries on.
                            if log.write(&chunk).is_err() {
                                session.log = None;
                            }
                        }
                        session.state_machine.feed_bytes(&chunk)
                    } else {
                        reported = true;
                        break;
                    }
                };

                // Charged by the reader when read; what doesn't reach the
                // page (a withheld prompt, a detached tab) is refunded below.
                let chunk_len = chunk.len();
                let mut forwarded = 0usize;
                match action {
                    PreAuthAction::Hold => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            if tx.send(chunk).is_ok() {
                                forwarded = chunk_len;
                            }
                        }
                    }
                    PreAuthAction::PassThrough(bytes) | PreAuthAction::TransitionToLive(bytes) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let n = bytes.len();
                            if tx.send(bytes).is_ok() {
                                forwarded = n;
                            }
                        }
                    }
                    PreAuthAction::Suppress => {}
                    PreAuthAction::HostKeyPrompt(info) => {
                        // Priority 1 security fix: DO NOT forward raw chunk to terminal.
                        // Broadcast structured prompt event for native UI dialog.
                        let _ = registry_clone.prompt_tx.send(PromptEvent {
                            session_id: id_for_task.clone(),
                            prompt: info,
                        });
                    }
                    PreAuthAction::Closed(reason) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let msg = match reason {
                                CloseReason::AuthFailed(err) => {
                                    if let Some(pos) = err.find("FATAL ERROR:") {
                                        format!("\r\n\x1b[31m{}\x1b[0m\r\n", &err[pos..].trim())
                                    } else {
                                        format!("\r\n\x1b[31m[Plinky: Session closed ({})]\x1b[0m\r\n", err)
                                    }
                                }
                                CloseReason::HostKeyRejected => {
                                    "\r\n\x1b[31m[Plinky: Host key was rejected]\x1b[0m\r\n".to_string()
                                }
                                CloseReason::Error(err) => {
                                    format!("\r\n\x1b[31m[Plinky: Error: {}]\x1b[0m\r\n", err)
                                }
                                CloseReason::Ok => {
                                    "\r\n[Plinky: Session closed]\r\n".to_string()
                                }
                            };
                            let _ = tx.send(msg.into_bytes());
                        }
                        reported = true;
                        break;
                    }
                }
                flow_for_task.ack(chunk_len.saturating_sub(forwarded) as u64);
            }
            if !reported {
                registry_clone.report_process_exit(&id_for_task, instance, &sub_clone);
            }
        };

        let mut sm = PreAuthStateMachine::new();
        sm.force_live(); // No pre-auth phase: Live immediately

        let active = ActiveSession {
            id: id_owned.clone(),
            name: name.to_string(),
            transport,
            state_machine: sm,
            scrollback: ScrollbackRingBuffer::new(2 * 1024 * 1024), // 2 MiB
            subscriber,
            log: log_file,
            flow,
            instance,
            jump_login: None,
        };

        self.insert_new_session(id_owned, active)?;
        tokio::spawn(reader);
        Ok(())
    }

    /// Spawns an interactive plink PuTTY session.
    pub fn create_plink_session(
        &self,
        id: &str,
        session_name: &str,
        explicit_target: Option<crate::transport::plink::ExplicitTarget>,
        log_file_name: Option<String>,
        cols: u16,
        rows: u16,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
    ) -> Result<()> {
        self.create_plink_session_with_login(id, session_name, explicit_target, None, log_file_name, cols, rows, out_tx)
    }

    /// Like `create_plink_session`, with plink logging in by itself from a
    /// vault password (SSH).
    #[allow(clippy::too_many_arguments)]
    pub fn create_plink_session_with_login(
        &self,
        id: &str,
        session_name: &str,
        explicit_target: Option<crate::transport::plink::ExplicitTarget>,
        login: Option<crate::transport::plink::PlinkLogin>,
        log_file_name: Option<String>,
        cols: u16,
        rows: u16,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
    ) -> Result<()> {
        self.spawn_plink(id, session_name, explicit_target, login, None, log_file_name, cols, rows, out_tx)
    }

    /// A saved session through a jump host, logging in to both hosts from
    /// the vault. No `-pwfile`: plink would offer it to the jump host first
    /// (see `jump_login`); the prompts are answered instead.
    #[allow(clippy::too_many_arguments)]
    pub fn create_plink_session_with_jump_login(
        &self,
        id: &str,
        session_name: &str,
        credentials: super::jump_login::JumpCredentials,
        log_file_name: Option<String>,
        cols: u16,
        rows: u16,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
    ) -> Result<()> {
        let jump = super::jump_login::JumpLogin::new(credentials);
        self.spawn_plink(id, session_name, None, None, Some(jump), log_file_name, cols, rows, out_tx)
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_plink(
        &self,
        id: &str,
        session_name: &str,
        explicit_target: Option<crate::transport::plink::ExplicitTarget>,
        login: Option<crate::transport::plink::PlinkLogin>,
        jump_login: Option<super::jump_login::JumpLogin>,
        log_file_name: Option<String>,
        cols: u16,
        rows: u16,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
    ) -> Result<()> {
        let (raw_tx, mut raw_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let flow = Arc::new(FlowGate::new(OUTPUT_WINDOW));
        let transport = PlinkTransport::spawn_session(session_name, explicit_target.as_ref(), login.as_ref(), cols, rows, raw_tx, flow.clone())?;
        let log_file = log_file_name
            .as_deref()
            .filter(|p| !p.is_empty())
            .and_then(|p| super::log::SessionLog::open(std::path::Path::new(p), super::log::LogMode::All).ok());

        let id_owned = id.to_string();
        let subscriber = Arc::new(Mutex::new(Some(out_tx)));
        let sub_clone = subscriber.clone();
        let registry_clone = self.clone();
        let id_for_task = id.to_string();
        let instance = NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed);
        let flow_for_task = flow.clone();

        let reader = async move {
            // Whether the loop's end has already been accounted for (Closed
            // action sent its own notice, or the session was removed). If
            // not, raw_rx hit EOF: the process exited on its own.
            let mut reported = false;
            while let Some(chunk) = raw_rx.recv().await {
                let action = {
                    let mut lock = registry_clone.sessions.lock().unwrap();
                    if let Some(session) = lock.get_mut(&id_for_task).filter(|s| s.instance == instance) {
                        session.scrollback.push(&chunk);
                        if let Some(log) = session.log.as_mut() {
                            // A log that can't be written any more (disk
                            // full, drive gone) is closed, not retried per
                            // chunk; the session carries on.
                            if log.write(&chunk).is_err() {
                                session.log = None;
                            }
                        }
                        // Pre-auth only: once Live, remote output can never
                        // draw a stored password out of the vault.
                        if session.state_machine.is_live() {
                            session.jump_login = None;
                        } else if let Some(answer) = session.jump_login.as_mut().and_then(|j| j.feed(&chunk)) {
                            let _ = session.transport.write(&answer);
                        }
                        session.state_machine.feed_bytes(&chunk)
                    } else {
                        reported = true;
                        break;
                    }
                };

                // Charged by the reader when read; what doesn't reach the
                // page (a withheld prompt, a detached tab) is refunded below.
                let chunk_len = chunk.len();
                let mut forwarded = 0usize;
                match action {
                    PreAuthAction::Hold => {
                        // Forward pre-auth interactive bytes (username prompt, password prompt, login banner)
                        // directly to the subscriber so the user can see prompts and enter credentials.
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            if tx.send(chunk).is_ok() {
                                forwarded = chunk_len;
                            }
                        }
                    }
                    PreAuthAction::PassThrough(bytes) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let n = bytes.len();
                            if tx.send(bytes).is_ok() {
                                forwarded = n;
                            }
                        }
                    }
                    PreAuthAction::TransitionToLive(bytes) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            if tx.send(bytes.clone()).is_ok() {
                                forwarded = bytes.len();
                            }
                        }
                        // plink prints "Press Return to begin session." as a
                        // one-time continuation gate right after auth
                        // succeeds -- it's not a credential or a decision,
                        // just a "press any key" pause, so auto-advance past
                        // it instead of making the user hit Enter a second
                        // time (once for their password, once more for this).
                        if String::from_utf8_lossy(&bytes).contains("Press Return to begin session") {
                            let mut lock = registry_clone.sessions.lock().unwrap();
                            if let Some(session) = lock.get_mut(&id_for_task).filter(|s| s.instance == instance) {
                                let _ = session.transport.write(b"\r");
                            }
                        }
                    }
                    PreAuthAction::Suppress => {}
                    PreAuthAction::HostKeyPrompt(info) => {
                        // Priority 1 security fix: DO NOT forward raw chunk to terminal.
                        // Broadcast structured prompt event for native UI dialog.
                        let _ = registry_clone.prompt_tx.send(PromptEvent {
                            session_id: id_for_task.clone(),
                            prompt: info,
                        });
                    }
                    PreAuthAction::Closed(reason) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let msg = match reason {
                                CloseReason::AuthFailed(err) => {
                                    if let Some(pos) = err.find("FATAL ERROR:") {
                                        format!("\r\n\x1b[31m{}\x1b[0m\r\n", &err[pos..].trim())
                                    } else {
                                        format!("\r\n\x1b[31m[Plinky: Session closed ({})]\x1b[0m\r\n", err)
                                    }
                                }
                                CloseReason::HostKeyRejected => {
                                    "\r\n\x1b[31m[Plinky: Host key was rejected]\x1b[0m\r\n".to_string()
                                }
                                CloseReason::Error(err) => {
                                    format!("\r\n\x1b[31m[Plinky: Error: {}]\x1b[0m\r\n", err)
                                }
                                CloseReason::Ok => {
                                    "\r\n[Plinky: Session closed]\r\n".to_string()
                                }
                            };
                            let _ = tx.send(msg.into_bytes());
                        }
                        reported = true;
                        break;
                    }
                }
                flow_for_task.ack(chunk_len.saturating_sub(forwarded) as u64);
            }
            if !reported {
                registry_clone.report_process_exit(&id_for_task, instance, &sub_clone);
            }
        };

        // The PreAuth gate guards plink's SSH handshake: host-key prompt,
        // then the D9 "Access granted" marker. Serial / Telnet / Raw / Rlogin
        // sessions (switch consoles, legacy gear) have no such phase -- plink
        // never prints the marker, so they sat in PreAuth forever: skipped by
        // sync broadcast, and force-closed once device output passed the
        // 8 KiB cap (one `show running-config`). Every byte on those is device
        // output from the start, so they begin Live. Explicit targets (Quick
        // Connect) are always SSH, so only a saved non-SSH session qualifies.
        let mut state_machine = PreAuthStateMachine::new();
        let saved_protocol = putty_compat::sessions::read_session(session_name)
            .map(|s| s.protocol)
            .unwrap_or_default();
        if !saved_protocol.is_empty() && !saved_protocol.eq_ignore_ascii_case("ssh") {
            state_machine.force_live();
        }

        let active = ActiveSession {
            id: id_owned.clone(),
            name: session_name.to_string(),
            transport: Box::new(transport),
            state_machine,
            scrollback: ScrollbackRingBuffer::new(2 * 1024 * 1024),
            subscriber,
            log: log_file,
            flow,
            instance,
            jump_login,
        };

        self.insert_new_session(id_owned, active)?;
        tokio::spawn(reader);
        Ok(())
    }

    /// Registers a freshly spawned session, refusing an id that's already
    /// live. A duplicate start used to silently overwrite the map entry,
    /// orphaning the first process (and its SSH connection) with no handle
    /// left to kill it. On conflict the NEW transport is killed instead, so
    /// the session the user is already looking at is never disturbed.
    ///
    /// The reader task is spawned only after this succeeds: its loop exits
    /// on the first chunk whose session id isn't in the map, so spawning it
    /// before the insert could lose the whole output stream if the PTY
    /// spoke first.
    /// Called when a session's output stream ends without a Closed action --
    /// the process exited by itself (the user typed `exit`, or plink quit
    /// without a "FATAL ERROR:" line, e.g. "no valid host name provided").
    /// Previously nothing was sent, so the tab kept looking live and input
    /// went nowhere. The notice also goes into scrollback so a later
    /// reattach still shows why the terminal is dead.
    fn report_process_exit(
        &self,
        id: &str,
        instance: u64,
        subscriber: &Arc<Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>>,
    ) {
        let notice = b"\r\n[Plinky: Session closed]\r\n";
        {
            let mut lock = self.sessions.lock().unwrap();
            let Some(session) = lock.get_mut(id).filter(|s| s.instance == instance) else { return };
            session.state_machine.terminate();
            session.scrollback.push(notice);
        }
        if let Some(tx) = subscriber.lock().unwrap().as_ref() {
            let _ = tx.send(notice.to_vec());
        }
    }

    fn insert_new_session(&self, id: String, mut active: ActiveSession) -> Result<()> {
        let mut lock = self.sessions.lock().unwrap();
        if lock.contains_key(&id) {
            let _ = active.transport.kill();
            return Err(PlinkyError::ProcessError(format!(
                "Session '{id}' already exists; refusing to spawn a duplicate"
            )));
        }
        lock.insert(id, active);
        Ok(())
    }

    /// Attaches or reattaches a live streaming channel to an existing session,
    /// replaying historical scrollback from `from_seq` onwards.
    pub fn attach_session(
        &self,
        id: &str,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
        from_seq: usize,
    ) -> Result<AttachInfo> {
        let mut lock = self.sessions.lock().unwrap();
        let session = lock
            .get_mut(id)
            .ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;

        let (replay_data, truncated) = session.scrollback.get_since(from_seq);
        *session.subscriber.lock().unwrap() = Some(out_tx);
        session.flow.attach();
        let pending_prompt = match session.state_machine.state() {
            SessionState::HostKeyPending { prompt } => Some(prompt.clone()),
            _ => None,
        };

        Ok(AttachInfo {
            session_id: id.to_string(),
            replay_data,
            truncated,
            is_live: session.state_machine.is_live(),
            pending_prompt,
        })
    }

    /// Answers a pending host key confirmation dialog safely via transport write.
    pub fn answer_prompt(&self, id: &str, answer: PromptAnswer) -> Result<()> {
        let mut lock = self.sessions.lock().unwrap();
        let session = lock.get_mut(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;

        if !matches!(session.state_machine.state(), SessionState::HostKeyPending { .. }) {
            return Err(PlinkyError::ProcessError(
                "Session is not awaiting host key confirmation".into(),
            ));
        }

        let bytes: &[u8] = match answer {
            PromptAnswer::AcceptAndStore => b"y\r",
            PromptAnswer::AcceptOnce => b"n\r",
            PromptAnswer::Reject => b"\r",
        };
        session.transport.write(bytes)?;
        session.state_machine.prompt_answered();
        Ok(())
    }

    /// Writes raw input directly into session PTY master, for the user's OWN
    /// keystrokes typed into THEIR OWN terminal.
    ///
    /// Only blocks HostKeyPending, not the whole PreAuth phase -- per R3, a
    /// password/passphrase prompt is deliberately display-only: it must
    /// reach the terminal, and the user must be able to type their own
    /// credential into it directly (Plinky does not auto-fill one). Do NOT
    /// use this for anything other than a session's own direct keystrokes --
    /// shell-integration injection, sync-broadcast fanout, or any other
    /// programmatic/automated write belongs on write_input_live_only below,
    /// which is what actually keeps R3's "typed by the user, once, into
    /// their own prompt" property true. This method alone cannot: it would
    /// let ANY caller write into a session sitting at its own password
    /// prompt, since PreAuth (not HostKeyPending) is what a password/
    /// passphrase prompt state maps to today.
    pub fn write_input(&self, id: &str, data: &[u8]) -> Result<()> {
        let mut lock = self.sessions.lock().unwrap();
        let session = lock.get_mut(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;

        if matches!(session.state_machine.state(), SessionState::HostKeyPending { .. }) {
            return Err(PlinkyError::ProcessError(
                "Terminal input blocked: session is awaiting host key trust approval via dialog".into(),
            ));
        }

        session.transport.write(data)
    }

    /// Types a vault secret and Enter into a session: the terminal's "Send
    /// password". The user asked for it at a prompt they can see, so it
    /// goes through `write_input` -- allowed at plink's own password prompt,
    /// refused while a host key is unanswered. The bytes sit in a buffer
    /// that is wiped when this returns.
    pub fn type_secret(&self, id: &str, secret: &crate::vault::SecretString) -> Result<()> {
        let plain = secret.expose_secret().as_bytes();
        let mut bytes = zeroize::Zeroizing::new(Vec::with_capacity(plain.len() + 1));
        bytes.extend_from_slice(plain);
        bytes.push(b'\r');
        self.write_input(id, &bytes)
    }

    /// Writes raw input directly into session PTY master, for PROGRAMMATIC /
    /// AUTOMATED writes only -- shell-integration bootstrap injection,
    /// sync-broadcast fanout from another session, or any future feature
    /// that writes into a session the user isn't the one directly typing
    /// into right now.
    ///
    /// Requires the session to be genuinely Live, not merely "not
    /// HostKeyPending" -- refuses during ANY PreAuth substate, including
    /// a password/passphrase prompt. This is the fix for a real incident:
    /// shell-integration injection reused the looser write_input (which
    /// only blocks HostKeyPending) and got accepted while a session sat at
    /// its remote password prompt, so the bootstrap script's lines were
    /// each submitted to the remote server as a separate password guess,
    /// exhausting the server's auth-attempt limit and disconnecting it.
    pub fn write_input_live_only(&self, id: &str, data: &[u8]) -> Result<()> {
        let mut lock = self.sessions.lock().unwrap();
        let session = lock.get_mut(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;

        if !session.state_machine.is_live() {
            return Err(PlinkyError::ProcessError(format!(
                "Input blocked: session is not Live yet (state: {:?}). Automated writes \
                 (shell integration, sync broadcast) are only allowed once a session has \
                 authenticated -- never during a host-key or credential prompt.",
                session.state_machine.state()
            )));
        }

        session.transport.write(data)
    }

    /// Propagates resize events to PTY master.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let mut lock = self.sessions.lock().unwrap();
        let session = lock.get_mut(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;
        session.transport.resize(cols, rows)
    }

    /// Sets the broadcast sync channel for a session (Channels A-D or None).
    pub fn set_sync_channel(&self, session_id: &str, channel: Option<crate::sync::router::SyncChannelId>) {
        self.sync_router.lock().unwrap().set_session_channel(session_id, channel);
    }

    /// Toggles protected status on a session (protected sessions do not accept broadcast input).
    pub fn set_sync_protected(&self, session_id: &str, protected: bool) {
        self.sync_router.lock().unwrap().set_session_protected(session_id, protected);
    }

    /// Sets whether sync broadcasting is armed or emergency-disarmed (D6 safety).
    pub fn set_sync_armed(&self, armed: bool) {
        self.sync_router.lock().unwrap().set_armed(armed);
    }

    pub fn is_sync_armed(&self) -> bool {
        self.sync_router.lock().unwrap().is_armed()
    }

    /// Broadcasts input data to all Live, unbuffered, and unprotected sessions in `channel`.
    /// Returns the ids of the sessions that received the input.
    pub fn broadcast_sync_input(&self, channel: crate::sync::router::SyncChannelId, data: &[u8]) -> Result<Vec<String>> {
        let router = self.sync_router.lock().unwrap();
        router.broadcast(self, channel, data)
    }

    /// Broadcasts input data to ALL Live, unbuffered, and unprotected sessions across the registry.
    pub fn broadcast_sync_all(&self, data: &[u8]) -> Result<Vec<String>> {
        let router = self.sync_router.lock().unwrap();
        router.broadcast_all(self, data)
    }

    /// Returns a snapshot of all active session IDs currently registered.
    pub fn list_session_ids(&self) -> Vec<String> {
        let lock = self.sessions.lock().unwrap();
        lock.keys().cloned().collect()
    }

    /// The page drawing a session went away (its tab left the screen). The
    /// session keeps running: output goes to scrollback only, the reader is
    /// no longer gated, and the next attach replays it.
    /// Starts writing this session's output to `path`, from now on,
    /// replacing any log already open. Returns where it goes.
    pub fn start_log(&self, id: &str, path: &std::path::Path, mode: super::log::LogMode) -> Result<std::path::PathBuf> {
        let log = super::log::SessionLog::open(path, mode)
            .map_err(|e| PlinkyError::ProcessError(format!("Couldn't open the log file {}: {e}", path.display())))?;
        let mut lock = self.sessions.lock().unwrap();
        let session = lock.get_mut(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;
        let out = log.path().to_path_buf();
        session.log = Some(log);
        Ok(out)
    }

    /// Stops logging. The file is closed and stays where it is.
    pub fn stop_log(&self, id: &str) {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            s.log = None;
        }
    }

    /// Where the session is logging and how much is on disk, if it is.
    pub fn log_status(&self, id: &str) -> Option<(std::path::PathBuf, u64)> {
        let lock = self.sessions.lock().unwrap();
        let log = lock.get(id)?.log.as_ref()?;
        Some((log.path().to_path_buf(), log.written()))
    }

    pub fn detach_session(&self, id: &str) -> Result<()> {
        let lock = self.sessions.lock().unwrap();
        let session = lock.get(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;
        *session.subscriber.lock().unwrap() = None;
        session.flow.detach();
        Ok(())
    }

    /// The session's flow gate, for whatever hands its output to the page
    /// (it charges what it sends).
    pub fn flow_gate(&self, id: &str) -> Option<Arc<FlowGate>> {
        self.sessions.lock().unwrap().get(id).map(|s| s.flow.clone())
    }

    /// The page finished drawing `bytes` of this session's output.
    pub fn ack_output(&self, id: &str, bytes: u64) {
        if let Some(s) = self.sessions.lock().unwrap().get(id) {
            s.flow.ack(bytes);
        }
    }

    /// Terminates and removes a session.
    pub fn close_session(&self, id: &str) -> Result<()> {
        let mut lock = self.sessions.lock().unwrap();
        if let Some(mut session) = lock.remove(id) {
            session.flow.close();
            let _ = session.transport.kill();
        }
        self.sync_router.lock().unwrap().remove_session(id);
        Ok(())
    }

    /// Retrieves scrollback history for webview reattachment.
    pub fn get_scrollback(&self, id: &str) -> Result<Vec<u8>> {
        let lock = self.sessions.lock().unwrap();
        let session = lock.get(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;
        Ok(session.scrollback.to_vec())
    }

    /// Resets a session's state machine to PreAuth (useful for testing prompt flows).
    pub fn reset_session_preauth(&self, id: &str) -> Result<()> {
        let mut lock = self.sessions.lock().unwrap();
        let session = lock.get_mut(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;
        session.state_machine = PreAuthStateMachine::new();
        Ok(())
    }

    /// Simulates feeding bytes into a session's state machine (useful for tests and mock injections).
    pub fn simulate_preauth_bytes(&self, id: &str, chunk: &[u8]) -> Result<PreAuthAction> {
        let mut lock = self.sessions.lock().unwrap();
        let session = lock.get_mut(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;
        Ok(session.state_machine.feed_bytes(chunk))
    }

    /// Returns the current state of a session's pre-auth state machine.
    pub fn get_session_state(&self, id: &str) -> Option<SessionState> {
        let lock = self.sessions.lock().unwrap();
        lock.get(id).map(|s| s.state_machine.state().clone())
    }

    /// Returns whether the given session has reached Live state.
    pub fn is_session_live(&self, id: &str) -> bool {
        let lock = self.sessions.lock().unwrap();
        lock.get(id).map(|s| s.state_machine.is_live()).unwrap_or(false)
    }
}
