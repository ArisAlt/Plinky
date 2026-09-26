//! Session logging straight to disk.
//!
//! The terminal's "Log" used to collect output in the page's memory, to be
//! exported at the end: nothing reached the disk until then, a crash or a
//! closed tab lost all of it, and in fact nothing was collected at all (the
//! capture flag was never set). Owner request: save the log on disk, live.
//!
//! Each chunk the session reads is written to the file as it arrives, before
//! it goes to the page, with a plain `write_all` on an unbuffered `File`: once
//! it returns, the bytes are the operating system's, and survive the app.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// PuTTY's two useful logging modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogMode {
    /// Every byte, escape sequences included (PuTTY "All session output").
    All,
    /// Text only: escape sequences, carriage returns and other control
    /// characters removed (PuTTY "Printable output").
    Printable,
}

pub struct SessionLog {
    file: File,
    path: PathBuf,
    filter: Option<PrintableFilter>,
    written: u64,
}

impl SessionLog {
    /// Opens `path` for appending, creating it and its folder. Appending
    /// matches PuTTY's own choice when the file exists and never destroys an
    /// earlier log.
    pub fn open(path: &Path, mode: LogMode) -> std::io::Result<Self> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Self {
            file,
            path: path.to_path_buf(),
            filter: (mode == LogMode::Printable).then(PrintableFilter::default),
            written: 0,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Bytes written to the file so far.
    pub fn written(&self) -> u64 {
        self.written
    }

    /// Writes one chunk of session output. A failed write (disk full, the
    /// file's drive gone) is returned; the session itself carries on.
    pub fn write(&mut self, chunk: &[u8]) -> std::io::Result<()> {
        let filtered;
        let bytes = match self.filter.as_mut() {
            Some(f) => {
                filtered = f.feed(chunk);
                &filtered[..]
            }
            None => chunk,
        };
        if bytes.is_empty() {
            return Ok(());
        }
        self.file.write_all(bytes)?;
        self.written += bytes.len() as u64;
        Ok(())
    }
}

/// Removes terminal control from a byte stream, keeping text, newlines and
/// tabs. Keeps its place between chunks: a sequence split across two reads
/// is still removed whole.
#[derive(Default)]
pub struct PrintableFilter {
    state: FilterState,
    /// Text written since the last newline: a cursor move to another line
    /// then ends the line (see `feed`).
    line_open: bool,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum FilterState {
    #[default]
    Text,
    /// After ESC.
    Escape,
    /// Inside `ESC [ ...`, until a final byte 0x40..=0x7E.
    Csi,
    /// Inside `ESC ] ...` (or DCS/APC/PM/SOS), until BEL or `ESC \`.
    String,
    /// ESC seen inside a string: `\` ends it.
    StringEscape,
    /// `ESC (`, `ESC )` and friends take one more byte.
    OneMore,
}

impl PrintableFilter {
    pub fn feed(&mut self, input: &[u8]) -> Vec<u8> {
        use FilterState::*;
        let mut out = Vec::with_capacity(input.len());
        for &b in input {
            self.state = match (self.state, b) {
                (Text, 0x1b) => Escape,
                (Text, b'\n') => {
                    out.push(b);
                    self.line_open = false;
                    Text
                }
                (Text, b'\t') => {
                    out.push(b);
                    Text
                }
                // Other C0 controls and DEL: \r, backspace, bell...
                (Text, 0x00..=0x1f | 0x7f) => Text,
                (Text, _) => {
                    out.push(b);
                    self.line_open = true;
                    Text
                }
                (Escape, b'[') => Csi,
                (Escape, b']' | b'P' | b'_' | b'^' | b'X') => String,
                (Escape, b'(' | b')' | b'*' | b'+' | b'#' | b'%') => OneMore,
                (Escape, _) => Text,
                // Windows' console layer (ConPTY) starts a new line with a
                // cursor move (CUP `H`/`f`, CNL `E`) instead of CR LF. Dropped
                // like any other sequence, it glued lines together in CI:
                // "All rights reserved.C:\Users\...>". A move after text on
                // the line ends it.
                (Csi, b'H' | b'f' | b'E') => {
                    if self.line_open {
                        out.push(b'\n');
                        self.line_open = false;
                    }
                    Text
                }
                (Csi, 0x40..=0x7e) => Text,
                (Csi, _) => Csi,
                (String, 0x07) => Text,
                (String, 0x1b) => StringEscape,
                (String, _) => String,
                (StringEscape, b'\\') => Text,
                (StringEscape, _) => String,
                (OneMore, _) => Text,
            };
        }
        out
    }
}

/// Characters no file name may hold on Windows (and `/` on Linux).
fn safe_file_part(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() { "session".to_string() } else { trimmed.to_string() }
}

/// `<logs dir>/<session>_<YYYY-MM-DD_HH-MM-SS>.log`, time in UTC.
pub fn default_log_path(logs_dir: &Path, session_name: &str, unix_secs: u64) -> PathBuf {
    let (y, mo, d, h, mi, s) = utc_parts(unix_secs);
    logs_dir.join(format!(
        "{}_{y:04}-{mo:02}-{d:02}_{h:02}-{mi:02}-{s:02}.log",
        safe_file_part(session_name)
    ))
}

/// PuTTY's log file name placeholders: `&Y &M &D &T &H &P &&`. A relative
/// name is placed under `base`: PuTTY resolves it against its working
/// directory, and Plinky's is inside the read-only AppImage.
pub fn expand_putty_log_name(template: &str, host: &str, port: u16, unix_secs: u64, base: &Path) -> PathBuf {
    let (y, mo, d, h, mi, s) = utc_parts(unix_secs);
    let mut out = String::new();
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '&' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('Y') => out.push_str(&format!("{y:04}")),
            Some('M') => out.push_str(&format!("{mo:02}")),
            Some('D') => out.push_str(&format!("{d:02}")),
            Some('T') => out.push_str(&format!("{h:02}{mi:02}{s:02}")),
            Some('H') => out.push_str(&safe_file_part(host)),
            Some('P') => out.push_str(&port.to_string()),
            Some('&') => out.push('&'),
            Some(other) => {
                out.push('&');
                out.push(other);
            }
            None => out.push('&'),
        }
    }
    let p = PathBuf::from(out);
    if p.is_absolute() { p } else { base.join(p) }
}

fn utc_parts(unix_secs: u64) -> (i64, u32, u32, u64, u64, u64) {
    let days = (unix_secs / 86_400) as i64;
    let rem = unix_secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printable_mode_keeps_text_and_drops_terminal_control() {
        let mut f = PrintableFilter::default();
        let out = f.feed(b"\x1b[1;32muser@host\x1b[0m:~$ ls\r\n\x1b]0;title\x07a\tb\x08\r\n");
        assert_eq!(String::from_utf8(out).unwrap(), "user@host:~$ ls\na\tb\n");
    }

    #[test]
    fn a_sequence_split_between_reads_is_still_removed() {
        let mut f = PrintableFilter::default();
        let mut out = f.feed(b"red:\x1b[3");
        out.extend(f.feed(b"1mX\x1b]2;t"));
        out.extend(f.feed(b"itle\x1b\\ done"));
        assert_eq!(String::from_utf8(out).unwrap(), "red:X done");
    }

    #[test]
    fn a_cursor_move_to_the_next_line_ends_the_line() {
        // Verbatim shape of ConPTY output (windows-latest CI, 2026-09-26).
        let mut f = PrintableFilter::default();
        let out = f.feed(b"\x1b[2J\x1b[HMicrosoft Windows\x1b[2;1H(c) Microsoft.\x1b[4;1HC:\\Users>\x1b[?25h");
        assert_eq!(String::from_utf8(out).unwrap(), "Microsoft Windows\n(c) Microsoft.\nC:\\Users>");
    }

    #[test]
    fn utf8_text_passes_through() {
        let mut f = PrintableFilter::default();
        assert_eq!(f.feed("λ ✓ ❯\n".as_bytes()), "λ ✓ ❯\n".as_bytes());
    }

    #[test]
    fn the_log_is_on_disk_after_each_write_not_at_the_end() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/dir/s.log");
        let mut log = SessionLog::open(&path, LogMode::All).unwrap();
        log.write(b"first\r\n").unwrap();
        // Read back while the log is still open: nothing waits for a close.
        assert_eq!(std::fs::read(&path).unwrap(), b"first\r\n");
        log.write(b"\x1b[31msecond").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first\r\n\x1b[31msecond");
        assert_eq!(log.written(), 18);
    }

    #[test]
    fn an_existing_log_is_appended_to_never_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.log");
        std::fs::write(&path, b"earlier\n").unwrap();
        let mut log = SessionLog::open(&path, LogMode::Printable).unwrap();
        log.write(b"\x1b[0mlater\r\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"earlier\nlater\n");
    }

    #[test]
    fn default_names_are_safe_on_windows_and_sort_by_time() {
        // 2026-09-26 16:20:05 UTC
        let p = default_log_path(Path::new("/logs"), "Corp: Site/1 <core>", 1_790_439_605);
        assert_eq!(p, Path::new("/logs/Corp_ Site_1 _core__2026-09-26_16-20-05.log"));
    }

    #[test]
    fn putty_placeholders_expand_and_relative_names_go_under_the_base() {
        let p = expand_putty_log_name("putty-&H-&P-&Y&M&D-&T.log", "10.0.0.1", 22, 1_790_439_605, Path::new("/home/u"));
        assert_eq!(p, Path::new("/home/u/putty-10.0.0.1-22-20260926-162005.log"));
        let abs = expand_putty_log_name("/var/log/x&&y.log", "h", 22, 0, Path::new("/home/u"));
        assert_eq!(abs, Path::new("/var/log/x&y.log"));
    }
}
