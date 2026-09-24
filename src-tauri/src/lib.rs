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

    if is_local {
        registry
            .create_local_session(&session_id, &session_name, log_file_name, cols, rows, tx)
            .map_err(|e| format!("Failed to create local session: {e}"))
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

#[tauri::command]
async fn sftp_list(
    session_name: String,
    remote_path: String,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
) -> Result<Vec<SftpFileEntry>, String> {
    let explicit_target = hostname
        .filter(|h| !h.is_empty())
        .map(|h| plinky_core::transport::plink::ExplicitTarget {
            hostname: h,
            port: port.unwrap_or(22),
            username,
        });
    PsftpClient::list_dir(&session_name, &remote_path, explicit_target.as_ref())
        .await
        .map_err(|e| format!("Failed to list remote directory: {e}"))
}

#[tauri::command]
async fn sftp_mkdir(
    session_name: String,
    remote_path: String,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
) -> Result<(), String> {
    let explicit_target = hostname
        .filter(|h| !h.is_empty())
        .map(|h| plinky_core::transport::plink::ExplicitTarget {
            hostname: h,
            port: port.unwrap_or(22),
            username,
        });
    PsftpClient::create_dir(&session_name, &remote_path, explicit_target.as_ref())
        .await
        .map_err(|e| format!("Failed to create remote directory: {e}"))
}

#[tauri::command]
async fn sftp_rm(
    session_name: String,
    remote_path: String,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
) -> Result<(), String> {
    let explicit_target = hostname
        .filter(|h| !h.is_empty())
        .map(|h| plinky_core::transport::plink::ExplicitTarget {
            hostname: h,
            port: port.unwrap_or(22),
            username,
        });
    PsftpClient::remove_file(&session_name, &remote_path, explicit_target.as_ref())
        .await
        .map_err(|e| format!("Failed to remove remote file: {e}"))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let registry = Arc::new(SessionRegistry::new());
    let reg_for_setup = registry.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(registry)
        .manage(VaultState::new())
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
            vault_is_initialized,
            vault_is_unlocked,
            vault_create,
            vault_unlock,
            vault_lock,
            vault_get,
            vault_set,
            vault_get_entry,
            vault_set_entry,
            vault_delete,
            vault_list_keys,
            vault_list_entries_meta,
            get_shell_integration_script,
            inject_shell_integration
        ])
        .run(tauri::generate_context!())
        .expect("error while running plinky desktop application");
}

