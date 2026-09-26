use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct HostKeyPromptInfo {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub raw_prompt: String,
}

impl HostKeyPromptInfo {
    pub fn parse(raw: &str) -> Self {
        // Parse host and port: e.g. "  192.0.2.1 (port 22)"
        let host_port_regex = Regex::new(r"(?m)^\s+([^\s]+)\s+\(port\s+(\d+)\)").unwrap();
        let (host, port) = if let Some(caps) = host_port_regex.captures(raw) {
            let h = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
            let p = caps.get(2).and_then(|m| m.as_str().parse::<u16>().ok()).unwrap_or(22);
            (h, p)
        } else {
            (String::new(), 22)
        };

        // Parse key type and fingerprint: e.g. "SHA256:..."
        let fp_regex = Regex::new(r"SHA256:[A-Za-z0-9+/=]+").unwrap();
        let fingerprint = fp_regex.find(raw).map(|m| m.as_str().to_string()).unwrap_or_default();

        let type_regex = Regex::new(r"(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9]+)").unwrap();
        let key_type = type_regex.find(raw).map(|m| m.as_str().to_string()).unwrap_or_else(|| "unknown".to_string());

        Self {
            host,
            port,
            key_type,
            fingerprint,
            raw_prompt: raw.to_string(),
        }
    }
}

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
    HostKeyPending { prompt: HostKeyPromptInfo },
    Live,
    Closed(CloseReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreAuthAction {
    /// In PreAuth, unmatched bytes are held (default-deny per D3).
    Hold,
    /// Pass bytes directly to the terminal consumer (only in Live).
    PassThrough(Vec<u8>),
    /// Host key confirmation prompt detected (requires user approval via native dialog).
    HostKeyPrompt(HostKeyPromptInfo),
    /// Bytes arriving while a host-key prompt awaits the user's answer: the
    /// tail of plink's prompt text. The dialog shows the prompt, so they're
    /// neither displayed nor announced again.
    Suppress,
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
            // Matched on the final action prompt line so earlier lines (host, port, fingerprint) are already in the buffer
            hostkey_prompt_regex: Regex::new(
                r"(Store key in cache\?|Update cached key\?)"
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

        // plink is blocked on the user's answer. Only a fatal error (the
        // connection dropped while the dialog was open) changes anything.
        if matches!(self.state, SessionState::HostKeyPending { .. }) {
            let text = String::from_utf8_lossy(chunk);
            if let Some(pos) = text.find("FATAL ERROR:") {
                let reason = CloseReason::AuthFailed(text[pos..].to_string());
                self.state = SessionState::Closed(reason.clone());
                self.buffer.clear();
                return PreAuthAction::Closed(reason);
            }
            return PreAuthAction::Suppress;
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
            let prompt_info = HostKeyPromptInfo::parse(&text);
            self.state = SessionState::HostKeyPending {
                prompt: prompt_info.clone(),
            };
            return PreAuthAction::HostKeyPrompt(prompt_info);
        }

        // Default-deny: hold unmatched pre-auth bytes until transition to Live or prompt
        PreAuthAction::Hold
    }

    /// The user answered the pending host-key prompt: back to PreAuth, with
    /// the answered prompt dropped from the buffer.
    ///
    /// Nothing used to do this. The session stayed HostKeyPending until
    /// "Access granted", every later chunk re-matched the old prompt still
    /// in the buffer -- re-announcing it (92 events for one prompt, against
    /// a real sshd) and hiding the text from the terminal -- and typing
    /// stayed blocked. So a first connection to a password server showed
    /// nothing after the key was accepted and wouldn't take the password;
    /// and through a jump host, the target's host-key prompt was hidden and
    /// re-announced with the bastion's fingerprint.
    pub fn prompt_answered(&mut self) {
        if matches!(self.state, SessionState::HostKeyPending { .. }) {
            self.state = SessionState::PreAuth;
            self.buffer.clear();
        }
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
