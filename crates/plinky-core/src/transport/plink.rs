use std::io::Write;
use std::path::{Path, PathBuf};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;
use crate::errors::{PlinkyError, Result};
use crate::transport::Transport;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PuttyInfo {
    pub path: Option<String>,
    pub version: Option<String>,
    pub ok: bool,
    pub reason: Option<String>,
}

/// The protocol of an explicit target. GNS3 opens device consoles as
/// `--telnet host port` (a console server's port), so a target isn't
/// always SSH.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetProtocol {
    #[default]
    Ssh,
    Telnet,
    Raw,
}

/// Direct connection target used when a session name doesn't resolve to a
/// persisted PuTTY session file (see spawn_session).
#[derive(Debug, Clone)]
pub struct ExplicitTarget {
    pub hostname: String,
    pub port: u16,
    pub username: Option<String>,
    pub protocol: TargetProtocol,
}

/// A vault password for plink to log in with by itself (SSH only).
pub struct PlinkLogin {
    pub password: crate::vault::SecretString,
    /// Passed as `-l` only when the session has no username of its own.
    pub username: Option<String>,
}

/// How long the password file outlives plink's start. plink reads
/// `-pwfile` while parsing its arguments -- measured: the file deleted
/// 150 ms after launch, plink still sent the password to the server --
/// so a few seconds is a wide margin.
const PWFILE_LIFETIME: std::time::Duration = std::time::Duration::from_secs(5);

/// Writes the password for `-pwfile` to a file only this user can read
/// (tempfile creates it 0600) and returns the guard that deletes it.
fn write_pwfile(password: &crate::vault::SecretString) -> Result<tempfile::NamedTempFile> {
    let mut file = tempfile::Builder::new()
        .prefix(".plinky_login_")
        .tempfile()
        .map_err(|e| PlinkyError::ProcessError(format!("Couldn't create the login file: {e}")))?;
    file.write_all(password.expose_secret().as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.flush())
        .map_err(|e| PlinkyError::ProcessError(format!("Couldn't write the login file: {e}")))?;
    Ok(file)
}

pub struct PlinkTransport {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: super::PtyChild,
    /// Telnet and raw consoles are driven in character mode; see
    /// `LineDiscipline`.
    char_mode: bool,
    /// plink's process id: for reaching its console on Windows, and for
    /// seeing when its connection is up (tcp_state.rs).
    pid: Option<u32>,
    /// Whether the login is over. Until then plink reads whole lines from
    /// its console -- the password, a host-key answer, "Press Return to
    /// begin session" -- and waits for a newline. On Windows,
    /// `prepare_input` switches off processed input (so Ctrl+C and the
    /// arrows reach the device), and without it Enter gives a carriage
    /// return and no newline: plink's line never ended, and an SSH session
    /// took no input at all at "Press Return to begin session" (owner,
    /// v0.1.15). So the console is left as plink set it until the session
    /// has begun. Telnet and raw have no login: begun from the start.
    begun: bool,
    #[cfg(unix)]
    discipline: LineDiscipline,
}

/// Whether a connection should run with plink's local line editing off.
///
/// plink turns local line editing on for telnet and raw until the server
/// negotiates echo, and does it by leaving its pty cooked. Against a console
/// that never negotiates (measured with a bare `Router>` server), that cooked
/// pty held the Up arrow back until Enter, so shell history didn't work, and
/// turned Ctrl+C into SIGINT, which killed plink and dropped the session.
/// PuTTY's "Local line editing: Force off" is the fix people apply there;
/// SSH is left alone because plink's own password and host-key prompts
/// read a line.
pub fn wants_character_mode(saved_protocol: Option<&str>, explicit: Option<TargetProtocol>) -> bool {
    match saved_protocol {
        Some(p) => matches!(p.to_ascii_lowercase().as_str(), "telnet" | "raw"),
        None => matches!(explicit, Some(TargetProtocol::Telnet | TargetProtocol::Raw)),
    }
}

/// What plink asked of its terminal, and what this set after it.
///
/// plink runs telnet and raw consoles with local echo and line editing on
/// until the server negotiates echo, and does it by leaving its pty cooked.
/// Cooked, the pty held the Up arrow back until Enter, turned Ctrl+C into a
/// SIGINT that killed plink, turned Enter into a bare LF (the console got
/// "show vlan\n"), and echoed control keys as ^? ^M ^J ^[[A (e2e suite).
/// So each write takes the pty over: every key goes to plink as typed, and
/// Plinky echoes and ends lines the way PuTTY does when it edits locally.
#[cfg(unix)]
#[derive(Default)]
struct LineDiscipline {
    /// plink wants local echo: the server echoes nothing.
    echo: bool,
    /// plink wants local line editing: the server negotiated no echo, and
    /// PuTTY ends such a line with CR LF. plink sets OPOST with line editing
    /// and clears it without (measured: an IOS-style console offering WILL
    /// ECHO leaves it off, a bare console keeps it on); this never sets it.
    edit: bool,
    /// The (lflag, iflag, oflag) this last set. Anything else is plink's:
    /// it rewrites the modes whenever the server renegotiates.
    set: Option<(libc::tcflag_t, libc::tcflag_t, libc::tcflag_t)>,
    local_echo: LocalEcho,
}

#[cfg(unix)]
fn take_over_line_discipline(fd: std::os::unix::io::RawFd, d: &mut LineDiscipline) {
    // SAFETY: fd is the live pty master owned by this transport; termios is
    // a plain C struct fully written by tcgetattr before it is read.
    unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut t) != 0 || d.set == Some((t.c_lflag, t.c_iflag, t.c_oflag)) {
            return;
        }
        d.echo = t.c_lflag & libc::ECHO != 0;
        d.edit = t.c_oflag & libc::OPOST != 0;
        t.c_lflag &= !(libc::ICANON | libc::ISIG | libc::IEXTEN | libc::ECHO);
        t.c_iflag &= !libc::ICRNL;
        t.c_cc[libc::VMIN] = 1;
        t.c_cc[libc::VTIME] = 0;
        if libc::tcsetattr(fd, libc::TCSANOW, &t) == 0 {
            d.set = Some((t.c_lflag, t.c_iflag, t.c_oflag));
        }
    }
}

/// Echo for a console that echoes nothing, as PuTTY's own line discipline
/// shows it: text as typed, Enter as a new line, Backspace erasing what was
/// typed (never the prompt), other control keys as ^C and the like, and
/// nothing for arrow and function keys, which only move the device's cursor.
#[derive(Default)]
struct LocalEcho {
    /// Characters typed on this line, so Backspace stops at the prompt.
    col: usize,
    /// 0: text; 1: after ESC; 2: inside an escape sequence.
    esc: u8,
    after_cr: bool,
}

impl LocalEcho {
    #[cfg_attr(not(unix), allow(dead_code))]
    fn echo(&mut self, typed: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for &b in typed {
            match self.esc {
                1 => {
                    self.esc = if b == b'[' || b == b'O' { 2 } else { 0 };
                    continue;
                }
                2 => {
                    if (0x40..=0x7e).contains(&b) {
                        self.esc = 0;
                    }
                    continue;
                }
                _ => {}
            }
            let after_cr = std::mem::take(&mut self.after_cr);
            match b {
                0x1b => self.esc = 1,
                b'\n' if after_cr => {}
                b'\r' | b'\n' => {
                    out.extend_from_slice(b"\r\n");
                    self.col = 0;
                    self.after_cr = b == b'\r';
                }
                0x7f | 0x08 => {
                    if self.col > 0 {
                        out.extend_from_slice(b"\x08 \x08");
                        self.col -= 1;
                    }
                }
                b'\t' => {
                    out.push(b);
                    self.col += 1;
                }
                0x00..=0x1f => {
                    out.extend_from_slice(&[b'^', b + 0x40]);
                    self.col += 2;
                }
                // A UTF-8 continuation byte: same character, same column.
                0x80..=0xbf => out.push(b),
                _ => {
                    out.push(b);
                    self.col += 1;
                }
            }
        }
        out
    }
}

/// Enter as PuTTY sends it where it edits the line itself (a server that
/// negotiated no echo): CR LF. PuTTY ends such a line with CR LF on raw
/// and a telnet newline, also CR LF, on telnet. Through plink, raw sends
/// exactly that, and telnet sends CR NUL LF: plink writes every CR as CR NUL
/// (RFC 854), which a telnet server reads back as CR. A CR LF already there
/// is left alone.
#[cfg_attr(not(unix), allow(dead_code))]
fn enter_as_crlf(data: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    if !data.contains(&b'\r') {
        return std::borrow::Cow::Borrowed(data);
    }
    let mut out = Vec::with_capacity(data.len() + 4);
    for (i, &b) in data.iter().enumerate() {
        out.push(b);
        if b == b'\r' && data.get(i + 1) != Some(&b'\n') {
            out.push(b'\n');
        }
    }
    std::borrow::Cow::Owned(out)
}

/// plink.exe's console input, set up the way PuTTY's own window behaves.
///
/// plink.exe always switches its console to ENABLE_PROCESSED_INPUT
/// (windows/plink.c, plink_echoedit_update), and under a pseudo console that
/// turns the Ctrl+C byte into a CTRL_C_EVENT: plink has no handler, so it
/// exits and the session drops -- SSH as much as telnet. That mode also has
/// no ENABLE_VIRTUAL_TERMINAL_INPUT, so keys without a character (the
/// arrows, for shell history) never reach plink. Before each write this
/// attaches to plink's console, clears processed input (and, for telnet and
/// raw, line input and echo, as on Unix), sets VT input, and detaches.
/// A console mode belongs to the console, so plink sees it at once.
#[cfg(windows)]
mod win_console {
    use std::sync::{Mutex, Once};

    const ENABLE_PROCESSED_INPUT: u32 = 0x0001;
    const ENABLE_LINE_INPUT: u32 = 0x0002;
    const ENABLE_ECHO_INPUT: u32 = 0x0004;
    const ENABLE_VIRTUAL_TERMINAL_INPUT: u32 = 0x0200;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_SHARE_READ: u32 = 1;
    const FILE_SHARE_WRITE: u32 = 2;
    const OPEN_EXISTING: u32 = 3;
    const INVALID_HANDLE_VALUE: isize = -1;
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    const ERROR_ACCESS_DENIED: u32 = 5;

    /// What the last setup did, for tests and bug reports: a failure here
    /// is otherwise silent, and a silent failure is what v0.1.7's first CI
    /// run found.
    static LAST: Mutex<String> = Mutex::new(String::new());

    pub fn last_setup() -> String {
        LAST.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn record(what: String) {
        if let Ok(mut s) = LAST.lock() {
            *s = what;
        }
    }

    type Handler = unsafe extern "system" fn(u32) -> i32;

    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(pid: u32) -> i32;
        fn GetLastError() -> u32;
        fn FreeConsole() -> i32;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const core::ffi::c_void,
            disposition: u32,
            flags: u32,
            template: isize,
        ) -> isize;
        fn GetConsoleMode(handle: isize, mode: *mut u32) -> i32;
        fn SetConsoleMode(handle: isize, mode: u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
        fn SetConsoleCtrlHandler(handler: Option<Handler>, add: i32) -> i32;
    }

    /// A process is attached to one console at a time.
    static ATTACH: Mutex<()> = Mutex::new(());
    static HANDLER: Once = Once::new();

    /// While attached, plink's console events reach Plinky too; without a
    /// handler that says "handled", one would end Plinky itself.
    unsafe extern "system" fn swallow(_event: u32) -> i32 {
        1
    }

    pub fn prepare_input(pid: u32, char_mode: bool) {
        HANDLER.call_once(|| {
            // SAFETY: registers a plain function with no captured state.
            unsafe { SetConsoleCtrlHandler(Some(swallow), 1) };
        });
        let _one = ATTACH.lock().unwrap_or_else(|e| e.into_inner());
        let conin: Vec<u16> = "CONIN$\0".encode_utf16().collect();
        // SAFETY: plain Win32 calls; the handle is checked before use and
        // closed, and the console is freed on every path after attaching.
        unsafe {
            // The app has no console. A debug build or a test runner has one,
            // sometimes without a window (so GetConsoleWindow can't tell),
            // and AttachConsole refuses a process that has a console: on CI
            // the keys never reached plink for exactly that reason. On
            // "access denied", leave it for the moment and go back after.
            let mut freed = false;
            if AttachConsole(pid) == 0 {
                let err = GetLastError();
                if err != ERROR_ACCESS_DENIED {
                    record(format!("attach to {pid} failed: error {err}"));
                    return;
                }
                FreeConsole();
                freed = true;
                if AttachConsole(pid) == 0 {
                    let err = GetLastError();
                    AttachConsole(ATTACH_PARENT_PROCESS);
                    record(format!("attach to {pid} failed after freeing own console: error {err}"));
                    return;
                }
            }
            let h = CreateFileW(
                conin.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                core::ptr::null(),
                OPEN_EXISTING,
                0,
                0,
            );
            if h != INVALID_HANDLE_VALUE && h != 0 {
                let mut mode = 0u32;
                if GetConsoleMode(h, &mut mode) == 0 {
                    record(format!("GetConsoleMode failed: error {}", GetLastError()));
                } else {
                    let mut want = (mode & !ENABLE_PROCESSED_INPUT) | ENABLE_VIRTUAL_TERMINAL_INPUT;
                    if char_mode {
                        // Echo is only valid with line input on Windows.
                        want &= !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT);
                    }
                    let set = want == mode || SetConsoleMode(h, want) != 0;
                    let mut now = 0u32;
                    GetConsoleMode(h, &mut now);
                    record(format!(
                        "pid {pid}: mode {mode:#06x} -> wanted {want:#06x}, set {set}, now {now:#06x}{}",
                        if freed { " (own console freed)" } else { "" }
                    ));
                }
                CloseHandle(h);
            } else {
                record(format!("CONIN$ of {pid} did not open: error {}", GetLastError()));
            }
            FreeConsole();
            if freed {
                AttachConsole(ATTACH_PARENT_PROCESS);
            }
        }
    }
}

/// What the last Windows console setup did (empty elsewhere).
pub fn console_setup_report() -> String {
    #[cfg(windows)]
    {
        win_console::last_setup()
    }
    #[cfg(not(windows))]
    {
        String::new()
    }
}

impl PlinkTransport {
    /// Discovers system plink binary according to ADR-002.
    pub fn find_plink_binary() -> Result<PathBuf> {
        #[cfg(not(windows))]
        {
            let candidates = ["/usr/bin/plink", "/usr/local/bin/plink", "/bin/plink"];
            for p in &candidates {
                let path = Path::new(p);
                if path.is_file() {
                    return Ok(path.to_path_buf());
                }
            }
        }

        #[cfg(windows)]
        {
            let candidates = [
                r"C:\Program Files\PuTTY\plink.exe",
                r"C:\Program Files (x86)\PuTTY\plink.exe",
            ];
            for p in &candidates {
                let path = Path::new(p);
                if path.is_file() {
                    return Ok(path.to_path_buf());
                }
            }
        }

        // Fallback to checking PATH
        if let Ok(output) = std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
            .arg(if cfg!(windows) { "plink.exe" } else { "plink" })
            .output()
        {
            if output.status.success() {
                let line = String::from_utf8_lossy(&output.stdout);
                if let Some(first) = line.lines().next() {
                    let p = PathBuf::from(first.trim());
                    if p.is_file() {
                        return Ok(p);
                    }
                }
            }
        }

        Err(PlinkyError::ProcessError(
            "PuTTY 'plink' binary not found. Please install PuTTY (>= 0.75) per ADR-002.".into(),
        ))
    }

    /// Detects PuTTY presence, binary location, and version compliance (>= 0.75).
    pub fn detect_putty() -> PuttyInfo {
        let path = match Self::find_plink_binary() {
            Ok(p) => p,
            Err(e) => {
                return PuttyInfo {
                    path: None,
                    version: None,
                    ok: false,
                    reason: Some(e.to_string()),
                };
            }
        };

        let path_str = path.to_string_lossy().to_string();
        let output = match std::process::Command::new(&path).arg("-V").output() {
            Ok(out) => out,
            Err(e) => {
                return PuttyInfo {
                    path: Some(path_str),
                    version: None,
                    ok: false,
                    reason: Some(format!("Failed to execute plink -V: {e}")),
                };
            }
        };

        let out_str = String::from_utf8_lossy(&output.stdout);
        // Extracts version like "0.85" from output
        let version_regex = regex::Regex::new(r"(\d+\.\d+)").unwrap();
        let version = version_regex
            .find(&out_str)
            .map(|m| m.as_str().to_string());

        let ok = if let Some(ref ver_str) = version {
            if let Ok(ver_float) = ver_str.parse::<f32>() {
                ver_float >= 0.75
            } else {
                false
            }
        } else {
            false
        };

        let reason = if ok {
            None
        } else if version.is_none() {
            Some("Could not parse PuTTY version from plink -V output".to_string())
        } else {
            Some(format!(
                "PuTTY version is below 0.75 minimum floor (found {})",
                version.as_deref().unwrap_or("")
            ))
        };

        PuttyInfo {
            path: Some(path_str),
            version,
            ok,
            reason,
        }
    }

    /// Builds the plink CLI args for a connection, given whether
    /// `session_name` matches a real persisted PuTTY session.
    ///
    /// `explicit_target`, when given, is used whenever `session_name` isn't
    /// a real persisted PuTTY session (Quick Connect and split-pane clones
    /// invent a display name like "Quick (host:port)" or "X (Split)" that
    /// was never written to ~/.putty/sessions). Previously this always ran
    /// `-load <session_name>` regardless -- for those synthetic names, plink
    /// found no matching saved session, ended up with no host configured at
    /// all, and the connection silently went nowhere (looked like a "dummy"
    /// terminal). A real saved session still takes the `-load` path so it
    /// keeps whatever proxy/key/terminal settings it was saved with.
    /// Pulled out as a pure function so the branching is unit-testable
    /// without spawning a real plink process.
    pub fn build_args(
        session_name: &str,
        has_saved_session: bool,
        explicit_target: Option<&ExplicitTarget>,
    ) -> Vec<String> {
        let mut args = Vec::new();

        if has_saved_session {
            // Interactive flags per D8 and PUTTY_WRAPPER_SPEC §4:
            args.push("-load".to_string());
            args.push(session_name.to_string());
            // Note: -agent is intentionally omitted (architecture review):
            // -load already applies the session's own AgentFwd configuration.
        } else if let Some(target) = explicit_target {
            match target.protocol {
                TargetProtocol::Ssh => {
                    if let Some(user) = target.username.as_deref().filter(|u| !u.is_empty()) {
                        args.push(format!("{user}@{}", target.hostname));
                    } else {
                        args.push(target.hostname.clone());
                    }
                }
                // No user@ prefix: a console asks for its own login, if any.
                TargetProtocol::Telnet => {
                    args.push("-telnet".to_string());
                    args.push(target.hostname.clone());
                }
                TargetProtocol::Raw => {
                    args.push("-raw".to_string());
                    args.push(target.hostname.clone());
                }
            }
            args.push("-P".to_string());
            args.push(target.port.to_string());
            // -t is an SSH option (a remote pty); telnet and raw have none.
            if target.protocol != TargetProtocol::Ssh {
                return args;
            }
        } else {
            // No saved session and nothing explicit to connect with -- fall
            // back to -load so plink's own "no hostname specified" error
            // still surfaces through the existing FATAL ERROR handling
            // instead of the process hanging with no target.
            args.push("-load".to_string());
            args.push(session_name.to_string());
        }
        args.push("-t".to_string()); // Force PTY
        args
    }

    /// `-pwfile`/`-l` for automatic login. Put before the target: plink
    /// takes the first non-option argument as the host.
    pub fn login_args(pwfile: &Path, username: Option<&str>) -> Vec<String> {
        let mut args = vec!["-pwfile".to_string(), pwfile.to_string_lossy().into_owned()];
        if let Some(u) = username.filter(|u| !u.is_empty()) {
            args.push("-l".to_string());
            args.push(u.to_string());
        }
        args
    }

    /// Spawns an interactive plink process attached to a new PTY pair.
    ///
    /// With `login`, plink authenticates by itself from a password file
    /// instead of prompting. The password goes only where plink sends it --
    /// the session's own host, after its host key has been checked -- and
    /// is never typed into the terminal, so no prompt text can redirect it.
    pub fn spawn_session(
        session_name: &str,
        explicit_target: Option<&ExplicitTarget>,
        login: Option<&PlinkLogin>,
        cols: u16,
        rows: u16,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
        flow: std::sync::Arc<crate::session::flow::FlowGate>,
    ) -> Result<Self> {
        let plink_bin = Self::find_plink_binary()?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PlinkyError::PtyError(e.to_string()))?;

        let saved = putty_compat::sessions::read_session(session_name).ok();
        let has_saved_session = saved.is_some();
        let char_mode = wants_character_mode(
            saved.as_ref().map(|s| s.protocol.as_str()),
            explicit_target.map(|t| t.protocol),
        );
        let pwfile = login.map(|l| write_pwfile(&l.password)).transpose()?;
        let mut cmd = CommandBuilder::new(plink_bin);
        if let (Some(file), Some(l)) = (&pwfile, login) {
            for arg in Self::login_args(file.path(), l.username.as_deref()) {
                cmd.arg(arg);
            }
        }
        for arg in Self::build_args(session_name, has_saved_session, explicit_target) {
            cmd.arg(arg);
        }

        #[cfg(not(windows))]
        cmd.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PlinkyError::PtyError(e.to_string()))?;

        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PlinkyError::PtyError(e.to_string()))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PlinkyError::PtyError(e.to_string()))?;

        let pid = child.process_id();
        let child = super::pump_pty_child(reader, child, out_tx, flow);

        if let Some(file) = pwfile {
            std::thread::spawn(move || {
                std::thread::sleep(PWFILE_LIFETIME);
                drop(file);
            });
        }

        Ok(Self {
            master: pair.master,
            writer,
            child,
            char_mode,
            pid,
            begun: char_mode,
            #[cfg(unix)]
            discipline: LineDiscipline::default(),
        })
    }
}

impl Transport for PlinkTransport {
    fn process_id(&self) -> Option<u32> {
        self.pid
    }

    fn session_begun(&mut self) {
        self.begun = true;
    }

    fn has_begun(&self) -> bool {
        self.begun
    }

    fn write(&mut self, data: &[u8]) -> Result<()> {
        #[allow(unused_mut)]
        let mut data = std::borrow::Cow::Borrowed(data);
        #[cfg(unix)]
        if self.char_mode {
            if let Some(fd) = self.master.as_raw_fd() {
                take_over_line_discipline(fd, &mut self.discipline);
                if self.discipline.echo {
                    self.child.inject(self.discipline.local_echo.echo(&data));
                }
                if self.discipline.edit {
                    if let std::borrow::Cow::Owned(crlf) = enter_as_crlf(&data) {
                        data = std::borrow::Cow::Owned(crlf);
                    }
                }
            }
        }
        #[cfg(windows)]
        if let (Some(pid), true) = (self.pid, self.begun) {
            win_console::prepare_input(pid, self.char_mode);
        }
        self.writer
            .write_all(&data)
            .map_err(PlinkyError::IoError)?;
        self.writer.flush().map_err(PlinkyError::IoError)?;
        Ok(())
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PlinkyError::PtyError(e.to_string()))?;
        Ok(())
    }

    fn kill(&mut self) -> Result<()> {
        self.child
            .killer
            .kill()
            .map_err(|e| PlinkyError::ProcessError(e.to_string()))?;
        Ok(())
    }

    fn is_alive(&mut self) -> bool {
        self.child.alive.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enter_becomes_crlf_and_everything_else_is_left_alone() {
        assert_eq!(&*enter_as_crlf(b"show vlan\r"), b"show vlan\r\n");
        assert_eq!(&*enter_as_crlf(b"a\rb\r"), b"a\r\nb\r\n");
        // Already a CR LF: not doubled.
        assert_eq!(&*enter_as_crlf(b"a\r\n"), b"a\r\n");
        // No Enter: nothing copied.
        assert!(matches!(enter_as_crlf(b"\x1b[A\x03"), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn login_args_carry_a_file_path_never_the_password() {
        let args = PlinkTransport::login_args(Path::new("/tmp/.plinky_login_x"), Some("admin"));
        assert_eq!(args, vec!["-pwfile", "/tmp/.plinky_login_x", "-l", "admin"]);
        let args = PlinkTransport::login_args(Path::new("/tmp/.plinky_login_x"), Some(""));
        assert_eq!(args, vec!["-pwfile", "/tmp/.plinky_login_x"], "an empty username adds no -l");
    }

    #[test]
    fn saved_session_uses_load_even_with_explicit_target() {
        // A real saved session's -load carries proxy/key/terminal settings
        // an explicit host/port/user pair can't replicate, so it must win
        // whenever the name actually resolves to one on disk.
        let target = ExplicitTarget {
            hostname: "203.0.113.5".to_string(),
            port: 2222,
            username: Some("someone".to_string()),
            protocol: TargetProtocol::Ssh,
        };
        let args = PlinkTransport::build_args("Saved Server", true, Some(&target));
        assert_eq!(args, vec!["-load", "Saved Server", "-t"]);
    }

    #[test]
    fn unsaved_session_with_explicit_target_connects_directly() {
        // Quick Connect / split-pane clones: no ~/.putty/sessions file
        // under this name, but the caller has real host/port/user -- this
        // is the fix for the "dummy server" bug (-load on a name that
        // doesn't exist left plink with no host at all).
        let target = ExplicitTarget {
            hostname: "192.0.2.10".to_string(),
            port: 22,
            username: Some("ops".to_string()),
            protocol: TargetProtocol::Ssh,
        };
        let args = PlinkTransport::build_args("Quick (192.0.2.10:22)", false, Some(&target));
        assert_eq!(args, vec!["ops@192.0.2.10", "-P", "22", "-t"]);
    }

    #[test]
    fn unsaved_session_with_explicit_target_and_no_username() {
        let target = ExplicitTarget {
            hostname: "192.0.2.10".to_string(),
            port: 2200,
            username: None,
            protocol: TargetProtocol::Ssh,
        };
        let args = PlinkTransport::build_args("Quick (192.0.2.10:2200)", false, Some(&target));
        assert_eq!(args, vec!["192.0.2.10", "-P", "2200", "-t"]);
    }

    #[test]
    fn unsaved_session_with_empty_username_omits_user_prefix() {
        let target = ExplicitTarget {
            hostname: "192.0.2.10".to_string(),
            port: 22,
            username: Some(String::new()),
            protocol: TargetProtocol::Ssh,
        };
        let args = PlinkTransport::build_args("Quick (192.0.2.10:22)", false, Some(&target));
        assert_eq!(args, vec!["192.0.2.10", "-P", "22", "-t"]);
    }

    #[test]
    fn unsaved_session_with_no_explicit_target_falls_back_to_load() {
        // Nothing to connect with at all -- still emit -load so plink's own
        // "no hostname specified" error surfaces through the existing
        // FATAL ERROR handling instead of hanging with no target.
        let args = PlinkTransport::build_args("Orphaned Name", false, None);
        assert_eq!(args, vec!["-load", "Orphaned Name", "-t"]);
    }

    #[test]
    fn telnet_target_uses_minus_telnet_and_no_pty_flag() {
        // GNS3: `plinky --telnet 127.0.0.1 5000`. -t is SSH-only, and a
        // user@ prefix means nothing to a console port.
        let target = ExplicitTarget {
            hostname: "127.0.0.1".to_string(),
            port: 5000,
            username: Some("ignored".to_string()),
            protocol: TargetProtocol::Telnet,
        };
        let args = PlinkTransport::build_args("R1", false, Some(&target));
        assert_eq!(args, vec!["-telnet", "127.0.0.1", "-P", "5000"]);
    }

    #[test]
    fn raw_target_uses_minus_raw() {
        let target = ExplicitTarget {
            hostname: "192.0.2.9".to_string(),
            port: 2001,
            username: None,
            protocol: TargetProtocol::Raw,
        };
        let args = PlinkTransport::build_args("console", false, Some(&target));
        assert_eq!(args, vec!["-raw", "192.0.2.9", "-P", "2001"]);
    }

    #[test]
    fn target_protocol_reads_lowercase_names() {
        let p: TargetProtocol = serde_json::from_str("\"telnet\"").unwrap();
        assert_eq!(p, TargetProtocol::Telnet);
        assert_eq!(TargetProtocol::default(), TargetProtocol::Ssh);
    }

    #[test]
    fn only_telnet_and_raw_consoles_run_in_character_mode() {
        // SSH keeps a line-mode pty: plink's password and host-key prompts read a line.
        assert!(wants_character_mode(None, Some(TargetProtocol::Telnet)));
        assert!(wants_character_mode(None, Some(TargetProtocol::Raw)));
        assert!(!wants_character_mode(None, Some(TargetProtocol::Ssh)));
        assert!(!wants_character_mode(None, None));
        // A saved session's own protocol wins over the tab's guess.
        assert!(wants_character_mode(Some("telnet"), Some(TargetProtocol::Ssh)));
        assert!(!wants_character_mode(Some("ssh"), Some(TargetProtocol::Telnet)));
        assert!(!wants_character_mode(Some("serial"), None));
    }
}
