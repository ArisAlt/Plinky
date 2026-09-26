//! SFTP against a real, throwaway sshd (key auth, ephemeral keys, its own
//! PUTTYDIR). Skips cleanly when sshd, psftp or puttygen are missing.
//!
//! One test function on purpose: PUTTYDIR is process-wide, and psftp reads
//! it for both the saved session and the host-key cache.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::io::Write;
use std::time::Duration;

use plinky_core::sftp::client::{ERR_HOSTKEY, ERR_PASSWORD};
use plinky_core::{PlinkyError, PsftpClient};
use plinky_core::transport::plink::ExplicitTarget;

/// The message the UI gets (lib.rs passes a ProcessError's text through).
fn message(e: PlinkyError) -> String {
    match e {
        PlinkyError::ProcessError(m) => m,
        other => other.to_string(),
    }
}

struct Sshd {
    child: Child,
    port: u16,
}

impl Drop for Sshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn tool(name: &str, arg: &str) -> bool {
    Command::new(name).arg(arg).output().is_ok()
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn start_sshd(dir: &Path) -> Option<Sshd> {
    let sshd = ["/usr/sbin/sshd", "/usr/bin/sshd"].iter().map(PathBuf::from).find(|p| p.is_file())?;
    for (k, _) in [("host_key", ()), ("client_key", ())] {
        let ok = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(dir.join(k))
            .status()
            .ok()?
            .success();
        if !ok {
            return None;
        }
    }
    Command::new("puttygen")
        .arg(dir.join("client_key"))
        .args(["-O", "private", "-o"])
        .arg(dir.join("client_key.ppk"))
        .output()
        .ok()?;
    std::fs::copy(dir.join("client_key.pub"), dir.join("authorized_keys")).ok()?;

    let port = free_port();
    let config = format!(
        "Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/host_key\nAuthorizedKeysFile {d}/authorized_keys\n\
         PasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\n\
         StrictModes no\nPidFile {d}/sshd.pid\nSubsystem sftp internal-sftp\n",
        d = dir.display()
    );
    std::fs::write(dir.join("sshd_config"), config).ok()?;
    let child = Command::new(sshd)
        .arg("-D")
        .arg("-f")
        .arg(dir.join("sshd_config"))
        .arg("-E")
        .arg(dir.join("sshd.log"))
        .spawn()
        .ok()?;
    for _ in 0..50 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Some(Sshd { child, port });
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

/// Accepts the host key into `putty_dir` the way a user would once: psftp
/// without -batch reads the "y" from stdin when there's no terminal.
fn trust_host_key(putty_dir: &Path, port: u16, key: &Path) {
    let user = std::env::var("USER").unwrap_or_default();
    let mut child = Command::new("psftp")
        .env("PUTTYDIR", putty_dir)
        .args(["-P", &port.to_string(), "-i"])
        .arg(key)
        .arg(format!("{user}@127.0.0.1"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"y\nquit\n").unwrap();
    let _ = child.wait();
}

#[tokio::test]
async fn test_sftp_operations_report_real_success_and_real_failure() {
    // Windows PuTTYgen is a GUI program: `puttygen -V` below opens a window
    // and waits for someone to close it. On CI's Windows runner nobody did,
    // and the job hung until GitHub killed it after 6 hours -- every run
    // from 07:32 on 2026-09-26. The fixture needs Unix sshd and command-line
    // puttygen anyway.
    if cfg!(windows) {
        eprintln!("skipping: needs Unix sshd and command-line puttygen");
        return;
    }
    if !tool("psftp", "-V") || !tool("puttygen", "-V") || !tool("ssh-keygen", "-?") {
        eprintln!("skipping: PuTTY tools or ssh-keygen missing");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let Some(sshd) = start_sshd(d) else {
        eprintln!("skipping: couldn't start a test sshd");
        return;
    };
    let putty = d.join("putty");
    std::fs::create_dir_all(putty.join("sessions")).unwrap();
    std::env::set_var("PUTTYDIR", &putty);
    trust_host_key(&putty, sshd.port, &d.join("client_key.ppk"));

    let user = std::env::var("USER").unwrap_or_default();
    std::fs::write(
        putty.join("sessions").join("sftp-test"),
        format!(
            "HostName=127.0.0.1\nPortNumber={}\nUserName={user}\nProtocol=ssh\nPublicKeyFile={}\n",
            sshd.port,
            d.join("client_key.ppk").display()
        ),
    )
    .unwrap();
    let s = "sftp-test";
    let remote = d.join("remote");
    std::fs::create_dir(&remote).unwrap();
    let local = d.join("local.txt");
    std::fs::write(&local, b"hello from plinky").unwrap();
    let p = |x: &Path| x.to_string_lossy().into_owned();

    // The remote pane opens in the user's home, as psftp reports it.
    let home = PsftpClient::home_dir(s, None, None).await.expect("pwd");
    assert_eq!(home, std::env::var("HOME").unwrap());

    // Upload that works lands on the server.
    let up = remote.join("up.txt");
    PsftpClient::upload_file(s, &p(&local), &p(&up), None, None).await.expect("upload");
    assert_eq!(std::fs::read(&up).unwrap(), b"hello from plinky");

    // Failures used to come back Ok(()) -- psftp exits 0 for a failed
    // command read from stdin. Each must now be an error with the reason.
    let denied = PsftpClient::upload_file(s, &p(&local), "/root/plinky-denied.txt", None, None).await;
    assert!(denied.as_ref().unwrap_err().to_string().contains("permission denied"), "{denied:?}");

    let dl = d.join("dl.txt");
    let missing = PsftpClient::download_file(s, "/nonexistent/nofile", &p(&dl), None, None).await;
    assert!(missing.as_ref().unwrap_err().to_string().contains("no such file"), "{missing:?}");
    assert!(!dl.exists(), "a failed download must not leave a file");
    assert!(!Path::new(&format!("{}.plinky-part", p(&dl))).exists(), "nor its partial");

    let listing = PsftpClient::list_dir(s, "/root", None, None).await;
    assert!(listing.is_err(), "an unreadable dir must not list as empty: {listing:?}");

    // Download that works, through a name that needs psftp's "" quoting.
    let odd = remote.join("we\"ird name.txt");
    std::fs::write(&odd, b"quoted").unwrap();
    let got = d.join("got it.txt");
    PsftpClient::download_file(s, &p(&odd), &p(&got), None, None).await.expect("download");
    assert_eq!(std::fs::read(&got).unwrap(), b"quoted");

    // Listing, mkdir, rmdir.
    let names: Vec<String> = PsftpClient::list_dir(s, &p(&remote), None, None)
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert!(names.contains(&"up.txt".to_string()) && names.contains(&"we\"ird name.txt".to_string()), "{names:?}");
    let sub = remote.join("sub dir");
    PsftpClient::create_dir(s, &p(&sub), None, None).await.expect("mkdir");
    assert!(sub.is_dir());
    PsftpClient::remove_dir(s, &p(&sub), None, None).await.expect("rmdir");
    assert!(!sub.exists());
    assert!(PsftpClient::remove_dir(s, &p(&sub), None, None).await.is_err());

    // A server whose key was never accepted says so, in a way the UI can act on.
    let fresh = d.join("putty-fresh");
    std::fs::create_dir_all(&fresh).unwrap();
    std::env::set_var("PUTTYDIR", &fresh);
    let target = ExplicitTarget { hostname: "127.0.0.1".into(), port: sshd.port, username: Some(user.clone()) };
    let err = message(PsftpClient::home_dir("quick-connect", Some(&target), None).await.unwrap_err());
    assert!(err.starts_with(ERR_HOSTKEY), "{err}");

    // Key accepted, but no credentials the server takes: the UI's cue for a
    // password prompt is the [password] prefix -- this server offers
    // publickey only, so it's a plain auth error instead.
    std::env::set_var("PUTTYDIR", &putty);
    let err = message(PsftpClient::home_dir("quick-connect", Some(&target), None).await.unwrap_err());
    assert!(err.contains("No supported authentication methods"), "{err}");
    assert!(!err.starts_with(ERR_PASSWORD));
}
