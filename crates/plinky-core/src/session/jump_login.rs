//! Vault logins for a session that goes through a jump host.
//!
//! A saved session with PuTTY's SSH proxy (`ProxyMethod=6`) makes plink log
//! in twice: to the jump host, then through it to the final host. `-pwfile`
//! cannot serve that. Measured with plink 0.81 against OpenSSH 9.6: the
//! file's password is offered to the JUMP host first; there it fails with
//! "Configured password was not accepted" and the connection dies -- after
//! the final host's password has been sent to the bastion.
//!
//! So a jump session starts without `-pwfile` and this answers plink's two
//! prompts itself, which plink prints as (verbatim, 0.81):
//!
//! ```text
//! -- Making proxy SSH connection to <jump host> port <port> -----...
//! <jump user>@<jump host>'s password:
//!
//! -- Making primary SSH connection to <final host> port <port> -----...
//! <final user>@<final host>'s password:
//! ```
//!
//! Each password goes out once, in order, and only at its own prompt:
//! - the jump password at `<jump user>@<jump host>'s password: ` while the
//!   jump login is still pending;
//! - the final password only after the jump prompt was answered (or there
//!   was no jump password to give), after plink's own "Making primary SSH
//!   connection to <final host> port <port>" line, and at
//!   `<final user>@<final host>'s password: `.
//!
//! A prompt that comes back means that login failed. Nothing more is typed
//! after that: the user sees plink's prompt and types. Retyping a stored
//! password into a repeated prompt would only lock the account, and the
//! final password must never land at the jump host's prompt.

use crate::vault::SecretString;

/// One login: who, where, and the password.
pub struct Login {
    pub user: String,
    pub host: String,
    pub port: u16,
    pub password: SecretString,
}

/// What to answer for a jump session. Either side may be missing: a jump
/// host that takes a key, or a final host with no vault entry.
pub struct JumpCredentials {
    pub jump: Option<Login>,
    pub target: Option<Login>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// The jump host's password prompt hasn't been answered yet.
    Jump,
    /// Jump done (or nothing to give it); waiting for plink's primary line.
    Primary,
    /// plink has started the final login; waiting for its prompt.
    Target,
    /// Nothing more to type.
    Done,
}

pub struct JumpLogin {
    creds: JumpCredentials,
    phase: Phase,
    /// Recent output, `\r` removed, trimmed to `TAIL_LEN` bytes.
    tail: String,
}

/// Enough for plink's header line plus a prompt; prompts are matched at the
/// end of the stream, so older text is never needed.
const TAIL_LEN: usize = 1024;

impl JumpLogin {
    pub fn new(creds: JumpCredentials) -> Self {
        let phase = if creds.jump.is_some() { Phase::Jump } else { Phase::Primary };
        let phase = if creds.jump.is_none() && creds.target.is_none() { Phase::Done } else { phase };
        Self { creds, phase, tail: String::new() }
    }

    pub fn is_done(&self) -> bool {
        self.phase == Phase::Done
    }

    fn prompt(l: &Login) -> String {
        format!("{}@{}'s password: ", l.user, l.host)
    }

    fn typed(password: &SecretString) -> zeroize::Zeroizing<Vec<u8>> {
        let mut out = zeroize::Zeroizing::new(Vec::with_capacity(password.len() + 1));
        out.extend_from_slice(password.as_bytes());
        out.push(b'\r');
        out
    }

    /// Feeds pre-auth output. Returns the bytes to type, if this chunk ends
    /// at a prompt that is this login's to answer.
    pub fn feed(&mut self, chunk: &[u8]) -> Option<zeroize::Zeroizing<Vec<u8>>> {
        if self.phase == Phase::Done {
            return None;
        }
        self.tail.push_str(&String::from_utf8_lossy(chunk).replace('\r', ""));
        if self.tail.len() > TAIL_LEN {
            let mut cut = self.tail.len() - TAIL_LEN;
            while !self.tail.is_char_boundary(cut) {
                cut += 1;
            }
            self.tail.drain(..cut);
        }

        // A jump prompt after the jump password went out: that login
        // failed. Stop, whatever phase we're in.
        if self.phase != Phase::Jump {
            if let Some(j) = &self.creds.jump {
                if self.tail.ends_with(&Self::prompt(j)) {
                    self.phase = Phase::Done;
                    return None;
                }
            }
        }

        match self.phase {
            Phase::Jump => {
                let j = self.creds.jump.as_ref()?;
                if self.tail.ends_with(&Self::prompt(j)) {
                    self.phase = if self.creds.target.is_some() { Phase::Primary } else { Phase::Done };
                    self.tail.clear();
                    return Some(Self::typed(&j.password));
                }
                None
            }
            Phase::Primary => {
                let t = self.creds.target.as_ref()?;
                let line = format!("-- Making primary SSH connection to {} port {} ", t.host, t.port);
                if let Some(pos) = self.tail.find(&line) {
                    self.tail.drain(..pos + line.len());
                    self.phase = Phase::Target;
                    return self.feed(b"");
                }
                None
            }
            Phase::Target => {
                let t = self.creds.target.as_ref()?;
                if self.tail.ends_with(&Self::prompt(t)) {
                    self.phase = Phase::Done;
                    self.tail.clear();
                    return Some(Self::typed(&t.password));
                }
                None
            }
            Phase::Done => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(user: &str, host: &str, port: u16, pw: &str) -> Login {
        Login { user: user.into(), host: host.into(), port, password: SecretString::new(pw) }
    }

    fn both() -> JumpLogin {
        JumpLogin::new(JumpCredentials {
            jump: Some(login("jumpu", "10.0.0.1", 22, "JumpPass")),
            target: Some(login("finalu", "192.168.1.5", 22, "FinalPass")),
        })
    }

    fn text(b: Option<zeroize::Zeroizing<Vec<u8>>>) -> Option<String> {
        b.map(|v| String::from_utf8(v.to_vec()).unwrap())
    }

    // Verbatim plink 0.81 output through ProxyMethod=6 (run 2026-09-26).
    const PROXY_LINE: &str = "-- Making proxy SSH connection to 10.0.0.1 port 22 ------------------------\r\n";
    const PRIMARY_LINE: &str = "\r\n-- Making primary SSH connection to 192.168.1.5 port 22 ----------------------\r\n";

    #[test]
    fn each_password_goes_to_its_own_prompt_in_order() {
        let mut j = both();
        assert_eq!(text(j.feed(PROXY_LINE.as_bytes())), None);
        assert_eq!(text(j.feed(b"jumpu@10.0.0.1's password: ")).as_deref(), Some("JumpPass\r"));
        assert_eq!(text(j.feed(PRIMARY_LINE.as_bytes())), None);
        assert_eq!(text(j.feed(b"finalu@192.168.1.5's password: ")).as_deref(), Some("FinalPass\r"));
        assert!(j.is_done());
    }

    #[test]
    fn the_final_password_is_never_typed_before_the_jump_login() {
        // A jump server's banner can print anything before its own prompt.
        // Even a perfect imitation of plink's primary line and the final
        // prompt must not get the final password: it would sit in plink's
        // input and be read by the jump host's real prompt.
        let mut j = both();
        let fake = format!("{PROXY_LINE}{PRIMARY_LINE}finalu@192.168.1.5's password: ");
        assert_eq!(text(j.feed(fake.as_bytes())), None);
    }

    #[test]
    fn the_final_password_waits_for_plinks_primary_line() {
        let mut j = both();
        j.feed(b"jumpu@10.0.0.1's password: ");
        assert_eq!(text(j.feed(b"\r\nfinalu@192.168.1.5's password: ")), None);
    }

    #[test]
    fn the_primary_line_must_name_the_final_host_and_port() {
        let mut j = both();
        j.feed(b"jumpu@10.0.0.1's password: ");
        let other = "\r\n-- Making primary SSH connection to 192.168.1.5 port 2222 ---\r\nfinalu@192.168.1.5's password: ";
        assert_eq!(text(j.feed(other.as_bytes())), None);
    }

    #[test]
    fn a_repeated_jump_prompt_stops_everything() {
        // The jump password was wrong. Typing the final password now would
        // hand it to the jump host's second prompt.
        let mut j = both();
        j.feed(b"jumpu@10.0.0.1's password: ");
        assert_eq!(text(j.feed(b"\r\nAccess denied\r\njumpu@10.0.0.1's password: ")), None);
        assert!(j.is_done());
        let rest = format!("{PRIMARY_LINE}finalu@192.168.1.5's password: ");
        assert_eq!(text(j.feed(rest.as_bytes())), None);
    }

    #[test]
    fn a_repeated_final_prompt_is_left_to_the_user() {
        let mut j = both();
        j.feed(b"jumpu@10.0.0.1's password: ");
        j.feed(PRIMARY_LINE.as_bytes());
        j.feed(b"finalu@192.168.1.5's password: ");
        assert_eq!(text(j.feed(b"\r\nAccess denied\r\nfinalu@192.168.1.5's password: ")), None);
    }

    #[test]
    fn a_prompt_for_another_user_or_host_is_not_answered() {
        let mut j = both();
        assert_eq!(text(j.feed(b"root@10.0.0.1's password: ")), None);
        assert_eq!(text(j.feed(b"\r\njumpu@10.0.0.2's password: ")), None);
    }

    #[test]
    fn a_prompt_must_end_the_output_so_far() {
        let mut j = both();
        assert_eq!(text(j.feed(b"jumpu@10.0.0.1's password: and more")), None);
    }

    #[test]
    fn a_key_authenticated_jump_host_still_gets_the_final_password() {
        let mut j = JumpLogin::new(JumpCredentials {
            jump: None,
            target: Some(login("finalu", "192.168.1.5", 22, "FinalPass")),
        });
        j.feed(PROXY_LINE.as_bytes());
        j.feed(PRIMARY_LINE.as_bytes());
        assert_eq!(text(j.feed(b"finalu@192.168.1.5's password: ")).as_deref(), Some("FinalPass\r"));
    }

    #[test]
    fn with_only_a_jump_password_the_final_prompt_is_left_alone() {
        let mut j = JumpLogin::new(JumpCredentials {
            jump: Some(login("jumpu", "10.0.0.1", 22, "JumpPass")),
            target: None,
        });
        assert!(j.feed(b"jumpu@10.0.0.1's password: ").is_some());
        assert!(j.is_done());
    }

    #[test]
    fn a_prompt_split_across_reads_is_still_found() {
        let mut j = both();
        assert_eq!(text(j.feed(b"jumpu@10.0.0")), None);
        assert_eq!(text(j.feed(b".1's pass")), None);
        assert_eq!(text(j.feed(b"word: ")).as_deref(), Some("JumpPass\r"));
    }
}
