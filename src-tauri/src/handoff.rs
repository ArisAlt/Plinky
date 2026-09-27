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
//!
//! Only a socket this user owns is ever used. The first version fell back
//! to `/tmp/<id>-<user>.sock`, a name any local user could create first:
//! a squatter then received every console request (host, port, title,
//! `--ssh` user) and acknowledged it, so the launch exited and no console
//! opened. Now the fallback is a directory named by uid, created 0700 and
//! refused unless it is ours and private (the tmux pattern), and both sides
//! check that the socket is a socket owned by us, never following a
//! symlink. Anything else skips the handoff: the launch opens its own
//! window, which is the pre-handoff behaviour, not a failure.

use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn my_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// `dir` is a real directory (not a symlink) owned by `uid`, closed to
/// group and others.
fn private_dir(dir: &Path, uid: u32) -> bool {
    std::fs::symlink_metadata(dir)
        .is_ok_and(|m| m.file_type().is_dir() && m.uid() == uid && m.mode() & 0o077 == 0)
}

/// `$XDG_RUNTIME_DIR/<identifier>.sock` when the runtime dir is private to
/// this user (as the XDG spec requires, but checked), else
/// `<tmp>/<identifier>-<uid>/handoff.sock` in a directory made 0700. None
/// when neither is safe: the directory exists but belongs to someone else,
/// or is open to them.
pub fn socket_path(identifier: &str) -> Option<PathBuf> {
    socket_path_in(
        std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from),
        &std::env::temp_dir(),
        identifier,
        my_uid(),
    )
}

fn socket_path_in(runtime_dir: Option<PathBuf>, tmp: &Path, identifier: &str, uid: u32) -> Option<PathBuf> {
    if let Some(dir) = runtime_dir.filter(|d| private_dir(d, uid)) {
        return Some(dir.join(format!("{identifier}.sock")));
    }
    let dir = tmp.join(format!("{identifier}-{uid}"));
    // Fails harmlessly when it exists; its owner and mode are checked next
    // either way, so a directory someone else made first is refused.
    let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
    private_dir(&dir, uid).then(|| dir.join("handoff.sock"))
}

#[derive(Debug, PartialEq, Eq)]
enum Existing {
    Nothing,
    /// A socket owned by `uid`.
    Ours,
    /// Anything else: another user's socket, a symlink, a regular file.
    Foreign,
}

fn existing(path: &Path, uid: u32) -> Existing {
    match std::fs::symlink_metadata(path) {
        Err(_) => Existing::Nothing,
        Ok(m) if m.file_type().is_socket() && m.uid() == uid => Existing::Ours,
        Ok(_) => Existing::Foreign,
    }
}

/// Sends the arguments to a running Plinky. True if one took them.
pub fn try_hand_over(path: &Path, args: &[String]) -> bool {
    hand_over_as(path, args, my_uid())
}

fn hand_over_as(path: &Path, args: &[String], uid: u32) -> bool {
    // A socket that isn't ours could be anyone's listener. In a private
    // directory nobody else can swap the file between this check and the
    // connect.
    if existing(path, uid) != Existing::Ours {
        return false;
    }
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
/// None when another live Plinky already owns the socket, or the path holds
/// something that isn't ours to replace.
pub fn listen<F>(path: PathBuf, on_args: F) -> Option<()>
where
    F: Fn(Vec<String>) + Send + 'static,
{
    listen_as(path, my_uid(), on_args)
}

fn listen_as<F>(path: PathBuf, uid: u32, on_args: F) -> Option<()>
where
    F: Fn(Vec<String>) + Send + 'static,
{
    match existing(&path, uid) {
        Existing::Nothing => {}
        // A socket nobody answers on is left over from a crash; a live one
        // belongs to another Plinky (then that one gets the launches).
        Existing::Ours => {
            if UnixStream::connect(&path).is_ok() {
                return None;
            }
            let _ = std::fs::remove_file(&path);
        }
        Existing::Foreign => return None,
    }
    let listener = UnixListener::bind(&path).ok()?;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
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
        fn path(&self) -> &Path { &self.0 }
    }
    impl Drop for Dir {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }
    fn tempdir(name: &str) -> Dir {
        let d = std::env::temp_dir().join(format!("plinky-handoff-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700)).unwrap();
        Dir(d)
    }

    /// A uid that isn't ours: stands in for another local user, whose files
    /// a test can't create without root.
    fn someone_else() -> u32 {
        my_uid().wrapping_add(1)
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

    #[test]
    fn a_socket_owned_by_another_user_is_never_handed_the_request() {
        // The squatter: a listener at our path that acknowledges everything.
        // Before the check, the launch sent it the console arguments and
        // exited, and no console opened.
        let dir = tempdir("squat");
        let path = dir.path().join("squat.sock");
        let (tx, rx) = std::sync::mpsc::channel();
        listen(path.clone(), move |a| { let _ = tx.send(a); }).expect("listening");
        assert!(!hand_over_as(&path, &["plinky".into(), "--ssh".into(), "ops@core".into()], someone_else()));
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "nothing was sent");
    }

    #[test]
    fn another_users_socket_is_left_alone_not_replaced() {
        let dir = tempdir("foreign");
        let path = dir.path().join("foreign.sock");
        drop(UnixListener::bind(&path).unwrap()); // stale, but not ours
        assert!(listen_as(path.clone(), someone_else(), |_| {}).is_none());
        assert!(path.exists(), "not deleted");
    }

    #[test]
    fn a_symlink_or_a_plain_file_is_not_a_socket_of_ours() {
        let dir = tempdir("links");
        let real = dir.path().join("real.sock");
        listen(real.clone(), |_| {}).expect("listening");
        let link = dir.path().join("link.sock");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(!try_hand_over(&link, &["plinky".into()]));
        let file = dir.path().join("file.sock");
        std::fs::write(&file, b"").unwrap();
        assert!(!try_hand_over(&file, &["plinky".into()]));
        assert!(listen(file.clone(), |_| {}).is_none());
        assert!(file.exists(), "not deleted");
    }

    #[test]
    fn the_fallback_directory_is_private_and_named_by_uid() {
        let tmp = tempdir("fallback");
        let p = socket_path_in(None, tmp.path(), "com.plinky.test", my_uid()).expect("a safe path");
        let d = p.parent().unwrap();
        assert_eq!(d.file_name().unwrap().to_string_lossy(), format!("com.plinky.test-{}", my_uid()));
        assert_eq!(std::fs::metadata(d).unwrap().mode() & 0o777, 0o700);
    }

    #[test]
    fn a_fallback_directory_someone_else_made_first_is_refused() {
        let tmp = tempdir("squatdir");
        // Made by "another user" (the uid we claim below isn't ours), or
        // made by us but left open to others: neither is used.
        assert!(socket_path_in(None, tmp.path(), "id", someone_else()).is_none());
        let open = tmp.path().join(format!("id2-{}", my_uid()));
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(socket_path_in(None, tmp.path(), "id2", my_uid()).is_none());
    }

    #[test]
    fn a_symlinked_fallback_directory_is_refused() {
        let tmp = tempdir("dirlink");
        let target = tmp.path().join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::os::unix::fs::symlink(&target, tmp.path().join(format!("id-{}", my_uid()))).unwrap();
        assert!(socket_path_in(None, tmp.path(), "id", my_uid()).is_none());
    }

    #[test]
    fn the_runtime_dir_is_used_only_when_it_is_private() {
        let tmp = tempdir("runtime");
        let run = tmp.path().join("run");
        std::fs::create_dir(&run).unwrap();
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(socket_path_in(Some(run.clone()), tmp.path(), "id", my_uid()), Some(run.join("id.sock")));
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o755)).unwrap();
        let fallback = socket_path_in(Some(run), tmp.path(), "id", my_uid()).unwrap();
        assert!(fallback.ends_with(format!("id-{}/handoff.sock", my_uid())));
    }
}
