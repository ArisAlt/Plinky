mod cli;
#[cfg(unix)]
mod handoff;
mod scripts;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{ipc::{Channel, InvokeResponseBody}, Emitter, Manager, State};
use tokio::sync::Mutex;
use putty_compat::sessions::PuttySession;
use putty_compat::hostkeys::HostKeyEntry;
use putty_compat::ppk::PpkHeader;
use plinky_core::{
    SessionRegistry, PlinkTransport, PuttyInfo, AttachInfo, PromptAnswer,
    SyncChannelId, PsftpClient, SftpFileEntry, Vault, VaultEntry, VaultEntryMeta,
    ShellType, get_bootstrap_script,
};
use tokio::sync::mpsc;


/// Runs blocking work (the registry, the disk, starting a process) off the
/// main thread. Tauri runs a plain `fn` command on the main thread, which on
/// Windows is also the thread that paints the window: reading every saved
/// session from the registry and starting `where` and `plink -V` froze the
/// window at startup and whenever Settings opened (where the theme is
/// changed). Linux never showed it; there the same work is quick.
async fn off_main<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("background task failed: {e}"))
}

/// PuTTY found once is not looked for again: finding it starts two
/// processes, and the title bar and Settings both ask. Not found is asked
/// again, so installing PuTTY while Plinky runs is noticed.
static PUTTY_FOUND: std::sync::OnceLock<PuttyInfo> = std::sync::OnceLock::new();

#[tauri::command]
async fn putty_detect() -> Result<PuttyInfo, String> {
    if let Some(info) = PUTTY_FOUND.get() {
        return Ok(info.clone());
    }
    let info = off_main(PlinkTransport::detect_putty).await?;
    if info.ok {
        let _ = PUTTY_FOUND.set(info.clone());
    }
    Ok(info)
}

#[tauri::command]
async fn list_putty_sessions() -> Result<Vec<PuttySession>, String> {
    off_main(list_putty_sessions_now).await?
}

fn list_putty_sessions_now() -> Result<Vec<PuttySession>, String> {
    let session_refs = putty_compat::sessions::list_sessions()
        .map_err(|e| format!("Failed to list PuTTY sessions: {e}"))?;

    let mut sessions = Vec::new();
    for s_ref in session_refs {
        if let Ok(sess) = putty_compat::sessions::read_session(&s_ref.name) {
            sessions.push(sess);
        }
    }
    Ok(sessions)
}

#[tauri::command]
async fn read_putty_session(name: String) -> Result<PuttySession, String> {
    off_main(move || {
        putty_compat::sessions::read_session(&name)
            .map_err(|e| format!("Failed to read PuTTY session '{name}': {e}"))
    }).await?
}

#[tauri::command]
async fn write_putty_session(session: PuttySession) -> Result<(), String> {
    off_main(move || {
        putty_compat::sessions::write_session(&session)
            .map_err(|e| format!("Failed to write PuTTY session '{}': {e}", session.name))
    }).await?
}

/// Removes a saved session the way PuTTY's own Delete does (registry key on
/// Windows, session file elsewhere). There was no way to delete a session
/// from Plinky, so stale ones piled up forever.
#[tauri::command]
async fn delete_putty_session(name: String) -> Result<(), String> {
    off_main(move || {
        putty_compat::sessions::delete_session(&name)
            .map_err(|e| format!("Failed to delete PuTTY session '{name}': {e}"))
    }).await?
}

/// A folder rename or move: every session's new folder path in one call,
/// saved all or nothing (see `set_session_folders`).
#[tauri::command]
async fn set_session_folders(changes: Vec<(String, String)>) -> Result<(), String> {
    off_main(move || {
        putty_compat::sessions::set_session_folders(&changes)
            .map_err(|e| format!("Failed to move sessions between folders: {e}"))
    }).await?
}

#[tauri::command]
async fn list_putty_hostkeys() -> Result<Vec<HostKeyEntry>, String> {
    off_main(move || {
        putty_compat::hostkeys::list_host_keys()
            .map_err(|e| format!("Failed to read PuTTY hostkeys: {e}"))
    }).await?
}

#[tauri::command]
async fn inspect_ppk(path: String) -> Result<PpkHeader, String> {
    off_main(move || {
        putty_compat::ppk::read_header(std::path::Path::new(&path))
            .map_err(|e| format!("Failed to parse PPK header for '{path}': {e}"))
    }).await?
}

/// Forgets one cached host key (PuTTY's sshhostkeys line, or its registry
/// value on Windows); the next connection to that host asks again.
#[tauri::command]
async fn remove_putty_hostkey(key_type: String, hostname: String, port: u16) -> Result<bool, String> {
    off_main(move || {
        putty_compat::remove_host_key(&key_type, &hostname, port)
            .map_err(|e| format!("Failed to remove the host key for {hostname}:{port}: {e}"))
    }).await?
}

/// Asks for a script to run on a terminal (Run Script).
#[tauri::command]
async fn pick_script_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Run a script on this session")
        .add_filter("Scripts", &["py", "sh", "ps1", "bat", "cmd"])
        .add_filter("All files", &["*"])
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.map_err(|_| "The file dialog closed unexpectedly".to_string())? else {
        return Ok(None);
    };
    Ok(Some(picked.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned()))
}

#[tauri::command]
fn run_script(
    app: tauri::AppHandle,
    registry: State<'_, Arc<SessionRegistry>>,
    session_id: String,
    session_name: String,
    path: String,
) -> Result<(), String> {
    scripts::start(&app, registry.inner().clone(), session_id, session_name, path)
}

#[tauri::command]
fn stop_script(app: tauri::AppHandle, registry: State<'_, Arc<SessionRegistry>>, session_id: String) {
    scripts::stop(&app, &registry, &session_id);
}

/// Asks for a .ppk file. The Host Keys screen's "Inspect .ppk" used a
/// hard-coded example path, so it could never inspect a real key.
#[tauri::command]
async fn pick_ppk_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Inspect a PuTTY private key")
        .add_filter("PuTTY private key", &["ppk"])
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.map_err(|_| "The file dialog closed unexpectedly".to_string())? else {
        return Ok(None);
    };
    Ok(Some(picked.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned()))
}

/// Largest message sent to the page at once.
const COALESCE_MAX: usize = 256 * 1024;

/// While output keeps coming, how often a message goes to the page. Under a
/// flood the PTY hands over reads well under 1 KB, and Tauri delivers each
/// small raw message by evaluating a script in the page: measured in the
/// real app, 0.8 KB messages and 7.6 MB/s. Output after a quiet spell -- a
/// keystroke's echo -- still goes at once.
const BATCH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(4);

/// Hands a session's output to its page as raw bytes (ADR-006). It was a
/// `Channel<Vec<u8>>`, which Tauri serialises as a JSON number array: a 4 KB
/// read became ~14 KB of text to build here and parse in the page.
fn forward_output(mut rx: mpsc::UnboundedReceiver<Vec<u8>>, on_data: Channel) {
    tokio::spawn(async move {
        let mut last_send: Option<tokio::time::Instant> = None;
        while let Some(mut batch) = rx.recv().await {
            // Busy: gather until an interval has passed since the last send.
            if let Some(deadline) = last_send.map(|t| t + BATCH_INTERVAL) {
                while batch.len() < COALESCE_MAX {
                    match tokio::time::timeout_at(deadline, rx.recv()).await {
                        Ok(Some(more)) => batch.extend_from_slice(&more),
                        _ => break,
                    }
                }
            }
            while batch.len() < COALESCE_MAX {
                match rx.try_recv() {
                    Ok(more) => batch.extend_from_slice(&more),
                    Err(_) => break,
                }
            }
            if on_data.send(InvokeResponseBody::Raw(batch)).is_err() {
                break;
            }
            last_send = Some(tokio::time::Instant::now());
        }
    });
}

/// The page finished drawing `bytes` of a session's output (ADR-006). Async
/// so the stream of acks during a flood stays off the main thread.
#[tauri::command]
async fn ack_terminal_output(
    registry: State<'_, Arc<SessionRegistry>>,
    session_id: String,
    bytes: u64,
) -> Result<(), String> {
    registry.ack_output(&session_id, bytes);
    Ok(())
}

/// Sessions whose connection is up (watch_connection), for a page that asks
/// after the event already went by.
#[derive(Default)]
struct ConnectedSessions(std::sync::Mutex<std::collections::HashSet<String>>);

/// Tells the page, as `session:connected`, when a session's TCP connection
/// is up, by watching plink's own socket (tcp_state.rs). A console that
/// prints nothing until something happens on the device otherwise showed
/// "Connecting to host:port" long after it had connected: measured on a
/// GNS3 IOS console, 0 bytes in the first 5 s. Linux and Windows can tell;
/// where it can't be told the watcher stops at once and the page waits for
/// output, as before.
fn watch_connection(app: &tauri::AppHandle, id: String) {
    use plinky_core::transport::tcp_state::has_established_tcp;
    let registry = app.state::<Arc<SessionRegistry>>().inner().clone();
    let Some(pid) = registry.process_id(&id) else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // A connect that fails takes the OS's connect timeout; a session
        // can't still be connecting after two minutes.
        let started = tokio::time::Instant::now();
        let deadline = started + std::time::Duration::from_secs(120);
        while tokio::time::Instant::now() < deadline {
            // Closed or restarted under the same id: this watch is over.
            if registry.process_id(&id) != Some(pid) {
                return;
            }
            // plink exited before it connected (refused, unreachable). A
            // tab behind the front one has no view to hear it, and kept its
            // "connecting" spinner; on Windows the table then showed no
            // rows forever rather than ending this loop.
            if registry.is_session_ended(&id) {
                let _ = app.emit("session:ended", &id);
                return;
            }
            match has_established_tcp(pid) {
                Some(true) => {
                    app.state::<ConnectedSessions>().0.lock().unwrap().insert(id.clone());
                    let _ = app.emit("session:connected", &id);
                    return;
                }
                // Every 10 ms while a connect is still quick; after a second
                // (a slow or unreachable host), every 100 ms: each look reads
                // the system's connection and process tables.
                Some(false) => {
                    let pause = if started.elapsed() < std::time::Duration::from_secs(1) { 10 } else { 100 };
                    tokio::time::sleep(std::time::Duration::from_millis(pause)).await
                }
                None => return,
            }
        }
    });
}

#[tauri::command]
fn is_session_connected(connected: State<'_, ConnectedSessions>, session_id: String) -> bool {
    connected.0.lock().unwrap().contains(&session_id)
}

/// For a page that made its tab after `session:ended` went by: a console
/// refused in milliseconds ends before GNS3's tab exists.
#[tauri::command]
fn is_session_ended(registry: State<'_, Arc<SessionRegistry>>, session_id: String) -> bool {
    registry.is_session_ended(&session_id)
}

/// The tab left the screen. The session keeps running into scrollback and is
/// no longer held to the page's pace; attaching again replays it.
#[tauri::command]
fn detach_terminal_session(
    registry: State<Arc<SessionRegistry>>,
    session_id: String,
) -> Result<(), String> {
    registry
        .detach_session(&session_id)
        .map_err(|e| format!("Failed to detach session: {e}"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_terminal_session(
    app: tauri::AppHandle,
    registry: State<'_, Arc<SessionRegistry>>,
    vault_state: State<'_, VaultState>,
    session_id: String,
    session_name: String,
    is_local: bool,
    cols: u16,
    rows: u16,
    on_data: Channel,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    log_file_name: Option<String>,
    // For a target that isn't a saved session: GNS3 consoles are telnet.
    protocol: Option<plinky_core::transport::plink::TargetProtocol>,
) -> Result<(), String> {
    let putty_log = if is_local || log_file_name.as_deref().is_some_and(|n| !n.is_empty()) {
        None
    } else {
        putty_compat::sessions::read_session(&session_name)
            .ok()
            .and_then(|s| putty_session_log(&s, unix_now()))
    };
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    forward_output(rx, on_data);
    spawn_terminal_session(
        &registry, &vault_state, session_id.clone(), session_name, is_local, cols, rows, tx,
        hostname, port, username, log_file_name, protocol,
    )
    .await?;
    if !is_local {
        watch_connection(&app, session_id.clone());
    }
    if let Some((path, mode)) = putty_log {
        // Opened right after the spawn returns: output from the first few
        // milliseconds can reach the page before the log. A log that can't
        // be opened doesn't stop the session.
        if let Err(e) = registry.start_log(&session_id, &path, mode) {
            eprintln!("plinky: {}", shown(e));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn spawn_terminal_session(
    registry: &SessionRegistry,
    vault_state: &VaultState,
    session_id: String,
    session_name: String,
    is_local: bool,
    cols: u16,
    rows: u16,
    // Where output goes: the page's channel, or nowhere yet for a console
    // started before its tab exists (start_console_session).
    tx: mpsc::UnboundedSender<Vec<u8>>,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    log_file_name: Option<String>,
    protocol: Option<plinky_core::transport::plink::TargetProtocol>,
) -> Result<(), String> {
    // Saved serial sessions open on the native serial transport (ADR-005):
    // plink can't send a Break. Line settings come from the PuTTY file.
    let saved_serial = (!is_local)
        .then(|| putty_compat::sessions::read_session(&session_name).ok())
        .flatten()
        .filter(|s| s.protocol.eq_ignore_ascii_case("serial"));

    if is_local {
        registry
            .create_local_session(&session_id, &session_name, log_file_name, cols, rows, tx)
            .map_err(|e| format!("Failed to create local session: {e}"))
    } else if let Some(sess) = saved_serial {
        // These messages go straight to the terminal ("Failed to open serial
        // line /dev/ttyUSB0: No such file or directory").
        let config = plinky_core::transport::serial::SerialConfig::from_putty_keys(&sess.extra)
            .map_err(shown)?;
        registry
            .create_serial_session(&session_id, &session_name, &config, log_file_name, tx)
            .map_err(shown)
    } else {
        // Quick Connect and split-pane clones invent a display name that was
        // never saved as a real PuTTY session -- pass the actual host/port/
        // username through so plink has somewhere to connect even when
        // there's no ~/.putty/sessions file to -load.
        // SSH logs in by itself when the vault (unlocked) has this
        // session's password: plink reads it from a file, so it goes only to
        // this host, after its key is checked, and is never typed. Telnet
        // and other plink protocols have no -pwfile.
        let saved = putty_compat::sessions::read_session(&session_name).ok();
        let is_ssh = saved
            .as_ref()
            .map(|s| s.protocol.is_empty() || s.protocol.eq_ignore_ascii_case("ssh"))
            .unwrap_or(protocol.unwrap_or_default() == plinky_core::transport::plink::TargetProtocol::Ssh);
        let has_username = match &saved {
            Some(s) => !s.user_name.is_empty(),
            None => username.as_deref().is_some_and(|u| !u.is_empty()),
        };
        // Through a jump host, plink would offer a -pwfile password to the
        // jump host first; answer each host's prompt instead.
        // Through a router or switch's CLI: plink goes to the first device,
        // a script hops from there (a tunnel is refused by NX-OS and IOS).
        if let Some(s) = saved.as_ref() {
            let guard = vault_state.inner.lock().await;
            let plan = cli_jump_plan(guard.as_ref(), s, |n| putty_compat::sessions::read_session(n).ok());
            drop(guard);
            if let Some((first_hop, script)) = plan {
                // Not the saved name: plink must not -load the target.
                let hop_name = format!("{} (via {})", session_name, first_hop.hostname);
                return registry
                    .create_plink_session_with_script(&session_id, &hop_name, first_hop, script, log_file_name, cols, rows, tx)
                    .map_err(|e| format!("Failed to create plink session: {e}"));
            }
        }
        if is_ssh {
            let guard = vault_state.inner.lock().await;
            let jump = match (guard.as_ref(), saved.as_ref()) {
                (Some(v), Some(s)) => jump_credentials_for(v, s, |n| putty_compat::sessions::read_session(n).ok()),
                (None, Some(s)) if s.extra.get("ProxyMethod").is_some_and(|m| m == "6") => {
                    // Locked vault: no -pwfile either, or the final host's
                    // password could still reach the jump host.
                    Some(plinky_core::session::jump_login::JumpCredentials { jump: None, target: None })
                }
                _ => None,
            };
            drop(guard);
            if let Some(credentials) = jump {
                return registry
                    .create_plink_session_with_jump_login(&session_id, &session_name, credentials, log_file_name, cols, rows, tx)
                    .map_err(|e| format!("Failed to create plink session: {e}"));
            }
        }
        let login = if is_ssh {
            let guard = vault_state.inner.lock().await;
            guard
                .as_ref()
                .and_then(|v| find_session_entry(v, &session_name, hostname.as_deref(), username.as_deref()))
                .map(|e| plinky_core::transport::plink::PlinkLogin {
                    password: e.secret.clone(),
                    username: if has_username { None } else { e.username.clone() },
                })
        } else {
            None
        };
        let explicit_target = hostname
            .filter(|h| !h.is_empty())
            .map(|h| plinky_core::transport::plink::ExplicitTarget {
                hostname: h,
                port: port.unwrap_or(22),
                username,
                protocol: protocol.unwrap_or_default(),
            });
        registry
            .create_plink_session_with_login(&session_id, &session_name, explicit_target, login, log_file_name, cols, rows, tx)
            .map_err(|e| format!("Failed to create plink session: {e}"))
    }
}

/// Where a session log is being written, and how much is on disk.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionLogInfo {
    path: String,
    bytes: u64,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Asks where to save the session's log, then writes its output there from
/// now on, as it arrives (on disk, live, not in memory).
/// `None` when the user cancels the dialog.
#[tauri::command]
async fn start_session_log(
    app: tauri::AppHandle,
    registry: State<'_, Arc<SessionRegistry>>,
    session_id: String,
    session_name: String,
    mode: plinky_core::session::log::LogMode,
) -> Result<Option<SessionLogInfo>, String> {
    use tauri_plugin_dialog::DialogExt;
    let dir = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?
        .join("Plinky Logs");
    // The dialog opens in this folder; it has to exist to be offered.
    let _ = std::fs::create_dir_all(&dir);
    let suggested = plinky_core::session::log::default_log_path(&dir, &session_name, unix_now());
    let file_name = suggested.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save session log")
        .add_filter("Log file", &["log", "txt"])
        .set_directory(&dir)
        .set_file_name(&file_name)
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.map_err(|_| "The save dialog closed unexpectedly".to_string())? else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let path = registry.start_log(&session_id, &path, mode).map_err(shown)?;
    Ok(Some(SessionLogInfo { path: path.display().to_string(), bytes: 0 }))
}

#[tauri::command]
fn stop_session_log(registry: State<'_, Arc<SessionRegistry>>, session_id: String) {
    registry.stop_log(&session_id);
}

#[tauri::command]
fn session_log_status(registry: State<'_, Arc<SessionRegistry>>, session_id: String) -> Option<SessionLogInfo> {
    registry
        .log_status(&session_id)
        .map(|(path, bytes)| SessionLogInfo { path: path.display().to_string(), bytes })
}

/// PuTTY's own per-session logging: `LogType` 1 (printable) or 2 (all
/// output) with a `LogFileName`. Plinky parsed the name but never used it:
/// the page passes none, so a session set up to log in PuTTY logged nothing
/// here. Other types (SSH packets, raw) aren't session output; they're off.
fn putty_session_log(saved: &putty_compat::sessions::PuttySession, now: u64) -> Option<(std::path::PathBuf, plinky_core::session::log::LogMode)> {
    use plinky_core::session::log::{expand_putty_log_name, LogMode};
    // Both are saved as plain text (no colour codes in logs). PuTTY's
    // "all output" kept them, and an editor shows them as [01;34m...[0m.
    let mode = match saved.extra.get("LogType").map(String::as_str) {
        Some("1") | Some("2") => LogMode::Printable,
        _ => return None,
    };
    if saved.log_file_name.trim().is_empty() {
        return None;
    }
    let home = std::path::PathBuf::from(plinky_core::sftp::client::PsftpClient::get_local_home_dir());
    Some((expand_putty_log_name(&saved.log_file_name, &saved.host_name, saved.port_number, now, &home), mode))
}

#[tauri::command]
fn attach_terminal_session(
    registry: State<Arc<SessionRegistry>>,
    session_id: String,
    from_seq: usize,
    on_data: Channel,
) -> Result<AttachInfo, String> {
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    forward_output(rx, on_data);

    registry
        .attach_session(&session_id, tx, from_seq)
        .map_err(|e| format!("Failed to attach session: {e}"))
}

#[tauri::command]
fn answer_hostkey_prompt(
    registry: State<Arc<SessionRegistry>>,
    session_id: String,
    answer: String,
) -> Result<(), String> {
    let prompt_answer = match answer.as_str() {
        "store" => PromptAnswer::AcceptAndStore,
        "once" => PromptAnswer::AcceptOnce,
        _ => PromptAnswer::Reject,
    };
    registry
        .answer_prompt(&session_id, prompt_answer)
        .map_err(|e| format!("Failed to answer prompt: {e}"))
}

#[tauri::command]
fn write_terminal_input(
    registry: State<Arc<SessionRegistry>>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    registry
        .write_input(&session_id, &data)
        .map_err(|e| format!("Failed to write input: {e}"))
}

#[tauri::command]
fn resize_terminal(
    registry: State<Arc<SessionRegistry>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    registry
        .resize(&session_id, cols, rows)
        .map_err(|e| format!("Failed to resize terminal: {e}"))
}

#[tauri::command]
fn close_terminal_session(
    registry: State<Arc<SessionRegistry>>,
    connected: State<ConnectedSessions>,
    session_id: String,
) -> Result<(), String> {
    connected.0.lock().unwrap().remove(&session_id);
    registry
        .close_session(&session_id)
        .map_err(|e| format!("Failed to close session: {e}"))
}

#[tauri::command]
fn set_sync_channel(
    registry: State<Arc<SessionRegistry>>,
    session_id: String,
    channel: Option<String>,
) -> Result<(), String> {
    let chan_id = channel.as_deref().and_then(SyncChannelId::parse);
    registry.set_sync_channel(&session_id, chan_id);
    Ok(())
}

#[tauri::command]
fn set_sync_protected(
    registry: State<Arc<SessionRegistry>>,
    session_id: String,
    protected: bool,
) -> Result<(), String> {
    registry.set_sync_protected(&session_id, protected);
    Ok(())
}

#[tauri::command]
fn set_sync_armed(
    registry: State<Arc<SessionRegistry>>,
    armed: bool,
) -> Result<(), String> {
    registry.set_sync_armed(armed);
    Ok(())
}

#[tauri::command]
fn broadcast_sync_input(
    registry: State<Arc<SessionRegistry>>,
    channel: String,
    data: Vec<u8>,
) -> Result<Vec<String>, String> {
    // The recipients' ids, not a count: the UI lights up exactly the panes
    // that received the command (T-012).
    if channel.eq_ignore_ascii_case("all") {
        registry
            .broadcast_sync_all(&data)
            .map_err(|e| format!("Failed to broadcast sync input: {e}"))
    } else {
        let chan_id = SyncChannelId::parse(&channel)
            .ok_or_else(|| format!("Invalid sync channel '{channel}'"))?;
        registry
            .broadcast_sync_input(chan_id, &data)
            .map_err(|e| format!("Failed to broadcast sync input: {e}"))
    }
}

/// A backend error as the UI shows it. PlinkyError's Display prefixes
/// "Process error:", which buried messages meant for the user -- and the
/// "[password]"/"[hostkey]" tags the SFTP pane acts on.
fn shown(e: plinky_core::errors::PlinkyError) -> String {
    match e {
        plinky_core::errors::PlinkyError::ProcessError(msg) => msg,
        other => other.to_string(),
    }
}

/// The vault entry names that hold a session's password, best first. An
/// explicit link from the session editor (PlinkyVaultKey) wins. After it
/// come the names the Vault screen itself suggests for a key --
/// "session:prod-web or server.internal". Nothing used to honour those:
/// an entry saved as "session:Server 2" or "192.0.2.10" was ignored, so
/// SFTP asked for a password and the terminal never offered the vault.
fn vault_key_candidates(
    session_name: &str,
    explicit: Option<&str>,
    host: Option<&str>,
    user: Option<&str>,
) -> Vec<String> {
    let mut keys = Vec::new();
    let mut push = |k: String| {
        if !k.is_empty() && !keys.contains(&k) {
            keys.push(k);
        }
    };
    if let Some(k) = explicit {
        push(k.to_string());
    }
    push(format!("session:{session_name}"));
    push(session_name.to_string());
    if let Some(h) = host.filter(|h| !h.is_empty()) {
        if let Some(u) = user.filter(|u| !u.is_empty()) {
            push(format!("{u}@{h}"));
        }
        push(h.to_string());
    }
    keys
}

/// The vault entry for a session, if the vault is unlocked and has one.
/// A saved session's own host and user are used (it connects with -load
/// to that host), otherwise the ones the caller passes (Quick Connect).
fn find_session_entry<'v>(
    vault: &'v Vault,
    session_name: &str,
    hostname: Option<&str>,
    username: Option<&str>,
) -> Option<&'v VaultEntry> {
    let saved = putty_compat::sessions::read_session(session_name).ok();
    find_session_entry_for(vault, saved.as_ref(), session_name, hostname, username)
}

/// [`find_session_entry`] given the saved session (if any) instead of
/// reading it: the test runs on Windows too, where sessions live in the
/// registry and a file under PUTTYDIR is never read.
fn find_session_entry_for<'v>(
    vault: &'v Vault,
    saved: Option<&putty_compat::sessions::PuttySession>,
    session_name: &str,
    hostname: Option<&str>,
    username: Option<&str>,
) -> Option<&'v VaultEntry> {
    let (explicit, host, user) = match saved {
        Some(s) => (
            s.extra.get("PlinkyVaultKey").map(String::as_str),
            Some(s.host_name.as_str()),
            Some(s.user_name.as_str()),
        ),
        None => (None, hostname, username),
    };
    vault_key_candidates(session_name, explicit, host, user)
        .iter()
        .find_map(|k| vault.get_entry(k))
}

/// For a saved session through PuTTY's SSH proxy (`ProxyMethod=6`): the
/// vault logins for the jump host and the final host, answered at their
/// prompts by `plinky_core::session::jump_login`. `None` when the session
/// has no such jump host.
///
/// The jump host is `ProxyHost`, which PuTTY also accepts as the name of a
/// saved session: then that session's host, port and user apply (unless
/// `ProxyUsername` overrides the user), and so does its vault entry.
/// Otherwise the jump entry is `PlinkyJumpVaultKey`, then `jump:<session>`,
/// `<user>@<host>`, `<host>`.
///
/// A login needs a user name: without one plink asks "login as:", which
/// this doesn't answer, so that side is left to the user.
fn jump_credentials_for(
    vault: &Vault,
    saved: &putty_compat::sessions::PuttySession,
    read: impl Fn(&str) -> Option<putty_compat::sessions::PuttySession>,
) -> Option<plinky_core::session::jump_login::JumpCredentials> {
    use plinky_core::session::jump_login::{JumpCredentials, Login};
    if saved.extra.get("ProxyMethod").map(String::as_str) != Some("6") {
        return None;
    }
    let (host, port, user, entry) = jump_host_of(Some(vault), saved, &read)?;
    let jump = entry.filter(|_| !user.is_empty()).map(|e| Login {
        user,
        host,
        port,
        password: e.secret.clone(),
    });

    let target = find_session_entry_for(vault, Some(saved), &saved.name, None, None)
        .filter(|_| !saved.user_name.is_empty())
        .map(|e| Login {
            user: saved.user_name.clone(),
            host: saved.host_name.clone(),
            port: saved.port_number,
            password: e.secret.clone(),
        });
    Some(JumpCredentials { jump, target })
}

/// The jump host a session names (`ProxyHost`, or a saved session by that
/// name), its port, user, and vault entry if the vault is open.
fn jump_host_of<'v>(
    vault: Option<&'v Vault>,
    saved: &putty_compat::sessions::PuttySession,
    read: &impl Fn(&str) -> Option<putty_compat::sessions::PuttySession>,
) -> Option<(String, u16, String, Option<&'v plinky_core::vault::VaultEntry>)> {
    let extra = |k: &str| saved.extra.get(k).map(String::as_str).unwrap_or("");
    if extra("ProxyHost").is_empty() {
        return None;
    }
    let proxy_host = extra("ProxyHost");
    let proxy_user = extra("ProxyUsername");

    Some(match read(proxy_host) {
        Some(preset) => {
            let user = if proxy_user.is_empty() { preset.user_name.clone() } else { proxy_user.to_string() };
            let entry = vault.and_then(|v| find_session_entry_for(v, Some(&preset), &preset.name, None, None));
            (preset.host_name.clone(), preset.port_number, user, entry)
        }
        None => {
            let explicit = Some(extra("PlinkyJumpVaultKey")).filter(|k| !k.is_empty());
            let keys = vault_key_candidates(&format!("jump:{}", saved.name), explicit, Some(proxy_host), Some(proxy_user));
            // vault_key_candidates adds "session:jump:<name>" and the bare
            // name too; harmless, nothing else is stored under them.
            let entry = vault.and_then(|v| keys.iter().find_map(|k| v.get_entry(k)));
            let port = extra("ProxyPort").parse().unwrap_or(22);
            (proxy_host.to_string(), port, proxy_user.to_string(), entry)
        }
    })
}

/// The hop command for a jump through a device's CLI, NX-OS style by
/// default: IOS wants `ssh -l {user} {host}`.
pub const DEFAULT_HOP_COMMAND: &str = "ssh {user}@{host}";

/// A session that goes through a router or switch's CLI instead of a
/// tunnel (`PlinkyJumpMode=cli`): where plink connects (the first device)
/// and the script that logs in and hops (see plinky_core::session::expect).
/// A locked vault still hops: only the passwords are left to the user.
fn cli_jump_plan(
    vault: Option<&Vault>,
    saved: &putty_compat::sessions::PuttySession,
    read: impl Fn(&str) -> Option<putty_compat::sessions::PuttySession>,
) -> Option<(plinky_core::transport::plink::ExplicitTarget, plinky_core::session::expect::Expect)> {
    use plinky_core::session::expect::{cli_prompt, hop_command, hop_failures, password_prompt, Expect, Reply, Step};
    if saved.extra.get("PlinkyJumpMode").map(String::as_str) != Some("cli") {
        return None;
    }
    let (host, port, user, entry) = jump_host_of(vault, saved, &read)?;
    let first_hop = plinky_core::transport::plink::ExplicitTarget {
        hostname: host,
        port,
        username: Some(user).filter(|u| !u.is_empty()),
        protocol: plinky_core::transport::plink::TargetProtocol::Ssh,
    };
    let template = saved
        .extra
        .get("PlinkyJumpCommand")
        .map(String::as_str)
        .filter(|c| !c.trim().is_empty())
        .unwrap_or(DEFAULT_HOP_COMMAND);
    let command = hop_command(template, &saved.user_name, &saved.host_name, saved.port_number);
    let target_entry = vault.and_then(|v| find_session_entry_for(v, Some(saved), &saved.name, None, None));

    let mut steps = Vec::new();
    if let Some(e) = entry {
        steps.push(Step { expect: password_prompt(), reply: Reply::Secret(e.secret.clone()), label: "jump password" });
    }
    steps.push(Step { expect: cli_prompt(), reply: Reply::Line(command), label: "hop command" });
    if let Some(e) = target_entry {
        steps.push(Step { expect: password_prompt(), reply: Reply::Secret(e.secret.clone()), label: "target password" });
    }
    Some((first_hop, Expect::new(steps, hop_failures())))
}

/// What the terminal needs to offer the vault: which entry (never its
/// secret) and whether the vault is locked.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultLookup {
    locked: bool,
    key: Option<String>,
    has_enable_secret: bool,
    /// The entry's username (not a secret), for Telnet/serial login prompts.
    username: Option<String>,
    /// Session opt-ins, from the session file.
    auto_login: bool,
    auto_enable: bool,
}

#[tauri::command]
async fn vault_lookup(
    vault_state: State<'_, VaultState>,
    session_name: String,
    hostname: Option<String>,
    username: Option<String>,
) -> Result<VaultLookup, String> {
    let flag = |k: &str| {
        putty_compat::sessions::read_session(&session_name)
            .map(|s| s.extra.get(k).is_some_and(|v| v == "1"))
            .unwrap_or(false)
    };
    let (auto_login, auto_enable) = (flag("PlinkyAutoLogin"), flag("PlinkyAutoEnable"));
    let guard = vault_state.inner.lock().await;
    let Some(vault) = guard.as_ref() else {
        return Ok(VaultLookup {
            locked: true, key: None, has_enable_secret: false, username: None, auto_login, auto_enable,
        });
    };
    let entry = find_session_entry(vault, &session_name, hostname.as_deref(), username.as_deref());
    Ok(VaultLookup {
        locked: false,
        key: entry.map(|e| e.id.clone()),
        has_enable_secret: entry
            .and_then(|e| e.enable_secret.as_ref())
            .is_some_and(|s| !s.expose_secret().is_empty()),
        username: entry.and_then(|e| e.username.clone()),
        auto_login,
        auto_enable,
    })
}

/// Where an SFTP call goes and the password it uses. A password typed into
/// the SFTP pane wins; otherwise the session's vault entry is read here, in
/// the backend, so the secret never passes through the webview. A saved
/// session always connects with -load (its own host), so its entry can't be
/// sent anywhere else. The flag says the vault was locked, so a password
/// prompt can say where a saved one would come from.
async fn sftp_target(
    session_name: &str,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    vault_state: &VaultState,
) -> (Option<plinky_core::transport::plink::ExplicitTarget>, Option<String>, bool) {
    let guard = vault_state.inner.lock().await;
    let locked = guard.is_none();
    let vault_pwd = if password.as_deref().is_some_and(|p| !p.is_empty()) {
        password
    } else {
        guard.as_ref().and_then(|v| {
            find_session_entry(v, session_name, hostname.as_deref(), username.as_deref())
                .map(|e| e.secret.expose_secret().to_string())
        })
    };
    drop(guard);
    let target = hostname
        .filter(|h| !h.is_empty())
        .map(|h| plinky_core::transport::plink::ExplicitTarget {
            hostname: h,
            port: port.unwrap_or(22),
            username,
            protocol: Default::default(), // SFTP is SSH
        });
    (target, vault_pwd, locked)
}

/// SFTP error as the pane shows it; a password request mentions the vault
/// when it was locked.
fn sftp_error(e: plinky_core::errors::PlinkyError, vault_locked: bool) -> String {
    let msg = shown(e);
    if vault_locked && msg.starts_with(plinky_core::sftp::client::ERR_PASSWORD) {
        format!("{msg} If it's saved in the vault, unlock the vault and retry.")
    } else {
        msg
    }
}

#[tauri::command]
async fn sftp_home_dir(
    session_name: String,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<String, String> {
    let (target, pwd, locked) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::home_dir(&session_name, target.as_ref(), pwd.as_deref()).await.map_err(|e| sftp_error(e, locked))
}

#[tauri::command]
async fn sftp_list(
    session_name: String,
    remote_path: String,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<Vec<SftpFileEntry>, String> {
    let (target, pwd, locked) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::list_dir(&session_name, &remote_path, target.as_ref(), pwd.as_deref()).await.map_err(|e| sftp_error(e, locked))
}

#[tauri::command]
async fn sftp_mkdir(
    session_name: String,
    remote_path: String,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<(), String> {
    let (target, pwd, locked) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::create_dir(&session_name, &remote_path, target.as_ref(), pwd.as_deref()).await.map_err(|e| sftp_error(e, locked))
}

#[tauri::command]
async fn sftp_rm(
    session_name: String,
    remote_path: String,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<(), String> {
    let (target, pwd, locked) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::remove_file(&session_name, &remote_path, target.as_ref(), pwd.as_deref()).await.map_err(|e| sftp_error(e, locked))
}

#[tauri::command]
async fn sftp_rmdir(
    session_name: String,
    remote_path: String,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<(), String> {
    let (target, pwd, locked) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::remove_dir(&session_name, &remote_path, target.as_ref(), pwd.as_deref()).await.map_err(|e| sftp_error(e, locked))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn sftp_upload(
    session_name: String,
    local_path: String,
    remote_path: String,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<(), String> {
    let (target, pwd, locked) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::upload_file(&session_name, &local_path, &remote_path, target.as_ref(), pwd.as_deref())
        .await
        .map_err(|e| sftp_error(e, locked))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn sftp_download(
    session_name: String,
    remote_path: String,
    local_path: String,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<(), String> {
    let (target, pwd, locked) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::download_file(&session_name, &remote_path, &local_path, target.as_ref(), pwd.as_deref())
        .await
        .map_err(|e| sftp_error(e, locked))
}

#[tauri::command]
async fn sftp_list_local(local_path: String) -> Result<Vec<SftpFileEntry>, String> {
    off_main(move || {
        PsftpClient::list_local_dir(&local_path).map_err(shown)
    }).await?
}

#[tauri::command]
async fn sftp_get_home_dir() -> Result<String, String> {
    off_main(move || {
        PsftpClient::get_local_home_dir()
    }).await
}

/// Cancel flags for in-flight paced pastes, keyed by session id.
#[derive(Default)]
pub struct PasteJobs(std::sync::Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PasteProgress {
    session_id: String,
    sent: usize,
    total: usize,
}

/// Pastes `text` one line at a time with `line_delay_ms` between lines (for
/// console ports and network gear that drop characters on a fast paste).
/// Emits "paste:progress" after each line; resolves with the lines sent.
#[tauri::command]
async fn paste_paced(
    app: tauri::AppHandle,
    registry: State<'_, Arc<SessionRegistry>>,
    jobs: State<'_, PasteJobs>,
    session_id: String,
    text: String,
    line_delay_ms: u64,
) -> Result<usize, String> {
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut map = jobs.0.lock().unwrap();
        if map.contains_key(&session_id) {
            return Err("A paste is already in progress for this session".into());
        }
        map.insert(session_id.clone(), cancel.clone());
    }
    let result = registry
        .paste_paced(
            &session_id,
            &text,
            std::time::Duration::from_millis(line_delay_ms),
            cancel,
            |sent, total| {
                let _ = app.emit(
                    "paste:progress",
                    PasteProgress { session_id: session_id.clone(), sent, total },
                );
            },
        )
        .await;
    jobs.0.lock().unwrap().remove(&session_id);
    result.map_err(|e| format!("Paste failed: {e}"))
}

#[tauri::command]
fn cancel_paste(jobs: State<'_, PasteJobs>, session_id: String) {
    if let Some(flag) = jobs.0.lock().unwrap().get(&session_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Sends a serial Break (ADR-005). 400 ms is what PuTTY holds on Windows and
/// is long enough for Cisco ROMMON and similar. Errors on non-serial sessions.
#[tauri::command]
async fn send_break(registry: State<'_, Arc<SessionRegistry>>, session_id: String) -> Result<(), String> {
    registry
        .send_break(&session_id, std::time::Duration::from_millis(400))
        .await
        .map_err(|e| e.to_string())
}

pub struct VaultState {
    pub inner: Mutex<Option<Vault>>,
    pub custom_path: Mutex<Option<PathBuf>>,
}

impl VaultState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            custom_path: Mutex::new(None),
        }
    }
}

fn resolve_vault_path(app: &tauri::AppHandle, state: &VaultState) -> PathBuf {
    if let Ok(guard) = state.custom_path.try_lock() {
        if let Some(p) = guard.as_ref() {
            return p.clone();
        }
    }
    if let Ok(app_dir) = app.path().app_data_dir() {
        return app_dir.join("vault.bin");
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join("vault.bin")
}

#[tauri::command]
fn vault_is_initialized(app: tauri::AppHandle, state: State<'_, VaultState>) -> Result<bool, String> {
    let path = resolve_vault_path(&app, &state);
    Ok(path.exists())
}

/// Deletes the vault for good -- the Settings screen's "Delete vault",
/// after its two warnings. No master password is asked: a forgotten one is
/// the usual reason to start over. The vault is locked first, so no secret
/// stays in memory (entries zeroize on drop) for a vault that's gone.
/// Ok(false) means there was no vault file to delete.
#[tauri::command]
async fn vault_destroy(app: tauri::AppHandle, state: State<'_, VaultState>) -> Result<bool, String> {
    let path = resolve_vault_path(&app, &state);
    *state.inner.lock().await = None;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("Couldn't delete the vault ({}): {e}", path.display())),
    }
}

#[tauri::command]
async fn vault_is_unlocked(state: State<'_, VaultState>) -> Result<bool, String> {
    let guard = state.inner.lock().await;
    Ok(guard.as_ref().map(|v| !v.is_locked()).unwrap_or(false))
}

#[tauri::command]
async fn vault_create(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    master_password: String,
) -> Result<(), String> {
    let path = resolve_vault_path(&app, &state);
    let vault = Vault::create(&path, &master_password)
        .map_err(|e| format!("Failed to create vault: {e}"))?;
    let mut guard = state.inner.lock().await;
    *guard = Some(vault);
    Ok(())
}

#[tauri::command]
async fn vault_unlock(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    master_password: String,
) -> Result<(), String> {
    let path = resolve_vault_path(&app, &state);
    let vault = Vault::load(&path, &master_password)
        .map_err(|e| format!("Failed to unlock vault: {e}"))?;
    let mut guard = state.inner.lock().await;
    *guard = Some(vault);
    Ok(())
}

#[tauri::command]
async fn vault_lock(state: State<'_, VaultState>) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if let Some(mut v) = guard.take() {
        v.lock();
    }
    Ok(())
}

#[tauri::command]
async fn vault_get(state: State<'_, VaultState>, key: String) -> Result<Option<String>, String> {
    let guard = state.inner.lock().await;
    let vault = guard.as_ref().ok_or_else(|| "Vault is locked".to_string())?;
    Ok(vault.get(&key).map(|s| s.to_string()))
}

#[tauri::command]
async fn vault_set(
    state: State<'_, VaultState>,
    key: String,
    secret: String,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    let vault = guard.as_mut().ok_or_else(|| "Vault is locked".to_string())?;
    vault.set(&key, &secret);
    vault.save().map_err(|e| format!("Failed to save vault: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn vault_get_entry(
    state: State<'_, VaultState>,
    key: String,
) -> Result<Option<VaultEntry>, String> {
    let guard = state.inner.lock().await;
    let vault = guard.as_ref().ok_or_else(|| "Vault is locked".to_string())?;
    Ok(vault.get_entry(&key).cloned())
}

/// Types a vault entry's login (`field = "login"`) or enable password into a
/// session, followed by Enter. The terminal's "Send password" used to fetch
/// the whole entry into the webview and keep it in component state, so
/// after the vault was locked an open tab still sent the password. Here the
/// secret goes from the vault to the session inside the backend and a
/// locked vault refuses.
#[tauri::command]
async fn vault_send_secret(
    registry: State<'_, Arc<SessionRegistry>>,
    vault_state: State<'_, VaultState>,
    session_id: String,
    key: String,
    field: String,
) -> Result<(), String> {
    let guard = vault_state.inner.lock().await;
    let vault = guard.as_ref().ok_or_else(|| "The vault is locked".to_string())?;
    let entry = vault.get_entry(&key).ok_or_else(|| format!("No vault entry '{key}'"))?;
    let secret = match field.as_str() {
        "login" => &entry.secret,
        "enable" => entry
            .enable_secret
            .as_ref()
            .ok_or_else(|| format!("Vault entry '{key}' has no enable password"))?,
        other => return Err(format!("Unknown vault field '{other}'")),
    };
    registry.type_secret(&session_id, secret).map_err(shown)
}

/// Where a vault entry points, for the KeePass URL field: an entry keyed
/// "session:<name>" belongs to that saved session.
fn session_url_for_entry(id: &str) -> Option<String> {
    session_url_for_entry_with(id, |name| putty_compat::sessions::read_session(name).ok())
}

fn session_url_for_entry_with(
    id: &str,
    read: impl Fn(&str) -> Option<putty_compat::sessions::PuttySession>,
) -> Option<String> {
    let name = id.strip_prefix("session:")?;
    let s = read(name)?;
    if s.host_name.is_empty() {
        return None;
    }
    let scheme = match s.protocol.to_ascii_lowercase().as_str() {
        "" | "ssh" => "ssh",
        "telnet" => "telnet",
        "rlogin" => "rlogin",
        _ => return None, // serial/raw: no meaningful URL
    };
    let user = if s.user_name.is_empty() { String::new() } else { format!("{}@", s.user_name) };
    Some(format!("{scheme}://{user}{}:{}", s.host_name, s.port_number))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KdbxExport {
    path: String,
    entries: usize,
}

/// Exports the whole vault to a KeePass (KDBX 4) file chosen in a Save As
/// dialog, protected by the vault's own master password.
/// The password is checked against the vault file itself -- an export
/// hands every secret out in a new file, so it's asked for again even when
/// the vault is already unlocked -- and that same check reads the entries,
/// so a locked vault can be exported too. Ok(None) means the dialog was
/// cancelled.
#[tauri::command]
async fn vault_export_kdbx(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    master_password: String,
) -> Result<Option<KdbxExport>, String> {
    use tauri_plugin_dialog::DialogExt;

    let vault_path = resolve_vault_path(&app, &state);
    if !vault_path.exists() {
        return Err("There is no vault to export yet.".into());
    }
    let vault = Vault::load(&vault_path, &master_password)
        .map_err(|_| "That isn't the vault's master password.".to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Export vault to KeePass")
        .add_filter("KeePass database", &["kdbx"])
        .set_file_name("plinky-vault.kdbx")
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.map_err(|_| "The save dialog closed unexpectedly".to_string())? else {
        return Ok(None);
    };
    let mut dest = picked.into_path().map_err(|e| format!("Can't save there: {e}"))?;
    // GTK's dialog doesn't add the filter's extension; KeePass clients
    // recognise the file by it.
    if dest.extension().is_none_or(|e| !e.eq_ignore_ascii_case("kdbx")) {
        dest.set_extension("kdbx");
    }

    let entries = plinky_core::vault::keepass_export::export_kdbx(&vault, &dest, &master_password, session_url_for_entry)
        .map_err(shown)?;
    Ok(Some(KdbxExport { path: dest.display().to_string(), entries }))
}

#[tauri::command]
async fn vault_set_entry(
    state: State<'_, VaultState>,
    entry: VaultEntry,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    let vault = guard.as_mut().ok_or_else(|| "Vault is locked".to_string())?;
    vault.set_entry(entry);
    vault.save().map_err(|e| format!("Failed to save vault: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn vault_delete(state: State<'_, VaultState>, key: String) -> Result<bool, String> {
    let mut guard = state.inner.lock().await;
    let vault = guard.as_mut().ok_or_else(|| "Vault is locked".to_string())?;
    let removed = vault.remove(&key).is_some();
    if removed {
        vault.save().map_err(|e| format!("Failed to save vault: {e}"))?;
    }
    Ok(removed)
}

#[tauri::command]
async fn vault_list_keys(state: State<'_, VaultState>) -> Result<Vec<String>, String> {
    let guard = state.inner.lock().await;
    let vault = guard.as_ref().ok_or_else(|| "Vault is locked".to_string())?;
    Ok(vault.list_keys())
}

/// Lists entry metadata (id, username, notes, timestamps) WITHOUT decrypted
/// secrets. The frontend list view uses this so every credential's plaintext
/// isn't pulled into the webview just to render the list -- vault_get_entry
/// is fetched per-row only when the user explicitly reveals or copies it.
#[tauri::command]
async fn vault_list_entries_meta(
    state: State<'_, VaultState>,
) -> Result<Vec<VaultEntryMeta>, String> {
    let guard = state.inner.lock().await;
    let vault = guard.as_ref().ok_or_else(|| "Vault is locked".to_string())?;
    Ok(vault.list_entries_meta())
}

#[tauri::command]
fn get_shell_integration_script(shell: String) -> Result<String, String> {
    let shell_type = ShellType::parse(&shell)
        .ok_or_else(|| format!("Unsupported shell: '{shell}'. Expected bash, zsh, or fish."))?;
    Ok(get_bootstrap_script(shell_type).to_string())
}

#[tauri::command]
fn inject_shell_integration(
    registry: State<'_, Arc<SessionRegistry>>,
    session_id: String,
    shell: String,
) -> Result<(), String> {
    let shell_type = ShellType::parse(&shell)
        .ok_or_else(|| format!("Unsupported shell: '{shell}'. Expected bash, zsh, or fish."))?;
    let script = get_bootstrap_script(shell_type);
    // write_input_live_only, NOT write_input: this is a programmatic bulk
    // write, not the user's own keystrokes. Using the looser write_input
    // here previously let the bootstrap script get submitted as a series
    // of password guesses if injected while a session sat at its remote
    // password prompt -- see the doc comment on write_input_live_only.
    registry
        .write_input_live_only(&session_id, script.as_bytes())
        .map_err(|e| format!("Failed to inject shell integration: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn list_serial_ports() -> Result<Vec<plinky_core::transport::serial::DetectedSerialPort>, String> {
    off_main(move || {
        Ok(plinky_core::transport::serial::detect_serial_ports())
    }).await?
}

/// The bundle identifier before 17afa6d (Tauri warns that an identifier
/// ending in ".app" clashes with macOS app bundles).
const OLD_IDENTIFIER: &str = "com.plinky.app";

/// Where Tauri and the webview keep per-identifier folders: the vault
/// (app_data_dir) and the webview's localStorage -- snippets, user folders,
/// tags, layout, Shell Hooks choices.
fn identifier_data_bases() -> Vec<PathBuf> {
    let env_dir = |k: &str| std::env::var_os(k).map(PathBuf::from).filter(|p| p.is_absolute());
    let home = env_dir("HOME");
    let mut bases = Vec::new();
    if cfg!(windows) {
        bases.extend(env_dir("APPDATA")); // app_data_dir
        bases.extend(env_dir("LOCALAPPDATA")); // WebView2 profile
    } else if cfg!(target_os = "macos") {
        if let Some(h) = &home {
            bases.push(h.join("Library/Application Support"));
            bases.push(h.join("Library/WebKit"));
        }
    } else {
        bases.extend(env_dir("XDG_DATA_HOME").or_else(|| home.map(|h| h.join(".local/share"))));
    }
    bases
}

/// Copies `base/old` to `base/new` if only the old folder exists. Without
/// this, the first launch under a new identifier looked like a reset. It
/// copies rather than moves, so an older build still finds its data, and
/// renames into place from a staging folder, so an interrupted copy is
/// retried next launch instead of counting as done.
fn migrate_identifier_dir(base: &std::path::Path, old: &str, new: &str) -> std::io::Result<bool> {
    let (from, to) = (base.join(old), base.join(new));
    if old == new || !from.is_dir() || to.exists() {
        return Ok(false);
    }
    let staging = base.join(format!("{new}.migrating"));
    let _ = std::fs::remove_dir_all(&staging);
    copy_dir_all(&from, &staging)?;
    std::fs::rename(&staging, &to)?;
    Ok(true)
}

fn copy_dir_all(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir_all(&entry.path(), &dest)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

/// Console tabs waiting to be opened (T-020): the first launch's own
/// arguments, then whatever later launches forward. Kept here until the
/// page takes them, rather than sent in an event: GNS3's "open all
/// consoles" starts twenty launches within milliseconds, and the ones that
/// arrive while the page is still loading would reach no listener.
struct OpenRequests(std::sync::Mutex<Vec<cli::OpenRequest>>);

/// The clipboard's text, read here rather than by the page: the webview
/// blocks the page from reading the clipboard (wry's clipboard access is
/// off), so pasting from a browser or any other program gave nothing, on
/// Linux and on Windows. Off the main thread: on Linux, when Plinky itself
/// owns the clipboard, the read waits for the GTK main loop to hand the
/// text over. Nothing (or no text) on the clipboard reads as "".
#[tauri::command]
async fn read_clipboard_text(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    tauri::async_runtime::spawn_blocking(move || app.clipboard().read_text().unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

/// Puts text on the clipboard: copies, and clearing a vault password after
/// 25 s -- from a timer, where a webview may refuse the page's own write.
#[tauri::command]
async fn write_clipboard_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    tauri::async_runtime::spawn_blocking(move || app.clipboard().write_text(text).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Starts a console request's session as soon as the request arrives,
/// before the page has drawn a tab for it; the tab attaches and replays what
/// it printed meanwhile. The connect used to wait on the page: measured
/// against GNS3 consoles, plink connects in 7 ms and PuTTY in ~52, while a
/// Plinky console took ~260-300 ms, ~100-135 of them after the request had
/// already arrived (a 60 ms batching wait, the tab and terminal being
/// built, an attach attempt, then the start).
async fn start_console_session(app: &tauri::AppHandle, mut req: cli::OpenRequest) -> cli::OpenRequest {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let id = format!("cli-{millis}-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let registry = app.state::<Arc<SessionRegistry>>();
    let vault = app.state::<VaultState>();
    // No page yet: output only goes to scrollback, for the tab to replay.
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    drop(rx);
    let name = req.session_name();
    match spawn_terminal_session(
        &registry, &vault, id.clone(), name.clone(), false, 120, 32, tx,
        Some(req.host.clone()), Some(req.port), req.user.clone(), None, Some(req.protocol),
    )
    .await
    {
        Ok(()) => {
            // Free-running into scrollback until a tab attaches.
            let _ = registry.detach_session(&id);
            watch_connection(app, id.clone());
            req.session_id = Some(id);
        }
        // The tab starts it itself then, and shows why it failed.
        Err(e) => eprintln!("plinky: couldn't start {name}: {e}"),
    }
    req
}

/// Starts each request's session, then queues the requests for the page and
/// nudges it. Queued only once started: a page that took a request while
/// its session was still being created would start a second one.
fn open_console_requests(app: &tauri::AppHandle, requests: Vec<cli::OpenRequest>) {
    if requests.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut started = Vec::with_capacity(requests.len());
        for r in requests {
            started.push(start_console_session(&app, r).await);
        }
        app.state::<OpenRequests>().0.lock().unwrap().extend(started);
        // Only a nudge: the page takes the queue when it hears it, and on
        // its own once it is ready.
        let _ = app.emit("cli:open", ());
    });
}

#[tauri::command]
fn take_open_requests(state: State<OpenRequests>) -> Vec<cli::OpenRequest> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let registry = Arc::new(SessionRegistry::new());
    let reg_for_setup = registry.clone();

    // Before the builder runs: the webview opens its storage when the
    // window is created, which happens ahead of the setup hook.
    let context = tauri::generate_context!();
    for base in identifier_data_bases() {
        if let Err(e) = migrate_identifier_dir(&base, OLD_IDENTIFIER, &context.config().identifier) {
            eprintln!("plinky: couldn't carry data over from {OLD_IDENTIFIER} in {}: {e}", base.display());
        }
    }

    // Plinky 0.1.0 for Windows saved sessions as files, which plink.exe never
    // reads: every one failed with "plink: no valid host name provided".
    // Copy them into PuTTY's registry key once, before the session list is
    // first loaded. Nothing already in the registry is overwritten.
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from).filter(|p| p.is_absolute()) {
        let marker = appdata
            .join(&context.config().identifier)
            .join(putty_compat::legacy_import::MARKER_FILE);
        for (dir, report) in putty_compat::legacy_import::import_into_registry(&marker) {
            match report {
                Ok(r) => eprintln!(
                    "plinky: sessions from {}: {} imported, {} already in the registry, {} failed {:?}",
                    dir.display(), r.imported.len(), r.skipped_existing.len(), r.failed.len(), r.failed
                ),
                Err(e) => eprintln!("plinky: couldn't read old sessions in {}: {e}", dir.display()),
            }
        }
    }

    let argv: Vec<String> = std::env::args().collect();
    let startup_requests = cli::parse_args(&argv);

    // A console request from GNS3 goes to the Plinky already running, if
    // there is one, before anything else starts (see handoff.rs).
    #[cfg(unix)]
    let handoff_path = handoff::socket_path(&context.config().identifier);
    #[cfg(unix)]
    if !startup_requests.is_empty() && handoff_path.as_deref().is_some_and(|p| handoff::try_hand_over(p, &argv)) {
        return;
    }

    tauri::Builder::default()
        // First: a second launch (GNS3 runs the console command once per
        // device) hands its arguments to this window as new tabs and exits,
        // instead of opening another Plinky.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            open_console_requests(app, cli::parse_args(&argv));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(OpenRequests(std::sync::Mutex::new(Vec::new())))
        .manage(registry)
        .manage(VaultState::new())
        .manage(PasteJobs::default())
        .manage(ConnectedSessions::default())
        .manage(scripts::Scripts::default())
        .setup(move |app| {
            // The first launch's own consoles connect while the page loads.
            open_console_requests(app.handle(), startup_requests);
            // No safe socket path (see handoff::socket_path): no handoff,
            // later launches still reach us through the plugin.
            #[cfg(unix)]
            if let Some(path) = handoff_path.clone() {
                let handle = app.handle().clone();
                handoff::listen(path, move |args| {
                    open_console_requests(&handle, cli::parse_args(&args));
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                });
            }
            let app_handle = app.handle().clone();
            let mut rx = reg_for_setup.subscribe_prompts();
            // tauri::async_runtime::spawn, NOT tokio::spawn: setup() runs
            // before Tauri's own async runtime context is entered around
            // this closure, so a bare tokio::spawn here panics with "there
            // is no reactor running" on startup. Tauri's wrapper dispatches
            // onto whatever runtime it's actually using instead of assuming
            // an ambient tokio::runtime::Handle is already current.
            tauri::async_runtime::spawn(async move {
                while let Ok(event) = rx.recv().await {
                    let _ = app_handle.emit("session:prompt", &event);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_open_requests,
            is_session_connected,
            is_session_ended,
            pick_script_file,
            run_script,
            stop_script,
            read_clipboard_text,
            write_clipboard_text,
            paste_paced,
            cancel_paste,
            send_break,
            putty_detect,
            list_putty_sessions,
            read_putty_session,
            write_putty_session,
            delete_putty_session,
            remove_putty_hostkey,
            pick_ppk_file,
            set_session_folders,
            list_putty_hostkeys,
            inspect_ppk,
            start_terminal_session,
            attach_terminal_session,
            start_session_log,
            stop_session_log,
            session_log_status,
            detach_terminal_session,
            ack_terminal_output,
            answer_hostkey_prompt,
            write_terminal_input,
            resize_terminal,
            close_terminal_session,
            set_sync_channel,
            set_sync_protected,
            set_sync_armed,
            broadcast_sync_input,
            sftp_list,
            sftp_mkdir,
            sftp_rm,
            sftp_rmdir,
            sftp_upload,
            sftp_download,
            sftp_list_local,
            sftp_get_home_dir,
            sftp_home_dir,
            vault_is_initialized,
            vault_is_unlocked,
            vault_create,
            vault_unlock,
            vault_lock,
            vault_get,
            vault_set,
            vault_get_entry,
            vault_send_secret,
            vault_export_kdbx,
            vault_destroy,
            vault_lookup,
            vault_set_entry,
            vault_delete,
            vault_list_keys,
            vault_list_entries_meta,
            get_shell_integration_script,
            inject_shell_integration,
            list_serial_ports
        ])
        .build(context)
        .expect("error while building plinky desktop application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // No plink outlives the window.
                if let Some(registry) = app.try_state::<Arc<SessionRegistry>>() {
                    registry.kill_all();
                }
                // On Windows, dropping the sessions at exit closes each
                // pseudo console, and that can block: the app window went
                // away but the process stayed, and had to be ended from Task
                // Manager. The children are dead; leave without the drops.
                #[cfg(windows)]
                std::process::exit(0);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::migrate_identifier_dir;

    /// The page hears the host-key prompt and paste progress through
    /// plugin:event|listen, which Tauri refuses unless a capability grants
    /// it. There was none at all: the refusal was caught and logged to
    /// a console nobody sees, so the trust dialog never appeared and a first
    /// connection to an unknown host sat at "The" for good. Checked against
    /// the release binary: without the file, "Command plugin:event|listen
    /// not allowed by ACL"; with it, listen succeeds.
    #[test]
    fn the_main_window_may_listen_to_backend_events() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let has = |key: &str, want: &str| {
            cap[key].as_array().is_some_and(|a| a.iter().any(|v| v == want))
        };
        assert!(has("windows", "main"));
        assert!(has("permissions", "core:event:allow-listen"));
        assert!(has("permissions", "core:event:allow-unlisten"));
        // The interface size setting (Settings) calls setZoom on the
        // webview; without this grant it silently does nothing.
        assert!(has("permissions", "core:webview:allow-set-webview-zoom"));
    }

    /// Tauri takes over WebView2's drag and drop for file drops unless the
    /// window turns that off, and then the page's own drag and drop never
    /// starts on Windows. Owner, v0.1.30 on Windows: dragging sessions in
    /// the list and tabs in the tab bar did nothing (the SFTP pane's drag
    /// between panes was dead there too). Plinky takes no file drops from
    /// the desktop, so nothing is lost.
    #[test]
    fn the_page_handles_its_own_drag_and_drop() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = conf["app"]["windows"].as_array().expect("windows in tauri.conf.json");
        assert!(!windows.is_empty());
        for w in windows {
            assert_eq!(w["dragDropEnabled"], serde_json::Value::Bool(false), "{w}");
        }
    }
    use super::{find_session_entry_for, session_url_for_entry_with, vault_key_candidates};
    use plinky_core::{Vault, VaultEntry};

    #[test]
    fn vault_keys_follow_the_names_the_vault_screen_suggests() {
        let keys = vault_key_candidates("Server 2", None, Some("192.0.2.10"), Some("ops"));
        assert_eq!(keys, ["session:Server 2", "Server 2", "ops@192.0.2.10", "192.0.2.10"]);
        // An explicit link from the session editor is tried first.
        let keys = vault_key_candidates("Server 2", Some("shared-admin"), Some("192.0.2.10"), None);
        assert_eq!(keys[0], "shared-admin");
    }

    #[test]
    fn a_session_finds_its_vault_entry_without_an_explicit_link() {
        // The reported case: a password saved from the Vault screen, no
        // PlinkyVaultKey in the session file -- it used to be ignored.
        // The saved session is handed in rather than written to PUTTYDIR:
        // on Windows sessions are read from the registry, and this test
        // failed there once CI's Windows job got far enough to run it.
        let server2 = putty_compat::sessions::PuttySession {
            name: "Server 2".into(),
            host_name: "192.0.2.10".into(),
            port_number: 22,
            user_name: "ops".into(),
            protocol: "ssh".into(),
            ..Default::default()
        };
        let saved = |name: &str| (name == "Server 2").then(|| server2.clone());
        let dir = std::env::temp_dir().join(format!("plinky-vault-lookup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut vault = Vault::create_fast(dir.join("vault.bin"), "pw").unwrap();

        vault.set_entry(VaultEntry::new("192.0.2.10", "by-host"));
        let e = find_session_entry_for(&vault, saved("Server 2").as_ref(), "Server 2", None, None).unwrap();
        assert_eq!(e.id, "192.0.2.10", "the saved session's own host is used");

        vault.set_entry(VaultEntry::new("session:Server 2", "by-session"));
        let e = find_session_entry_for(&vault, saved("Server 2").as_ref(), "Server 2", None, None).unwrap();
        assert_eq!(e.id, "session:Server 2");

        // Quick Connect: no saved session, so the host the tab connects to.
        vault.set_entry(VaultEntry::new("192.0.2.7", "quick"));
        assert_eq!(find_session_entry_for(&vault, None, "192.0.2.7:22", Some("192.0.2.7"), None).unwrap().id, "192.0.2.7");
        assert!(find_session_entry_for(&vault, None, "elsewhere", Some("198.51.100.1"), None).is_none());

        // KeePass export: a session's entry gets that session's address.
        assert_eq!(session_url_for_entry_with("session:Server 2", saved).as_deref(), Some("ssh://ops@192.0.2.10:22"));
        assert_eq!(session_url_for_entry_with("192.0.2.10", saved), None);
        assert_eq!(session_url_for_entry_with("session:No Such Session", saved), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_jump_session_gets_a_login_for_each_host_from_the_vault() {
        use super::jump_credentials_for;
        let session = |name: &str, host: &str, user: &str, extra: &[(&str, &str)]| putty_compat::sessions::PuttySession {
            name: name.into(),
            host_name: host.into(),
            port_number: 22,
            user_name: user.into(),
            protocol: "ssh".into(),
            extra: extra.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        };
        let dir = std::env::temp_dir().join(format!("plinky-jump-lookup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut vault = Vault::create_fast(dir.join("vault.bin"), "pw").unwrap();
        vault.set_entry(VaultEntry::new("session:Router", "final-pw"));
        vault.set_entry(VaultEntry::new("jump:Router", "jump-pw"));
        vault.set_entry(VaultEntry::new("session:Bastion", "preset-pw"));
        let none = |_: &str| None;

        // Typed-in jump host: its entry is jump:<session>.
        let router = session("Router", "192.168.1.5", "admin", &[
            ("ProxyMethod", "6"), ("ProxyHost", "10.0.0.1"), ("ProxyPort", "2200"), ("ProxyUsername", "ops"),
        ]);
        let c = jump_credentials_for(&vault, &router, none).unwrap();
        let j = c.jump.unwrap();
        assert_eq!((j.user.as_str(), j.host.as_str(), j.port, j.password.expose_secret()), ("ops", "10.0.0.1", 2200, "jump-pw"));
        let t = c.target.unwrap();
        assert_eq!((t.user.as_str(), t.host.as_str(), t.password.expose_secret()), ("admin", "192.168.1.5", "final-pw"));

        // A saved session as the jump host brings its own host, user and entry.
        let bastion = session("Bastion", "bastion.example", "jumper", &[]);
        let via_preset = session("Router", "192.168.1.5", "admin", &[("ProxyMethod", "6"), ("ProxyHost", "Bastion")]);
        let c = jump_credentials_for(&vault, &via_preset, |n| (n == "Bastion").then(|| bastion.clone())).unwrap();
        let j = c.jump.unwrap();
        assert_eq!((j.user.as_str(), j.host.as_str(), j.password.expose_secret()), ("jumper", "bastion.example", "preset-pw"));

        // No user name for the jump host: plink asks "login as:"; not ours.
        let no_user = session("Router", "192.168.1.5", "admin", &[("ProxyMethod", "6"), ("ProxyHost", "10.0.0.1")]);
        let c = jump_credentials_for(&vault, &no_user, none).unwrap();
        assert!(c.jump.is_none() && c.target.is_some());

        // Not a jump session (or another proxy type): the -pwfile path applies.
        assert!(jump_credentials_for(&vault, &session("Router", "h", "u", &[]), none).is_none());
        assert!(jump_credentials_for(&vault, &session("Router", "h", "u", &[("ProxyMethod", "5"), ("ProxyHost", "x")]), none).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_router_jump_connects_to_the_first_device_and_hops_by_command() {
        // NX-OS first, IOS behind it: no tunnel (NX-OS won't forward),
        // plink goes to the NX-OS box and the script types the hop.
        use super::cli_jump_plan;
        use plinky_core::session::expect::Event;
        let session = |extra: &[(&str, &str)]| putty_compat::sessions::PuttySession {
            name: "PE2".into(),
            host_name: "10.1.1.2".into(),
            port_number: 22,
            user_name: "admin".into(),
            protocol: "ssh".into(),
            extra: extra.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        };
        let dir = std::env::temp_dir().join(format!("plinky-cli-jump-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut vault = Vault::create_fast(dir.join("vault.bin"), "pw").unwrap();
        vault.set_entry(VaultEntry::new("session:PE2", "ios-pw"));
        vault.set_entry(VaultEntry::new("jump:PE2", "nxos-pw"));
        let none = |_: &str| None;
        let sent = |e: Event| match e { Event::Send { bytes, .. } => Some(String::from_utf8(bytes.to_vec()).unwrap()), _ => None };

        let pe2 = session(&[
            ("PlinkyJumpMode", "cli"), ("ProxyMethod", "0"), ("ProxyHost", "10.0.0.1"),
            ("ProxyUsername", "space"), ("PlinkyJumpCommand", "ssh -l {user} {host}"),
        ]);
        let (hop, mut script) = cli_jump_plan(Some(&vault), &pe2, none).unwrap();
        assert_eq!((hop.hostname.as_str(), hop.port, hop.username.as_deref()), ("10.0.0.1", 22, Some("space")));
        assert_eq!(sent(script.feed(b"| Password: ")).as_deref(), Some("nxos-pw\r"));
        assert_eq!(sent(script.feed(b"\r\nnexus-01# ")).as_deref(), Some("ssh -l admin 10.1.1.2\r"));
        assert_eq!(sent(script.feed(b"Password: ")).as_deref(), Some("ios-pw\r"));

        // Locked vault: it still hops, the passwords are the user's.
        let (_, mut script) = cli_jump_plan(None, &session(&[("PlinkyJumpMode", "cli"), ("ProxyHost", "10.0.0.1")]), none).unwrap();
        assert_eq!(sent(script.feed(b"| Password: ")), None);
        assert_eq!(sent(script.feed(b"\r\nnexus-01# ")).as_deref(), Some("ssh admin@10.1.1.2\r"));

        // Tunnel mode or no jump host: not this path.
        assert!(cli_jump_plan(Some(&vault), &session(&[("ProxyMethod", "6"), ("ProxyHost", "10.0.0.1")]), none).is_none());
        assert!(cli_jump_plan(Some(&vault), &session(&[("PlinkyJumpMode", "cli")]), none).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("plinky-mig-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn old_identifier_data_is_copied_once_and_left_in_place() {
        let base = scratch("copy");
        let store = base.join("old.id/localstorage");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("tauri_localhost_0.localstorage"), b"snippets").unwrap();

        assert!(migrate_identifier_dir(&base, "old.id", "new.id").unwrap());
        let copied = std::fs::read(base.join("new.id/localstorage/tauri_localhost_0.localstorage")).unwrap();
        assert_eq!(copied, b"snippets");
        assert!(store.exists(), "an older build must still find its data");
        assert!(!base.join("new.id.migrating").exists());

        // Data written under the new identifier is never overwritten later.
        std::fs::write(base.join("new.id/localstorage/tauri_localhost_0.localstorage"), b"newer").unwrap();
        assert!(!migrate_identifier_dir(&base, "old.id", "new.id").unwrap());
        let kept = std::fs::read(base.join("new.id/localstorage/tauri_localhost_0.localstorage")).unwrap();
        assert_eq!(kept, b"newer");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn nothing_happens_without_old_data() {
        let base = scratch("none");
        assert!(!migrate_identifier_dir(&base, "old.id", "new.id").unwrap());
        assert!(!base.join("new.id").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}

