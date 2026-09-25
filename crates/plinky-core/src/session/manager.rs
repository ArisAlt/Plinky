use std::collections::HashMap;
use std::io::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, broadcast};
use crate::errors::{PlinkyError, Result};
use crate::transport::Transport;
use crate::transport::local::LocalTransport;
use crate::transport::plink::PlinkTransport;
use crate::session::state_machine::{PreAuthStateMachine, PreAuthAction, SessionState, HostKeyPromptInfo, CloseReason};
use crate::session::ring_buffer::ScrollbackRingBuffer;

/// Opens (or creates) a session log file in append mode, matching PuTTY's
/// simplest "All session output" logging mode -- raw bytes, unfiltered.
/// A failure to open just disables logging for this session rather than
/// blocking the connection; the caller sees no error either way.
fn open_log_file(path: &str) -> Option<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

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
    pub log_file: Option<std::fs::File>,
    /// Unique per spawned process. A session id can be reused after a close,
    /// so a reader task checks this before touching the map entry -- keyed
    /// by id alone, a closed session's trailing output and EOF landed on its
    /// successor.
    pub instance: u64,
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
        let (raw_tx, mut raw_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let transport = LocalTransport::spawn(cols, rows, raw_tx)?;
        let log_file = log_file_name
            .as_deref()
            .filter(|p| !p.is_empty())
            .and_then(open_log_file);

        let id_owned = id.to_string();
        let subscriber = Arc::new(Mutex::new(Some(out_tx)));
        let sub_clone = subscriber.clone();
        let registry_clone = self.clone();
        let id_for_task = id.to_string();
        let instance = NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed);

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
                        if let Some(f) = session.log_file.as_mut() {
                            let _ = f.write_all(&chunk);
                        }
                        session.state_machine.feed_bytes(&chunk)
                    } else {
                        reported = true;
                        break;
                    }
                };

                match action {
                    PreAuthAction::Hold => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let _ = tx.send(chunk);
                        }
                    }
                    PreAuthAction::PassThrough(bytes) | PreAuthAction::TransitionToLive(bytes) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let _ = tx.send(bytes);
                        }
                    }
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
            }
            if !reported {
                registry_clone.report_process_exit(&id_for_task, instance, &sub_clone);
            }
        };

        let mut sm = PreAuthStateMachine::new();
        sm.force_live(); // Local shells are always Live immediately

        let active = ActiveSession {
            id: id_owned.clone(),
            name: name.to_string(),
            transport: Box::new(transport),
            state_machine: sm,
            scrollback: ScrollbackRingBuffer::new(2 * 1024 * 1024), // 2 MiB
            subscriber,
            log_file,
            instance,
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
        let (raw_tx, mut raw_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let transport = PlinkTransport::spawn_session(session_name, explicit_target.as_ref(), cols, rows, raw_tx)?;
        let log_file = log_file_name
            .as_deref()
            .filter(|p| !p.is_empty())
            .and_then(open_log_file);

        let id_owned = id.to_string();
        let subscriber = Arc::new(Mutex::new(Some(out_tx)));
        let sub_clone = subscriber.clone();
        let registry_clone = self.clone();
        let id_for_task = id.to_string();
        let instance = NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed);

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
                        if let Some(f) = session.log_file.as_mut() {
                            let _ = f.write_all(&chunk);
                        }
                        session.state_machine.feed_bytes(&chunk)
                    } else {
                        reported = true;
                        break;
                    }
                };

                match action {
                    PreAuthAction::Hold => {
                        // Forward pre-auth interactive bytes (username prompt, password prompt, login banner)
                        // directly to the subscriber so the user can see prompts and enter credentials.
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let _ = tx.send(chunk);
                        }
                    }
                    PreAuthAction::PassThrough(bytes) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let _ = tx.send(bytes);
                        }
                    }
                    PreAuthAction::TransitionToLive(bytes) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let _ = tx.send(bytes.clone());
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
            log_file,
            instance,
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
        session.transport.write(bytes)
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
    pub fn broadcast_sync_input(&self, channel: crate::sync::router::SyncChannelId, data: &[u8]) -> Result<usize> {
        let router = self.sync_router.lock().unwrap();
        router.broadcast(self, channel, data)
    }

    /// Broadcasts input data to ALL Live, unbuffered, and unprotected sessions across the registry.
    pub fn broadcast_sync_all(&self, data: &[u8]) -> Result<usize> {
        let router = self.sync_router.lock().unwrap();
        router.broadcast_all(self, data)
    }

    /// Returns a snapshot of all active session IDs currently registered.
    pub fn list_session_ids(&self) -> Vec<String> {
        let lock = self.sessions.lock().unwrap();
        lock.keys().cloned().collect()
    }

    /// Terminates and removes a session.
    pub fn close_session(&self, id: &str) -> Result<()> {
        let mut lock = self.sessions.lock().unwrap();
        if let Some(mut session) = lock.remove(id) {
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
