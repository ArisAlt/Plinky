//! A small expect engine: wait for a prompt, send a reply, next step.
//!
//! What SecureCRT's logon scripts and Linux `expect` do, for the one job a
//! tunnel can't: reaching a device behind a router or switch. PuTTY's SSH
//! proxy asks the first device to forward a TCP connection; NX-OS and IOS
//! refuse (or never answer, which looks like a freeze after the password).
//! Chaining through the device's own CLI works: log in to it, type
//! `ssh admin@10.1.1.2` at its prompt, answer the second device's password.
//!
//! Rules, because a script that types passwords must not type them into
//! the wrong place:
//! - steps run in order; a step fires only when the output so far *ends*
//!   with its prompt (a banner that merely mentions "Password:" doesn't);
//! - each step fires once;
//! - after a secret went out, the same prompt coming back means that login
//!   failed: the script stops and the user types (retyping a stored password
//!   into a repeated prompt only locks accounts);
//! - any failure pattern ("% Authentication failed", "Connection refused",
//!   ...) stops it too.
//!
//! Unlike the pre-auth logins, this runs while the session is live: the
//! prompts it answers are the first device's CLI, after its own login. It
//! answers only its own scripted steps, in order, never an arbitrary prompt.

use regex::Regex;
use zeroize::Zeroizing;

use crate::vault::SecretString;

pub enum Reply {
    /// Typed as is (a command), then Return.
    Line(String),
    /// A password, then Return. Never logged or echoed by this module.
    Secret(SecretString),
}

pub struct Step {
    /// Matched against the end of the output (`\r` removed).
    pub expect: Regex,
    pub reply: Reply,
    /// For the terminal's status line ("jump password", "ssh command").
    pub label: &'static str,
}

pub struct Expect {
    steps: Vec<Step>,
    next: usize,
    fail: Vec<Regex>,
    /// Recent output, `\r` removed, at most `TAIL_LEN` bytes.
    tail: String,
    /// The step whose secret was sent last: seeing its prompt again means
    /// that login failed.
    last_secret: Option<usize>,
    stopped: Option<String>,
}

const TAIL_LEN: usize = 2048;

/// What the engine did with a chunk.
#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    /// Nothing to send.
    None,
    /// Send these bytes; `label` says which step it was.
    Send { bytes: Zeroizing<Vec<u8>>, label: &'static str },
    /// The script ended: finished (`None`) or stopped with a reason.
    Stopped(Option<String>),
}

impl Expect {
    pub fn new(steps: Vec<Step>, fail: Vec<Regex>) -> Self {
        Self { steps, next: 0, fail, tail: String::new(), last_secret: None, stopped: None }
    }

    pub fn is_done(&self) -> bool {
        self.stopped.is_some() || self.next >= self.steps.len()
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Event {
        if self.is_done() {
            return Event::None;
        }
        self.tail.push_str(&String::from_utf8_lossy(chunk).replace('\r', ""));
        if self.tail.len() > TAIL_LEN {
            let mut cut = self.tail.len() - TAIL_LEN;
            while !self.tail.is_char_boundary(cut) {
                cut += 1;
            }
            self.tail.drain(..cut);
        }

        if let Some(rx) = self.fail.iter().find(|rx| rx.is_match(&self.tail)) {
            let why = rx.find(&self.tail).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
            return self.stop(Some(why));
        }
        if let Some(i) = self.last_secret {
            if self.steps[i].expect.is_match(&self.tail) {
                return self.stop(Some("the password was not accepted".into()));
            }
        }

        let step = &self.steps[self.next];
        if !step.expect.is_match(&self.tail) {
            return Event::None;
        }
        let mut bytes = Zeroizing::new(Vec::new());
        match &step.reply {
            Reply::Line(text) => {
                bytes.extend_from_slice(text.as_bytes());
                self.last_secret = None;
            }
            Reply::Secret(secret) => {
                bytes.extend_from_slice(secret.as_bytes());
                self.last_secret = Some(self.next);
            }
        }
        bytes.push(b'\r');
        let label = step.label;
        self.next += 1;
        self.tail.clear();
        Event::Send { bytes, label }
    }

    fn stop(&mut self, why: Option<String>) -> Event {
        self.stopped = Some(why.clone().unwrap_or_default());
        Event::Stopped(why)
    }
}

/// A session's logon actions (Session settings), as SecureCRT's Logon
/// Actions: for each pair, wait until the output ends with `wait` (plain
/// text, not a pattern) and send `send` and Return. An empty `wait` means
/// any prompt (# > $ %). Lines are sent in order, each once.
pub fn logon_actions(pairs: &[(String, String)]) -> Option<Expect> {
    let steps: Vec<Step> = pairs
        .iter()
        .filter(|(_, send)| !send.trim().is_empty())
        .map(|(wait, send)| Step {
            expect: if wait.trim().is_empty() {
                Regex::new(r"[#>$%]\s*$").unwrap()
            } else {
                Regex::new(&format!(r"{}\s*$", regex::escape(wait.trim()))).unwrap()
            },
            reply: Reply::Line(send.clone()),
            label: "logon action",
        })
        .collect();
    (!steps.is_empty()).then(|| Expect::new(steps, Vec::new()))
}

/// The password prompt of a device's login, OpenSSH style ("admin@10.1.1.2's
/// password: "), plink's keyboard-interactive ("| Password: ") or a CLI
/// client's ("Password: ").
pub fn password_prompt() -> Regex {
    Regex::new(r"(?i)password:\s*$").unwrap()
}

/// A network device's CLI prompt: "switch#", "router>", "R1(config)#".
pub fn cli_prompt() -> Regex {
    Regex::new(r"(?m)^[^\s#>]+(\([^)]*\))?[#>]\s*$").unwrap()
}

/// How a second hop fails on NX-OS and IOS (and OpenSSH, for tests).
pub fn hop_failures() -> Vec<Regex> {
    [
        r"% ?Authentication failed",
        r"% ?Connection refused[^\n]*",
        r"% ?Connection timed out[^\n]*",
        r"% ?Destination unreachable[^\n]*",
        r"% ?Unknown command[^\n]*",
        r"% ?Invalid (input|command)[^\n]*",
        r"(?i)ssh: connect to host [^\n]*",
        r"(?i)permission denied \([^)]*\)",
        r"(?i)connection closed by (foreign|remote) host",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
}

/// Fills `{user}`, `{host}` and `{port}` in a hop command.
pub fn hop_command(template: &str, user: &str, host: &str, port: u16) -> String {
    template.replace("{user}", user).replace("{host}", host).replace("{port}", &port.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(e: Event) -> Option<String> {
        match e {
            Event::Send { bytes, .. } => Some(String::from_utf8(bytes.to_vec()).unwrap()),
            _ => None,
        }
    }

    /// NX-OS first (keyboard-interactive login, then its CLI), IOS behind it.
    fn chain() -> Expect {
        Expect::new(
            vec![
                Step { expect: password_prompt(), reply: Reply::Secret(SecretString::new("nxos-pw")), label: "jump password" },
                Step { expect: cli_prompt(), reply: Reply::Line(hop_command("ssh {user}@{host}", "admin", "10.1.1.2", 22)), label: "hop command" },
                Step { expect: password_prompt(), reply: Reply::Secret(SecretString::new("ios-pw")), label: "target password" },
            ],
            hop_failures(),
        )
    }

    #[test]
    fn walks_nx_os_to_ios_in_order() {
        let mut e = chain();
        assert_eq!(text(e.feed(b"-- Keyboard-interactive authentication prompts from server: ---\r\n| Password: ")).as_deref(), Some("nxos-pw\r"));
        assert_eq!(e.feed(b"\r\n-- End of keyboard-interactive prompts from server ---\r\nAccess granted. Press Return to begin session.\r\n"), Event::None);
        assert_eq!(text(e.feed(b"Cisco NX-OS Software\r\nnexus-01# ")).as_deref(), Some("ssh admin@10.1.1.2\r"));
        assert_eq!(text(e.feed(b"ssh admin@10.1.1.2\r\nUser Access Verification\r\nPassword: ")).as_deref(), Some("ios-pw\r"));
        assert!(e.is_done());
        // Done means done: later prompts are the user's.
        assert_eq!(e.feed(b"\r\nPE2>enable\r\nPassword: "), Event::None);
    }

    #[test]
    fn a_banner_that_mentions_a_password_is_not_a_prompt() {
        let mut e = chain();
        assert_eq!(e.feed(b"Unauthorised access prohibited. Password: must be changed every 90 days.\r\n"), Event::None);
    }

    #[test]
    fn the_command_waits_for_the_first_devices_prompt() {
        let mut e = chain();
        let _ = e.feed(b"| Password: ");
        // Banner lines ending in '#' are not a prompt line.
        assert_eq!(e.feed(b"\r\n######## WARNING ########\r\nlast login from 10.0.0.9\r\n"), Event::None);
        assert!(text(e.feed(b"nexus-01(config)# ")).is_some());
    }

    #[test]
    fn a_rejected_password_stops_the_script() {
        let mut e = chain();
        let _ = e.feed(b"| Password: ");
        assert_eq!(e.feed(b"\r\n| Password: "), Event::Stopped(Some("the password was not accepted".into())));
        assert!(e.is_done());
    }

    #[test]
    fn a_refused_second_hop_stops_the_script() {
        let mut e = chain();
        let _ = e.feed(b"| Password: ");
        let _ = e.feed(b"\r\nnexus-01# ");
        match e.feed(b"ssh admin@10.1.1.2\r\n% Connection refused by remote host\r\nnexus-01# ") {
            Event::Stopped(Some(why)) => assert!(why.contains("Connection refused")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_second_hops_host_key_question_is_left_to_the_user() {
        let mut e = chain();
        let _ = e.feed(b"| Password: ");
        let _ = e.feed(b"\r\nnexus-01# ");
        assert_eq!(e.feed(b"The authenticity of host '10.1.1.2' can't be established.\r\nAre you sure you want to continue connecting (yes/no)? "), Event::None);
        assert_eq!(text(e.feed(b"yes\r\nPassword: ")).as_deref(), Some("ios-pw\r"));
    }

    #[test]
    fn commands_fill_in_the_target() {
        assert_eq!(hop_command("ssh -l {user} {host}", "ops", "192.0.2.9", 22), "ssh -l ops 192.0.2.9");
        assert_eq!(hop_command("telnet {host} {port}", "", "192.0.2.9", 2323), "telnet 192.0.2.9 2323");
    }

    #[test]
    fn logon_actions_wait_for_their_text_at_the_end_and_send_in_order() {
        let pairs = vec![
            ("#".to_string(), "terminal length 0".to_string()),
            (String::new(), "terminal width 0".to_string()),
            ("x".to_string(), "   ".to_string()), // nothing to send: dropped
        ];
        let mut script = logon_actions(&pairs).unwrap();
        // A banner mentioning "#" mid-line is not the prompt.
        assert_eq!(script.feed(b"Use # to comment\r\nmore"), Event::None);
        match script.feed(b"\r\nR1#") {
            Event::Send { bytes, .. } => assert_eq!(&bytes[..], b"terminal length 0\r"),
            other => panic!("{other:?}"),
        }
        match script.feed(b"terminal length 0\r\nR1#") {
            Event::Send { bytes, .. } => assert_eq!(&bytes[..], b"terminal width 0\r"),
            other => panic!("{other:?}"),
        }
        assert!(script.is_done());
        assert!(logon_actions(&[]).is_none());
    }
}
