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
    std::thread::spawn(move || {
        if let Ok((mut sock, _)) = listener.accept() {
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
                // Up is sent before Ctrl+C, so Ctrl+C means both are in.
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
    registry.write_input(id, b"\x1b[A").unwrap();
    registry.write_input(id, b"\x03").unwrap();

    let got = tokio::task::spawn_blocking(move || got_rx.recv_timeout(Duration::from_secs(8)).unwrap_or_default())
        .await
        .unwrap();
    let got = telnet_data(&got);
    let up = got.windows(3).any(|w| w == b"\x1b[A" || w == b"\x1bOA");
    assert!(
        up && got.contains(&0x03),
        "Up and Ctrl+C must reach the console without waiting for Enter; got {got:?}"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(registry.is_session_live(id), "Ctrl+C must not kill plink");
    let _ = registry.close_session(id);
}
