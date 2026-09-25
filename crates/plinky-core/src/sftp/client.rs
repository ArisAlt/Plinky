use std::io::Write as _;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use crate::errors::{PlinkyError, Result};
use super::parser::{parse_psftp_ls_output, SftpFileEntry};

/// Time limit for quick operations (ls, mkdir, rm). Transfers get none: a
/// large file over a slow link legitimately takes longer than any fixed
/// limit, and killing it left a partial file behind.
pub const SFTP_TIMEOUT_SECS: u64 = 30;

/// Prefix on errors the UI acts on: it offers a password prompt.
pub const ERR_PASSWORD: &str = "[password] ";
/// Prefix on errors the UI acts on: the host key must be accepted first.
pub const ERR_HOSTKEY: &str = "[hostkey] ";

/// Turns psftp's failure output into one message. The FATAL ERROR texts
/// below are psftp 0.85's, measured against a real sshd.
fn describe_failure(stdout: &str, stderr: &str) -> String {
    let all = format!("{stdout}\n{stderr}");
    if all.contains("Cannot confirm a host key in batch mode") {
        return format!(
            "{ERR_HOSTKEY}This server's host key isn't trusted yet. Open the session in a terminal tab once and accept its key, then try again."
        );
    }
    if all.contains("Cannot answer interactive prompts in batch mode") {
        return format!("{ERR_PASSWORD}This server needs a password.");
    }
    if all.contains("Configured password was not accepted") {
        return format!("{ERR_PASSWORD}The password was not accepted.");
    }
    // Otherwise the last line psftp printed about the failure, e.g.
    // "/root/x: open for write: permission denied".
    let noise = |l: &&str| {
        let l = l.trim();
        !l.is_empty()
            && !l.starts_with("Using username")
            && !l.starts_with("Remote working directory")
            && !l.starts_with("local:")
            && !l.starts_with("remote:")
            && !l.starts_with("Listing directory")
    };
    stdout
        .lines()
        .chain(stderr.lines())
        .rfind(noise)
        .map(|l| l.trim().trim_start_matches("FATAL ERROR: ").to_string())
        .unwrap_or_else(|| "SFTP operation failed".to_string())
}

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

    /// Builds the psftp CLI args for a session, supporting both real saved sessions
    /// and explicit targets (Quick Connect or split pane sessions).
    pub fn build_psftp_args(
        session_name: &str,
        has_saved_session: bool,
        explicit_target: Option<&crate::transport::plink::ExplicitTarget>,
        pw_file: Option<&std::path::Path>,
    ) -> Vec<String> {
        let mut args = vec!["-batch".to_string()];
        if let Some(pw) = pw_file {
            args.push("-pwfile".to_string());
            args.push(pw.to_string_lossy().to_string());
        }
        if has_saved_session {
            args.push("-load".to_string());
            args.push(session_name.to_string());
        } else if let Some(target) = explicit_target {
            if let Some(user) = target.username.as_deref().filter(|u| !u.is_empty()) {
                args.push(format!("{user}@{}", target.hostname));
            } else {
                args.push(target.hostname.clone());
            }
            args.push("-P".to_string());
            args.push(target.port.to_string());
        } else {
            args.push("-load".to_string());
            args.push(session_name.to_string());
        }
        args
    }

    /// Runs `script` as a psftp batch file and returns what psftp printed.
    ///
    /// Commands used to be piped to psftp's stdin, where a failed command
    /// doesn't change the exit status: measured against a real sshd, psftp
    /// exited 0 after "open for write: permission denied", "no such file or
    /// directory" and the rest, so failed uploads and downloads showed as
    /// completed. With `-b <file>` psftp stops at the first failed command
    /// and exits non-zero, with the reason on stdout.
    async fn run_batch(
        session_name: &str,
        explicit_target: Option<&crate::transport::plink::ExplicitTarget>,
        password: Option<&str>,
        script: &str,
        limit: Option<Duration>,
    ) -> Result<String> {
        Self::validate_session_name(session_name)?;
        let pw_guard = PsftpPasswordGuard::create(password)?;
        let mut batch = tempfile::Builder::new()
            .prefix(".plinky_psftp_batch_")
            .tempfile()
            .map_err(|e| PlinkyError::ProcessError(format!("Failed to create psftp batch file: {e}")))?;
        batch
            .write_all(script.as_bytes())
            .and_then(|_| batch.flush())
            .map_err(|e| PlinkyError::ProcessError(format!("Failed to write psftp batch file: {e}")))?;

        let has_saved_session = putty_compat::sessions::read_session(session_name).is_ok();
        let mut cmd = Command::new(Self::find_binary()?);
        cmd.args(Self::build_psftp_args(session_name, has_saved_session, explicit_target, pw_guard.path()))
            .arg("-b")
            .arg(batch.path())
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = cmd
            .spawn()
            .map_err(|e| PlinkyError::ProcessError(format!("Failed to start psftp: {e}")))?;

        let output = match limit {
            Some(d) => timeout(d, child.wait_with_output()).await.map_err(|_| {
                PlinkyError::ProcessError(format!("SFTP operation timed out after {} seconds", d.as_secs()))
            })?,
            None => child.wait_with_output().await,
        }
        .map_err(|e| PlinkyError::ProcessError(format!("psftp failed: {e}")))?;

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        if output.status.success() {
            return Ok(stdout);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(PlinkyError::ProcessError(describe_failure(&stdout, &stderr)))
    }

    fn quick() -> Option<Duration> {
        Some(Duration::from_secs(SFTP_TIMEOUT_SECS))
    }

    /// The remote working directory psftp starts in: the user's home.
    pub async fn home_dir(
        session_name: &str,
        explicit_target: Option<&crate::transport::plink::ExplicitTarget>,
        password: Option<&str>,
    ) -> Result<String> {
        let out = Self::run_batch(session_name, explicit_target, password, "pwd\n", Self::quick()).await?;
        out.lines()
            .find_map(|l| l.trim().strip_prefix("Remote directory is "))
            .map(|p| p.trim().to_string())
            .ok_or_else(|| PlinkyError::ProcessError("psftp did not report a remote directory".into()))
    }

    /// Lists files in `remote_path`.
    pub async fn list_dir(
        session_name: &str,
        remote_path: &str,
        explicit_target: Option<&crate::transport::plink::ExplicitTarget>,
        password: Option<&str>,
    ) -> Result<Vec<SftpFileEntry>> {
        Self::validate_path(remote_path)?;
        let script = format!("ls {}\n", Self::escape_psftp_path(remote_path));
        let out = Self::run_batch(session_name, explicit_target, password, &script, Self::quick()).await?;
        Ok(parse_psftp_ls_output(&out))
    }

    /// Creates a directory on the remote server.
    pub async fn create_dir(
        session_name: &str,
        remote_path: &str,
        explicit_target: Option<&crate::transport::plink::ExplicitTarget>,
        password: Option<&str>,
    ) -> Result<()> {
        Self::validate_path(remote_path)?;
        let script = format!("mkdir {}\n", Self::escape_psftp_path(remote_path));
        Self::run_batch(session_name, explicit_target, password, &script, Self::quick()).await.map(|_| ())
    }

    /// Removes a file on the remote server.
    pub async fn remove_file(
        session_name: &str,
        remote_path: &str,
        explicit_target: Option<&crate::transport::plink::ExplicitTarget>,
        password: Option<&str>,
    ) -> Result<()> {
        Self::validate_path(remote_path)?;
        let script = format!("rm {}\n", Self::escape_psftp_path(remote_path));
        Self::run_batch(session_name, explicit_target, password, &script, Self::quick()).await.map(|_| ())
    }

    /// Removes an (empty) directory on the remote server.
    pub async fn remove_dir(
        session_name: &str,
        remote_path: &str,
        explicit_target: Option<&crate::transport::plink::ExplicitTarget>,
        password: Option<&str>,
    ) -> Result<()> {
        Self::validate_path(remote_path)?;
        let script = format!("rmdir {}\n", Self::escape_psftp_path(remote_path));
        Self::run_batch(session_name, explicit_target, password, &script, Self::quick()).await.map(|_| ())
    }

    /// Uploads a local file to `remote_path` (the full destination path).
    pub async fn upload_file(
        session_name: &str,
        local_path: &str,
        remote_path: &str,
        explicit_target: Option<&crate::transport::plink::ExplicitTarget>,
        password: Option<&str>,
    ) -> Result<()> {
        Self::validate_path(remote_path)?;
        Self::validate_path(local_path)?;
        if !std::path::Path::new(local_path).is_file() {
            return Err(PlinkyError::ProcessError(format!("Not a local file: {local_path}")));
        }
        let script = format!(
            "put {} {}\n",
            Self::escape_psftp_path(local_path),
            Self::escape_psftp_path(remote_path)
        );
        Self::run_batch(session_name, explicit_target, password, &script, None).await.map(|_| ())
    }

    /// Downloads `remote_path` to `local_path` (the full destination path).
    ///
    /// psftp writes into the destination as it goes, so a transfer that
    /// fails halfway -- or overwrites an existing file -- would leave a
    /// truncated file under the real name. It downloads to a sibling
    /// ".plinky-part" file and renames it into place only on success.
    pub async fn download_file(
        session_name: &str,
        remote_path: &str,
        local_path: &str,
        explicit_target: Option<&crate::transport::plink::ExplicitTarget>,
        password: Option<&str>,
    ) -> Result<()> {
        Self::validate_path(remote_path)?;
        Self::validate_path(local_path)?;
        let dest = std::path::Path::new(local_path);
        // The destination is built from a name the server chose. A server can
        // return "../../.bashrc"; never let that climb out of the folder.
        if dest.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(PlinkyError::ProcessError(format!("Refusing download path with '..': {local_path}")));
        }
        let part = format!("{local_path}.plinky-part");
        let script = format!(
            "get {} {}\n",
            Self::escape_psftp_path(remote_path),
            Self::escape_psftp_path(&part)
        );
        let result = Self::run_batch(session_name, explicit_target, password, &script, None).await;
        match result {
            Ok(_) => std::fs::rename(&part, dest).map_err(|e| {
                let _ = std::fs::remove_file(&part);
                PlinkyError::ProcessError(format!("Downloaded, but couldn't move it into place: {e}"))
            }),
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                Err(e)
            }
        }
    }

    /// Lists entries in a local filesystem directory.
    pub fn list_local_dir(local_path: &str) -> Result<Vec<SftpFileEntry>> {
        let path = if local_path.starts_with('~') {
            if let Ok(home) = std::env::var("HOME") {
                std::path::PathBuf::from(local_path.replacen('~', &home, 1))
            } else {
                std::path::PathBuf::from(local_path)
            }
        } else {
            std::path::PathBuf::from(local_path)
        };

        let canonical = match path.canonicalize() {
            Ok(c) => c,
            Err(_) => path.clone(),
        };

        let read_dir = std::fs::read_dir(&canonical).map_err(|e| {
            PlinkyError::ProcessError(format!("Failed to read local directory '{}': {}", canonical.display(), e))
        })?;

        let mut entries = Vec::new();

        // Include parent directory if not filesystem root
        if canonical.parent().is_some() {
            entries.push(SftpFileEntry {
                name: "..".to_string(),
                is_dir: true,
                is_symlink: false,
                size: 4096,
                permissions: "drwxr-xr-x".to_string(),
                owner: "".to_string(),
                group: "".to_string(),
                modified: "".to_string(),
            });
        }

        for entry in read_dir.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            // DirEntry::metadata doesn't follow symlinks, so a link to a
            // folder listed as a file you couldn't open. Follow it for
            // the type and size; a broken link falls back to the link.
            let is_symlink = entry.file_type().map(|t| t.is_symlink()).unwrap_or(false);
            if let Ok(meta) = std::fs::metadata(entry.path()).or_else(|_| entry.metadata()) {
                let is_dir = meta.is_dir();
                let size = meta.len();

                #[cfg(unix)]
                let permissions = {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = meta.permissions().mode();
                    let dir_char = if is_dir { 'd' } else if is_symlink { 'l' } else { '-' };
                    let rwx = |shift: u32| -> String {
                        let r = if (mode >> (shift + 2)) & 1 == 1 { 'r' } else { '-' };
                        let w = if (mode >> (shift + 1)) & 1 == 1 { 'w' } else { '-' };
                        let x = if (mode >> shift) & 1 == 1 { 'x' } else { '-' };
                        format!("{r}{w}{x}")
                    };
                    format!("{}{}{}{}", dir_char, rwx(6), rwx(3), rwx(0))
                };

                #[cfg(not(unix))]
                let permissions = if is_dir { "drwxr-xr-x".to_string() } else { "-rw-r--r--".to_string() };

                let modified = meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| format_unix_timestamp(d.as_secs()))
                    .unwrap_or_default();

                entries.push(SftpFileEntry {
                    name: file_name,
                    is_dir,
                    is_symlink,
                    size,
                    permissions,
                    owner: "".to_string(),
                    group: "".to_string(),
                    modified,
                });
            }
        }

        // Sort: ".." always first, then directories alphabetically, then files alphabetically
        entries.sort_by(|a, b| {
            if a.name == ".." {
                return std::cmp::Ordering::Less;
            }
            if b.name == ".." {
                return std::cmp::Ordering::Greater;
            }
            if a.is_dir != b.is_dir {
                return b.is_dir.cmp(&a.is_dir);
            }
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        });

        Ok(entries)
    }

    /// Returns the system user's home directory.
    pub fn get_local_home_dir() -> String {
        #[cfg(windows)]
        {
            if let Ok(profile) = std::env::var("USERPROFILE") {
                if !profile.trim().is_empty() {
                    return profile;
                }
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            if !home.trim().is_empty() {
                return home;
            }
        }
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    }
}

/// Helper to format unix epoch seconds into human-readable `Mon DD HH:MM`.
fn format_unix_timestamp(secs: u64) -> String {
    let days = secs / 86400;
    let rem_secs = secs % 86400;
    let hours = rem_secs / 3600;
    let mins = (rem_secs % 3600) / 60;

    let mut year = 1970;
    let mut day_count = days;
    loop {
        let leap = if (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) { 1 } else { 0 };
        let days_in_year = 365 + leap;
        if day_count >= days_in_year {
            day_count -= days_in_year;
            year += 1;
        } else {
            break;
        }
    }
    let leap = if (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) { 1 } else { 0 };
    let month_days = [31, 28 + leap, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let mut month = 0;
    for (m, &md) in month_days.iter().enumerate() {
        if day_count >= md {
            day_count -= md;
        } else {
            month = m;
            break;
        }
    }
    let day = day_count + 1;
    format!("{} {:02} {:02}:{:02}", month_names[month], day, hours, mins)
}

/// RAII guard for ephemeral password files passed to `psftp -pwfile`.
/// Creates a temporary file with restrictive (0600) permissions on POSIX,
/// writes the password followed by newline, and ensures deletion on drop.
pub struct PsftpPasswordGuard {
    _file: Option<tempfile::NamedTempFile>,
    path: Option<std::path::PathBuf>,
}

impl PsftpPasswordGuard {
    pub fn create(password: Option<&str>) -> Result<Self> {
        match password {
            Some(pwd) if !pwd.is_empty() => {
                let mut temp = tempfile::Builder::new()
                    .prefix(".plinky_psftp_pw_")
                    .tempfile()
                    .map_err(|e| PlinkyError::ProcessError(format!("Failed to create temporary password file: {e}")))?;

                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o600));
                }

                use std::io::Write;
                temp.write_all(pwd.as_bytes())
                    .map_err(|e| PlinkyError::ProcessError(format!("Failed to write password file: {e}")))?;
                temp.write_all(b"\n")
                    .map_err(|e| PlinkyError::ProcessError(format!("Failed to write password file newline: {e}")))?;
                temp.flush()
                    .map_err(|e| PlinkyError::ProcessError(format!("Failed to flush password file: {e}")))?;

                let path = temp.path().to_path_buf();
                Ok(Self {
                    _file: Some(temp),
                    path: Some(path),
                })
            }
            _ => Ok(Self {
                _file: None,
                path: None,
            }),
        }
    }

    pub fn path(&self) -> Option<&std::path::Path> {
        self.path.as_deref()
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

    #[test]
    fn test_build_psftp_args_saved_session() {
        let args = PsftpClient::build_psftp_args("myserver", true, None, None);
        assert_eq!(args, vec!["-batch", "-load", "myserver"]);
    }

    #[test]
    fn test_build_psftp_args_unsaved_with_target() {
        let target = crate::transport::plink::ExplicitTarget {
            hostname: "192.168.1.100".to_string(),
            port: 2222,
            username: Some("root".to_string()),
        };
        let args = PsftpClient::build_psftp_args("unsaved_quick", false, Some(&target), None);
        assert_eq!(args, vec!["-batch", "root@192.168.1.100", "-P", "2222"]);
    }

    #[test]
    fn test_build_psftp_args_unsaved_without_target_fallback() {
        let args = PsftpClient::build_psftp_args("unsaved_quick", false, None, None);
        assert_eq!(args, vec!["-batch", "-load", "unsaved_quick"]);
    }

    #[test]
    fn test_build_psftp_args_with_pwfile() {
        let p = std::path::Path::new("/tmp/test_pw");
        let args = PsftpClient::build_psftp_args("myserver", true, None, Some(p));
        assert_eq!(args, vec!["-batch", "-pwfile", "/tmp/test_pw", "-load", "myserver"]);
    }

    #[test]
    fn test_list_local_dir_and_home() {
        let home = PsftpClient::get_local_home_dir();
        assert!(!home.is_empty());
        let entries = PsftpClient::list_local_dir(&home).expect("Failed to list home directory");
        assert!(!entries.is_empty());
    }
}

