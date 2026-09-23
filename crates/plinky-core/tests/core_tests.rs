use plinky_core::session::ring_buffer::ScrollbackRingBuffer;
use plinky_core::session::state_machine::{PreAuthStateMachine, SessionState, PreAuthAction, CloseReason};
use plinky_core::session::manager::{SessionRegistry, PromptAnswer};
use tokio::sync::mpsc;

#[test]
fn test_scrollback_ring_buffer_fifo_overflow() {
    let mut ring = ScrollbackRingBuffer::new(10);
    ring.push(b"12345");
    assert_eq!(ring.to_vec(), b"12345");

    ring.push(b"67890");
    assert_eq!(ring.to_vec(), b"1234567890");

    // Overflow by 3 bytes
    ring.push(b"abc");
    assert_eq!(ring.to_vec(), b"4567890abc");
    assert_eq!(ring.len(), 10);
    assert_eq!(ring.total_bytes_written(), 13);
}

#[test]
fn test_scrollback_replay_and_truncation() {
    let mut ring = ScrollbackRingBuffer::new(10);
    ring.push(b"0123456789"); // 10 bytes written, seq: 10
    
    // Exact replay from seq 0 (no truncation yet)
    let (replay, truncated) = ring.get_since(0);
    assert_eq!(replay, b"0123456789");
    assert!(!truncated);

    // Write 5 more bytes -> overflow by 5 bytes
    ring.push(b"abcde"); // total_bytes_written = 15, buffer has b"56789abcde"
    
    // Requesting from seq 0 (which was dropped) -> truncated should be true
    let (replay, truncated) = ring.get_since(0);
    assert_eq!(replay, b"56789abcde");
    assert!(truncated);

    // Requesting from seq 12 (within valid range: index 12 - 5 = 7 -> "cde")
    let (replay, truncated) = ring.get_since(12);
    assert_eq!(replay, b"cde");
    assert!(!truncated);
}

#[test]
fn test_preauth_state_machine_access_granted_marker() {
    let mut sm = PreAuthStateMachine::new();
    assert_eq!(*sm.state(), SessionState::PreAuth);

    // Initial banner chunks held (default-deny per D3)
    let action1 = sm.feed_bytes(b"PuTTY plink connection initializing...\r\n");
    assert_eq!(action1, PreAuthAction::Hold);
    assert_eq!(*sm.state(), SessionState::PreAuth);

    // D9 Access Granted Marker arrives with trailing prompt/shell bytes
    let action2 = sm.feed_bytes(b"Access granted. Press Return to begin session. \r\n");
    match action2 {
        PreAuthAction::TransitionToLive(bytes) => {
            assert_eq!(bytes, b". Press Return to begin session. \r\n");
        }
        _ => panic!("Expected TransitionToLive on 'Access granted' marker"),
    }
    assert_eq!(*sm.state(), SessionState::Live);
    assert!(sm.is_live());

    // Subsequent bytes pass straight through without regex checks
    let action3 = sm.feed_bytes(b"user@host:~$ ls\r\n");
    assert_eq!(action3, PreAuthAction::PassThrough(b"user@host:~$ ls\r\n".to_vec()));
}

#[test]
fn test_preauth_hostkey_prompt_detection_verbatim() {
    let mut sm = PreAuthStateMachine::new();
    // Verbatim plink 0.85 prompt captured empirically in DEEP_DESIGN.md §2
    let prompt_chunk = b"The host key is not cached for this server:\r\n  192.0.2.1 (port 22)\r\nYou have no guarantee that the server is the computer you think it is.\r\nThe server's ssh-ed25519 key fingerprint is:\r\n  ssh-ed25519 255 SHA256:4t7E0k5M2ZgJ9V8W7K6L5X4Y3Z2A1B0C9D8E7F6G5H4\r\nStore key in cache? (y/n, Return cancels connection, i for more info) ";
    let action = sm.feed_bytes(prompt_chunk);

    match action {
        PreAuthAction::HostKeyPrompt(info) => {
            assert_eq!(info.host, "192.0.2.1");
            assert_eq!(info.port, 22);
            assert_eq!(info.key_type, "ssh-ed25519");
            assert!(info.fingerprint.contains("SHA256:4t7E0k5M2ZgJ9V8W7K6L5X4Y3Z2A1B0C9D8E7F6G5H4"));
        }
        _ => panic!("Expected HostKeyPrompt"),
    }

    match sm.state() {
        SessionState::HostKeyPending { prompt } => {
            assert_eq!(prompt.host, "192.0.2.1");
            assert_eq!(prompt.port, 22);
            assert_eq!(prompt.key_type, "ssh-ed25519");
        }
        _ => panic!("Expected SessionState::HostKeyPending"),
    }
}

#[test]
fn test_preauth_buffer_cap_default_deny() {
    let mut sm = PreAuthStateMachine::new();
    let junk = vec![b'X'; 8193];
    let action = sm.feed_bytes(&junk);

    match action {
        PreAuthAction::Closed(CloseReason::Error(msg)) => {
            assert!(msg.contains("PreAuth buffer exceeded 8KiB cap"));
        }
        _ => panic!("Expected Closed(Error) when PreAuth buffer exceeds 8 KiB"),
    }
    assert!(!sm.is_live());
}

#[tokio::test]
async fn test_session_registry_local_pty_lifecycle_and_reattach() {
    let registry = SessionRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel();

    registry
        .create_local_session("test-tab-1", "Local Bash", 80, 24, tx)
        .expect("Failed to spawn local session");

    // Write a simple command to PTY
    registry
        .write_input("test-tab-1", b"echo PLINKY_TEST_OK\n")
        .expect("Failed to write to session");

    // Read response from PTY
    let mut received = Vec::new();
    let timeout = tokio::time::sleep(std::time::Duration::from_millis(500));
    tokio::pin!(timeout);

    loop {
        tokio::select! {
            Some(chunk) = rx.recv() => {
                received.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&received).contains("PLINKY_TEST_OK") {
                    break;
                }
            }
            _ = &mut timeout => {
                break;
            }
        }
    }

    let text = String::from_utf8_lossy(&received);
    assert!(
        text.contains("PLINKY_TEST_OK"),
        "PTY did not echo expected string: {}",
        text
    );

    // Verify resize
    registry.resize("test-tab-1", 120, 40).expect("Resize failed");

    // Test reattach with replay
    let (attach_tx, mut _attach_rx) = mpsc::unbounded_channel();
    let attach_info = registry
        .attach_session("test-tab-1", attach_tx, 0)
        .expect("Reattach failed");
    assert_eq!(attach_info.session_id, "test-tab-1");
    assert!(!attach_info.replay_data.is_empty());
    assert!(String::from_utf8_lossy(&attach_info.replay_data).contains("PLINKY_TEST_OK"));
    assert!(attach_info.is_live);

    // Clean close
    registry.close_session("test-tab-1").expect("Close failed");
}

#[tokio::test]
async fn test_write_input_blocked_during_hostkey_pending() {
    let registry = SessionRegistry::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    registry.create_local_session("test-prompt-sess", "Test", 80, 24, tx).unwrap();
    registry.reset_session_preauth("test-prompt-sess").unwrap();

    // Simulate arriving hostkey prompt
    let prompt_chunk = b"The host key is not cached for this server:\r\n  192.0.2.1 (port 22)\r\nStore key in cache? (y/n, Return cancels connection, i for more info) ";
    let action = registry.simulate_preauth_bytes("test-prompt-sess", prompt_chunk).unwrap();
    assert!(matches!(action, PreAuthAction::HostKeyPrompt(_)));

    // 1. Raw terminal keystroke must be BLOCKED
    let write_res = registry.write_input("test-prompt-sess", b"y\n");
    assert!(write_res.is_err(), "write_input should be rejected while HostKeyPending");
    assert!(write_res.unwrap_err().to_string().contains("Terminal input blocked"));

    // 2. Answering via answer_prompt must SUCCEED
    let answer_res = registry.answer_prompt("test-prompt-sess", PromptAnswer::AcceptAndStore);
    assert!(answer_res.is_ok(), "answer_prompt should succeed");

    registry.close_session("test-prompt-sess").unwrap();
}

#[tokio::test]
async fn test_sync_input_router_d6_safety() {
    use plinky_core::sync::SyncChannelId;

    let registry = SessionRegistry::new();
    let (tx1, mut rx1) = mpsc::unbounded_channel();
    let (tx2, _rx2) = mpsc::unbounded_channel();

    // Spawn 2 sessions
    registry.create_local_session("sess-1", "S1", 80, 24, tx1).unwrap();
    registry.create_local_session("sess-2", "S2", 80, 24, tx2).unwrap();

    // Assign both to Channel A
    registry.set_sync_channel("sess-1", Some(SyncChannelId::A));
    registry.set_sync_channel("sess-2", Some(SyncChannelId::A));

    // Put sess-2 into HostKeyPending state
    registry.reset_session_preauth("sess-2").unwrap();
    let prompt_chunk = b"The host key is not cached for this server:\r\n  192.0.2.1 (port 22)\r\nStore key in cache? (y/n, Return cancels connection, i for more info) ";
    registry.simulate_preauth_bytes("sess-2", prompt_chunk).unwrap();

    // 1. Broadcast on Channel A:
    // sess-1 is Live and receives input.
    // sess-2 is HostKeyPending and is safely filtered by D6 gate (not written to!).
    let count = registry.broadcast_sync_input(SyncChannelId::A, b"echo SYNC_TEST\n").unwrap();
    assert_eq!(count, 1, "Only Live sess-1 should receive broadcast");

    // Verify sess-1 got the bytes
    let mut buf = Vec::new();
    let timeout = tokio::time::sleep(std::time::Duration::from_millis(500));
    tokio::pin!(timeout);
    loop {
        tokio::select! {
            Some(chunk) = rx1.recv() => {
                buf.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&buf).contains("SYNC_TEST") {
                    break;
                }
            }
            _ = &mut timeout => break,
        }
    }
    assert!(String::from_utf8_lossy(&buf).contains("SYNC_TEST"));

    // 2. Protection gate: mark sess-1 as protected -> broadcast receives 0
    registry.set_sync_protected("sess-1", true);
    let count = registry.broadcast_sync_input(SyncChannelId::A, b"ls\n").unwrap();
    assert_eq!(count, 0, "Protected sessions must not receive broadcast");

    // 3. Emergency disarm: unprotect sess-1, disarm sync router
    registry.set_sync_protected("sess-1", false);
    registry.set_sync_armed(false);
    let count = registry.broadcast_sync_input(SyncChannelId::A, b"ls\n").unwrap();
    assert_eq!(count, 0, "Disarmed router must not broadcast");

    registry.close_session("sess-1").unwrap();
    registry.close_session("sess-2").unwrap();
}

// Regression tests for the password-prompt-injection incident: a real SSH
// login had its bash shell-integration bootstrap script submitted to the
// remote server as a series of password guesses because write_input's guard
// only checked for HostKeyPending, never the general PreAuth state a session
// sits in at a password/passphrase prompt.

#[tokio::test]
async fn test_write_input_live_only_blocked_during_plain_preauth() {
    let registry = SessionRegistry::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    registry.create_local_session("test-live-only-preauth", "Test", 80, 24, tx).unwrap();
    registry.reset_session_preauth("test-live-only-preauth").unwrap();

    // Session is in plain PreAuth (e.g. sitting at a remote password prompt),
    // not HostKeyPending. Automated writes must still be rejected.
    let write_res = registry.write_input_live_only("test-live-only-preauth", b"some bootstrap script\n");
    assert!(write_res.is_err(), "write_input_live_only should be rejected during plain PreAuth");
    assert!(write_res.unwrap_err().to_string().contains("not Live yet"));

    registry.close_session("test-live-only-preauth").unwrap();
}

#[tokio::test]
async fn test_write_input_live_only_blocked_during_hostkey_pending() {
    let registry = SessionRegistry::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    registry.create_local_session("test-live-only-hostkey", "Test", 80, 24, tx).unwrap();
    registry.reset_session_preauth("test-live-only-hostkey").unwrap();

    let prompt_chunk = b"The host key is not cached for this server:\r\n  192.0.2.1 (port 22)\r\nStore key in cache? (y/n, Return cancels connection, i for more info) ";
    let action = registry.simulate_preauth_bytes("test-live-only-hostkey", prompt_chunk).unwrap();
    assert!(matches!(action, PreAuthAction::HostKeyPrompt(_)));

    let write_res = registry.write_input_live_only("test-live-only-hostkey", b"injected\n");
    assert!(write_res.is_err(), "write_input_live_only should be rejected during HostKeyPending");

    registry.close_session("test-live-only-hostkey").unwrap();
}

#[tokio::test]
async fn test_write_input_still_allowed_during_plain_preauth_for_password_typing() {
    // This must NOT regress: R3 requires a password prompt to be
    // display-only, with the user typing their own credential directly.
    // write_input (the user's own-keystroke path) must remain permissive
    // during plain PreAuth -- only write_input_live_only tightens to Live.
    let registry = SessionRegistry::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    registry.create_local_session("test-password-typing", "Test", 80, 24, tx).unwrap();
    registry.reset_session_preauth("test-password-typing").unwrap();

    let write_res = registry.write_input("test-password-typing", b"my-actual-password\n");
    assert!(write_res.is_ok(), "write_input must still allow the user's own keystrokes during a password prompt");

    registry.close_session("test-password-typing").unwrap();
}

#[tokio::test]
async fn test_sync_input_router_skips_plain_preauth_not_just_hostkey_pending() {
    use plinky_core::sync::SyncChannelId;

    let registry = SessionRegistry::new();
    let (tx1, mut rx1) = mpsc::unbounded_channel();
    let (tx2, _rx2) = mpsc::unbounded_channel();

    registry.create_local_session("sess-a", "A", 80, 24, tx1).unwrap();
    registry.create_local_session("sess-b", "B", 80, 24, tx2).unwrap();

    registry.set_sync_channel("sess-a", Some(SyncChannelId::A));
    registry.set_sync_channel("sess-b", Some(SyncChannelId::A));

    // sess-b sits at a plain PreAuth password prompt -- not HostKeyPending.
    registry.reset_session_preauth("sess-b").unwrap();

    let count = registry.broadcast_sync_input(SyncChannelId::A, b"echo SYNC_TEST\n").unwrap();
    assert_eq!(count, 1, "Only Live sess-a should receive broadcast; PreAuth sess-b must be skipped");

    let mut buf = Vec::new();
    let timeout = tokio::time::sleep(std::time::Duration::from_millis(500));
    tokio::pin!(timeout);
    loop {
        tokio::select! {
            Some(chunk) = rx1.recv() => {
                buf.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&buf).contains("SYNC_TEST") {
                    break;
                }
            }
            _ = &mut timeout => break,
        }
    }
    assert!(String::from_utf8_lossy(&buf).contains("SYNC_TEST"));

    registry.close_session("sess-a").unwrap();
    registry.close_session("sess-b").unwrap();
}
