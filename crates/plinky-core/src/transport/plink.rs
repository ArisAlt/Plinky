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

    /// Spawns an interactive plink process attached to a new PTY pair.
    pub fn spawn_session(
        session_name: &str,
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

        let mut cmd = CommandBuilder::new(plink_bin);
        // Interactive flags per D8 and PUTTY_WRAPPER_SPEC §4:
        cmd.arg("-load");
        cmd.arg(session_name);
        cmd.arg("-t"); // Force PTY
        // Note: -agent is intentionally omitted per Claude architecture review:
        // -load already applies the session's own AgentFwd configuration.

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
