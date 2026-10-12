//! One long-lived psftp per SFTP target, for the quick actions.
//!
//! Every action used to be its own psftp process and its own SSH login:
//! opening a folder, listing it, making a directory. Browsing a few folders
//! and then downloading opened several connections in seconds, and a server
//! limiting new connections (ufw's `limit`, fail2ban, MaxStartups) dropped
//! some: the owner's download failed with "Connection timed out" while the
//! listing before it had worked. Now the quick actions (pwd, ls, mkdir, rm,
//! rmdir) share one logged-in psftp per target and take no new connection.
//!
//! Transfers keep a process of their own (see `PsftpClient::run_batch`): a
//! large download takes minutes, and on a shared session it would hold up
//! every listing in the pane behind it.
//!
//! psftp is driven over pipes: it reads one command per line and prints
//! "psftp> " when it is ready for the next. A failed command doesn't end it
//! or change anything but its output, so each caller says what success looks
//! like for its command (`ls` prints "Listing directory", `mkdir` ends ": OK").

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

use super::client::{describe_failure, never_connected, PsftpClient, PsftpPasswordGuard, CONNECT_ATTEMPTS, SFTP_TIMEOUT_SECS};
use crate::errors::{PlinkyError, Result};
use crate::transport::plink::ExplicitTarget;

const PROMPT: &[u8] = b"psftp> ";

/// A session unused this long is closed: servers drop idle logins anyway,
/// and a pane closed long ago shouldn't keep one open.
const IDLE_LIMIT: Duration = Duration::from_secs(5 * 60);

struct Session {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    last_used: Instant,
}

type Slot = Arc<Mutex<Option<Session>>>;

static SESSIONS: LazyLock<std::sync::Mutex<HashMap<u64, (Slot, Instant)>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// What a session is for. The password is part of it, hashed: a password
/// typed after "the password was not accepted" must get a new login, and
/// the table shouldn't hold passwords.
fn key(session_name: &str, target: Option<&ExplicitTarget>, password: Option<&str>) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    session_name.hash(&mut h);
    if let Some(t) = target {
        t.hostname.hash(&mut h);
        t.port.hash(&mut h);
        t.username.hash(&mut h);
    }
    password.hash(&mut h);
    h.finish()
}

/// The slot for a target, made if new. Slots idle past the limit are
/// dropped on the way, which ends their psftp (kill_on_drop) unless one is
/// in use right now.
fn slot_for(k: u64) -> Slot {
    let mut all = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    all.retain(|other, (slot, used)| *other == k || now.duration_since(*used) < IDLE_LIMIT || Arc::strong_count(slot) > 1);
    let entry = all.entry(k).or_insert_with(|| (Arc::new(Mutex::new(None)), now));
    entry.1 = now;
    entry.0.clone()
}

/// Reads until psftp's prompt ends the output. Ok(None) when psftp exited
/// first.
async fn read_reply(stdout: &mut ChildStdout) -> std::io::Result<Option<String>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = stdout.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
        // The prompt at the very end, at the start of a line. A listing line
        // ending in a file named "psftp> " has the rest of the line before it.
        if buf.ends_with(PROMPT) && (buf.len() == PROMPT.len() || buf[buf.len() - PROMPT.len() - 1] == b'\n') {
            buf.truncate(buf.len() - PROMPT.len());
            return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
        }
    }
}

async fn open(session_name: &str, target: Option<&ExplicitTarget>, password: Option<&str>) -> Result<Session> {
    PsftpClient::validate_session_name(session_name)?;
    let has_saved_session = putty_compat::sessions::read_session(session_name).is_ok();
    let binary = PsftpClient::find_binary()?;
    let mut attempt = 0;
    loop {
        attempt += 1;
        // psftp reads the password file while logging in; the guard can go
        // once the prompt is up.
        let pw_guard = PsftpPasswordGuard::create(password)?;
        let mut cmd = Command::new(&binary);
        cmd.args(PsftpClient::build_psftp_args(session_name, has_saved_session, target, pw_guard.path()))
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::hidden::tokio_command(&mut cmd);
        let mut child = cmd
            .spawn()
            .map_err(|e| PlinkyError::ProcessError(format!("Failed to start psftp: {e}")))?;
        let stdin = child.stdin.take().expect("piped");
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let errors = tokio::spawn(async move {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s).await;
            s
        });

        let limit = Duration::from_secs(SFTP_TIMEOUT_SECS);
        match timeout(limit, read_reply(&mut stdout)).await {
            Ok(Ok(Some(_banner))) => {
                drop(pw_guard);
                return Ok(Session { child, stdin, stdout, last_used: Instant::now() });
            }
            Ok(Ok(None)) | Ok(Err(_)) => {
                // psftp gave up before its prompt: the login failed.
                let _ = child.wait().await;
                let err = errors.await.unwrap_or_default();
                if attempt < CONNECT_ATTEMPTS && never_connected("", &err) {
                    tokio::time::sleep(Duration::from_secs(2 * attempt as u64)).await;
                    continue;
                }
                return Err(PlinkyError::ProcessError(describe_failure("", &err)));
            }
            Err(_) => {
                return Err(PlinkyError::ProcessError(format!(
                    "SFTP login timed out after {SFTP_TIMEOUT_SECS} seconds"
                )));
            }
        }
    }
}

/// Runs one psftp command on the target's session and returns its output.
///
/// `ok` says whether the output is a success; otherwise the error is the
/// line psftp printed about it. `read_only` commands are sent once more on
/// a fresh login when the session dies under them; a change (mkdir, rm) is
/// not, since it may have been done before the connection went.
pub async fn run(
    session_name: &str,
    target: Option<&ExplicitTarget>,
    password: Option<&str>,
    command: &str,
    read_only: bool,
    ok: impl Fn(&str) -> bool,
) -> Result<String> {
    let slot = slot_for(key(session_name, target, password));
    let mut held = slot.lock().await;
    let mut tries = 0;
    loop {
        tries += 1;
        // A session the server closed while idle has its psftp gone.
        let stale = match held.as_mut() {
            Some(s) => s.last_used.elapsed() >= IDLE_LIMIT || !matches!(s.child.try_wait(), Ok(None)),
            None => true,
        };
        if stale {
            *held = None;
            *held = Some(open(session_name, target, password).await?);
        }
        let s = held.as_mut().expect("opened above");
        let limit = Duration::from_secs(SFTP_TIMEOUT_SECS);
        let reply = timeout(limit, async {
            s.stdin.write_all(format!("{command}\n").as_bytes()).await?;
            s.stdin.flush().await?;
            read_reply(&mut s.stdout).await
        })
        .await;
        match reply {
            Ok(Ok(Some(out))) => {
                s.last_used = Instant::now();
                return if ok(&out) {
                    Ok(out)
                } else {
                    Err(PlinkyError::ProcessError(describe_failure(&out, "")))
                };
            }
            Ok(Ok(None)) | Ok(Err(_)) => {
                // The connection went mid-command.
                *held = None;
                if read_only && tries < 2 {
                    continue;
                }
                return Err(PlinkyError::ProcessError("The SFTP connection was lost. Try again.".into()));
            }
            Err(_) => {
                // Unknown state: the next action gets a fresh login.
                *held = None;
                return Err(PlinkyError::ProcessError(format!(
                    "SFTP operation timed out after {SFTP_TIMEOUT_SECS} seconds"
                )));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_password_is_a_new_session_and_the_same_one_is_not() {
        let t = ExplicitTarget {
            hostname: "192.0.2.10".into(),
            port: 22,
            username: Some("ops".into()),
            protocol: crate::transport::plink::TargetProtocol::Ssh,
        };
        assert_eq!(key("s", Some(&t), Some("a")), key("s", Some(&t), Some("a")));
        assert_ne!(key("s", Some(&t), Some("a")), key("s", Some(&t), Some("b")));
        assert_ne!(key("s", Some(&t), None), key("s", None, None));
    }
}
