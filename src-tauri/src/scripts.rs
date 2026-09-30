//! Run Script: a program attached to one terminal session.
//!
//! What the script prints is typed into the session; what the device prints
//! is copied to the script's input (the session's output tap); what the
//! script writes to stderr shows in the terminal as a note and never reaches
//! the device. Python scripts get `plinky.py` (scripting/plinky.py) on their
//! path for send/expect. The script sees the session's output, never the
//! vault: a password it needs goes through "Send password" as for a person.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use plinky_core::SessionRegistry;
use tauri::{AppHandle, Emitter, Manager};

const HELPER: &str = include_str!("../scripting/plinky.py");

/// Output chunks a script may fall behind by before new ones are dropped.
const TAP_DEPTH: usize = 1024;

struct Running {
    child: Arc<Mutex<Child>>,
    stopped: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Scripts(Mutex<HashMap<String, Running>>);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptLog {
    session_id: String,
    line: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptStarted {
    session_id: String,
    name: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptEnded {
    session_id: String,
    code: Option<i32>,
    stopped: bool,
}

/// The folder Plinky runs from when it is an AppImage (APPDIR, or the one
/// holding usr/bin/plinky-desktop), None otherwise.
fn app_dir() -> Option<std::path::PathBuf> {
    if let Some(dir) = std::env::var_os("APPDIR").filter(|d| !d.is_empty()) {
        return Some(dir.into());
    }
    let exe = std::env::current_exe().ok()?;
    let bin = exe.parent()?;
    let usr = bin.parent()?;
    (bin.file_name()? == "bin" && usr.file_name()? == "usr" && std::env::var_os("APPIMAGE").is_some())
        .then(|| usr.parent().map(Path::to_path_buf))
        .flatten()
}

/// A path list (PATH, PYTHONPATH...) without the entries inside `dir`, and
/// without empty ones (an empty PYTHONPATH entry means "the current folder").
fn without_dir(list: &std::ffi::OsStr, dir: &Path) -> Vec<std::path::PathBuf> {
    std::env::split_paths(list)
        .filter(|p| !p.as_os_str().is_empty() && !p.starts_with(dir))
        .collect()
}

/// A script runs with the user's environment, not the AppImage's. The
/// AppImage's AppRun points Python at its own folder (PYTHONHOME and
/// PYTHONPATH into ~/apps/Plinky/usr) and puts its libraries first: the
/// system python3 then found no standard library and died at start, "No
/// module named 'encodings'" (owner, the unpacked AppImage).
fn user_environment(cmd: &mut Command) {
    cmd.env_remove("PYTHONHOME");
    let Some(dir) = app_dir() else { return };
    for var in ["LD_LIBRARY_PATH", "PATH", "XDG_DATA_DIRS"] {
        if let Some(value) = std::env::var_os(var) {
            match std::env::join_paths(without_dir(&value, &dir)) {
                Ok(kept) if !kept.is_empty() => { cmd.env(var, kept); }
                _ => { cmd.env_remove(var); }
            }
        }
    }
}

/// How a script file is run: Python, a shell, PowerShell or cmd by its
/// extension, anything else as a program of its own.
fn command_for(path: &Path) -> Command {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let file = path.as_os_str();
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = match ext.as_str() {
        "py" => {
            let mut c = Command::new(if cfg!(windows) { "python" } else { "python3" });
            c.arg("-u").arg(file);
            c
        }
        "sh" => {
            let mut c = Command::new("bash");
            c.arg(file);
            c
        }
        "ps1" => {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(file);
            c
        }
        "bat" | "cmd" => {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(file);
            c
        }
        _ => Command::new(file),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub fn start(
    app: &AppHandle,
    registry: Arc<SessionRegistry>,
    session_id: String,
    session_name: String,
    path: String,
) -> Result<(), String> {
    let scripts = app.state::<Scripts>();
    if scripts.0.lock().unwrap().contains_key(&session_id) {
        return Err("A script is already running on this tab. Stop it first.".into());
    }
    let script = Path::new(&path);
    if !script.is_file() {
        return Err(format!("No script at {path}"));
    }

    // The helper, written fresh each run so it matches this version.
    let helper_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("scripting");
    std::fs::create_dir_all(&helper_dir).map_err(|e| format!("Couldn't prepare the script helper: {e}"))?;
    std::fs::write(helper_dir.join("plinky.py"), HELPER).map_err(|e| format!("Couldn't write the script helper: {e}"))?;
    let mut python_path = vec![helper_dir.clone()];
    if let Some(existing) = std::env::var_os("PYTHONPATH") {
        match app_dir() {
            Some(dir) => python_path.extend(without_dir(&existing, &dir)),
            None => python_path.extend(std::env::split_paths(&existing).filter(|p| !p.as_os_str().is_empty())),
        }
    }

    let mut cmd = command_for(script);
    user_environment(&mut cmd);
    cmd.env("PYTHONPATH", std::env::join_paths(python_path).map_err(|e| e.to_string())?)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PLINKY_SESSION", &session_name)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = script.parent().filter(|d| !d.as_os_str().is_empty()) {
        cmd.current_dir(dir);
    }
    let program = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd.spawn().map_err(|e| {
        if program.starts_with("python") {
            format!("Couldn't start {program}: {e}. Is Python installed and on PATH?")
        } else {
            format!("Couldn't start {program}: {e}")
        }
    })?;

    let mut stdin = child.stdin.take().expect("piped");
    let mut stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    let child = Arc::new(Mutex::new(child));
    let stopped = Arc::new(AtomicBool::new(false));
    // Registered before the watcher below starts: a script that exits at
    // once must not be removed before it was added.
    scripts.0.lock().unwrap().insert(session_id.clone(), Running { child: child.clone(), stopped: stopped.clone() });

    // Device output -> script.
    let (tap_tx, tap_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(TAP_DEPTH);
    if let Err(e) = registry.set_output_tap(&session_id, Some(tap_tx)) {
        scripts.0.lock().unwrap().remove(&session_id);
        let _ = child.lock().unwrap().kill();
        return Err(e.to_string());
    }
    std::thread::spawn(move || {
        for chunk in tap_rx {
            if stdin.write_all(&chunk).and_then(|_| stdin.flush()).is_err() {
                break;
            }
        }
    });

    // Script -> device.
    {
        let registry = registry.clone();
        let id = session_id.clone();
        let child = child.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // The session is gone: nothing left to type into.
                        if registry.write_input(&id, &buf[..n]).is_err() && registry.is_session_ended(&id) {
                            let _ = child.lock().unwrap().kill();
                            break;
                        }
                    }
                }
            }
        });
    }

    // Script's notes -> the terminal.
    {
        let app = app.clone();
        let id = session_id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let _ = app.emit("script:log", ScriptLog { session_id: id.clone(), line });
            }
        });
    }

    // The end.
    {
        let app = app.clone();
        let id = session_id.clone();
        let child = child.clone();
        let stopped = stopped.clone();
        std::thread::spawn(move || {
            let code = loop {
                if let Ok(Some(status)) = child.lock().unwrap().try_wait() {
                    break status.code();
                }
                std::thread::sleep(Duration::from_millis(100));
            };
            let _ = registry.set_output_tap(&id, None);
            app.state::<Scripts>().0.lock().unwrap().remove(&id);
            let _ = app.emit("script:ended", ScriptEnded { session_id: id, code, stopped: stopped.load(Ordering::Relaxed) });
        });
    }

    // The page shows the running bar (and Stop) on this, however the script
    // was started.
    let name = script.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(path.clone());
    let _ = app.emit("script:started", ScriptStarted { session_id, name });
    Ok(())
}

/// Ends the script, then sends Ctrl+C to the session: what the script
/// started on the device (a ping that never ends on Linux, a login to the
/// next device) kept running after Stop until Ctrl+C was pressed by hand
/// (owner). A script that ends by itself leaves the session alone.
pub fn stop(app: &AppHandle, registry: &SessionRegistry, session_id: &str) {
    let running = {
        let scripts = app.state::<Scripts>();
        let map = scripts.0.lock().unwrap();
        map.get(session_id).map(|run| {
            run.stopped.store(true, Ordering::Relaxed);
            let _ = run.child.lock().unwrap().kill();
        })
    };
    if running.is_some() {
        let _ = registry.write_input(session_id, b"\x03");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn the_appimage_s_own_folders_are_left_out_of_a_script_s_paths() {
        // What the unpacked AppImage handed its children: PYTHONPATH into its
        // own usr/share/pyshared, and a trailing empty entry.
        let dir = Path::new("/home/u/apps/Plinky");
        let list = std::ffi::OsString::from("/home/u/apps/Plinky/usr/share/pyshared/:/home/u/lib/py:");
        assert_eq!(without_dir(&list, dir), vec![std::path::PathBuf::from("/home/u/lib/py")]);
        let path = std::ffi::OsString::from("/home/u/apps/Plinky/usr/bin:/usr/local/bin:/usr/bin");
        assert_eq!(without_dir(&path, dir), vec![std::path::PathBuf::from("/usr/local/bin"), std::path::PathBuf::from("/usr/bin")]);
    }
}
