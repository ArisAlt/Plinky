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
//
// The runtime is built by hand rather than with #[tokio::main] so the
// environment can be settled first, while this is the only thread: WebKit
// reads it when the window is made, and setting a variable while other
// threads may read the environment is not safe.
fn main() {
    plinky_desktop_lib::prepare_webkit_environment();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("the Tokio runtime")
        .block_on(async { plinky_desktop_lib::run() });
}
