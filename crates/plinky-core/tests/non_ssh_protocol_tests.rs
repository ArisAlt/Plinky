//! Network engineers live on Serial / Telnet / Raw sessions (switch
//! consoles, legacy gear). Those protocols have no SSH handshake, so plink
//! never prints the D9 "Access granted" marker. These tests run real plink
//! against a local TCP "device" through a saved PuTTY session. Separate test
//! binary because on Unix it sets PUTTYDIR for the whole process.
use std::io::Write;
use std::net::TcpListener;
use std::time::Duration;
use plinky_core::SessionRegistry;
use putty_compat::sessions::{write_session, PuttySession};
use tokio::sync::{mpsc, Mutex};

// PUTTYDIR is process-global; serialize the tests that set it.
static PUTTYDIR_LOCK: Mutex<()> = Mutex::const_new(());

fn plink_available() -> bool {
    std::process::Command::new("plink").arg("-V").output().is_ok()
}

/// PuTTY for Windows reads saved sessions only from
/// HKCU\Software\SimonTatham\PuTTY\Sessions: no PUTTYDIR, and nothing can
/// point a child plink at another key. So there the test session has to go
/// in the user's real PuTTY key, which is only done on a GitHub Actions
/// runner (its registry is thrown away with the VM). On anyone's own machine
/// the test skips rather than touch their PuTTY sessions.
#[cfg(windows)]
fn can_save_where_plink_looks() -> bool {
    std::env::var_os("GITHUB_ACTIONS").is_some()
}

#[cfg(not(windows))]
fn can_save_where_plink_looks() -> bool {
    true
}

/// A session saved where plink -load finds it, removed again on drop.
struct SavedSession {
    #[cfg(windows)]
    name: String,
    #[cfg(not(windows))]
    _putty_dir: tempfile::TempDir,
}

impl SavedSession {
    fn save(session: &PuttySession) -> Self {
        // No sessions/ subdir created here on purpose: write_session must put
        // the file where real PuTTY (plink -load) looks, $PUTTYDIR/sessions.
        #[cfg(not(windows))]
        let putty_dir = {
            let dir = tempfile::TempDir::new().unwrap();
            std::env::set_var("PUTTYDIR", dir.path());
            dir
        };
        write_session(session).unwrap();
        Self {
            #[cfg(windows)]
            name: session.name.clone(),
            #[cfg(not(windows))]
            _putty_dir: putty_dir,
        }
    }
}

#[cfg(windows)]
impl Drop for SavedSession {
    fn drop(&mut self) {
        let _ = putty_compat::sessions::delete_session(&self.name);
    }
}

async fn device_dump_survives(protocol: &str) {
    if !plink_available() {
        eprintln!("skipping: plink not installed");
        return;
    }
    if !can_save_where_plink_looks() {
        eprintln!("skipping: plink only loads sessions from your real PuTTY registry key; runs on CI only");
        return;
    }
    let _guard = PUTTYDIR_LOCK.lock().await;

    // A "switch" that dumps a running-config far bigger than 8 KiB.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((mut sock, _)) = listener.accept() {
            let mut cfg = String::from("Building configuration...\r\n");
            for i in 0..600 {
                cfg.push_str(&format!("interface GigabitEthernet0/{i}\r\n description uplink-{i}\r\n"));
            }
            cfg.push_str("END_OF_RUNNING_CONFIG\r\nswitch01#");
            let _ = sock.write_all(cfg.as_bytes());
            std::thread::sleep(Duration::from_secs(5));
        }
    });

    // Prefixed so a leftover is obviously a test's (and never a real
    // session) on the one store that isn't a temp dir: Windows' registry.
    let name = format!("plinky-test-switch01-{protocol}-{}", std::process::id());
    let _saved = SavedSession::save(&PuttySession {
        name: name.clone(),
        host_name: "127.0.0.1".into(),
        port_number: port,
        user_name: String::new(),
        protocol: protocol.into(),
        public_key_file: String::new(),
        log_file_name: String::new(),
        extra: Default::default(),
    });

    let registry = SessionRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let id = format!("{protocol}-1");
    registry.create_plink_session(&id, &name, None, None, 80, 24, tx).unwrap();

    let mut buf = Vec::new();
    let deadline = tokio::time::sleep(Duration::from_secs(5));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            chunk = rx.recv() => match chunk {
                Some(c) => {
                    buf.extend_from_slice(&c);
                    if String::from_utf8_lossy(&buf).contains("switch01#") { break; }
                }
                None => break,
            },
            _ = &mut deadline => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    assert!(!text.contains("no valid host name"), "plink couldn't find the saved session");
    assert!(!text.contains("PreAuth buffer exceeded"), "{protocol} session was force-closed mid-output");
    assert!(text.contains("END_OF_RUNNING_CONFIG"), "full device output must arrive (got {} bytes)", buf.len());
    assert!(
        registry.is_session_live(&id),
        "a {protocol} session must be Live so sync broadcast can reach it"
    );
    let _ = registry.close_session(&id);
}

#[tokio::test]
async fn raw_session_survives_large_device_output() {
    device_dump_survives("raw").await;
}

#[tokio::test]
async fn telnet_session_survives_large_device_output() {
    device_dump_survives("telnet").await;
}

/// What a telnet peer typed, without the IAC option commands (IAC WILL 3
/// would otherwise look like a Ctrl+C).
fn telnet_data(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == 255 && i + 1 < raw.len() {
            i += if (251..=254).contains(&raw[i + 1]) { 3 } else { 2 };
            continue;
        }
        out.push(raw[i]);
        i += 1;
    }
    out
}

/// A GNS3-style console that never negotiates echo (a bare `Router>`).
/// plink keeps local line editing on for it, and its pty used to stay
/// cooked: Up was held until Enter (no shell history) and Ctrl+C became a
/// SIGINT that killed plink and dropped the session. Both must now reach
/// the device as typed, and the session must survive.
///
/// On Windows the same keys died another way: plink.exe keeps its console
/// in processed-input mode, so Ctrl+C became a CTRL_C_EVENT that ended it,
/// and without VT input the arrows never reached it at all.
#[tokio::test]
async fn telnet_console_gets_ctrl_c_and_arrows_as_typed() {
    use std::io::Read;
    if !plink_available() {
        eprintln!("skipping: plink not installed");
        return;
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (got_tx, got_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let accepted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let accepted_srv = accepted.clone();
    std::thread::spawn(move || {
        if let Ok((mut sock, _)) = listener.accept() {
            accepted_srv.store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = sock.write_all(b"Router>");
            sock.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
            let mut got = Vec::new();
            let end = std::time::Instant::now() + Duration::from_secs(6);
            let mut buf = [0u8; 256];
            while std::time::Instant::now() < end {
                match sock.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => got.extend_from_slice(&buf[..n]),
                    Err(_) => {}
                }
                // The arrows are sent before Ctrl+C, so Ctrl+C means all are in.
                if telnet_data(&got).contains(&0x03) { break; }
            }
            let _ = got_tx.send(got);
            // Stay connected: a closed socket would end plink by itself.
            std::thread::sleep(Duration::from_secs(3));
        }
    });

    let registry = SessionRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let target = plinky_core::transport::plink::ExplicitTarget {
        hostname: "127.0.0.1".into(),
        port,
        username: None,
        protocol: plinky_core::transport::plink::TargetProtocol::Telnet,
    };
    let id = "gns3-r1";
    registry
        .create_plink_session(id, "R1 (plinky-test, not saved)", Some(target), None, 80, 24, tx)
        .unwrap();
    // Wait for the prompt, so plink has settled its terminal modes.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut seen = Vec::new();
    while !String::from_utf8_lossy(&seen).contains("Router>") {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(c)) => seen.extend_from_slice(&c),
            _ => break,
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Up and Down for history, Right and Left for editing the line.
    for key in [&b"\x1b[A"[..], b"\x1b[B", b"\x1b[C", b"\x1b[D", b"\x03"] {
        registry.write_input(id, key).unwrap();
    }

    let got = tokio::task::spawn_blocking(move || got_rx.recv_timeout(Duration::from_secs(8)).unwrap_or_default())
        .await
        .unwrap();
    let got = telnet_data(&got);
    let arrow = |c: u8| got.windows(3).any(|w| w == [0x1b, b'[', c] || w == [0x1b, b'O', c]);
    let context = format!(
        "console connected: {}; console got {got:?}; plink printed {:?}; console setup: {:?}",
        accepted.load(std::sync::atomic::Ordering::SeqCst),
        String::from_utf8_lossy(&seen),
        plinky_core::transport::plink::console_setup_report(),
    );
    for (c, name) in [(b'A', "Up"), (b'B', "Down"), (b'C', "Right"), (b'D', "Left")] {
        assert!(arrow(c), "{name} must reach the console as typed; {context}");
    }
    assert!(got.contains(&0x03), "Ctrl+C must reach the console; {context}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(registry.is_session_live(id), "Ctrl+C must not kill plink");
    let _ = registry.close_session(id);
}

/// A GNS3 router console sends nothing until something happens on the
/// device: measured on a GNS3 IOS console, 0 bytes in the first 5 s. Plinky
/// waited for output before it stopped showing "Connecting to host:port",
/// so a saved console session looked like it took ~10 s to connect. plink's
/// own socket shows the connection is up while not one byte has arrived.
#[cfg(any(target_os = "linux", windows))]
#[tokio::test]
async fn a_silent_console_is_seen_connected_before_it_prints_anything() {
    use plinky_core::transport::tcp_state::has_established_tcp;
    if !plink_available() {
        eprintln!("skipping: plink not installed");
        return;
    }
    // The router: accepts, then says nothing.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((_sock, _)) = listener.accept() {
            std::thread::sleep(Duration::from_secs(4));
        }
    });

    let registry = SessionRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let target = plinky_core::transport::plink::ExplicitTarget {
        hostname: "127.0.0.1".into(),
        port,
        username: None,
        protocol: plinky_core::transport::plink::TargetProtocol::Telnet,
    };
    let id = "silent-r3";
    registry
        .create_plink_session(id, "R3 (plinky-test, not saved)", Some(target), None, 80, 24, tx)
        .unwrap();
    let pid = registry.process_id(id).expect("plink's process id");

    let started = std::time::Instant::now();
    let mut connected = false;
    while started.elapsed() < Duration::from_secs(3) {
        if has_established_tcp(pid) == Some(true) {
            connected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let took = started.elapsed();
    let mut printed = Vec::new();
    while let Ok(chunk) = rx.try_recv() {
        printed.extend_from_slice(&chunk);
    }
    assert!(connected, "plink's connection was never seen established");
    // No login on a console: its keys are set up from the first one.
    assert_eq!(registry.has_begun(id), Some(true), "a telnet console has no login to wait for");
    assert!(took < Duration::from_secs(1), "seen only after {took:?}");
    // Windows' pseudo-console announces its own modes when plink starts
    // (ESC[?9001h ESC[?1004h, seen on CI): terminal setup, not the device.
    let text = String::from_utf8_lossy(&printed);
    let without_setup = strip_control_sequences(&text);
    assert!(without_setup.trim().is_empty(), "the console printed nothing, yet got {text:?}");
    let _ = registry.close_session(id);
}

/// Text with CSI sequences (ESC [ ... final letter) removed.
#[cfg(any(target_os = "linux", windows))]
fn strip_control_sequences(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() || c == '~' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn pseudo_console_setup_is_not_device_output() {
    // Exactly what Windows CI's plink printed on a silent console.
    assert_eq!(strip_control_sequences("\u{1b}[?9001h\u{1b}[?1004h"), "");
    // A device's own text stays, colours or not.
    assert_eq!(strip_control_sequences("\u{1b}[1mR1#\u{1b}[0m"), "R1#");
}
