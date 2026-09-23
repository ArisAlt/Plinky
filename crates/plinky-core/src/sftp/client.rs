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

    /// Validates remote path against injection characters (\n, \r, \0).
    pub fn validate_path(path: &str) -> Result<()> {
        if path.contains('\n') || path.contains('\r') || path.contains('\0') {
            return Err(PlinkyError::ProcessError(
                "Security violation: path contains prohibited newline or null characters".into(),
            ));
        }
        if path.trim().is_empty() {
            return Err(PlinkyError::ProcessError("Path cannot be empty".into()));
        }
        Ok(())
    }

    /// Validates session name against injection characters.
    pub fn validate_session_name(session_name: &str) -> Result<()> {
        if session_name.contains('\n') || session_name.contains('\r') || session_name.contains('\0') {
            return Err(PlinkyError::ProcessError(
                "Security violation: session name contains prohibited control characters".into(),
            ));
        }
        if session_name.trim().is_empty() {
            return Err(PlinkyError::ProcessError("Session name cannot be empty".into()));
        }
        Ok(())
    }

    /// Escapes double quotes using PuTTY's "" convention and wraps in double quotes.
    pub fn escape_psftp_path(path: &str) -> String {
        let escaped = path.replace('"', "\"\"");
        format!("\"{}\"", escaped)
    }

    /// Lists files in `remote_path` for `session_name` via plain `psftp`.
    pub async fn list_dir(session_name: &str, remote_path: &str) -> Result<Vec<SftpFileEntry>> {
        Self::validate_session_name(session_name)?;
        Self::validate_path(remote_path)?;
        let escaped_path = Self::escape_psftp_path(remote_path);

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
        let script = format!("cd {}\nls\nquit\n", escaped_path);
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
        Self::validate_session_name(session_name)?;
        Self::validate_path(remote_path)?;
        let escaped_path = Self::escape_psftp_path(remote_path);

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

        let script = format!("mkdir {}\nquit\n", escaped_path);
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
        Self::validate_session_name(session_name)?;
        Self::validate_path(remote_path)?;
        let escaped_path = Self::escape_psftp_path(remote_path);

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

        let script = format!("rm {}\nquit\n", escaped_path);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_path_accepts_clean_paths() {
        assert!(PsftpClient::validate_path("/var/www/html").is_ok());
        assert!(PsftpClient::validate_path("my folder with spaces").is_ok());
        assert!(PsftpClient::validate_path("file_name-123.tar.gz").is_ok());
        assert!(PsftpClient::validate_path(r#"path with "quotes""#).is_ok());
    }

    #[test]
    fn test_validate_path_rejects_newline_injection() {
        let poc = "/var/www\n!touch /tmp/plinky_poc_test\ncd \"bar";
        let res = PsftpClient::validate_path(poc);
        assert!(res.is_err());
        let err_msg = res.unwrap_err().to_string();
        assert!(err_msg.contains("Security violation"));
    }

    #[test]
    fn test_validate_path_rejects_carriage_return_and_null() {
        assert!(PsftpClient::validate_path("path\rwith\rCR").is_err());
        assert!(PsftpClient::validate_path("path\0with\0NULL").is_err());
    }

    #[test]
    fn test_escape_psftp_path() {
        assert_eq!(
            PsftpClient::escape_psftp_path("/simple/path"),
            "\"/simple/path\""
        );
        assert_eq!(
            PsftpClient::escape_psftp_path("path with spaces"),
            "\"path with spaces\""
        );
        assert_eq!(
            PsftpClient::escape_psftp_path(r#"path with "quotes""#),
            r#""path with ""quotes""""#
        );
    }
}
