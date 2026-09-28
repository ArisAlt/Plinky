//! plink's pause after login: "Access granted. Press Return to begin
//! session." (PuTTY's anti-spoofing prompt). Plinky answers it for the
//! user -- it is not a question, and the user already pressed Enter once,
//! for the password.
//!
//! The answer used to look only at the chunk of output that carried
//! "Access granted". On Linux plink's line arrives whole. On Windows
//! plink's output goes through the pseudo-console, which paints it in
//! frames: the rest of the line can come in a later chunk, among the
//! console's own control sequences, and a Windows session sat at the
//! prompt (owner's screenshot, v0.1.15: ". Press Return to begin
//! session." and nothing after it). So the text after the marker is
//! watched for a while, as text: control sequences removed, and
//! whitespace ignored, since the pseudo-console can draw spaces as cursor
//! moves.

const PHRASE: &str = "PressReturntobeginsession";

/// Past this much text the prompt isn't coming: the session already shows
/// its shell, or the server said something else.
const LIMIT: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub enum Gate {
    /// The prompt is complete: answer it, once.
    Answer,
    /// Not yet; keep feeding.
    Waiting,
    /// Gave up: nothing to answer.
    Done,
}

#[derive(Default)]
pub struct BeginGate {
    seen: String,
    finished: bool,
}

impl BeginGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Output after "Access granted", as it arrives.
    pub fn feed(&mut self, bytes: &[u8]) -> Gate {
        if self.finished {
            return Gate::Done;
        }
        self.seen.push_str(&squeeze(&String::from_utf8_lossy(bytes)));
        if self.seen.contains(PHRASE) {
            self.finished = true;
            Gate::Answer
        } else if self.seen.len() > LIMIT {
            self.finished = true;
            Gate::Done
        } else {
            Gate::Waiting
        }
    }
}

/// Text without control sequences (CSI `ESC [ ... final`, OSC `ESC ] ...
/// BEL`, other two-byte escapes) and without whitespace.
fn squeeze(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if !c.is_whitespace() && !c.is_control() {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_the_prompt_when_it_comes_whole() {
        // Linux: the rest of plink's line in the same chunk as the marker.
        let mut g = BeginGate::new();
        assert_eq!(g.feed(b". Press Return to begin session. \r\n"), Gate::Answer);
    }

    #[test]
    fn answers_the_prompt_split_across_chunks() {
        // Windows: the pseudo-console paints the line in frames.
        let mut g = BeginGate::new();
        assert_eq!(g.feed(b"."), Gate::Waiting);
        assert_eq!(g.feed(b" Press Return to beg"), Gate::Waiting);
        assert_eq!(g.feed(b"in session. "), Gate::Answer);
    }

    #[test]
    fn answers_the_prompt_among_console_control_sequences() {
        // Cursor moves standing in for spaces, colour, a window title, the
        // cursor hidden and shown -- all things a pseudo-console emits.
        let mut g = BeginGate::new();
        let painted = b"\x1b[?25l\x1b]0;plink\x07. Press\x1b[1CReturn to\x1b[1Cbegin \x1b[33msession\x1b[m.\x1b[?25h";
        assert_eq!(g.feed(painted), Gate::Answer);
    }

    #[test]
    fn answers_only_once() {
        let mut g = BeginGate::new();
        assert_eq!(g.feed(b"Press Return to begin session."), Gate::Answer);
        assert_eq!(g.feed(b"Press Return to begin session."), Gate::Done);
    }

    #[test]
    fn gives_up_when_the_session_just_starts() {
        // A server whose login printed no prompt: the shell's output runs on.
        let mut g = BeginGate::new();
        let motd = "Welcome to Ubuntu\r\n".repeat(300);
        assert_eq!(g.feed(motd.as_bytes()), Gate::Done);
        assert_eq!(g.feed(b"Press Return to begin session."), Gate::Done, "too late to be plink's prompt");
    }
}
