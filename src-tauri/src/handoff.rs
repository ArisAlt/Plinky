//! A second launch hands its console request to the running Plinky over a
//! Unix socket, then exits.
//!
//! tauri-plugin-single-instance does this over the D-Bus session bus. When a
//! launch can't reach that bus (GNS3 started from a service, sudo, a remote
//! shell, or a desktop without a session bus), each GNS3 console opened a
//! new Plinky window. Measured here: with `dbus-run-session` a second launch
//! handed over and exited 0; without a bus it ran as its own instance. The
//! socket needs nothing but the filesystem, so both paths now lead to one
//! window. Windows keeps the plugin, which doesn't use D-Bus there.

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::Duration;

/// Per user: `$XDG_RUNTIME_DIR` is private to the user (0700); the /tmp
/// fallback carries the user name and is chmod 0600 once bound.
pub fn socket_path(identifier: &str) -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|d| d.is_dir()) {
        return dir.join(format!("{identifier}.sock"));
    }
    let user = std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_else(|_| "user".into());
    std::env::temp_dir().join(format!("{identifier}-{user}.sock"))
}

/// Sends the arguments to a running Plinky. True if one took them.
pub fn try_hand_over(path: &std::path::Path, args: &[String]) -> bool {
    let Ok(mut stream) = UnixStream::connect(path) else { return false };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    if stream.write_all(args.join("\0").as_bytes()).is_err() {
        return false;
    }
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let mut ack = [0u8; 1];
    matches!(stream.read(&mut ack), Ok(1) if ack[0] == b'1')
}

/// Listens for later launches; each message is one launch's argv. Returns
/// None when another live Plinky already owns the socket.
pub fn listen<F>(path: PathBuf, on_args: F) -> Option<()>
where
    F: Fn(Vec<String>) + Send + 'static,
{
    if path.exists() {
        // A socket nobody answers on is left over from a crash; a live one
        // belongs to another Plinky (then that one gets the launches).
        if UnixStream::connect(&path).is_ok() {
            return None;
        }
        let _ = std::fs::remove_file(&path);
    }
    let listener = UnixListener::bind(&path).ok()?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buf = Vec::new();
            // A command line, not a file: 64 KiB is plenty.
            if (&mut stream).take(64 * 1024).read_to_end(&mut buf).is_err() {
                continue;
            }
            let args: Vec<String> = String::from_utf8_lossy(&buf).split('\0').map(str::to_string).collect();
            on_args(args);
            let _ = stream.write_all(b"1");
        }
    });
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory per test (no tempfile crate in src-tauri).
    struct Dir(PathBuf);
    impl Dir {
        fn path(&self) -> &std::path::Path { &self.0 }
    }
    impl Drop for Dir {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }
    fn tempdir(name: &str) -> Dir {
        let d = std::env::temp_dir().join(format!("plinky-handoff-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Dir(d)
    }

    #[test]
    fn a_second_launch_hands_its_arguments_to_the_first() {
        let dir = tempdir("handover");
        let path = dir.path().join("plinky-test.sock");
        let (tx, rx) = std::sync::mpsc::channel();
        listen(path.clone(), move |a| { let _ = tx.send(a); }).expect("listening");
        let argv: Vec<String> = ["plinky", "--telnet", "127.0.0.1", "5000", "--title", "R1 core"].iter().map(|s| s.to_string()).collect();
        assert!(try_hand_over(&path, &argv));
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), argv);
    }

    #[test]
    fn with_nobody_listening_the_launch_starts_its_own_window() {
        let dir = tempdir("nobody");
        assert!(!try_hand_over(&dir.path().join("none.sock"), &["plinky".into()]));
    }

    #[test]
    fn a_stale_socket_from_a_crash_is_replaced() {
        let dir = tempdir("stale");
        let path = dir.path().join("stale.sock");
        drop(UnixListener::bind(&path).unwrap()); // file left, nobody listening
        assert!(listen(path.clone(), |_| {}).is_some());
        assert!(try_hand_over(&path, &["plinky".into()]));
    }

    #[test]
    fn a_live_owner_keeps_the_socket() {
        let dir = tempdir("owner");
        let path = dir.path().join("owned.sock");
        assert!(listen(path.clone(), |_| {}).is_some());
        assert!(listen(path, |_| {}).is_none());
    }
}
