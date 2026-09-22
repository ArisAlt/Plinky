use std::io::{Read, Write};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;
use crate::errors::{PlinkyError, Result};
use crate::transport::Transport;

pub struct LocalTransport {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

impl LocalTransport {
    pub fn spawn(
        cols: u16,
        rows: u16,
        out_tx: mpsc::UnboundedSender<Vec<u8>>,
    ) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PlinkyError::PtyError(e.to_string()))?;

        #[cfg(windows)]
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        #[cfg(not(windows))]
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());

        let mut cmd = CommandBuilder::new(shell);
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

        // Background reader thread pumping bytes into out_tx
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        if out_tx.send(buf[..n].to_vec()).is_err() {
                            break; // Consumer dropped
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

impl Transport for LocalTransport {
    fn write(&mut self, data: &[u8]) -> Result<()> {
        self.writer
            .write_all(data)
            .map_err(|e| PlinkyError::IoError(e))?;
        self.writer.flush().map_err(|e| PlinkyError::IoError(e))?;
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
        match self.child.try_wait() {
            Ok(None) => true,
            _ => false,
        }
    }
}
