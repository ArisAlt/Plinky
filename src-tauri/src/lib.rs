use putty_compat::sessions::PuttySession;
use putty_compat::hostkeys::HostKeyEntry;
use putty_compat::ppk::PpkHeader;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_putty_sessions,
            read_putty_session,
            write_putty_session,
            list_putty_hostkeys,
            inspect_ppk
        ])
        .run(tauri::generate_context!())
        .expect("error while running plinky desktop application");
}
