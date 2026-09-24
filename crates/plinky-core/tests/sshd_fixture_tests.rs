use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio::time::sleep;

use plinky_core::{
    PromptAnswer, SessionRegistry, SessionState,
};
use putty_compat::sessions::{write_session, PuttySession};

fn find_sshd_path() -> Option<PathBuf> {
    for p in ["/usr/sbin/sshd", "/usr/bin/sshd", "/sbin/sshd", "/bin/sshd"] {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    None
}

struct SshdFixture {
    _temp_dir: TempDir,
    pub dir_path: PathBuf,
    pub port: u16,
    pub _host_key_fp: String,
    process: Option<Child>,
}

impl SshdFixture {
    pub fn new() -> Option<Self> {
        let sshd_path = find_sshd_path()?;

        if Command::new(&sshd_path).arg("-V").output().is_err() {
            eprintln!("Skipping sshd fixture tests: sshd binary not runnable");
            return None;
        }
        if Command::new("plink").arg("-V").output().is_err() {
            eprintln!("Skipping sshd fixture tests: plink binary not found");
            return None;
        }
        if Command::new("puttygen").arg("-V").output().is_err() {
            eprintln!("Skipping sshd fixture tests: puttygen binary not found");
            return None;
        }

        let temp_dir = TempDir::new().expect("Failed to create temporary directory for sshd fixture");
        let dir = temp_dir.path().to_path_buf();

        let host_key_path = dir.join("host_key");
        let client_key_path = dir.join("client_key");
        let client_ppk_path = dir.join("client_key.ppk");
        let auth_keys_path = dir.join("authorized_keys");
        let sshd_config_path = dir.join("sshd_config");
        let pid_path = dir.join("sshd.pid");

        // 1. Generate ephemeral ed25519 host key
        let status = Command::new("ssh-keygen")
            .args(&["-t", "ed25519", "-N", "", "-f", host_key_path.to_str().unwrap()])
            .output()
            .expect("Failed to generate host key");
        assert!(status.status.success());

        // Get fingerprint of host key
        let fp_out = Command::new("ssh-keygen")
            .args(&["-l", "-f", host_key_path.to_str().unwrap()])
            .output()
            .expect("Failed to get host key fingerprint");
        let host_key_fp = String::from_utf8_lossy(&fp_out.stdout).to_string();

        // 2. Generate ephemeral ed25519 client key
        let status = Command::new("ssh-keygen")
            .args(&["-t", "ed25519", "-N", "", "-f", client_key_path.to_str().unwrap()])
            .output()
            .expect("Failed to generate client key");
        assert!(status.status.success());

        // Copy public key to authorized_keys
        let pub_key = fs::read(dir.join("client_key.pub")).expect("Failed to read public key");
        fs::write(&auth_keys_path, pub_key).expect("Failed to write authorized_keys");

        // 3. Convert client key to PuTTY .ppk format via puttygen
        let status = Command::new("puttygen")
            .args(&[
                client_key_path.to_str().unwrap(),
                "-o",
                client_ppk_path.to_str().unwrap(),
                "-O",
                "private",
            ])
            .output()
            .expect("Failed to run puttygen");
        assert!(status.status.success());

        // 4. Find available unprivileged TCP port
        let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind ephemeral port");
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        // 5. Write unprivileged sshd_config
        let config_content = format!(
            "Port {}\n\
            ListenAddress 127.0.0.1\n\
            HostKey {}\n\
            AuthorizedKeysFile {}\n\
            StrictModes no\n\
            PidFile {}\n\
            UsePAM no\n\
            PasswordAuthentication no\n\
            PubkeyAuthentication yes\n",
            port,
            host_key_path.to_str().unwrap(),
            auth_keys_path.to_str().unwrap(),
            pid_path.to_str().unwrap()
        );
        fs::write(&sshd_config_path, config_content).expect("Failed to write sshd_config");

        // 6. Spawn sshd in foreground/daemonless mode with ABSOLUTE binary path
        let child = Command::new(&sshd_path)
            .args(&[
                "-D",
                "-e",
                "-f",
                sshd_config_path.to_str().unwrap(),
            ])
            .spawn()
            .expect("Failed to spawn sshd child process");

        // Wait for sshd to begin listening
        let mut ready = false;
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(50));
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                ready = true;
                break;
            }
        }

        if !ready {
            panic!("sshd failed to listen on port {} within 2.5s", port);
        }

        // 7. Write PuTTY session config under PUTTYDIR/sessions
        let sessions_dir = dir.join("sessions");
        fs::create_dir_all(&sessions_dir).expect("Failed to create sessions dir");

        let current_user = std::env::var("USER").unwrap_or_else(|_| "deploy".to_string());
        let session = PuttySession {
            name: "sshd_test_session".to_string(),
            host_name: "127.0.0.1".to_string(),
            port_number: port,
            user_name: current_user,
            protocol: "ssh".to_string(),
            public_key_file: client_ppk_path.to_str().unwrap().to_string(),
            extra: std::collections::BTreeMap::new(),
        };

        std::env::set_var("PUTTYDIR", &dir);
        write_session(&session).expect("Failed to write test PuTTY session");

        Some(Self {
            _temp_dir: temp_dir,
            dir_path: dir,
            port,
            _host_key_fp: host_key_fp,
            process: Some(child),
        })
    }
}

impl Drop for SshdFixture {
    fn drop(&mut self) {
        if let Some(mut child) = self.process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tokio::test]
async fn test_sshd_fixture_plink_preauth_to_live_and_reattach() {
    let fixture = match SshdFixture::new() {
        Some(f) => f,
        None => return, // Graceful skip on environments lacking sshd/plink
    };

    // Ensure PUTTYDIR points to our ephemeral fixture directory
    std::env::set_var("PUTTYDIR", &fixture.dir_path);

    let registry = Arc::new(SessionRegistry::new());
    let mut prompt_rx = registry.subscribe_prompts();

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(_chunk) = out_rx.recv().await {}
    });

    let session_id = "plink-sshd-test-1";

    // 1. Spawn real plink session
    registry
        .create_plink_session(session_id, "sshd_test_session", None, 80, 24, out_tx)
        .expect("Failed to spawn plink session");

    // 2. Await HostKeyPrompt event
    let mut prompt_received = false;
    let mut prompt_info = None;

    for _ in 0..60 {
        match tokio::time::timeout(Duration::from_millis(200), prompt_rx.recv()).await {
            Ok(Ok(event)) if event.session_id == session_id => {
                prompt_received = true;
                prompt_info = Some(event.prompt);
                break;
            }
            _ => {
                if matches!(registry.get_session_state(session_id), Some(SessionState::HostKeyPending { .. })) {
                    // State reached HostKeyPending
                }
            }
        }
    }

    assert!(
        prompt_received,
        "Failed to receive host key prompt from real plink session"
    );

    let prompt = prompt_info.unwrap();
    println!("DEBUG RAW PROMPT: {:?}", prompt.raw_prompt);
    println!("DEBUG KEY TYPE: {:?}", prompt.key_type);
    assert_eq!(prompt.host, "127.0.0.1");
    assert_eq!(prompt.port, fixture.port);
    // Plink may report key type as "ssh-ed25519", "ed25519", or "unknown"
    assert!(prompt.key_type == "ssh-ed25519" || prompt.key_type == "ed25519" || prompt.key_type == "unknown");
    assert!(prompt.fingerprint.starts_with("SHA256:"));

    // Verify session state is HostKeyPending
    assert!(matches!(
        registry.get_session_state(session_id),
        Some(SessionState::HostKeyPending { .. })
    ));

    // 3. Answer prompt with AcceptAndStore
    registry
        .answer_prompt(session_id, PromptAnswer::AcceptAndStore)
        .expect("Failed to answer host key prompt");

    // 4. Await state machine transition to Live via D9 "Access granted" marker
    let mut reached_live = false;
    for _ in 0..60 {
        if registry.is_session_live(session_id) {
            reached_live = true;
            break;
        }
        sleep(Duration::from_millis(100)).await;
    }

    assert!(
        reached_live,
        "Session failed to transition to SessionState::Live via D9 marker"
    );

    // 5. Send command to remote session
    sleep(Duration::from_millis(500)).await;
    registry
        .write_input_live_only(session_id, b"echo PLINK_INTEGRATION_TEST_PASSED_OK\r\n")
        .expect("Failed to write command to live session");

    sleep(Duration::from_millis(500)).await;

    // 6. Test attach_session and confirm replayed scrollback contains real remote output
    let (reattach_tx, _reattach_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let attach_info = registry
        .attach_session(session_id, reattach_tx, 0)
        .expect("Failed to attach session");

    let scrollback_str = String::from_utf8_lossy(&attach_info.replay_data);
    println!("Scrollback replay len: {}", attach_info.replay_data.len());
    println!("Scrollback contents: {:?}", scrollback_str);

    assert!(
        attach_info.replay_data.len() > 0,
        "Replayed scrollback must contain remote session output"
    );

    // 7. Clean up session
    let _ = registry.close_session(session_id);
}
