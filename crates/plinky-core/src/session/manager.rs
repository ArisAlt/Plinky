use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use crate::errors::{PlinkyError, Result};
use crate::transport::Transport;
use crate::transport::local::LocalTransport;
use crate::transport::plink::PlinkTransport;
use crate::session::state_machine::{PreAuthStateMachine, PreAuthAction};
use crate::session::ring_buffer::ScrollbackRingBuffer;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AttachInfo {
    pub session_id: String,
    pub replay_data: Vec<u8>,
    pub truncated: bool,
    pub is_live: bool,
}

pub struct ActiveSession {
    pub id: String,
    pub name: String,
    pub transport: Box<dyn Transport>,
    pub state_machine: PreAuthStateMachine,
    pub scrollback: ScrollbackRingBuffer,
    pub subscriber: Arc<Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>>,
}

#[derive(Clone)]
pub struct SessionRegistry {
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawns a local shell session.
    pub fn create_local_session(
        &self,
        id: &str,
        name: &str,
        cols: u16,
        rows: u16,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
    ) -> Result<()> {
        let (raw_tx, mut raw_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let transport = LocalTransport::spawn(cols, rows, raw_tx)?;

        let id_owned = id.to_string();
        let subscriber = Arc::new(Mutex::new(Some(out_tx)));
        let sub_clone = subscriber.clone();
        let registry_clone = self.clone();
        let id_for_task = id.to_string();

        // Background worker inspecting bytes through state machine and saving to scrollback
        tokio::spawn(async move {
            while let Some(chunk) = raw_rx.recv().await {
                let action = {
                    let mut lock = registry_clone.sessions.lock().unwrap();
                    if let Some(session) = lock.get_mut(&id_for_task) {
                        session.scrollback.push(&chunk);
                        session.state_machine.feed_bytes(&chunk)
                    } else {
                        break;
                    }
                };

                match action {
                    PreAuthAction::Hold => {}
                    PreAuthAction::PassThrough(bytes) | PreAuthAction::TransitionToLive(bytes) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let _ = tx.send(bytes);
                        }
                    }
                    PreAuthAction::HostKeyPrompt(_) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let _ = tx.send(chunk);
                        }
                    }
                    PreAuthAction::Closed(reason) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let msg = format!("\r\n[Plinky: Session closed ({:?})]\r\n", reason);
                            let _ = tx.send(msg.into_bytes());
                        }
                        break;
                    }
                }
            }
        });

        let mut sm = PreAuthStateMachine::new();
        sm.force_live(); // Local shells are always Live immediately

        let active = ActiveSession {
            id: id_owned.clone(),
            name: name.to_string(),
            transport: Box::new(transport),
            state_machine: sm,
            scrollback: ScrollbackRingBuffer::new(2 * 1024 * 1024), // 2 MiB
            subscriber,
        };

        self.sessions.lock().unwrap().insert(id_owned, active);
        Ok(())
    }

    /// Spawns an interactive plink PuTTY session.
    pub fn create_plink_session(
        &self,
        id: &str,
        session_name: &str,
        cols: u16,
        rows: u16,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
    ) -> Result<()> {
        let (raw_tx, mut raw_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let transport = PlinkTransport::spawn_session(session_name, cols, rows, raw_tx)?;

        let id_owned = id.to_string();
        let subscriber = Arc::new(Mutex::new(Some(out_tx)));
        let sub_clone = subscriber.clone();
        let registry_clone = self.clone();
        let id_for_task = id.to_string();

        // Background worker piping stream through PreAuth state machine
        tokio::spawn(async move {
            while let Some(chunk) = raw_rx.recv().await {
                let action = {
                    let mut lock = registry_clone.sessions.lock().unwrap();
                    if let Some(session) = lock.get_mut(&id_for_task) {
                        session.scrollback.push(&chunk);
                        session.state_machine.feed_bytes(&chunk)
                    } else {
                        break;
                    }
                };

                match action {
                    PreAuthAction::Hold => {}
                    PreAuthAction::PassThrough(bytes) | PreAuthAction::TransitionToLive(bytes) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let _ = tx.send(bytes);
                        }
                    }
                    PreAuthAction::HostKeyPrompt(_) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let _ = tx.send(chunk);
                        }
                    }
                    PreAuthAction::Closed(reason) => {
                        if let Some(tx) = sub_clone.lock().unwrap().as_ref() {
                            let msg = format!("\r\n[Plinky: Session closed ({:?})]\r\n", reason);
                            let _ = tx.send(msg.into_bytes());
                        }
                        break;
                    }
                }
            }
        });

        let active = ActiveSession {
            id: id_owned.clone(),
            name: session_name.to_string(),
            transport: Box::new(transport),
            state_machine: PreAuthStateMachine::new(),
            scrollback: ScrollbackRingBuffer::new(2 * 1024 * 1024),
            subscriber,
        };

        self.sessions.lock().unwrap().insert(id_owned, active);
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

        Ok(AttachInfo {
            session_id: id.to_string(),
            replay_data,
            truncated,
            is_live: session.state_machine.is_live(),
        })
    }

    /// Writes raw input directly into session PTY master.
    pub fn write_input(&self, id: &str, data: &[u8]) -> Result<()> {
        let mut lock = self.sessions.lock().unwrap();
        let session = lock.get_mut(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;
        session.transport.write(data)
    }

    /// Propagates resize events to PTY master.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let mut lock = self.sessions.lock().unwrap();
        let session = lock.get_mut(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;
        session.transport.resize(cols, rows)
    }

    /// Terminates and removes a session.
    pub fn close_session(&self, id: &str) -> Result<()> {
        let mut lock = self.sessions.lock().unwrap();
        if let Some(mut session) = lock.remove(id) {
            let _ = session.transport.kill();
        }
        Ok(())
    }

    /// Retrieves scrollback history for webview reattachment.
    pub fn get_scrollback(&self, id: &str) -> Result<Vec<u8>> {
        let lock = self.sessions.lock().unwrap();
        let session = lock.get(id).ok_or_else(|| PlinkyError::SessionNotFound(id.to_string()))?;
        Ok(session.scrollback.to_vec())
    }
}
