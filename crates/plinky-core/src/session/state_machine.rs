use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseReason {
    Ok,
    AuthFailed(String),
    HostKeyRejected,
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionState {
    PreAuth,
    HostKeyPending { prompt: String },
    Live,
    Closed(CloseReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreAuthAction {
    /// In PreAuth, unmatched bytes are held (default-deny per D3).
    Hold,
    /// Pass bytes directly to the terminal consumer (only in Live).
    PassThrough(Vec<u8>),
    /// Host key confirmation prompt detected (requires user approval).
    HostKeyPrompt(String),
    /// Authentication verified via D9 marker ("Access granted") — transitions to Live.
    TransitionToLive(Vec<u8>),
    /// Session closed (error, rejected, or auth failure).
    Closed(CloseReason),
}

pub struct PreAuthStateMachine {
    state: SessionState,
    buffer: Vec<u8>,
    access_granted_regex: Regex,
    hostkey_prompt_regex: Regex,
}

impl PreAuthStateMachine {
    pub const MAX_PREAUTH_BUFFER_LEN: usize = 8192;

    pub fn new() -> Self {
        Self {
            state: SessionState::PreAuth,
            buffer: Vec::with_capacity(2048),
            // D9 Marker: PuTTY plink outputs "Access granted" right upon auth success
            access_granted_regex: Regex::new(r"Access granted").unwrap(),
            // Verbatim PuTTY 0.85 hostkey prompt indicators per DEEP_DESIGN.md §2 & §3
            hostkey_prompt_regex: Regex::new(
                r"(The host key is not cached for this server:|Store key in cache\?|Update cached key\?)"
            ).unwrap(),
        }
    }

    pub fn state(&self) -> &SessionState {
        &self.state
    }

    pub fn is_live(&self) -> bool {
        self.state == SessionState::Live
    }

    /// Feeds incoming PTY bytes into the state machine.
    /// In Live mode, this immediately returns PassThrough with zero regex overhead.
    pub fn feed_bytes(&mut self, chunk: &[u8]) -> PreAuthAction {
        if self.state == SessionState::Live {
            return PreAuthAction::PassThrough(chunk.to_vec());
        }

        if let SessionState::Closed(ref reason) = self.state {
            return PreAuthAction::Closed(reason.clone());
        }

        self.buffer.extend_from_slice(chunk);

        // 8 KiB PreAuth bounded default-deny: fail closed on unrecognized output
        if self.buffer.len() > Self::MAX_PREAUTH_BUFFER_LEN {
            let reason = CloseReason::Error(
                "PreAuth buffer exceeded 8KiB cap without recognized marker — plink version mismatch?".to_string()
            );
            self.state = SessionState::Closed(reason.clone());
            self.buffer.clear();
            return PreAuthAction::Closed(reason);
        }

        let text = String::from_utf8_lossy(&self.buffer);

        // Check for batch-mode rejection
        if text.contains("FATAL ERROR: Cannot confirm a host key in batch mode") {
            let reason = CloseReason::HostKeyRejected;
            self.state = SessionState::Closed(reason.clone());
            self.buffer.clear();
            return PreAuthAction::Closed(reason);
        }

        // Check for general fatal errors
        if text.contains("FATAL ERROR:") {
            let reason = CloseReason::AuthFailed(text.to_string());
            self.state = SessionState::Closed(reason.clone());
            self.buffer.clear();
            return PreAuthAction::Closed(reason);
        }

        // Check for D9 "Access granted" boundary marker
        if let Some(mat) = self.access_granted_regex.find(&text) {
            self.state = SessionState::Live;
            // Any bytes appearing after the match belong to the live session
            let match_end = mat.end();
            let remaining = if match_end < self.buffer.len() {
                self.buffer[match_end..].to_vec()
            } else {
                Vec::new()
            };
            self.buffer.clear();
            return PreAuthAction::TransitionToLive(remaining);
        }

        // Check for host-key confirmation prompt
        if self.hostkey_prompt_regex.is_match(&text) {
            let prompt = text.to_string();
            self.state = SessionState::HostKeyPending {
                prompt: prompt.clone(),
            };
            return PreAuthAction::HostKeyPrompt(prompt);
        }

        // Default-deny: hold unmatched pre-auth bytes until transition to Live or prompt
        PreAuthAction::Hold
    }

    pub fn force_live(&mut self) {
        self.state = SessionState::Live;
        self.buffer.clear();
    }

    pub fn terminate(&mut self) {
        self.state = SessionState::Closed(CloseReason::Ok);
        self.buffer.clear();
    }
}
