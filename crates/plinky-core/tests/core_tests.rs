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
        .create_local_session("test-tab-1", "Local Bash", None, 80, 24, tx)
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
    registry.create_local_session("test-prompt-sess", "Test", None, 80, 24, tx).unwrap();
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
    registry.create_local_session("sess-1", "S1", None, 80, 24, tx1).unwrap();
    registry.create_local_session("sess-2", "S2", None, 80, 24, tx2).unwrap();

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
    let sent = registry.broadcast_sync_input(SyncChannelId::A, b"echo SYNC_TEST\n").unwrap();
    assert_eq!(sent.len(), 1, "Only Live sess-1 should receive broadcast");
    // The ids, not just the count: the UI lights up exactly these panes.
    assert_eq!(sent, vec!["sess-1".to_string()]);

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
    let sent = registry.broadcast_sync_input(SyncChannelId::A, b"ls\n").unwrap();
    assert_eq!(sent.len(), 0, "Protected sessions must not receive broadcast");

    // 3. Emergency disarm: unprotect sess-1, disarm sync router
    registry.set_sync_protected("sess-1", false);
    registry.set_sync_armed(false);
    let sent = registry.broadcast_sync_input(SyncChannelId::A, b"ls\n").unwrap();
    assert_eq!(sent.len(), 0, "Disarmed router must not broadcast");

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
    registry.create_local_session("test-live-only-preauth", "Test", None, 80, 24, tx).unwrap();
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
    registry.create_local_session("test-live-only-hostkey", "Test", None, 80, 24, tx).unwrap();
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
    registry.create_local_session("test-password-typing", "Test", None, 80, 24, tx).unwrap();
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

    registry.create_local_session("sess-a", "A", None, 80, 24, tx1).unwrap();
    registry.create_local_session("sess-b", "B", None, 80, 24, tx2).unwrap();

    registry.set_sync_channel("sess-a", Some(SyncChannelId::A));
    registry.set_sync_channel("sess-b", Some(SyncChannelId::A));

    // sess-b sits at a plain PreAuth password prompt -- not HostKeyPending.
    registry.reset_session_preauth("sess-b").unwrap();

    let sent = registry.broadcast_sync_input(SyncChannelId::A, b"echo SYNC_TEST\n").unwrap();
    assert_eq!(sent.len(), 1, "Only Live sess-a should receive broadcast; PreAuth sess-b must be skipped");

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
    registry.close_session("sess-a").unwrap();
    registry.close_session("sess-b").unwrap();
}

#[tokio::test]
async fn test_sync_input_router_broadcast_all() {
    use plinky_core::sync::SyncChannelId;

    let registry = SessionRegistry::new();
    let (tx1, mut rx1) = mpsc::unbounded_channel();
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    let (tx3, _rx3) = mpsc::unbounded_channel();

    // sess-1 has Channel None
    registry.create_local_session("sess-all-1", "S1", None, 80, 24, tx1).unwrap();
    // sess-2 has Channel A
    registry.create_local_session("sess-all-2", "S2", None, 80, 24, tx2).unwrap();
    registry.set_sync_channel("sess-all-2", Some(SyncChannelId::A));
    // sess-3 is protected
    registry.create_local_session("sess-all-3", "S3", None, 80, 24, tx3).unwrap();
    registry.set_sync_protected("sess-all-3", true);

    // broadcast_sync_all sends to live & unprotected sessions (sess-1 and sess-2)
    let sent = registry.broadcast_sync_all(b"ALL_BROADCAST\n").unwrap();
    assert_eq!(sent.len(), 2, "Both sess-1 and sess-2 should receive ALL broadcast");
    assert_eq!(sent, vec!["sess-all-1".to_string(), "sess-all-2".to_string()], "recipients come back sorted");

    let mut buf1 = Vec::new();
    let timeout1 = tokio::time::sleep(std::time::Duration::from_millis(1000));
    tokio::pin!(timeout1);
    loop {
        tokio::select! {
            Some(chunk) = rx1.recv() => {
                buf1.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&buf1).contains("ALL_BROADCAST") {
                    break;
                }
            }
            _ = &mut timeout1 => break,
        }
    }
    assert!(String::from_utf8_lossy(&buf1).contains("ALL_BROADCAST"));

    let mut buf2 = Vec::new();
    let timeout2 = tokio::time::sleep(std::time::Duration::from_millis(1000));
    tokio::pin!(timeout2);
    loop {
        tokio::select! {
            Some(chunk) = rx2.recv() => {
                buf2.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&buf2).contains("ALL_BROADCAST") {
                    break;
                }
            }
            _ = &mut timeout2 => break,
        }
    }
    assert!(String::from_utf8_lossy(&buf2).contains("ALL_BROADCAST"));

    // Disarming router prevents ALL broadcast
    registry.set_sync_armed(false);
    let sent = registry.broadcast_sync_all(b"NO_SEND\n").unwrap();
    assert_eq!(sent.len(), 0, "Disarmed router must broadcast to 0 sessions");

    registry.close_session("sess-all-1").unwrap();
    registry.close_session("sess-all-2").unwrap();
    registry.close_session("sess-all-3").unwrap();
}

#[tokio::test]
async fn test_sync_input_router_remove_session_purges_protection() {
    let registry = SessionRegistry::new();
    let (tx, _rx) = mpsc::unbounded_channel();

    registry.create_local_session("sess-purge", "S_Purge", None, 80, 24, tx).unwrap();
    registry.set_sync_protected("sess-purge", true);

    // Close session invokes remove_session on router
    registry.close_session("sess-purge").unwrap();

    // Re-create session with same ID, it should not inherit protected status
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    registry.create_local_session("sess-purge", "S_Purge", None, 80, 24, tx2).unwrap();

    let sent = registry.broadcast_sync_all(b"PING\n").unwrap();
    assert_eq!(sent.len(), 1, "Re-created session must not retain stale protected state");

    let mut buf = Vec::new();
    let timeout = tokio::time::sleep(std::time::Duration::from_millis(1000));
    tokio::pin!(timeout);
    loop {
        tokio::select! {
            Some(chunk) = rx2.recv() => {
                buf.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&buf).contains("PING") {
                    break;
                }
            }
            _ = &mut timeout => break,
        }
    }
    assert!(String::from_utf8_lossy(&buf).contains("PING"));

    registry.close_session("sess-purge").unwrap();
}


#[tokio::test]
async fn test_duplicate_session_id_is_refused_and_original_survives() {
    // A second start for an id that's already live used to overwrite the map
    // entry and orphan the first process. It must now be refused, and the
    // original session must keep working.
    let registry = SessionRegistry::new();
    let (tx1, mut rx1) = mpsc::unbounded_channel();
    let (tx2, _rx2) = mpsc::unbounded_channel();

    registry.create_local_session("dup-id", "First", None, 80, 24, tx1).unwrap();
    let second = registry.create_local_session("dup-id", "Second", None, 80, 24, tx2);
    assert!(second.is_err(), "duplicate session id must be refused");
    assert!(second.unwrap_err().to_string().contains("already exists"));

    registry.write_input("dup-id", b"echo STILL_THE_FIRST\n").unwrap();
    let mut buf = Vec::new();
    let timeout = tokio::time::sleep(std::time::Duration::from_millis(1000));
    tokio::pin!(timeout);
    loop {
        tokio::select! {
            Some(chunk) = rx1.recv() => {
                buf.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&buf).contains("STILL_THE_FIRST") { break; }
            }
            _ = &mut timeout => break,
        }
    }
    assert!(
        String::from_utf8_lossy(&buf).contains("STILL_THE_FIRST"),
        "original session must still be wired to its own subscriber"
    );

    registry.close_session("dup-id").unwrap();
}

#[tokio::test]
async fn test_attach_reports_pending_hostkey_prompt() {
    // The prompt event is broadcast once. A view that reattaches later (its
    // tab was in the background) must get the prompt from attach, or the
    // session is stuck: input is blocked and no dialog is showing.
    let registry = SessionRegistry::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    registry.create_local_session("pending-sess", "Test", None, 80, 24, tx).unwrap();
    registry.reset_session_preauth("pending-sess").unwrap();

    let (attach_tx, _attach_rx) = mpsc::unbounded_channel();
    let before = registry.attach_session("pending-sess", attach_tx, 0).unwrap();
    assert!(before.pending_prompt.is_none(), "no prompt before one arrives");

    let prompt_chunk = b"The host key is not cached for this server:\r\n  192.0.2.1 (port 22)\r\nStore key in cache? (y/n, Return cancels connection, i for more info) ";
    registry.simulate_preauth_bytes("pending-sess", prompt_chunk).unwrap();

    let (attach_tx2, _attach_rx2) = mpsc::unbounded_channel();
    let during = registry.attach_session("pending-sess", attach_tx2, 0).unwrap();
    let prompt = during.pending_prompt.expect("attach must surface the pending host-key prompt");
    assert_eq!(prompt.host, "192.0.2.1");

    registry.answer_prompt("pending-sess", PromptAnswer::AcceptAndStore).unwrap();
    registry.close_session("pending-sess").unwrap();
}

#[tokio::test]
async fn test_process_exit_is_reported_to_subscriber() {
    // When the session's process exits on its own (user typed `exit`, or
    // plink quit without a "FATAL ERROR:" line), the reader loop used to end
    // silently: no closed notice, so the tab kept showing as live and
    // keystrokes went nowhere.
    let registry = SessionRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    registry.create_local_session("exit-sess", "Test", None, 80, 24, tx).unwrap();
    // "\r" is what the terminal sends for Enter. A bare "\n" never submits
    // the line to cmd.exe through ConPTY, so on Windows the shell never
    // exited at all.
    registry.write_input("exit-sess", b"exit\r").unwrap();
    let buf = collect_until_closed(&mut rx, 3000).await;
    assert!(
        String::from_utf8_lossy(&buf).contains("[Plinky: Session closed"),
        "process exit must be surfaced; got: {:?}",
        String::from_utf8_lossy(&buf)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn test_exit_is_reported_even_when_the_terminal_never_hits_eof() {
    // On Windows, ConPTY keeps the output pipe open after the child exits,
    // so the reader never saw EOF and a dead shell -- or an SSH session
    // whose plink had quit -- stayed "live" (Windows CI failed on this for
    // every push). The same happens on Unix when something the shell
    // started still holds the terminal: here a disowned sleep. The session
    // must end when its own process does, not when the last descendant
    // lets go.
    let registry = SessionRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    registry.create_local_session("held-sess", "Test", None, 80, 24, tx).unwrap();
    registry.write_input("held-sess", b"sleep 8 & disown; exit\r").unwrap();

    let started = std::time::Instant::now();
    let buf = collect_until_closed(&mut rx, 5000).await;
    assert!(
        String::from_utf8_lossy(&buf).contains("[Plinky: Session closed"),
        "exit hidden while a background job held the terminal; got: {:?}",
        String::from_utf8_lossy(&buf)
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "waited for the background job");
}

async fn collect_until_closed(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>, ms: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    let timeout = tokio::time::sleep(std::time::Duration::from_millis(ms));
    tokio::pin!(timeout);
    loop {
        tokio::select! {
            chunk = rx.recv() => match chunk {
                Some(c) => {
                    buf.extend_from_slice(&c);
                    if String::from_utf8_lossy(&buf).contains("[Plinky: Session closed") { break; }
                }
                None => break,
            },
            _ = &mut timeout => break,
        }
    }
    buf
}

#[tokio::test]
async fn test_paste_paced_sends_lines_in_order_with_delay() {
    use std::sync::{atomic::AtomicBool, Arc};
    let registry = SessionRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    registry.create_local_session("paste-sess", "Test", None, 80, 24, tx).unwrap();

    let started = std::time::Instant::now();
    let mut progress = Vec::new();
    let sent = registry
        .paste_paced(
            "paste-sess",
            "echo PASTE_ONE\necho PASTE_TWO\necho PASTE_THREE\n",
            std::time::Duration::from_millis(100),
            Arc::new(AtomicBool::new(false)),
            |done, total| progress.push((done, total)),
        )
        .await
        .unwrap();
    assert_eq!(sent, 3);
    assert_eq!(progress, vec![(1, 3), (2, 3), (3, 3)]);
    assert!(started.elapsed() >= std::time::Duration::from_millis(200), "two gaps of 100ms between three lines");

    let mut buf = Vec::new();
    let timeout = tokio::time::sleep(std::time::Duration::from_millis(1500));
    tokio::pin!(timeout);
    loop {
        tokio::select! {
            Some(c) = rx.recv() => {
                buf.extend_from_slice(&c);
                if String::from_utf8_lossy(&buf).matches("PASTE_THREE").count() >= 2 { break; }
            }
            _ = &mut timeout => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let one = text.find("PASTE_ONE").expect("line 1 reached the shell");
    let three = text.rfind("PASTE_THREE").expect("line 3 reached the shell");
    assert!(one < three, "lines must arrive in order");
    registry.close_session("paste-sess").unwrap();
}

#[tokio::test]
async fn test_paste_paced_refused_before_live_and_honours_cancel() {
    use std::sync::{atomic::AtomicBool, Arc};
    let registry = SessionRegistry::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    registry.create_local_session("paste-guard", "Test", None, 80, 24, tx).unwrap();

    // Cancelled before start: nothing is sent.
    let sent = registry
        .paste_paced("paste-guard", "a\nb\n", std::time::Duration::ZERO, Arc::new(AtomicBool::new(true)), |_, _| {})
        .await
        .unwrap();
    assert_eq!(sent, 0);

    // At a pre-auth prompt (e.g. a password prompt): refused, so pasted
    // lines can never be submitted as password guesses.
    registry.reset_session_preauth("paste-guard").unwrap();
    let res = registry
        .paste_paced("paste-guard", "line1\nline2\n", std::time::Duration::ZERO, Arc::new(AtomicBool::new(false)), |_, _| {})
        .await;
    assert!(res.is_err(), "paced paste must be refused while not Live");
    registry.close_session("paste-guard").unwrap();
}

#[cfg(unix)] // proves Enter via shell arithmetic, which cmd.exe doesn't have
#[tokio::test]
async fn test_type_secret_reaches_the_session_followed_by_enter() {
    // The vault's "Send password" path: the secret goes from the vault to
    // the session inside the backend, never through the webview.
    let registry = SessionRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    registry.create_local_session("secret-sess", "Test", None, 80, 24, tx).unwrap();
    let secret = plinky_core::SecretString::new("echo PLINKY_SECRET_$((6*7))");
    registry.type_secret("secret-sess", &secret).unwrap();

    // The shell ran it, so it arrived whole and Enter followed it.
    let mut buf = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline && !String::from_utf8_lossy(&buf).contains("PLINKY_SECRET_42") {
        if let Ok(Some(c)) = tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await {
            buf.extend_from_slice(&c);
        }
    }
    assert!(String::from_utf8_lossy(&buf).contains("PLINKY_SECRET_42"), "{:?}", String::from_utf8_lossy(&buf));
    registry.close_session("secret-sess").unwrap();
}

#[tokio::test]
async fn test_type_secret_is_refused_while_a_host_key_is_unanswered() {
    // A password typed into an unanswered "Store key in cache? (y/n)" would
    // be read as the answer; the host-key block must hold for vault sends.
    let registry = SessionRegistry::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    registry.create_local_session("hk-sess", "Test", None, 80, 24, tx).unwrap();
    registry.reset_session_preauth("hk-sess").unwrap();
    let prompt = b"The host key is not cached for this server:\r\n  192.0.2.1 (port 22)\r\nStore key in cache? (y/n, Return cancels connection, i for more info) ";
    registry.simulate_preauth_bytes("hk-sess", prompt).unwrap();

    let res = registry.type_secret("hk-sess", &plinky_core::SecretString::new("y"));
    assert!(res.is_err(), "a vault send must not answer a host-key prompt");
    registry.close_session("hk-sess").unwrap();
}

// Verbatim plink 0.85 host-key prompt tail for a given port.
fn hostkey_prompt(port: u16) -> Vec<u8> {
    format!(
        "The host key is not cached for this server:\r\n  127.0.0.1 (port {port})\r\n\
         The server's ssh-ed25519 key fingerprint is:\r\n  ssh-ed25519 255 SHA256:AAAA{port}\r\n\
         Store key in cache? (y/n, Return cancels connection, i for more info) "
    )
    .into_bytes()
}

#[test]
fn test_a_host_key_prompt_is_announced_once() {
    // Against a real sshd one prompt was announced 92 times: every later
    // chunk re-matched the prompt still sitting in the buffer.
    let mut sm = PreAuthStateMachine::new();
    assert!(matches!(sm.feed_bytes(&hostkey_prompt(22)), PreAuthAction::HostKeyPrompt(_)));
    assert_eq!(sm.feed_bytes(b"more prompt text"), PreAuthAction::Suppress);
    assert_eq!(sm.feed_bytes(b"\r\n"), PreAuthAction::Suppress);
}

#[test]
fn test_after_answering_output_shows_and_a_second_host_key_prompt_is_its_own() {
    // Through a jump host plink asks about the bastion's key, then the
    // target's. The answered prompt used to stay in the buffer: output was
    // hidden and the target's question came back with the bastion's port and
    // fingerprint -- accepting it accepted a key the user never saw.
    let mut sm = PreAuthStateMachine::new();
    match sm.feed_bytes(&hostkey_prompt(50357)) {
        PreAuthAction::HostKeyPrompt(p) => assert_eq!(p.port, 50357),
        other => panic!("{other:?}"),
    }
    sm.prompt_answered();
    assert_eq!(*sm.state(), SessionState::PreAuth);

    match sm.feed_bytes(&hostkey_prompt(39477)) {
        PreAuthAction::HostKeyPrompt(p) => {
            assert_eq!(p.port, 39477, "the target's own prompt, not the bastion's");
            assert!(p.fingerprint.contains("AAAA39477"));
        }
        other => panic!("{other:?}"),
    }
    sm.prompt_answered();

    // A password prompt after the key is accepted reaches the terminal.
    assert_eq!(sm.feed_bytes(b"citizenzero@127.0.0.1's password: "), PreAuthAction::Hold);
}

#[test]
fn test_a_connection_dropped_while_the_dialog_is_open_closes_the_session() {
    let mut sm = PreAuthStateMachine::new();
    sm.feed_bytes(&hostkey_prompt(22));
    assert!(matches!(
        sm.feed_bytes(b"\r\nFATAL ERROR: Remote side unexpectedly closed network connection\r\n"),
        PreAuthAction::Closed(_)
    ));
}

#[tokio::test]
async fn test_the_password_can_be_typed_after_the_host_key_is_accepted() {
    // First connection to a password server: accept the key, then type the
    // password. Typing stayed blocked ("awaiting host key trust approval")
    // because answering never left HostKeyPending.
    let registry = SessionRegistry::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    registry.create_local_session("pw-sess", "Test", None, 80, 24, tx).unwrap();
    registry.reset_session_preauth("pw-sess").unwrap();
    registry.simulate_preauth_bytes("pw-sess", &hostkey_prompt(22)).unwrap();
    assert!(registry.write_input("pw-sess", b"x").is_err(), "blocked while the dialog is up");

    registry.answer_prompt("pw-sess", PromptAnswer::AcceptAndStore).unwrap();
    registry.simulate_preauth_bytes("pw-sess", b"user@host's password: ").unwrap();
    registry.write_input("pw-sess", b"secret\r").expect("the user can type the password");
    assert!(registry.answer_prompt("pw-sess", PromptAnswer::AcceptAndStore).is_err(), "nothing left to answer");
    registry.close_session("pw-sess").unwrap();
}

/// ADR-006: a flood stops at the output window until the page catches up.
/// Without flow control the reader read as fast as `yes` wrote, and a page
/// that couldn't keep up fell behind without limit.
#[cfg(unix)]
#[tokio::test]
async fn a_flood_waits_for_the_page_and_a_detached_tab_runs_free() {
    use plinky_core::session::flow::OUTPUT_WINDOW;
    use std::time::Duration;

    let registry = SessionRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    registry.create_local_session("flood", "Flood", None, 80, 24, tx).unwrap();
    let gate = registry.flow_gate("flood").unwrap();
    registry.write_input("flood", b"yes 0123456789abcdefghijklmnopqrstuvwxyz\n").unwrap();

    // The page receives but never acknowledges.
    async fn drain(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>, for_ms: u64) -> usize {
        let mut n = 0;
        let deadline = tokio::time::sleep(Duration::from_millis(for_ms));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                Some(c) = rx.recv() => n += c.len(),
                _ = &mut deadline => return n,
            }
        }
    }
    let first = drain(&mut rx, 1500).await as u64;
    assert!(first >= OUTPUT_WINDOW / 2, "the flood got going ({first} bytes)");
    // One read past the check at most: the reader charges as it reads.
    assert!(first <= OUTPUT_WINDOW + 4096 + 512, "stopped at the window, got {first}");
    assert_eq!(drain(&mut rx, 500).await, 0, "nothing more until the page acknowledges");

    // The page catches up: more arrives.
    gate.ack(gate.unacked());
    let second = drain(&mut rx, 1000).await as u64;
    assert!(second >= OUTPUT_WINDOW / 2, "an ack let the flood continue ({second} bytes)");

    // The tab leaves the screen: the session keeps running into scrollback.
    registry.detach_session("flood").unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let scrollback = registry.get_scrollback("flood").unwrap().len() as u64;
    assert!(scrollback > 3 * OUTPUT_WINDOW, "a detached tab isn't held to the window ({scrollback} bytes)");
    assert_eq!(gate.unacked(), 0, "and builds up no debt");

    registry.close_session("flood").unwrap();
}


/// Owner request: the session log goes to disk as output arrives, not into
/// the page's memory for a later export. Read the file while the session is
/// still running -- no stop, no close -- and the command's output is there.
#[tokio::test]
async fn a_session_log_is_on_disk_while_the_session_is_still_running() {
    use plinky_core::session::log::LogMode;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("Plinky Logs").join("local.log");
    let registry = SessionRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    registry.create_local_session("log-live", "Local", None, 80, 24, tx).unwrap();
    // Keep the page side drained, as the real page does.
    tokio::spawn(async move { while rx.recv().await.is_some() {} });

    let opened = registry.start_log("log-live", &path, LogMode::Printable).unwrap();
    assert_eq!(opened, path);
    registry.write_input("log-live", b"echo LOG_$((6*7))_MARK\r").unwrap();

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut on_disk = String::new();
    while tokio::time::Instant::now() < deadline {
        on_disk = std::fs::read_to_string(&path).unwrap_or_default();
        if on_disk.contains("LOG_42_MARK") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(on_disk.contains("LOG_42_MARK"), "log so far: {on_disk:?}");
    assert!(!on_disk.contains('\x1b'), "printable mode keeps no escape sequences");
    let (status_path, bytes) = registry.log_status("log-live").unwrap();
    assert_eq!(status_path, path);
    assert!(bytes > 0);

    registry.stop_log("log-live");
    assert!(registry.log_status("log-live").is_none());
    let _ = registry.close_session("log-live");
}
