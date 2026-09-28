use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct HostKeyPromptInfo {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub raw_prompt: String,
    /// The server offered a different key from the one PuTTY has cached:
    /// plink's "WARNING - POTENTIAL SECURITY BREACH". The same dialog used to
    /// show for this and for a first visit, saying "not cached" with a green
    /// accept button, at exactly the moment a man-in-the-middle would appear.
    #[serde(default)]
    pub changed: bool,
    /// Not a host key at all: plink's weak-crypto question, "The first
    /// key-exchange algorithm supported by the server is
    /// diffie-hellman-group1-sha1, which is below the configured warning
    /// threshold. Continue with connection? (y/n)". Holds what is weak
    /// ("key-exchange algorithm: diffie-hellman-group1-sha1"). Old Cisco
    /// gear asks this before the host key; it went to the terminal as plain
    /// text, the user had to type "y", and its text then leaked into the
    /// host-key dialog that followed.
    #[serde(default)]
    pub weak: Option<String>,
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
            changed: raw.contains("POTENTIAL SECURITY BREACH") || raw.contains("host key does not match"),
            weak: None,
        }
    }

    /// plink's weak-crypto question (PuTTY's `confirm_weak_crypto_primitive`
    /// and `confirm_weak_cached_hostkey`), or None if `raw` isn't one.
    pub fn parse_weak(raw: &str) -> Option<Self> {
        let rx = Regex::new(
            r"(?s)The first (.+?) (?:supported by the server|we have stored for this server)\s+is\s+(\S+), which is below the configured warning threshold",
        )
        .unwrap();
        let caps = rx.captures(raw)?;
        let what = caps.get(1)?.as_str().trim().to_string();
        let alg = caps.get(2)?.as_str().trim().to_string();
        Some(Self {
            host: String::new(),
            port: 0,
            key_type: String::new(),
            fingerprint: String::new(),
            raw_prompt: raw.to_string(),
            changed: false,
            weak: Some(format!("{what}: {alg}")),
        })
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
    /// Pre-auth output that is part of plink's host-key notice. The dialog
    /// shows it; the terminal gets only the bytes carried here (whatever came
    /// before the notice in this chunk, often nothing).
    Withhold(Vec<u8>),
}

pub struct PreAuthStateMachine {
    state: SessionState,
    buffer: Vec<u8>,
    access_granted_regex: Regex,
    hostkey_prompt_regex: Regex,
    /// Inside plink's host-key notice, before its question. That text used to
    /// reach the terminal and stay there after the dialog was answered, with
    /// the answer's echo glued on ("...press Returny").
    in_hostkey_notice: bool,
    /// The terminal echo of the answer just typed ("y\r\n"), dropped when it
    /// comes back.
    pending_echo: Vec<u8>,
    /// The end of the output so far, not yet shown: an unfinished line that
    /// could still turn into a host-key notice ("The" arrived alone in a
    /// real run, and leaked in front of the dialog). Shown with the next
    /// output once the line is clearly something else.
    held: Vec<u8>,
}

/// How plink's host-key notices begin, for holding back an unfinished line
/// that may be one of them.
const HOSTKEY_NOTICE_STARTS: [&str; 5] = [
    "The host key is not cached",
    "The server's host key is not cached",
    "The host key does not match",
    "WARNING - POTENTIAL SECURITY BREACH",
    // The weak-crypto question ("The first cipher supported by ...").
    "The first ",
];

/// Whether `tail` (an unfinished last line) may still become a notice.
fn could_start_notice(tail: &[u8]) -> bool {
    let t = String::from_utf8_lossy(tail);
    let t = t.trim_start_matches('\r');
    !t.is_empty() && HOSTKEY_NOTICE_STARTS.iter().any(|m| m.starts_with(t) && m.len() > t.len())
}

/// How plink (0.75 to 0.85) opens a host-key notice, new key or changed key.
const HOSTKEY_NOTICE_MARKERS: [&str; 6] = [
    "host key is not cached",
    "WARNING - POTENTIAL SECURITY BREACH",
    "host key does not match",
    // The weak-crypto question: the dialog shows it, not the terminal.
    "The first key-exchange algorithm",
    "The first host key type",
    "cipher supported by the server is",
];

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
            in_hostkey_notice: false,
            pending_echo: Vec::new(),
            held: Vec::new(),
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

        // The echo of a host-key answer: drop it, byte by byte, across reads.
        let mut chunk = chunk;
        while let (Some(&want), Some(&got)) = (self.pending_echo.first(), chunk.first()) {
            if want != got {
                self.pending_echo.clear();
                break;
            }
            self.pending_echo.remove(0);
            chunk = &chunk[1..];
        }
        if chunk.is_empty() {
            return PreAuthAction::Withhold(Vec::new());
        }
        self.pending_echo.clear();

        let notice_was_open = self.in_hostkey_notice;
        let visible_before = self.buffer.len();
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

        // plink's weak-crypto question, asked before any host key.
        if text.contains("Continue with connection? (y/n)") {
            if let Some(prompt_info) = HostKeyPromptInfo::parse_weak(&text) {
                self.state = SessionState::HostKeyPending { prompt: prompt_info.clone() };
                return PreAuthAction::HostKeyPrompt(prompt_info);
            }
        }

        // Check for host-key confirmation prompt
        if self.hostkey_prompt_regex.is_match(&text) {
            // Only the notice itself: anything earlier in the buffer (a
            // banner, a question already answered) is not about the key.
            let from = HOSTKEY_NOTICE_MARKERS[..3].iter().filter_map(|m| text.find(m)).min().unwrap_or(0);
            let line_start = text[..from].rfind('\n').map(|i| i + 1).unwrap_or(0);
            let prompt_info = HostKeyPromptInfo::parse(&text[line_start..]);
            self.state = SessionState::HostKeyPending {
                prompt: prompt_info.clone(),
            };
            return PreAuthAction::HostKeyPrompt(prompt_info);
        }

        // A host-key notice has started: keep it off the terminal (the dialog
        // shows it). Bytes of this chunk from before the notice still show.
        if !notice_was_open {
            if let Some(start) = HOSTKEY_NOTICE_MARKERS.iter().filter_map(|m| text.find(m)).min() {
                self.in_hostkey_notice = true;
                // The notice's first line begins at the line start before the marker.
                let line_start = text[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
                // Clamped: `text` is a lossy view, so its offsets can run past the bytes.
                let shown_from = visible_before.saturating_sub(self.held.len());
                let shown_end = line_start.max(shown_from).min(self.buffer.len());
                let shown = self.buffer[shown_from.min(shown_end)..shown_end].to_vec();
                self.held.clear();
                return PreAuthAction::Withhold(shown);
            }
        } else {
            return PreAuthAction::Withhold(Vec::new());
        }

        // An unfinished last line that may still become a notice waits.
        let mut pending = std::mem::take(&mut self.held);
        let had_held = !pending.is_empty();
        pending.extend_from_slice(chunk);
        let tail_start = pending.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
        if could_start_notice(&pending[tail_start..]) {
            self.held = pending.split_off(tail_start);
            return PreAuthAction::Withhold(pending);
        }
        if had_held {
            return PreAuthAction::Withhold(pending);
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
        self.prompt_answered_with_echo(b"");
    }

    /// As `prompt_answered`, also dropping `echo` (the terminal's echo of
    /// the answer, e.g. `y\r\n`) when it comes back.
    pub fn prompt_answered_with_echo(&mut self, echo: &[u8]) {
        if matches!(self.state, SessionState::HostKeyPending { .. }) {
            self.state = SessionState::PreAuth;
            self.buffer.clear();
            self.in_hostkey_notice = false;
            self.held.clear();
            self.pending_echo = echo.to_vec();
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

#[cfg(test)]
mod hostkey_notice_tests {
    use super::*;

    // Verbatim plink 0.81 output for an unknown host, via a jump host
    // (2026-09-26 GUI test), split where the PTY split it.
    const PROXY_LINE: &[u8] = b"-- Making proxy SSH connection to 127.0.0.1 port 2222 ---\r\n";
    const NOTICE: &[u8] = b"The host key is not cached for this server:\r\n  127.0.0.1 (port 2222)\r\nYou have no guarantee that the server is the computer you\r\nthink it is.\r\nThe server's ssh-ed25519 key fingerprint is:\r\n  ssh-ed25519 255 SHA256:L+WPtiy7pQ5CsKZG3ScgWz1Bues7LXQ1uPhfNvl7J+8\r\nIf you trust this host, enter \"y\" to add the key to Plink's\r\ncache and carry on connecting.\r\n";
    const QUESTION: &[u8] = b"Store key in cache? (y/n, Return cancels connection, i for more info) ";

    #[test]
    fn the_host_key_notice_goes_to_the_dialog_not_the_terminal() {
        let mut sm = PreAuthStateMachine::new();
        assert_eq!(sm.feed_bytes(PROXY_LINE), PreAuthAction::Hold, "text before the notice still shows");
        assert_eq!(sm.feed_bytes(NOTICE), PreAuthAction::Withhold(Vec::new()));
        match sm.feed_bytes(QUESTION) {
            PreAuthAction::HostKeyPrompt(info) => assert_eq!(info.fingerprint, "SHA256:L+WPtiy7pQ5CsKZG3ScgWz1Bues7LXQ1uPhfNvl7J+8"),
            other => panic!("expected the dialog, got {other:?}"),
        }
    }

    #[test]
    fn text_before_the_notice_in_the_same_read_still_shows() {
        let mut sm = PreAuthStateMachine::new();
        let mut chunk = PROXY_LINE.to_vec();
        chunk.extend_from_slice(NOTICE);
        assert_eq!(sm.feed_bytes(&chunk), PreAuthAction::Withhold(PROXY_LINE.to_vec()));
    }

    #[test]
    fn the_answers_echo_is_dropped_and_what_follows_shows() {
        let mut sm = PreAuthStateMachine::new();
        sm.feed_bytes(NOTICE);
        sm.feed_bytes(QUESTION);
        sm.prompt_answered_with_echo(b"y\r\n");
        // Echo split across reads, then the password prompt.
        assert_eq!(sm.feed_bytes(b"y"), PreAuthAction::Withhold(Vec::new()));
        assert_eq!(sm.feed_bytes(b"\r\nuser@host's password: "), PreAuthAction::Hold);
        assert!(String::from_utf8_lossy(&sm.buffer).starts_with("user@host"), "echo not in the buffer");
    }

    #[test]
    fn a_second_host_key_notice_is_withheld_too() {
        // Through a jump host plink asks about the bastion, then the target.
        let mut sm = PreAuthStateMachine::new();
        sm.feed_bytes(NOTICE);
        sm.feed_bytes(QUESTION);
        sm.prompt_answered_with_echo(b"y\r\n");
        assert_eq!(sm.feed_bytes(b"y\r\n"), PreAuthAction::Withhold(Vec::new()));
        assert_eq!(sm.feed_bytes(NOTICE), PreAuthAction::Withhold(Vec::new()));
        assert!(matches!(sm.feed_bytes(QUESTION), PreAuthAction::HostKeyPrompt(_)));
    }

    #[test]
    fn a_notice_split_after_its_first_word_does_not_leak_that_word() {
        // Real run, 2026-09-27: "The" arrived alone and showed in front of
        // the dialog as "TheUsing username ...".
        let mut sm = PreAuthStateMachine::new();
        assert_eq!(sm.feed_bytes(b"The"), PreAuthAction::Withhold(Vec::new()));
        assert_eq!(sm.feed_bytes(&NOTICE[3..]), PreAuthAction::Withhold(Vec::new()));
        assert!(matches!(sm.feed_bytes(QUESTION), PreAuthAction::HostKeyPrompt(_)));
    }

    #[test]
    fn a_held_line_that_is_not_a_notice_is_shown_after_all() {
        let mut sm = PreAuthStateMachine::new();
        assert_eq!(sm.feed_bytes(b"The"), PreAuthAction::Withhold(Vec::new()));
        assert_eq!(sm.feed_bytes(b"re is a banner\r\n"), PreAuthAction::Withhold(b"There is a banner\r\n".to_vec()));
        assert_eq!(sm.feed_bytes(b"user@host's password: "), PreAuthAction::Hold);
    }

    #[test]
    fn a_fatal_error_during_the_notice_still_closes_with_its_reason() {
        let mut sm = PreAuthStateMachine::new();
        sm.feed_bytes(NOTICE);
        assert!(matches!(sm.feed_bytes(b"FATAL ERROR: Network error: Connection reset\r\n"), PreAuthAction::Closed(_)));
    }
}

#[cfg(test)]
mod changed_key_tests {
    use super::*;

    // Verbatim plink 0.81 against an sshd whose host key was swapped after
    // the first one was cached (run 2026-09-27).
    const CHANGED: &str = "WARNING - POTENTIAL SECURITY BREACH!\r\nThe host key does not match the one Plink has cached for\r\nthis server:\r\n  127.0.0.1 (port 2230)\r\nThis means that either the server administrator has changed\r\nthe host key, or you have actually connected to another\r\ncomputer pretending to be the server.\r\nThe new ssh-ed25519 key fingerprint is:\r\n  ssh-ed25519 255 SHA256:3O68y3/hYcPWT0PvUA6iAW4Hke8MxUWDn1JMiSW6EGo\r\nIf you were expecting this change and trust the new key,\r\nenter \"y\" to update Plink's cache and carry on connecting.\r\nIf you want to carry on connecting but without updating the\r\ncache, enter \"n\".\r\nIf you want to abandon the connection completely, press\r\nReturn to cancel. Pressing Return is the ONLY guaranteed\r\nsafe choice.\r\nUpdate cached key? (y/n, Return cancels connection, i for more info) ";

    #[test]
    fn a_changed_host_key_is_reported_as_changed_not_as_new() {
        let mut sm = PreAuthStateMachine::new();
        match sm.feed_bytes(CHANGED.as_bytes()) {
            PreAuthAction::HostKeyPrompt(info) => {
                assert!(info.changed);
                assert_eq!(info.host, "127.0.0.1");
                assert_eq!(info.port, 2230);
                assert_eq!(info.fingerprint, "SHA256:3O68y3/hYcPWT0PvUA6iAW4Hke8MxUWDn1JMiSW6EGo");
            }
            other => panic!("expected a host-key prompt, got {other:?}"),
        }
    }

    #[test]
    fn a_first_visit_is_not_reported_as_changed() {
        let raw = "The host key is not cached for this server:\r\n  127.0.0.1 (port 2230)\r\nThe server's ssh-ed25519 key fingerprint is:\r\n  ssh-ed25519 255 SHA256:abc\r\nStore key in cache? (y/n, Return cancels connection, i for more info) ";
        assert!(!HostKeyPromptInfo::parse(raw).changed);
    }
}

#[cfg(test)]
mod weak_crypto_tests {
    use super::*;

    // PuTTY 0.81's wording (console confirm_weak_crypto_primitive), as the
    // owner's old Cisco router produced it.
    const WEAK_KEX: &str = "The first key-exchange algorithm supported by the server is\r\ndiffie-hellman-group1-sha1, which is below the configured warning threshold.\r\nContinue with connection? (y/n) ";
    const WEAK_CIPHER: &str = "The first cipher supported by the server is\r\n3des-cbc, which is below the configured warning threshold.\r\nContinue with connection? (y/n) ";
    const NEW_KEY: &str = "The host key is not cached for this server:\r\n  192.0.2.57 (port 22)\r\nYou have no guarantee that the server is the computer\r\nyou think it is.\r\nThe server's ssh-rsa key fingerprint is:\r\n  ssh-rsa 2048 SHA256:q1w2e3r4t5y6u7i8o9p0asdfghjklzxcvbnmQWERTYU\r\nStore key in cache? (y/n, Return cancels connection, i for more info) ";

    #[test]
    fn the_weak_crypto_question_becomes_a_dialog_not_terminal_text() {
        let mut sm = PreAuthStateMachine::new();
        match sm.feed_bytes(WEAK_KEX.as_bytes()) {
            PreAuthAction::HostKeyPrompt(info) => {
                assert_eq!(info.weak.as_deref(), Some("key-exchange algorithm: diffie-hellman-group1-sha1"));
                assert!(!info.changed);
            }
            other => panic!("expected a prompt, got {other:?}"),
        }
        assert!(matches!(sm.state(), SessionState::HostKeyPending { .. }));
    }

    #[test]
    fn a_weak_cipher_is_named_too() {
        let info = HostKeyPromptInfo::parse_weak(WEAK_CIPHER).unwrap();
        assert_eq!(info.weak.as_deref(), Some("cipher: 3des-cbc"));
        assert!(HostKeyPromptInfo::parse_weak(NEW_KEY).is_none());
    }

    #[test]
    fn the_host_key_dialog_after_it_shows_only_the_host_key() {
        // Answered weak-crypto question, its echo, then the host key: the
        // dialog used to be built from the whole buffer.
        let mut sm = PreAuthStateMachine::new();
        assert!(matches!(sm.feed_bytes(WEAK_KEX.as_bytes()), PreAuthAction::HostKeyPrompt(_)));
        sm.prompt_answered_with_echo(b"y\r\n");
        let _ = sm.feed_bytes(b"y\r\n");
        match sm.feed_bytes(NEW_KEY.as_bytes()) {
            PreAuthAction::HostKeyPrompt(info) => {
                assert!(info.weak.is_none());
                assert_eq!(info.host, "192.0.2.57");
                assert_eq!(info.port, 22);
                assert_eq!(info.key_type, "ssh-rsa");
                assert!(info.fingerprint.starts_with("SHA256:q1w2"));
                assert!(!info.raw_prompt.contains("diffie-hellman"));
            }
            other => panic!("expected the host-key prompt, got {other:?}"),
        }
    }

    #[test]
    fn a_line_that_starts_like_the_question_is_held_then_shown() {
        // "The first " is also held back while it may become the question.
        let mut sm = PreAuthStateMachine::new();
        assert!(matches!(sm.feed_bytes(b"The first "), PreAuthAction::Withhold(_) | PreAuthAction::Hold));
    }
}
