use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;
use crate::errors::{PlinkyError, Result};
use crate::transport::Transport;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PuttyInfo {
    pub path: Option<String>,
    pub version: Option<String>,
    pub ok: bool,
    pub reason: Option<String>,
}

/// Direct connection target used when a session name doesn't resolve to a
/// persisted PuTTY session file (see spawn_session).
#[derive(Debug, Clone)]
pub struct ExplicitTarget {
    pub hostname: String,
    pub port: u16,
    pub username: Option<String>,
}

pub struct PlinkTransport {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

impl PlinkTransport {
    /// Discovers system plink binary according to ADR-002.
    pub fn find_plink_binary() -> Result<PathBuf> {
        #[cfg(not(windows))]
        {
            let candidates = ["/usr/bin/plink", "/usr/local/bin/plink", "/bin/plink"];
            for p in &candidates {
                let path = Path::new(p);
                if path.is_file() {
                    return Ok(path.to_path_buf());
                }
            }
        }

        #[cfg(windows)]
        {
            let candidates = [
                r"C:\Program Files\PuTTY\plink.exe",
                r"C:\Program Files (x86)\PuTTY\plink.exe",
            ];
            for p in &candidates {
                let path = Path::new(p);
                if path.is_file() {
                    return Ok(path.to_path_buf());
                }
            }
        }

        // Fallback to checking PATH
        if let Ok(output) = std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
            .arg(if cfg!(windows) { "plink.exe" } else { "plink" })
            .output()
        {
            if output.status.success() {
                let line = String::from_utf8_lossy(&output.stdout);
                if let Some(first) = line.lines().next() {
                    let p = PathBuf::from(first.trim());
                    if p.is_file() {
                        return Ok(p);
                    }
                }
            }
        }

        Err(PlinkyError::ProcessError(
            "PuTTY 'plink' binary not found. Please install PuTTY (>= 0.75) per ADR-002.".into(),
        ))
    }

    /// Detects PuTTY presence, binary location, and version compliance (>= 0.75).
    pub fn detect_putty() -> PuttyInfo {
        let path = match Self::find_plink_binary() {
            Ok(p) => p,
            Err(e) => {
                return PuttyInfo {
                    path: None,
                    version: None,
                    ok: false,
                    reason: Some(e.to_string()),
                };
            }
        };

        let path_str = path.to_string_lossy().to_string();
        let output = match std::process::Command::new(&path).arg("-V").output() {
            Ok(out) => out,
            Err(e) => {
                return PuttyInfo {
                    path: Some(path_str),
                    version: None,
                    ok: false,
                    reason: Some(format!("Failed to execute plink -V: {e}")),
                };
            }
        };

        let out_str = String::from_utf8_lossy(&output.stdout);
        // Extracts version like "0.85" from output
        let version_regex = regex::Regex::new(r"(\d+\.\d+)").unwrap();
        let version = version_regex
            .find(&out_str)
            .map(|m| m.as_str().to_string());

        let ok = if let Some(ref ver_str) = version {
            if let Ok(ver_float) = ver_str.parse::<f32>() {
                ver_float >= 0.75
            } else {
                false
            }
        } else {
            false
        };

        let reason = if ok {
            None
        } else if version.is_none() {
            Some("Could not parse PuTTY version from plink -V output".to_string())
        } else {
            Some(format!(
                "PuTTY version is below 0.75 minimum floor (found {})",
                version.as_deref().unwrap_or("")
            ))
        };

        PuttyInfo {
            path: Some(path_str),
            version,
            ok,
            reason,
        }
    }

    /// Builds the plink CLI args for a connection, given whether
    /// `session_name` matches a real persisted PuTTY session.
    ///
    /// `explicit_target`, when given, is used whenever `session_name` isn't
    /// a real persisted PuTTY session (Quick Connect and split-pane clones
    /// invent a display name like "Quick (host:port)" or "X (Split)" that
    /// was never written to ~/.putty/sessions). Previously this always ran
    /// `-load <session_name>` regardless -- for those synthetic names, plink
    /// found no matching saved session, ended up with no host configured at
    /// all, and the connection silently went nowhere (looked like a "dummy"
    /// terminal). A real saved session still takes the `-load` path so it
    /// keeps whatever proxy/key/terminal settings it was saved with.
    /// Pulled out as a pure function so the branching is unit-testable
    /// without spawning a real plink process.
    pub fn build_args(
        session_name: &str,
        has_saved_session: bool,
        explicit_target: Option<&ExplicitTarget>,
    ) -> Vec<String> {
        let mut args = Vec::new();

        if has_saved_session {
            // Interactive flags per D8 and PUTTY_WRAPPER_SPEC §4:
            args.push("-load".to_string());
            args.push(session_name.to_string());
            // Note: -agent is intentionally omitted per Claude architecture review:
            // -load already applies the session's own AgentFwd configuration.
        } else if let Some(target) = explicit_target {
            if let Some(user) = target.username.as_deref().filter(|u| !u.is_empty()) {
                args.push(format!("{user}@{}", target.hostname));
            } else {
                args.push(target.hostname.clone());
            }
            args.push("-P".to_string());
            args.push(target.port.to_string());
        } else {
            // No saved session and nothing explicit to connect with -- fall
            // back to -load so plink's own "no hostname specified" error
            // still surfaces through the existing FATAL ERROR handling
            // instead of the process hanging with no target.
            args.push("-load".to_string());
            args.push(session_name.to_string());
        }
        args.push("-t".to_string()); // Force PTY
        args
    }

    /// Spawns an interactive plink process attached to a new PTY pair.
    pub fn spawn_session(
        session_name: &str,
        explicit_target: Option<&ExplicitTarget>,
        cols: u16,
        rows: u16,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
    ) -> Result<Self> {
        let plink_bin = Self::find_plink_binary()?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PlinkyError::PtyError(e.to_string()))?;

        let has_saved_session = putty_compat::sessions::read_session(session_name).is_ok();
        let mut cmd = CommandBuilder::new(plink_bin);
        for arg in Self::build_args(session_name, has_saved_session, explicit_target) {
            cmd.arg(arg);
        }

        #[cfg(not(windows))]
        cmd.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PlinkyError::PtyError(e.to_string()))?;

        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PlinkyError::PtyError(e.to_string()))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PlinkyError::PtyError(e.to_string()))?;

        // Background reader thread piping stdout
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if out_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            master: pair.master,
            writer,
            child,
        })
    }
}

impl Transport for PlinkTransport {
    fn write(&mut self, data: &[u8]) -> Result<()> {
        self.writer
            .write_all(data)
            .map_err(PlinkyError::IoError)?;
        self.writer.flush().map_err(PlinkyError::IoError)?;
        Ok(())
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PlinkyError::PtyError(e.to_string()))?;
        Ok(())
    }

    fn kill(&mut self) -> Result<()> {
        self.child
            .kill()
            .map_err(|e| PlinkyError::ProcessError(e.to_string()))?;
        Ok(())
    }

    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_session_uses_load_even_with_explicit_target() {
        // A real saved session's -load carries proxy/key/terminal settings
        // an explicit host/port/user pair can't replicate, so it must win
        // whenever the name actually resolves to one on disk.
        let target = ExplicitTarget {
            hostname: "203.0.113.5".to_string(),
            port: 2222,
            username: Some("someone".to_string()),
        };
        let args = PlinkTransport::build_args("Saved Server", true, Some(&target));
        assert_eq!(args, vec!["-load", "Saved Server", "-t"]);
    }

    #[test]
    fn unsaved_session_with_explicit_target_connects_directly() {
        // Quick Connect / split-pane clones: no ~/.putty/sessions file
        // under this name, but the caller has real host/port/user -- this
        // is the fix for the "dummy server" bug (-load on a name that
        // doesn't exist left plink with no host at all).
        let target = ExplicitTarget {
            hostname: "10.10.10.10".to_string(),
            port: 22,
            username: Some("citizenzero".to_string()),
        };
        let args = PlinkTransport::build_args("Quick (10.10.10.10:22)", false, Some(&target));
        assert_eq!(args, vec!["citizenzero@10.10.10.10", "-P", "22", "-t"]);
    }

    #[test]
    fn unsaved_session_with_explicit_target_and_no_username() {
        let target = ExplicitTarget {
            hostname: "10.10.10.10".to_string(),
            port: 2200,
            username: None,
        };
        let args = PlinkTransport::build_args("Quick (10.10.10.10:2200)", false, Some(&target));
        assert_eq!(args, vec!["10.10.10.10", "-P", "2200", "-t"]);
    }

    #[test]
    fn unsaved_session_with_empty_username_omits_user_prefix() {
        let target = ExplicitTarget {
            hostname: "10.10.10.10".to_string(),
            port: 22,
            username: Some(String::new()),
        };
        let args = PlinkTransport::build_args("Quick (10.10.10.10:22)", false, Some(&target));
        assert_eq!(args, vec!["10.10.10.10", "-P", "22", "-t"]);
    }

    #[test]
    fn unsaved_session_with_no_explicit_target_falls_back_to_load() {
        // Nothing to connect with at all -- still emit -load so plink's own
        // "no hostname specified" error surfaces through the existing
        // FATAL ERROR handling instead of hanging with no target.
        let args = PlinkTransport::build_args("Orphaned Name", false, None);
        assert_eq!(args, vec!["-load", "Orphaned Name", "-t"]);
    }
}
