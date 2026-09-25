//! Native serial transport (ADR-005). Serial sessions are opened directly
//! instead of through plink, because plink has no way to send a Break.
//! Line settings still come from PuTTY's own session keys, so the same
//! session opens identically in real PuTTY.

use std::collections::BTreeMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::Duration;

use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use tokio::sync::mpsc;

use crate::errors::{PlinkyError, Result};
use crate::transport::Transport;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SerialConfig {
    pub line: String,
    pub baud: u32,
    pub data_bits: DataBits,
    pub parity: Parity,
    pub stop_bits: StopBits,
    pub flow_control: FlowControl,
}

fn bad(key: &str, msg: impl std::fmt::Display) -> PlinkyError {
    PlinkyError::ProcessError(format!("Serial setting {key}: {msg}"))
}

fn int_key(extra: &BTreeMap<String, String>, key: &str, default: u32) -> Result<u32> {
    match extra.get(key).map(|v| v.trim()).filter(|v| !v.is_empty()) {
        None => Ok(default),
        Some(v) => v.parse().map_err(|_| bad(key, format!("not a number: {v:?}"))),
    }
}

impl SerialConfig {
    /// Reads PuTTY's serial keys (putty-compat keeps them in `extra`) with
    /// PuTTY's own defaults. Settings the native driver can't reproduce
    /// faithfully are refused rather than silently approximated.
    pub fn from_putty_keys(extra: &BTreeMap<String, String>) -> Result<Self> {
        let line = extra.get("SerialLine").map(|v| v.trim()).unwrap_or("");
        if line.is_empty() {
            return Err(bad("SerialLine", "no serial device set (e.g. /dev/ttyUSB0 or COM3)"));
        }
        let data_bits = match int_key(extra, "SerialDataBits", 8)? {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            8 => DataBits::Eight,
            n => return Err(bad("SerialDataBits", format!("{n} (must be 5-8)"))),
        };
        // PuTTY stores stop bits in halves: 2 = 1, 3 = 1.5, 4 = 2.
        let stop_bits = match int_key(extra, "SerialStopHalfbits", 2)? {
            2 => StopBits::One,
            4 => StopBits::Two,
            3 => return Err(bad("SerialStopHalfbits", "1.5 stop bits isn't supported")),
            n => return Err(bad("SerialStopHalfbits", n)),
        };
        // PuTTY: 0 none, 1 odd, 2 even, 3 mark, 4 space.
        let parity = match int_key(extra, "SerialParity", 0)? {
            0 => Parity::None,
            1 => Parity::Odd,
            2 => Parity::Even,
            3 | 4 => return Err(bad("SerialParity", "mark/space parity isn't supported")),
            n => return Err(bad("SerialParity", n)),
        };
        // PuTTY: 0 none, 1 XON/XOFF (its default), 2 RTS/CTS, 3 DSR/DTR.
        let flow_control = match int_key(extra, "SerialFlowControl", 1)? {
            0 => FlowControl::None,
            1 => FlowControl::Software,
            2 => FlowControl::Hardware,
            3 => return Err(bad("SerialFlowControl", "DSR/DTR flow control isn't supported")),
            n => return Err(bad("SerialFlowControl", n)),
        };
        Ok(Self {
            line: line.to_string(),
            baud: int_key(extra, "SerialSpeed", 9600)?,
            data_bits,
            parity,
            stop_bits,
            flow_control,
        })
    }
}

pub struct SerialTransport {
    /// Kept for break control; reads and writes use their own clones.
    port: Box<dyn SerialPort>,
    writer_tx: std_mpsc::Sender<Vec<u8>>,
    alive: Arc<AtomicBool>,
}

fn is_wait(e: &std::io::Error) -> bool {
    matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::Interrupted | ErrorKind::WouldBlock)
}

impl SerialTransport {
    /// Opens the line and starts a reader thread forwarding bytes to
    /// `out_tx`. When the device goes away (unplugged) the thread exits and
    /// drops `out_tx`, which the session manager reports as a closed session.
    pub fn open(config: &SerialConfig, out_tx: mpsc::UnboundedSender<Vec<u8>>) -> Result<Self> {
        let open_err = |e: serialport::Error| {
            PlinkyError::ProcessError(format!("Failed to open serial line {}: {e}", config.line))
        };
        let port = serialport::new(&config.line, config.baud)
            .data_bits(config.data_bits)
            .parity(config.parity)
            .stop_bits(config.stop_bits)
            .flow_control(config.flow_control)
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(open_err)?;
        let mut reader = port.try_clone().map_err(open_err)?;
        let mut writer = port.try_clone().map_err(open_err)?;

        let alive = Arc::new(AtomicBool::new(true));
        let alive_reader = alive.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while alive_reader.load(Ordering::Relaxed) {
                match reader.read(&mut buf) {
                    // A hung-up tty reads as EOF, not "no data yet".
                    Ok(0) => break,
                    Ok(n) => {
                        if out_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) if is_wait(&e) => {}
                    Err(_) => break,
                }
            }
            alive_reader.store(false, Ordering::Relaxed);
        });

        // Writes run on their own thread so a slow line never holds the
        // session registry's lock: at 9600 baud a pasted config drains at
        // ~1 KB/s, and a device's XOFF can pause it for as long as it likes.
        // A timeout here is that wait, not a failure.
        let (writer_tx, writer_rx) = std_mpsc::channel::<Vec<u8>>();
        let alive_writer = alive.clone();
        std::thread::spawn(move || {
            for data in writer_rx {
                let mut sent = 0;
                while sent < data.len() {
                    if !alive_writer.load(Ordering::Relaxed) {
                        return;
                    }
                    match writer.write(&data[sent..]) {
                        Ok(n) => sent += n,
                        Err(e) if is_wait(&e) => {}
                        Err(_) => {
                            alive_writer.store(false, Ordering::Relaxed);
                            return;
                        }
                    }
                }
            }
        });

        Ok(Self { port, writer_tx, alive })
    }
}

impl Transport for SerialTransport {
    fn set_break(&mut self, on: bool) -> Result<()> {
        let res = if on { self.port.set_break() } else { self.port.clear_break() };
        res.map_err(|e| PlinkyError::ProcessError(format!("Serial break failed: {e}")))
    }

    fn write(&mut self, data: &[u8]) -> Result<()> {
        if !self.alive.load(Ordering::Relaxed) {
            return Err(PlinkyError::ProcessError("Serial line is closed".into()));
        }
        self.writer_tx
            .send(data.to_vec())
            .map_err(|_| PlinkyError::ProcessError("Serial line is closed".into()))
    }

    fn resize(&mut self, _cols: u16, _rows: u16) -> Result<()> {
        // A serial line has no window size to report.
        Ok(())
    }

    fn kill(&mut self) -> Result<()> {
        // The threads notice within their 100 ms timeouts; the port itself
        // closes when the transport and both threads' clones are dropped.
        self.alive.store(false, Ordering::Relaxed);
        Ok(())
    }

    fn is_alive(&mut self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }
}

impl Drop for SerialTransport {
    /// The reader thread holds its own handle to the device; without this a
    /// transport dropped un-killed would keep the line open.
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
    }
}

/// Represents a detected hardware serial or USB-serial device.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct DetectedSerialPort {
    pub port_name: String,
    pub display_name: String,
    pub is_usb: bool,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

#[cfg(target_os = "linux")]
pub fn detect_serial_ports() -> Vec<DetectedSerialPort> {
    let mut usb_ports = Vec::new();
    let mut other_ports = Vec::new();

    if let Ok(entries) = std::fs::read_dir("/sys/class/tty") {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            let link_path = entry.path();

            if let Ok(target) = std::fs::canonicalize(&link_path) {
                let target_str = target.to_string_lossy();
                // Skip virtual pseudo-terminals and virtual consoles
                if target_str.contains("/virtual/") {
                    continue;
                }

                let dev_path = format!("/dev/{name}");
                let is_usb = target_str.contains("/usb") || name.starts_with("ttyUSB") || name.starts_with("ttyACM");
                
                let mut product = None;
                let mut manufacturer = None;

                if is_usb {
                    let dev_dir = target.join("device");
                    let candidates = [
                        dev_dir.join("../product"),
                        dev_dir.join("../../product"),
                        dev_dir.join("product"),
                    ];
                    for p in &candidates {
                        if let Ok(s) = std::fs::read_to_string(p) {
                            let trimmed = s.trim().to_string();
                            if !trimmed.is_empty() {
                                product = Some(trimmed);
                                break;
                            }
                        }
                    }
                    let mfg_candidates = [
                        dev_dir.join("../manufacturer"),
                        dev_dir.join("../../manufacturer"),
                        dev_dir.join("manufacturer"),
                    ];
                    for m in &mfg_candidates {
                        if let Ok(s) = std::fs::read_to_string(m) {
                            let trimmed = s.trim().to_string();
                            if !trimmed.is_empty() {
                                manufacturer = Some(trimmed);
                                break;
                            }
                        }
                    }
                }

                let display_name = match (&product, &manufacturer) {
                    (Some(prod), Some(mfg)) => format!("{dev_path} ({mfg} {prod})"),
                    (Some(prod), None) => format!("{dev_path} ({prod})"),
                    (None, Some(mfg)) => format!("{dev_path} ({mfg})"),
                    (None, None) => {
                        if is_usb {
                            format!("{dev_path} (USB Serial)")
                        } else {
                            format!("{dev_path} (Serial Port)")
                        }
                    }
                };

                let port_item = DetectedSerialPort {
                    port_name: dev_path,
                    display_name,
                    is_usb,
                    manufacturer,
                    product,
                };

                if is_usb {
                    usb_ports.push(port_item);
                } else if name.starts_with("ttyS") {
                    let suffix = name.trim_start_matches("ttyS");
                    if let Ok(idx) = suffix.parse::<u32>() {
                        if idx <= 3 {
                            other_ports.push(port_item);
                        }
                    }
                } else {
                    other_ports.push(port_item);
                }
            }
        }
    }

    usb_ports.sort_by(|a, b| a.port_name.cmp(&b.port_name));
    other_ports.sort_by(|a, b| a.port_name.cmp(&b.port_name));
    usb_ports.extend(other_ports);
    usb_ports
}

#[cfg(target_os = "windows")]
pub fn detect_serial_ports() -> Vec<DetectedSerialPort> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let mut ports = Vec::new();
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(key) = hklm.open_subkey("HARDWARE\\DEVICEMAP\\SERIALCOMM") {
        for val in key.enum_values().flatten() {
            let val_name = val.0;
            if let winreg::RegValue { bytes, .. } = val.1 {
                let s = String::from_utf8_lossy(&bytes).trim_matches('\0').trim().to_string();
                if !s.is_empty() {
                    let is_usb = val_name.to_lowercase().contains("usb") || val_name.to_lowercase().contains("vcp");
                    let display_name = if is_usb {
                        format!("{s} (USB Serial Port)")
                    } else {
                        format!("{s} (Serial Port)")
                    };
                    ports.push(DetectedSerialPort {
                        port_name: s,
                        display_name,
                        is_usb,
                        manufacturer: None,
                        product: None,
                    });
                }
            }
        }
    }
    ports.sort_by(|a, b| a.port_name.cmp(&b.port_name));
    ports
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub fn detect_serial_ports() -> Vec<DetectedSerialPort> {
    let mut ports = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/dev") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("cu.usb") || name.starts_with("tty.usb") {
                let path = format!("/dev/{name}");
                ports.push(DetectedSerialPort {
                    port_name: path.clone(),
                    display_name: format!("{path} (USB Serial)"),
                    is_usb: true,
                    manufacturer: None,
                    product: None,
                });
            }
        }
    }
    ports.sort_by(|a, b| a.port_name.cmp(&b.port_name));
    ports
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn putty_defaults_apply_when_only_the_line_is_set() {
        let cfg = SerialConfig::from_putty_keys(&keys(&[("SerialLine", "/dev/ttyUSB0")])).unwrap();
        assert_eq!(cfg.baud, 9600);
        assert_eq!(cfg.data_bits, DataBits::Eight);
        assert_eq!(cfg.stop_bits, StopBits::One);
        assert_eq!(cfg.parity, Parity::None);
        assert_eq!(cfg.flow_control, FlowControl::Software, "PuTTY defaults to XON/XOFF");
    }

    #[test]
    fn putty_key_encodings_map_correctly() {
        let cfg = SerialConfig::from_putty_keys(&keys(&[
            ("SerialLine", "COM3"),
            ("SerialSpeed", "115200"),
            ("SerialDataBits", "7"),
            ("SerialStopHalfbits", "4"),
            ("SerialParity", "2"),
            ("SerialFlowControl", "2"),
        ]))
        .unwrap();
        assert_eq!(cfg.baud, 115200);
        assert_eq!(cfg.data_bits, DataBits::Seven);
        assert_eq!(cfg.stop_bits, StopBits::Two);
        assert_eq!(cfg.parity, Parity::Even);
        assert_eq!(cfg.flow_control, FlowControl::Hardware);
    }

    #[test]
    fn unsupported_settings_are_refused_not_approximated() {
        for (key, val) in [
            ("SerialParity", "3"),
            ("SerialStopHalfbits", "3"),
            ("SerialFlowControl", "3"),
            ("SerialDataBits", "9"),
            ("SerialSpeed", "fast"),
        ] {
            let res = SerialConfig::from_putty_keys(&keys(&[("SerialLine", "/dev/ttyS0"), (key, val)]));
            assert!(res.is_err(), "{key}={val} must be refused");
        }
    }

    #[test]
    fn missing_line_is_refused() {
        assert!(SerialConfig::from_putty_keys(&BTreeMap::new()).is_err());
    }

    #[test]
    fn test_detect_serial_ports_does_not_panic() {
        let ports = detect_serial_ports();
        // Regardless of whether hardware is plugged in, detect_serial_ports must complete cleanly
        for p in &ports {
            assert!(!p.port_name.is_empty());
            assert!(!p.display_name.is_empty());
        }
    }
}
