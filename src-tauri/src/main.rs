// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// #[tokio::main] gives the whole process one real, ambient Tokio runtime
// before anything else runs. Without it there is NO tokio runtime anywhere
// in the process: Tauri's own internal dispatch mostly copes via
// tauri::async_runtime's own handling, but any plain tokio::spawn call --
// including ones inside crates/plinky-core, which deliberately has zero
// Tauri dependency and so cannot call tauri::async_runtime::spawn -- panics
// with "there is no reactor running", which is fatal across the GTK/WebKit
// FFI boundary that fires most of these callbacks (a panic there cannot
// unwind, so it hard-crashes the whole app rather than surfacing as an
// error). Tauri detects and uses this ambient runtime automatically instead
// of spinning up its own separate one.
#[tokio::main]
async fn main() {
    plinky_desktop_lib::run();
}
