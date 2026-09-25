use std::path::PathBuf;
use std::sync::Arc;
use tauri::{ipc::Channel, Emitter, Manager, State};
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


#[tauri::command]
fn putty_detect() -> PuttyInfo {
    PlinkTransport::detect_putty()
}

#[tauri::command]
fn list_putty_sessions() -> Result<Vec<PuttySession>, String> {
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
fn read_putty_session(name: String) -> Result<PuttySession, String> {
    putty_compat::sessions::read_session(&name)
        .map_err(|e| format!("Failed to read PuTTY session '{name}': {e}"))
}

#[tauri::command]
fn write_putty_session(session: PuttySession) -> Result<(), String> {
    putty_compat::sessions::write_session(&session)
        .map_err(|e| format!("Failed to write PuTTY session '{}': {e}", session.name))
}

#[tauri::command]
fn list_putty_hostkeys() -> Result<Vec<HostKeyEntry>, String> {
    putty_compat::hostkeys::list_host_keys()
        .map_err(|e| format!("Failed to read PuTTY hostkeys: {e}"))
}

#[tauri::command]
fn inspect_ppk(path: String) -> Result<PpkHeader, String> {
    putty_compat::ppk::read_header(std::path::Path::new(&path))
        .map_err(|e| format!("Failed to parse PPK header for '{path}': {e}"))
}

#[tauri::command]
fn start_terminal_session(
    registry: State<Arc<SessionRegistry>>,
    session_id: String,
    session_name: String,
    is_local: bool,
    cols: u16,
    rows: u16,
    on_data: Channel<Vec<u8>>,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    log_file_name: Option<String>,
) -> Result<(), String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();

    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            if on_data.send(chunk).is_err() {
                break;
            }
        }
    });

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
        let explicit_target = hostname
            .filter(|h| !h.is_empty())
            .map(|h| plinky_core::transport::plink::ExplicitTarget {
                hostname: h,
                port: port.unwrap_or(22),
                username,
            });
        registry
            .create_plink_session(&session_id, &session_name, explicit_target, log_file_name, cols, rows, tx)
            .map_err(|e| format!("Failed to create plink session: {e}"))
    }
}

#[tauri::command]
fn attach_terminal_session(
    registry: State<Arc<SessionRegistry>>,
    session_id: String,
    from_seq: usize,
    on_data: Channel<Vec<u8>>,
) -> Result<AttachInfo, String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();

    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            if on_data.send(chunk).is_err() {
                break;
            }
        }
    });

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
    session_id: String,
) -> Result<(), String> {
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
) -> Result<usize, String> {
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

/// Where an SFTP call goes and the password it uses. A password typed into
/// the SFTP pane wins; otherwise a saved session's vault entry is read here,
/// in the backend, so the secret never passes through the webview. A saved
/// session always connects with -load (its own host), so a session name
/// can't send its vault password anywhere else.
async fn sftp_target(
    session_name: &str,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    vault_state: &VaultState,
) -> (Option<plinky_core::transport::plink::ExplicitTarget>, Option<String>) {
    let target = hostname
        .filter(|h| !h.is_empty())
        .map(|h| plinky_core::transport::plink::ExplicitTarget {
            hostname: h,
            port: port.unwrap_or(22),
            username,
        });
    if let Some(pwd) = password.filter(|p| !p.is_empty()) {
        return (target, Some(pwd));
    }
    let vault_pwd = match putty_compat::sessions::read_session(session_name) {
        Ok(sess) => match sess.extra.get("PlinkyVaultKey").filter(|k| !k.is_empty()) {
            Some(key) => vault_state
                .inner
                .lock()
                .await
                .as_ref()
                .and_then(|v| v.get_entry(key))
                .map(|e| e.secret.expose_secret().to_string()),
            None => None,
        },
        Err(_) => None,
    };
    (target, vault_pwd)
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
    let (target, pwd) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::home_dir(&session_name, target.as_ref(), pwd.as_deref()).await.map_err(shown)
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
    let (target, pwd) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::list_dir(&session_name, &remote_path, target.as_ref(), pwd.as_deref()).await.map_err(shown)
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
    let (target, pwd) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::create_dir(&session_name, &remote_path, target.as_ref(), pwd.as_deref()).await.map_err(shown)
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
    let (target, pwd) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::remove_file(&session_name, &remote_path, target.as_ref(), pwd.as_deref()).await.map_err(shown)
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
    let (target, pwd) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::remove_dir(&session_name, &remote_path, target.as_ref(), pwd.as_deref()).await.map_err(shown)
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
    let (target, pwd) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::upload_file(&session_name, &local_path, &remote_path, target.as_ref(), pwd.as_deref())
        .await
        .map_err(shown)
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
    let (target, pwd) = sftp_target(&session_name, hostname, port, username, password, &vault_state).await;
    PsftpClient::download_file(&session_name, &remote_path, &local_path, target.as_ref(), pwd.as_deref())
        .await
        .map_err(shown)
}

#[tauri::command]
fn sftp_list_local(local_path: String) -> Result<Vec<SftpFileEntry>, String> {
    PsftpClient::list_local_dir(&local_path).map_err(shown)
}

#[tauri::command]
fn sftp_get_home_dir() -> String {
    PsftpClient::get_local_home_dir()
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
fn list_serial_ports() -> Result<Vec<plinky_core::transport::serial::DetectedSerialPort>, String> {
    Ok(plinky_core::transport::serial::detect_serial_ports())
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(registry)
        .manage(VaultState::new())
        .manage(PasteJobs::default())
        .setup(move |app| {
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
            paste_paced,
            cancel_paste,
            send_break,
            putty_detect,
            list_putty_sessions,
            read_putty_session,
            write_putty_session,
            list_putty_hostkeys,
            inspect_ppk,
            start_terminal_session,
            attach_terminal_session,
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
            vault_set_entry,
            vault_delete,
            vault_list_keys,
            vault_list_entries_meta,
            get_shell_integration_script,
            inject_shell_integration,
            list_serial_ports
        ])
        .run(context)
        .expect("error while running plinky desktop application");
}

#[cfg(test)]
mod tests {
    use super::migrate_identifier_dir;

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

