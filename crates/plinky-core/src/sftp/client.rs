use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use crate::errors::{PlinkyError, Result};
use super::parser::{parse_psftp_ls_output, SftpFileEntry};

/// Client wrapper around PuTTY's `psftp` CLI binary (ADR-003 Option B).
pub struct PsftpClient;

impl PsftpClient {
    /// Discovers psftp executable on the host system.
    pub fn find_binary() -> Result<std::path::PathBuf> {
        if let Ok(path) = std::env::var("PUTTY_PSFTP_PATH") {
            let p = std::path::PathBuf::from(path);
            if p.exists() {
                return Ok(p);
            }
        }

        #[cfg(not(windows))]
        {
            let candidates = ["/usr/bin/psftp", "/usr/local/bin/psftp", "/bin/psftp"];
            for p in &candidates {
                let path = std::path::Path::new(p);
                if path.is_file() {
                    return Ok(path.to_path_buf());
                }
            }
        }

        #[cfg(windows)]
        {
            let candidates = [
                r"C:\Program Files\PuTTY\psftp.exe",
                r"C:\Program Files (x86)\PuTTY\psftp.exe",
            ];
            for p in &candidates {
                let path = std::path::Path::new(p);
                if path.is_file() {
                    return Ok(path.to_path_buf());
                }
            }
        }

        // Fallback to checking PATH
        if let Ok(output) = std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
            .arg(if cfg!(windows) { "psftp.exe" } else { "psftp" })
            .output()
        {
            if output.status.success() {
                let line = String::from_utf8_lossy(&output.stdout);
                if let Some(first) = line.lines().next() {
                    let p = std::path::PathBuf::from(first.trim());
                    if p.is_file() {
                        return Ok(p);
                    }
                }
            }
        }

        Err(PlinkyError::ProcessError(
            "psftp executable not found on system PATH. Please install PuTTY or set PUTTY_PSFTP_PATH.".into(),
        ))
    }

    /// Lists files in `remote_path` for `session_name` via plain `psftp`.
    pub async fn list_dir(session_name: &str, remote_path: &str) -> Result<Vec<SftpFileEntry>> {
        let psftp_path = Self::find_binary()?;
        let mut cmd = Command::new(psftp_path);

        cmd.arg("-batch")
            .arg("-load")
            .arg(session_name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            PlinkyError::ProcessError(format!("Failed to spawn psftp: {}", e))
        })?;

        // Prepare commands to execute
        let script = format!("cd \"{}\"\nls\nquit\n", remote_path);
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(script.as_bytes()).await;
            let _ = stdin.flush().await;
        }

        let output = child.wait_with_output().await.map_err(|e| {
            PlinkyError::ProcessError(format!("psftp execution failed: {}", e))
        })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let files = parse_psftp_ls_output(&stdout);
        Ok(files)
    }

    /// Creates a directory on the remote server.
    pub async fn create_dir(session_name: &str, remote_path: &str) -> Result<()> {
        let psftp_path = Self::find_binary()?;
        let mut cmd = Command::new(psftp_path);

        cmd.arg("-batch")
            .arg("-load")
            .arg(session_name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            PlinkyError::ProcessError(format!("Failed to spawn psftp: {}", e))
        })?;

        let script = format!("mkdir \"{}\"\nquit\n", remote_path);
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(script.as_bytes()).await;
            let _ = stdin.flush().await;
        }

        let output = child.wait_with_output().await.map_err(|e| {
            PlinkyError::ProcessError(format!("psftp execution failed: {}", e))
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(PlinkyError::ProcessError(format!("mkdir failed: {}", stderr)));
        }

        Ok(())
    }

    /// Removes a file on the remote server.
    pub async fn remove_file(session_name: &str, remote_path: &str) -> Result<()> {
        let psftp_path = Self::find_binary()?;
        let mut cmd = Command::new(psftp_path);

        cmd.arg("-batch")
            .arg("-load")
            .arg(session_name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            PlinkyError::ProcessError(format!("Failed to spawn psftp: {}", e))
        })?;

        let script = format!("rm \"{}\"\nquit\n", remote_path);
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(script.as_bytes()).await;
            let _ = stdin.flush().await;
        }

        let output = child.wait_with_output().await.map_err(|e| {
            PlinkyError::ProcessError(format!("psftp execution failed: {}", e))
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(PlinkyError::ProcessError(format!("rm failed: {}", stderr)));
        }

        Ok(())
    }
}
