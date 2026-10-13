//! Telnet and raw TCP consoles, connected by Thyrion itself.
//!
//! These went through plink, and on Windows plink can't run them. plink.exe
//! reads its keyboard from a console whose mode is its only way to say
//! "echo locally": it sets that mode when a telnet server negotiates echo,
//! and never for a console that negotiates nothing, nor for raw (PuTTY 0.84
//! windows/plink.c: `ldisc_create` makes no `echoedit_update` call). A bare
//! console's mode was then the same as an IOS console's that echoes itself,
//! so Thyrion could not tell them apart, and typing on a ser2net-style
//! console showed nothing at all (e2e suite on a Windows runner: screen
//! empty while the device got "show vlan"). plink.exe also never reports a
//! window size (80x24, whatever the tab), and a Ctrl+Z read from its console
//! ends its input for good. Here the protocol is in reach: echo follows the
//! negotiation, the window size goes out as NAWS, and every byte is sent as
//! typed. Linux uses the same code, so its e2e suite covers it too.
//!
//! Negotiation is PuTTY's active telnet: on connect, offer NAWS and TTYPE,
//! ask the server to echo and to suppress go-ahead. Anything else is refused.

use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::errors::{PlinkyError, Result};
use crate::session::flow::FlowGate;
use crate::transport::plink::{LocalEcho, TargetProtocol};
use crate::transport::Transport;

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_TTYPE: u8 = 24;
const OPT_NAWS: u8 = 31;

const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;

/// How long one address may take to answer a connect. plink leaves it to
/// the system (about 21 s on Windows, over two minutes on Linux); a console
/// that hasn't answered in this long isn't going to.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Set to anything to send telnet and raw through plink as before.
pub const VIA_PLINK_ENV: &str = "THYRION_TELNET_VIA_PLINK";

/// PuTTY's "Local echo" setting (`LocalEcho`: 0 force on, 1 force off,
/// 2 auto, the default).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum EchoSetting {
    #[default]
    Auto,
    On,
    Off,
}

/// Where a telnet or raw session connects, and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetTarget {
    pub host: String,
    pub port: u16,
    /// Raw, when not telnet.
    pub telnet: bool,
    /// What TTYPE reports: the saved session's own, or PuTTY's default.
    pub term_type: String,
    pub echo: EchoSetting,
}

impl NetTarget {
    /// The target for a session that Thyrion connects itself, or `None`
    /// for plink. A saved session decides by its own settings, as `plink
    /// -load` would; otherwise the explicit target does. A saved session
    /// with a proxy stays with plink, which knows how to go through one.
    pub fn for_session(
        saved: Option<&putty_compat::sessions::PuttySession>,
        explicit: Option<&crate::transport::plink::ExplicitTarget>,
    ) -> Option<Self> {
        if std::env::var_os(VIA_PLINK_ENV).is_some() {
            return None;
        }
        if let Some(s) = saved {
            let telnet = match s.protocol.to_ascii_lowercase().as_str() {
                "telnet" => true,
                "raw" => false,
                _ => return None,
            };
            let proxy = s.extra.get("ProxyMethod").map(|m| m.trim()).unwrap_or("0");
            if proxy != "0" && !proxy.is_empty() {
                return None;
            }
            if s.host_name.trim().is_empty() {
                return None;
            }
            let echo = match s.extra.get("LocalEcho").map(|v| v.trim()) {
                Some("0") => EchoSetting::On,
                Some("1") => EchoSetting::Off,
                _ => EchoSetting::Auto,
            };
            let term_type = s.extra.get("TerminalType").map(|t| t.trim()).filter(|t| !t.is_empty()).unwrap_or("xterm");
            return Some(Self {
                host: s.host_name.trim().to_string(),
                port: if s.port_number == 0 { if telnet { 23 } else { 0 } } else { s.port_number },
                telnet,
                term_type: term_type.to_string(),
                echo,
            });
        }
        let t = explicit?;
        let telnet = match t.protocol {
            TargetProtocol::Telnet => true,
            TargetProtocol::Raw => false,
            TargetProtocol::Ssh => return None,
        };
        Some(Self { host: t.hostname.clone(), port: t.port, telnet, term_type: "xterm".into(), echo: EchoSetting::Auto })
    }
}

/// One option's state on one side (a simplified RFC 1143: the "requested"
/// state is what keeps two ends from answering each other forever).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Opt {
    #[default]
    Off,
    Requested,
    On,
}

/// The telnet protocol, without the socket: what came in, and what to say.
#[derive(Debug)]
struct Telnet {
    /// Options this side performs (NAWS, TTYPE, SGA).
    ours: [Opt; 256],
    /// Options the server performs (ECHO, SGA).
    theirs: [Opt; 256],
    cols: u16,
    rows: u16,
    term_type: String,
    parse: Parse,
    sb: Vec<u8>,
    /// The last data byte was a CR: a NUL after it is padding (RFC 854).
    after_cr: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Parse {
    Data,
    Iac,
    Verb(u8),
    Sb,
    SbIac,
}

impl Telnet {
    fn new(cols: u16, rows: u16, term_type: &str) -> Self {
        Self {
            ours: [Opt::Off; 256],
            theirs: [Opt::Off; 256],
            cols,
            rows,
            term_type: term_type.to_string(),
            parse: Parse::Data,
            sb: Vec::new(),
            after_cr: false,
        }
    }

    /// What PuTTY says first.
    fn opening(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        for opt in [OPT_NAWS, OPT_TTYPE, OPT_SGA] {
            self.ours[opt as usize] = Opt::Requested;
            out.extend_from_slice(&[IAC, WILL, opt]);
        }
        for opt in [OPT_ECHO, OPT_SGA] {
            self.theirs[opt as usize] = Opt::Requested;
            out.extend_from_slice(&[IAC, DO, opt]);
        }
        out
    }

    fn we_support(opt: u8) -> bool {
        matches!(opt, OPT_NAWS | OPT_TTYPE | OPT_SGA)
    }

    fn they_may(opt: u8) -> bool {
        matches!(opt, OPT_ECHO | OPT_SGA)
    }

    /// Whether the server echoes what it is sent.
    fn server_echoes(&self) -> bool {
        self.theirs[OPT_ECHO as usize] == Opt::On
    }

    fn naws(&self) -> Vec<u8> {
        let mut out = vec![IAC, SB, OPT_NAWS];
        for b in [self.cols.to_be_bytes(), self.rows.to_be_bytes()].concat() {
            out.push(b);
            // A 255 in the size is data, and doubled like all data.
            if b == IAC {
                out.push(IAC);
            }
        }
        out.extend_from_slice(&[IAC, SE]);
        out
    }

    /// The window changed: the new size, to send if the server asked for it.
    fn resize(&mut self, cols: u16, rows: u16) -> Option<Vec<u8>> {
        if (cols, rows) == (self.cols, self.rows) {
            return None;
        }
        self.cols = cols;
        self.rows = rows;
        (self.ours[OPT_NAWS as usize] == Opt::On).then(|| self.naws())
    }

    /// Splits what the server sent into data for the screen and replies
    /// for the server.
    fn receive(&mut self, input: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut data = Vec::with_capacity(input.len());
        let mut reply = Vec::new();
        for &b in input {
            match self.parse {
                Parse::Data => {
                    if b == IAC {
                        self.parse = Parse::Iac;
                        continue;
                    }
                    if b == 0 && self.after_cr {
                        self.after_cr = false;
                        continue;
                    }
                    self.after_cr = b == b'\r';
                    data.push(b);
                }
                Parse::Iac => {
                    self.parse = match b {
                        IAC => {
                            self.after_cr = false;
                            data.push(IAC);
                            Parse::Data
                        }
                        WILL | WONT | DO | DONT => Parse::Verb(b),
                        SB => {
                            self.sb.clear();
                            Parse::Sb
                        }
                        // GA, NOP, DM, AYT and the rest: nothing to show.
                        _ => Parse::Data,
                    };
                }
                Parse::Verb(verb) => {
                    self.negotiate(verb, b, &mut reply);
                    self.parse = Parse::Data;
                }
                Parse::Sb => {
                    if b == IAC {
                        self.parse = Parse::SbIac;
                    } else if self.sb.len() < 1024 {
                        self.sb.push(b);
                    }
                }
                Parse::SbIac => {
                    if b == SE {
                        self.subnegotiation(&mut reply);
                        self.parse = Parse::Data;
                    } else {
                        if self.sb.len() < 1024 {
                            self.sb.push(b);
                        }
                        self.parse = Parse::Sb;
                    }
                }
            }
        }
        (data, reply)
    }

    fn negotiate(&mut self, verb: u8, opt: u8, reply: &mut Vec<u8>) {
        let i = opt as usize;
        match verb {
            DO if Self::we_support(opt) => {
                if self.ours[i] == Opt::Off {
                    reply.extend_from_slice(&[IAC, WILL, opt]);
                }
                if self.ours[i] != Opt::On {
                    self.ours[i] = Opt::On;
                    if opt == OPT_NAWS {
                        reply.extend_from_slice(&self.naws());
                    }
                }
            }
            DO => reply.extend_from_slice(&[IAC, WONT, opt]),
            DONT => {
                if self.ours[i] == Opt::On {
                    reply.extend_from_slice(&[IAC, WONT, opt]);
                }
                self.ours[i] = Opt::Off;
            }
            WILL if Self::they_may(opt) => {
                if self.theirs[i] == Opt::Off {
                    reply.extend_from_slice(&[IAC, DO, opt]);
                }
                self.theirs[i] = Opt::On;
            }
            WILL => reply.extend_from_slice(&[IAC, DONT, opt]),
            WONT => {
                if self.theirs[i] == Opt::On {
                    reply.extend_from_slice(&[IAC, DONT, opt]);
                }
                self.theirs[i] = Opt::Off;
            }
            _ => {}
        }
    }

    fn subnegotiation(&mut self, reply: &mut Vec<u8>) {
        if self.sb.first() == Some(&OPT_TTYPE) && self.sb.get(1) == Some(&TTYPE_SEND) && self.ours[OPT_TTYPE as usize] == Opt::On {
            reply.extend_from_slice(&[IAC, SB, OPT_TTYPE, TTYPE_IS]);
            reply.extend(self.term_type.bytes().filter(|&b| b != IAC));
            reply.extend_from_slice(&[IAC, SE]);
        }
    }
}

/// What a key press becomes on the wire.
///
/// Enter is CR LF, as PuTTY sends it: on telnet, "Return key sends Telnet
/// New Line" (on by default); on raw, PuTTY's local line editing ends the
/// line that way. A CR LF already there is one Enter, also across writes.
/// On telnet a 255 is data and goes doubled (RFC 854).
#[derive(Debug, Default)]
struct Encoder {
    after_cr: bool,
}

impl Encoder {
    fn encode(&mut self, typed: &[u8], telnet: bool) -> Vec<u8> {
        let mut out = Vec::with_capacity(typed.len() + 4);
        for &b in typed {
            let after_cr = std::mem::take(&mut self.after_cr);
            match b {
                b'\n' if after_cr => {}
                b'\r' => {
                    out.extend_from_slice(b"\r\n");
                    self.after_cr = true;
                }
                IAC if telnet => out.extend_from_slice(&[IAC, IAC]),
                _ => out.push(b),
            }
        }
        out
    }
}

/// Connection progress, for `Transport::connected`.
const CONNECTING: u8 = 0;
const UP: u8 = 1;
const DOWN: u8 = 2;

/// Output to the page: the reader's bytes and the local echo, in order,
/// charged to the flow window like a pty's.
struct Output {
    tx: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    flow: Arc<FlowGate>,
}

impl Output {
    fn send(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let n = bytes.len();
        if let Some(tx) = self.tx.lock().unwrap().as_ref() {
            if tx.send(bytes).is_ok() {
                self.flow.charge(n);
            }
        }
    }

    /// Ends the stream: the session manager reports the session closed.
    fn close(&self) {
        self.tx.lock().unwrap().take();
        self.flow.close();
    }
}

pub struct NetTransport {
    telnet: bool,
    echo: EchoSetting,
    protocol: Option<Arc<Mutex<Telnet>>>,
    writer_tx: std_mpsc::Sender<Vec<u8>>,
    socket: Arc<Mutex<Option<TcpStream>>>,
    state: Arc<AtomicU8>,
    alive: Arc<AtomicBool>,
    output: Arc<Output>,
    local_echo: LocalEcho,
    encoder: Encoder,
}

/// plink's words for a failed connect, so the tab reads the same as before.
fn network_error(e: &std::io::Error) -> String {
    match e.kind() {
        ErrorKind::ConnectionRefused => "Connection refused".into(),
        ErrorKind::TimedOut => "Connection timed out".into(),
        ErrorKind::ConnectionReset => "Connection reset by peer".into(),
        ErrorKind::HostUnreachable => "No route to host".into(),
        ErrorKind::NetworkUnreachable => "Network is unreachable".into(),
        _ => e.to_string(),
    }
}

fn connect(host: &str, port: u16) -> std::result::Result<TcpStream, String> {
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|_| format!("Host does not exist: {host}"))?
        .collect();
    let mut last = format!("Host does not exist: {host}");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(s) => return Ok(s),
            Err(e) => last = format!("Network error: {}", network_error(&e)),
        }
    }
    Err(last)
}

impl NetTransport {
    /// Starts connecting and returns at once; the connect runs on its own
    /// thread, as plink's did in its own process, so a host that never
    /// answers doesn't hold up the tab.
    pub fn connect(
        target: &NetTarget,
        cols: u16,
        rows: u16,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
        flow: Arc<FlowGate>,
    ) -> Self {
        let output = Arc::new(Output { tx: Mutex::new(Some(out_tx)), flow: flow.clone() });
        let protocol = target.telnet.then(|| Arc::new(Mutex::new(Telnet::new(cols, rows, &target.term_type))));
        let (writer_tx, writer_rx) = std_mpsc::channel::<Vec<u8>>();
        let socket = Arc::new(Mutex::new(None::<TcpStream>));
        let state = Arc::new(AtomicU8::new(CONNECTING));
        let alive = Arc::new(AtomicBool::new(true));

        let (host, port) = (target.host.clone(), target.port);
        let (out, proto, sock, st, live, replies) =
            (output.clone(), protocol.clone(), socket.clone(), state.clone(), alive.clone(), writer_tx.clone());
        std::thread::spawn(move || {
            let stream = match connect(&host, port) {
                Ok(s) => s,
                Err(why) => {
                    st.store(DOWN, Ordering::Relaxed);
                    live.store(false, Ordering::Relaxed);
                    out.send(format!("FATAL ERROR: {why}\r\n").into_bytes());
                    out.close();
                    return;
                }
            };
            let _ = stream.set_nodelay(true);
            let (Ok(mut reader), Ok(mut writer)) = (stream.try_clone(), stream.try_clone()) else {
                st.store(DOWN, Ordering::Relaxed);
                live.store(false, Ordering::Relaxed);
                out.close();
                return;
            };
            *sock.lock().unwrap() = Some(stream);
            // Closed before the connect finished.
            if !live.load(Ordering::Relaxed) {
                if let Some(s) = sock.lock().unwrap().as_ref() {
                    let _ = s.shutdown(Shutdown::Both);
                }
                out.close();
                return;
            }
            st.store(UP, Ordering::Relaxed);

            if let Some(p) = &proto {
                let _ = replies.send(p.lock().unwrap().opening());
            }
            // Writes on their own thread: a console that stops reading
            // must not hold the session registry's lock, which every write
            // is made under.
            std::thread::spawn(move || {
                for data in writer_rx {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                }
            });

            let mut buf = [0u8; 4096];
            loop {
                // Don't read while the page is a full window behind (ADR-006):
                // the socket's buffer fills and the device slows down.
                out.flow.wait_for_room();
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => match &proto {
                        Some(p) => {
                            let (data, reply) = p.lock().unwrap().receive(&buf[..n]);
                            // Through the writer, so a reply never lands
                            // in the middle of a key press on the wire.
                            if !reply.is_empty() {
                                let _ = replies.send(reply);
                            }
                            out.send(data);
                        }
                        None => out.send(buf[..n].to_vec()),
                    },
                    Err(e) if e.kind() == ErrorKind::Interrupted => {}
                    Err(e) => {
                        // A drop the user didn't ask for says why, as plink did.
                        if live.load(Ordering::Relaxed) {
                            out.send(format!("\r\nFATAL ERROR: Network error: {}\r\n", network_error(&e)).into_bytes());
                        }
                        break;
                    }
                }
            }
            st.store(DOWN, Ordering::Relaxed);
            live.store(false, Ordering::Relaxed);
            out.close();
        });

        Self {
            telnet: target.telnet,
            echo: target.echo,
            protocol,
            writer_tx,
            socket,
            state,
            alive,
            output,
            local_echo: LocalEcho::default(),
            encoder: Encoder::default(),
        }
    }

    fn echoes_locally(&self) -> bool {
        match self.echo {
            EchoSetting::On => true,
            EchoSetting::Off => false,
            // PuTTY echoes until a telnet server says it will; raw always.
            EchoSetting::Auto => !self.protocol.as_ref().is_some_and(|p| p.lock().unwrap().server_echoes()),
        }
    }
}

impl Transport for NetTransport {
    fn write(&mut self, data: &[u8]) -> Result<()> {
        if !self.alive.load(Ordering::Relaxed) {
            return Err(PlinkyError::ProcessError("The connection is closed".into()));
        }
        if self.echoes_locally() {
            self.output.send(self.local_echo.echo(data));
        }
        let wire = self.encoder.encode(data, self.telnet);
        self.writer_tx
            .send(wire)
            .map_err(|_| PlinkyError::ProcessError("The connection is closed".into()))
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        if let Some(naws) = self.protocol.as_ref().and_then(|p| p.lock().unwrap().resize(cols, rows)) {
            let _ = self.writer_tx.send(naws);
        }
        Ok(())
    }

    fn connected(&self) -> Option<bool> {
        Some(self.state.load(Ordering::Relaxed) == UP)
    }

    fn kill(&mut self) -> Result<()> {
        self.alive.store(false, Ordering::Relaxed);
        if let Some(s) = self.socket.lock().unwrap().as_ref() {
            let _ = s.shutdown(Shutdown::Both);
        }
        // A reader waiting for room must not outlive the connection.
        self.output.flow.close();
        Ok(())
    }

    fn is_alive(&mut self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }
}

impl Drop for NetTransport {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_offers_naws_ttype_sga_and_asks_for_echo_and_sga() {
        let mut t = Telnet::new(80, 24, "xterm");
        assert_eq!(
            t.opening(),
            vec![IAC, WILL, OPT_NAWS, IAC, WILL, OPT_TTYPE, IAC, WILL, OPT_SGA, IAC, DO, OPT_ECHO, IAC, DO, OPT_SGA]
        );
    }

    #[test]
    fn an_ios_console_that_echoes_turns_local_echo_off_and_gets_the_size() {
        // What the e2e stand-in for a GNS3 router sends on connect.
        let mut t = Telnet::new(132, 40, "xterm");
        t.opening();
        let (data, reply) = t.receive(&[IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SGA, IAC, DO, OPT_NAWS]);
        assert!(data.is_empty());
        assert!(t.server_echoes());
        // Answers to our own requests need no reply; the size goes out once.
        assert_eq!(reply, vec![IAC, SB, OPT_NAWS, 0, 132, 0, 40, IAC, SE]);
    }

    #[test]
    fn a_console_that_negotiates_nothing_is_echoed_locally() {
        let mut t = Telnet::new(80, 24, "xterm");
        t.opening();
        let (data, reply) = t.receive(b"\r\nR1>");
        assert_eq!(data, b"\r\nR1>");
        assert!(reply.is_empty());
        assert!(!t.server_echoes());
    }

    #[test]
    fn requests_from_a_server_that_did_not_hear_ours_are_answered_once() {
        let mut t = Telnet::new(80, 24, "xterm");
        let (_, reply) = t.receive(&[IAC, WILL, OPT_ECHO]);
        assert_eq!(reply, vec![IAC, DO, OPT_ECHO]);
        let (_, reply) = t.receive(&[IAC, WILL, OPT_ECHO]);
        assert!(reply.is_empty(), "already on: no answer, or two ends loop");
        let (_, reply) = t.receive(&[IAC, WONT, OPT_ECHO]);
        assert_eq!(reply, vec![IAC, DONT, OPT_ECHO]);
        assert!(!t.server_echoes());
    }

    #[test]
    fn unknown_options_are_refused() {
        let mut t = Telnet::new(80, 24, "xterm");
        let (_, reply) = t.receive(&[IAC, DO, 39, IAC, WILL, 0]);
        assert_eq!(reply, vec![IAC, WONT, 39, IAC, DONT, 0]);
    }

    #[test]
    fn terminal_type_is_sent_when_asked() {
        let mut t = Telnet::new(80, 24, "xterm-256color");
        t.opening();
        let (_, reply) = t.receive(&[IAC, DO, OPT_TTYPE, IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]);
        let mut want = vec![IAC, SB, OPT_TTYPE, TTYPE_IS];
        want.extend_from_slice(b"xterm-256color");
        want.extend_from_slice(&[IAC, SE]);
        assert_eq!(reply, want);
    }

    #[test]
    fn a_resize_is_sent_only_once_naws_is_agreed() {
        let mut t = Telnet::new(80, 24, "xterm");
        t.opening();
        assert_eq!(t.resize(100, 30), None);
        t.receive(&[IAC, DO, OPT_NAWS]);
        assert_eq!(t.resize(100, 30), None, "same size: nothing new to say");
        // 255 columns: the size byte is doubled like any data byte.
        assert_eq!(t.resize(255, 30), Some(vec![IAC, SB, OPT_NAWS, 0, 255, 255, 0, 30, IAC, SE]));
    }

    #[test]
    fn commands_split_across_reads_and_escaped_data_come_out_right() {
        let mut t = Telnet::new(80, 24, "xterm");
        let (a, _) = t.receive(&[b'a', IAC]);
        let (b, reply) = t.receive(&[WILL, OPT_ECHO, b'b', IAC, IAC, b'\r', 0, b'c', IAC, 241]);
        assert_eq!(a, b"a");
        assert_eq!(b, vec![b'b', IAC, b'\r', b'c'], "IAC IAC is a 255, CR NUL is CR, NOP is nothing");
        assert_eq!(reply, vec![IAC, DO, OPT_ECHO]);
    }

    #[test]
    fn enter_goes_as_crlf_once_and_255_is_doubled_on_telnet_only() {
        let mut e = Encoder::default();
        assert_eq!(e.encode(b"show vlan\r", true), b"show vlan\r\n");
        // The LF of a CR LF that arrives in the next write is the same Enter.
        assert_eq!(e.encode(b"\nx", true), b"x");
        assert_eq!(e.encode(b"a\r\nb", true), b"a\r\nb");
        assert_eq!(e.encode(&[0x03, 0x1a, 0x7f], true), vec![0x03, 0x1a, 0x7f], "control keys go as typed");
        assert_eq!(e.encode(&[IAC], true), vec![IAC, IAC]);
        assert_eq!(e.encode(&[IAC], false), vec![IAC]);
    }

    fn saved(protocol: &str, extra: &[(&str, &str)]) -> putty_compat::sessions::PuttySession {
        putty_compat::sessions::PuttySession {
            name: "R1".into(),
            host_name: "192.0.2.1".into(),
            port_number: 2001,
            protocol: protocol.into(),
            extra: extra.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn saved_telnet_and_raw_sessions_connect_natively_unless_they_use_a_proxy() {
        let t = NetTarget::for_session(Some(&saved("telnet", &[("TerminalType", "vt100"), ("LocalEcho", "1")])), None).unwrap();
        assert_eq!((t.host.as_str(), t.port, t.telnet, t.term_type.as_str(), t.echo), ("192.0.2.1", 2001, true, "vt100", EchoSetting::Off));
        assert!(!NetTarget::for_session(Some(&saved("raw", &[])), None).unwrap().telnet);
        assert_eq!(NetTarget::for_session(Some(&saved("telnet", &[("ProxyMethod", "5")])), None), None);
        assert_eq!(NetTarget::for_session(Some(&saved("ssh", &[])), None), None);
    }

    #[test]
    fn an_explicit_console_target_connects_natively_and_ssh_stays_with_plink() {
        use crate::transport::plink::ExplicitTarget;
        let target = |protocol| ExplicitTarget { hostname: "127.0.0.1".into(), port: 5000, username: None, protocol };
        assert!(NetTarget::for_session(None, Some(&target(TargetProtocol::Telnet))).unwrap().telnet);
        assert!(!NetTarget::for_session(None, Some(&target(TargetProtocol::Raw))).unwrap().telnet);
        assert_eq!(NetTarget::for_session(None, Some(&target(TargetProtocol::Ssh))), None);
        // A saved session wins over the explicit target, as with plink -load.
        assert_eq!(NetTarget::for_session(Some(&saved("ssh", &[])), Some(&target(TargetProtocol::Telnet))), None);
    }
}
