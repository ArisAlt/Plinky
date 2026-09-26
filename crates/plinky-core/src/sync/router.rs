use std::collections::{HashMap, HashSet};
use crate::errors::Result;
use crate::session::manager::SessionRegistry;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum SyncChannelId {
    A,
    B,
    C,
    D,
}

impl SyncChannelId {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_uppercase().as_str() {
            "A" => Some(Self::A),
            "B" => Some(Self::B),
            "C" => Some(Self::C),
            "D" => Some(Self::D),
            _ => None,
        }
    }
}

pub struct SyncInputRouter {
    channels: HashMap<SyncChannelId, HashSet<String>>,
    protected_sessions: HashSet<String>,
    armed: bool,
}

impl SyncInputRouter {
    pub fn new() -> Self {
        Self {
            channels: HashMap::new(),
            protected_sessions: HashSet::new(),
            armed: true,
        }
    }

    /// Sets or clears the active broadcast channel for a session.
    pub fn set_session_channel(&mut self, session_id: &str, channel: Option<SyncChannelId>) {
        // Remove from all existing channels
        for set in self.channels.values_mut() {
            set.remove(session_id);
        }
        if let Some(ch) = channel {
            self.channels.entry(ch).or_default().insert(session_id.to_string());
        }
    }

    /// Toggles protected status on a session (protected sessions do not accept broadcast input).
    pub fn set_session_protected(&mut self, session_id: &str, protected: bool) {
        if protected {
            self.protected_sessions.insert(session_id.to_string());
        } else {
            self.protected_sessions.remove(session_id);
        }
    }

    /// Emergency arm/disarm toggle for all broadcast operations (D6 safety).
    pub fn set_armed(&mut self, armed: bool) {
        self.armed = armed;
    }

    pub fn is_armed(&self) -> bool {
        self.armed
    }

    /// Gets the list of session IDs assigned to a channel.
    pub fn get_channel_sessions(&self, channel: SyncChannelId) -> Vec<String> {
        self.channels
            .get(&channel)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Broadcasts input data to all LIVE and UNPROTECTED sessions assigned to `channel`.
    /// Enforces D6: never writes into sessions awaiting host key prompts or unauthenticated.
    /// Returns the ids of the sessions that received it, sorted, so the UI can
    /// mark exactly those panes -- a session on the channel that was skipped
    /// (protected, still logging in) must not look as if it got the command.
    pub fn broadcast(
        &self,
        registry: &SessionRegistry,
        channel: SyncChannelId,
        data: &[u8],
    ) -> Result<Vec<String>> {
        if !self.armed {
            return Ok(Vec::new());
        }

        let targets = match self.channels.get(&channel) {
            Some(set) => set,
            None => return Ok(Vec::new()),
        };

        let mut sent = Vec::new();
        for session_id in targets {
            // D6 Gate 1: Protected sessions require explicit opt-in
            if self.protected_sessions.contains(session_id) {
                continue;
            }

            // D6 Gate 2: write_input_live_only requires the session to be
            // genuinely Live and rejects ANY PreAuth substate (HostKeyPending
            // included). This comment previously claimed the looser
            // write_input already did this -- it didn't (it only blocked
            // HostKeyPending), which meant a broadcast could reach a target
            // session sitting at its own password prompt. Fixed by switching
            // to write_input_live_only, not just by correcting the comment.
            if registry.write_input_live_only(session_id, data).is_ok() {
                sent.push(session_id.clone());
            }
        }

        sent.sort();
        Ok(sent)
    }

    /// Completely purges a session from channels and protected status upon close.
    pub fn remove_session(&mut self, session_id: &str) {
        self.set_session_channel(session_id, None);
        self.protected_sessions.remove(session_id);
    }

    /// Broadcasts input data to ALL LIVE and UNPROTECTED sessions in the registry,
    /// regardless of discrete channel assignment. Returns the recipients' ids, sorted.
    pub fn broadcast_all(
        &self,
        registry: &SessionRegistry,
        data: &[u8],
    ) -> Result<Vec<String>> {
        if !self.armed {
            return Ok(Vec::new());
        }

        let session_ids = registry.list_session_ids();
        let mut sent = Vec::new();
        for session_id in session_ids {
            if self.protected_sessions.contains(&session_id) {
                continue;
            }
            if registry.write_input_live_only(&session_id, data).is_ok() {
                sent.push(session_id);
            }
        }

        sent.sort();
        Ok(sent)
    }
}
