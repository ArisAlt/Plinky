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

/// A serial device found on this machine, for the session editor's picker.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct DetectedSerialPort {
    pub port_name: String,
    pub display_name: String,
    pub is_usb: bool,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

/// Lists the serial devices present right now, USB adapters first. Uses the
/// `serialport` crate's own scan: sysfs on Linux (no libudev needed), the
/// device installer's friendly names on Windows, IOKit on macOS.
pub fn detect_serial_ports() -> Vec<DetectedSerialPort> {
    // serialport's sysfs scan panics if /sys/class/tty is missing (some
    // containers); an empty list is the right answer there.
    #[cfg(target_os = "linux")]
    if !std::path::Path::new("/sys/class/tty").is_dir() {
        return Vec::new();
    }
    let found = serialport::available_ports().unwrap_or_default();
    let mut ports: Vec<DetectedSerialPort> = found
        .into_iter()
        .filter(|p| !is_phantom_uart(std::path::Path::new("/sys/class/tty"), &p.port_name))
        .map(|p| {
            let (is_usb, manufacturer, product, kind) = match p.port_type {
                serialport::SerialPortType::UsbPort(info) => (true, info.manufacturer, info.product, "USB serial"),
                serialport::SerialPortType::BluetoothPort => (false, None, None, "Bluetooth serial"),
                _ => (false, None, None, "Serial port"),
            };
            let label = match (&manufacturer, &product) {
                (Some(m), Some(pr)) if pr.contains(m.as_str()) => Some(pr.clone()),
                (Some(m), Some(pr)) => Some(format!("{m} {pr}")),
                (None, Some(pr)) => Some(pr.clone()),
                (Some(m), None) => Some(m.clone()),
                (None, None) => None,
            };
            DetectedSerialPort {
                display_name: format!("{} ({})", p.port_name, label.as_deref().unwrap_or(kind)),
                port_name: p.port_name,
                is_usb,
                manufacturer,
                product,
            }
        })
        .collect();
    ports.sort_by(|a, b| b.is_usb.cmp(&a.is_usb).then_with(|| a.port_name.cmp(&b.port_name)));
    ports
}

/// Linux registers ttyS0-ttyS31 whether or not a UART is behind them; the
/// kernel reports UART type 0 (PORT_UNKNOWN) for the empty ones. Listing
/// them would bury the real ports under 31 dead entries.
fn is_phantom_uart(sys_class_tty: &std::path::Path, port_name: &str) -> bool {
    let Some(name) = port_name.strip_prefix("/dev/") else { return false };
    match std::fs::read_to_string(sys_class_tty.join(name).join("type")) {
        Ok(t) => t.trim() == "0",
        Err(_) => false,
    }
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
    fn detected_ports_have_names_and_list_usb_first() {
        let ports = detect_serial_ports();
        for p in &ports {
            assert!(!p.port_name.is_empty());
            assert!(p.display_name.starts_with(&p.port_name));
        }
        let first_non_usb = ports.iter().position(|p| !p.is_usb).unwrap_or(ports.len());
        assert!(ports[first_non_usb..].iter().all(|p| !p.is_usb), "USB adapters must come first");
    }

    #[test]
    fn phantom_uarts_are_recognised_by_type_zero() {
        let dir = tempfile::tempdir().unwrap();
        for (name, uart_type) in [("ttyS0", "4\n"), ("ttyS1", "0\n")] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
            std::fs::write(dir.path().join(name).join("type"), uart_type).unwrap();
        }
        std::fs::create_dir(dir.path().join("ttyUSB0")).unwrap(); // USB ttys have no type file
        assert!(!is_phantom_uart(dir.path(), "/dev/ttyS0"), "16550A is real");
        assert!(is_phantom_uart(dir.path(), "/dev/ttyS1"), "type 0 is an empty slot");
        assert!(!is_phantom_uart(dir.path(), "/dev/ttyUSB0"));
        assert!(!is_phantom_uart(dir.path(), "COM3"));
    }
}
