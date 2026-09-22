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
    /// Returns the number of sessions that successfully received the broadcast.
    pub fn broadcast(
        &self,
        registry: &SessionRegistry,
        channel: SyncChannelId,
        data: &[u8],
    ) -> Result<usize> {
        if !self.armed {
            return Ok(0);
        }

        let targets = match self.channels.get(&channel) {
            Some(set) => set,
            None => return Ok(0),
        };

        let mut sent_count = 0;
        for session_id in targets {
            // D6 Gate 1: Protected sessions require explicit opt-in
            if self.protected_sessions.contains(session_id) {
                continue;
            }

            // D6 Gate 2: write_input internally verifies that the session is in Live state,
            // and rejects any session in HostKeyPending or PreAuth.
            if registry.write_input(session_id, data).is_ok() {
                sent_count += 1;
            }
        }

        Ok(sent_count)
    }
}
