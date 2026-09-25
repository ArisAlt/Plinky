//! Paced paste: send pasted text one line at a time with a delay between
//! lines. Console ports and many network devices have tiny input buffers; a
//! config pasted at full speed drops characters (SecureCRT's "line send
//! delay").

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::errors::{PlinkyError, Result};
use crate::session::manager::SessionRegistry;

/// Bounds so a stray paste can't pin a session for hours.
pub const MAX_LINE_DELAY_MS: u64 = 5_000;
pub const MAX_PASTE_BYTES: usize = 1024 * 1024;

/// Splits pasted text into the chunks to send. Every line that was followed
/// by a newline ends in CR (what Enter sends to a terminal). A final line
/// with no newline after it is sent without CR, so it waits at the prompt --
/// exactly what an unpaced paste of the same text would do.
pub fn split_paste_lines(text: &str) -> Vec<Vec<u8>> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut parts: Vec<&str> = normalized.split('\n').collect();
    let tail = parts.pop().unwrap_or("");
    let mut lines: Vec<Vec<u8>> = parts
        .into_iter()
        .map(|line| {
            let mut bytes = line.as_bytes().to_vec();
            bytes.push(b'\r');
            bytes
        })
        .collect();
    if !tail.is_empty() {
        lines.push(tail.as_bytes().to_vec());
    }
    lines
}

impl SessionRegistry {
    /// Writes `text` line by line with `line_delay` between lines. Goes
    /// through write_input_live_only: a multi-line paste into a pre-auth
    /// prompt is exactly how bootstrap text once got submitted as a series of
    /// password guesses, so it's refused until the session is Live.
    ///
    /// Stops early (Ok) when `cancel` is set; stops with the write error if
    /// the session dies or leaves Live. Returns the number of lines sent.
    pub async fn paste_paced(
        &self,
        id: &str,
        text: &str,
        line_delay: Duration,
        cancel: Arc<AtomicBool>,
        mut progress: impl FnMut(usize, usize),
    ) -> Result<usize> {
        if text.len() > MAX_PASTE_BYTES {
            return Err(PlinkyError::ProcessError(format!(
                "Paste too large ({} bytes, max {MAX_PASTE_BYTES})",
                text.len()
            )));
        }
        if line_delay > Duration::from_millis(MAX_LINE_DELAY_MS) {
            return Err(PlinkyError::ProcessError(format!(
                "Line delay too long (max {MAX_LINE_DELAY_MS} ms)"
            )));
        }

        let lines = split_paste_lines(text);
        let total = lines.len();
        let mut sent = 0;
        for line in lines {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            if sent > 0 && !line_delay.is_zero() {
                tokio::time::sleep(line_delay).await;
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
            }
            self.write_input_live_only(id, &line)?;
            sent += 1;
            progress(sent, total);
        }
        Ok(sent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_followed_by_newline_get_cr() {
        assert_eq!(
            split_paste_lines("interface Gi0/1\n shutdown\n"),
            vec![b"interface Gi0/1\r".to_vec(), b" shutdown\r".to_vec()]
        );
    }

    #[test]
    fn trailing_partial_line_is_sent_without_enter() {
        assert_eq!(
            split_paste_lines("conf t\nhostname sw1"),
            vec![b"conf t\r".to_vec(), b"hostname sw1".to_vec()]
        );
    }

    #[test]
    fn crlf_and_blank_lines_are_preserved() {
        assert_eq!(
            split_paste_lines("a\r\n\r\nb\r\n"),
            vec![b"a\r".to_vec(), b"\r".to_vec(), b"b\r".to_vec()]
        );
    }

    #[test]
    fn empty_paste_sends_nothing() {
        assert!(split_paste_lines("").is_empty());
    }
}
