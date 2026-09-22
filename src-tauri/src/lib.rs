use std::sync::Arc;
use tauri::{State, ipc::Channel, Emitter};
use putty_compat::sessions::PuttySession;
use putty_compat::hostkeys::HostKeyEntry;
use putty_compat::ppk::PpkHeader;
use plinky_core::{SessionRegistry, PlinkTransport, PuttyInfo, AttachInfo, PromptAnswer, SyncChannelId};
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
            .create_local_session(&session_id, &session_name, cols, rows, tx)
            .map_err(|e| format!("Failed to create local session: {e}"))
    } else {
        registry
            .create_plink_session(&session_id, &session_name, cols, rows, tx)
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
    let chan_id = SyncChannelId::parse(&channel)
        .ok_or_else(|| format!("Invalid sync channel '{channel}'"))?;
    registry
        .broadcast_sync_input(chan_id, &data)
        .map_err(|e| format!("Failed to broadcast sync input: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let registry = Arc::new(SessionRegistry::new());
    let reg_for_setup = registry.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(registry)
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let mut rx = reg_for_setup.subscribe_prompts();
            tokio::spawn(async move {
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
            broadcast_sync_input
        ])
        .run(tauri::generate_context!())
        .expect("error while running plinky desktop application");
}
