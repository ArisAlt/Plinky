//! Native serial transport (ADR-005). Serial sessions are opened directly
//! instead of through plink, because plink has no way to send a Break.
//! Line settings still come from PuTTY's own session keys, so the same
//! session opens identically in real PuTTY.

use std::collections::BTreeMap;
#[cfg(not(windows))]
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::Duration;

#[cfg(not(windows))]
use serialport::SerialPort;
use serialport::{DataBits, FlowControl, Parity, StopBits};
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
    #[cfg(not(windows))]
    port: Box<dyn SerialPort>,
    /// Shared with the reader and writer threads; the line closes when the
    /// last of the three lets go.
    #[cfg(windows)]
    port: Arc<win::ComPort>,
    writer_tx: std_mpsc::Sender<Vec<u8>>,
    alive: Arc<AtomicBool>,
}

#[cfg(not(windows))]
fn is_wait(e: &std::io::Error) -> bool {
    matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::Interrupted | ErrorKind::WouldBlock)
}

impl SerialTransport {
    /// Opens the line and starts a reader thread forwarding bytes to
    /// `out_tx`. When the device goes away (unplugged) the thread exits and
    /// drops `out_tx`, which the session manager reports as a closed session.
    #[cfg(not(windows))]
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

    /// As on Unix, but on a line opened for overlapped I/O, the way PuTTY
    /// opens it (windows/winser.c).
    ///
    /// The serialport crate opens COM ports for synchronous I/O, and its
    /// `try_clone` duplicates that handle: one file object, on which Windows
    /// runs one I/O call at a time. Every keystroke's write queued behind the
    /// reader's waiting read. Its timeouts (MAXDWORD, MAXDWORD, 100 ms) are
    /// a special case Windows' own serial driver honours and USB adapter
    /// drivers need not: where it isn't, the read waits for data, the key
    /// never reaches the device, and nothing echoes until the device prints
    /// something of its own. Reported as typed letters appearing 5-10 s late,
    /// sometimes.
    #[cfg(windows)]
    pub fn open(config: &SerialConfig, out_tx: mpsc::UnboundedSender<Vec<u8>>) -> Result<Self> {
        let port = win::ComPort::open(config)
            .map(Arc::new)
            .map_err(|e| PlinkyError::ProcessError(format!("Failed to open serial line {}: {e}", config.line)))?;

        let alive = Arc::new(AtomicBool::new(true));
        let (reader, alive_reader) = (port.clone(), alive.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while alive_reader.load(Ordering::Relaxed) {
                match reader.read(&mut buf, &alive_reader) {
                    // Nothing, or a read cancelled by a kill: the loop
                    // decides. Never a hangup on Windows (that's an error).
                    Ok(0) => std::thread::sleep(Duration::from_millis(1)),
                    Ok(n) => {
                        if out_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) if win::was_cancelled(&e) => {}
                    Err(_) => break,
                }
            }
            alive_reader.store(false, Ordering::Relaxed);
        });

        // Its own thread, for the same reason as on Unix: a device's XOFF
        // can hold a write for as long as it likes.
        let (writer_tx, writer_rx) = std_mpsc::channel::<Vec<u8>>();
        let (writer, alive_writer) = (port.clone(), alive.clone());
        std::thread::spawn(move || {
            for data in writer_rx {
                let mut sent = 0;
                while sent < data.len() {
                    if !alive_writer.load(Ordering::Relaxed) {
                        return;
                    }
                    match writer.write(&data[sent..], &alive_writer) {
                        Ok(n) => sent += n,
                        Err(e) if win::was_cancelled(&e) => return,
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
        #[cfg(not(windows))]
        let res = if on { self.port.set_break() } else { self.port.clear_break() };
        #[cfg(windows)]
        let res = self.port.set_break(on);
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
        // The threads notice within their 100 ms timeouts (250 ms waits on
        // Windows); the port itself
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

/// A COM port opened for overlapped I/O, set up the way PuTTY sets it up
/// (windows/winser.c), so a session behaves as it does there.
#[cfg(windows)]
mod win {
    use std::io;
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};

    use serialport::{DataBits, FlowControl, Parity, StopBits};
    use windows_sys::Win32::Devices::Communication::{
        ClearCommBreak, GetCommState, SetCommBreak, SetCommState, SetCommTimeouts, COMMTIMEOUTS, DCB,
    };
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, GENERIC_READ, GENERIC_WRITE,
        HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, OPEN_EXISTING};
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
    use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

    use super::SerialConfig;

    /// How long a waiting read or write sleeps before checking whether the
    /// session was closed.
    const KILL_CHECK_MS: u32 = 250;

    // DCB's bitfield (winbase.h order).
    const F_BINARY: u32 = 1 << 0;
    const F_PARITY: u32 = 1 << 1;
    const F_OUTX_CTS_FLOW: u32 = 1 << 2;
    const F_OUTX_DSR_FLOW: u32 = 1 << 3;
    const F_DTR_CONTROL: u32 = 0b11 << 4;
    const F_DSR_SENSITIVITY: u32 = 1 << 6;
    const F_TX_CONTINUE_ON_XOFF: u32 = 1 << 7;
    const F_OUTX: u32 = 1 << 8;
    const F_INX: u32 = 1 << 9;
    const F_ERROR_CHAR: u32 = 1 << 10;
    const F_NULL: u32 = 1 << 11;
    const F_RTS_CONTROL: u32 = 0b11 << 12;
    const F_ABORT_ON_ERROR: u32 = 1 << 14;
    const DTR_CONTROL_ENABLE: u32 = 1 << 4;
    const RTS_CONTROL_ENABLE: u32 = 1 << 12;
    const RTS_CONTROL_HANDSHAKE: u32 = 2 << 12;

    pub struct ComPort {
        handle: HANDLE,
    }

    // Overlapped calls from several threads on one handle are what it is
    // for; each call has its own OVERLAPPED and event.
    unsafe impl Send for ComPort {}
    unsafe impl Sync for ComPort {}

    impl Drop for ComPort {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }

    pub fn was_cancelled(e: &io::Error) -> bool {
        e.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32)
    }

    struct Event(HANDLE);

    impl Event {
        fn new() -> io::Result<Self> {
            let h = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
            if h == 0 { Err(io::Error::last_os_error()) } else { Ok(Self(h)) }
        }
    }

    impl Drop for Event {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    impl ComPort {
        pub fn open(config: &SerialConfig) -> io::Result<Self> {
            let path = if config.line.starts_with('\\') { config.line.clone() } else { format!(r"\\.\{}", config.line) };
            let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    0,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let port = Self::from_handle(handle);
            port.configure(config)?;
            Ok(port)
        }

        /// Takes ownership of a handle opened with FILE_FLAG_OVERLAPPED.
        pub(super) fn from_handle(handle: HANDLE) -> Self {
            Self { handle }
        }

        fn configure(&self, config: &SerialConfig) -> io::Result<()> {
            let mut dcb: DCB = unsafe { std::mem::zeroed() };
            dcb.DCBlength = std::mem::size_of::<DCB>() as u32;
            if unsafe { GetCommState(self.handle, &mut dcb) } == 0 {
                return Err(io::Error::last_os_error());
            }
            // PuTTY's boilerplate: DTR and RTS raised, no flow control, no
            // byte rewriting, errors don't stop the line.
            let mut f = dcb._bitfield;
            f &= !(F_DTR_CONTROL | F_DSR_SENSITIVITY | F_TX_CONTINUE_ON_XOFF | F_OUTX | F_INX | F_ERROR_CHAR
                | F_NULL | F_RTS_CONTROL | F_ABORT_ON_ERROR | F_OUTX_CTS_FLOW | F_OUTX_DSR_FLOW | F_PARITY);
            f |= F_BINARY | DTR_CONTROL_ENABLE | RTS_CONTROL_ENABLE;
            if config.parity != Parity::None {
                f |= F_PARITY;
            }
            match config.flow_control {
                FlowControl::None => {}
                FlowControl::Software => f |= F_OUTX | F_INX,
                FlowControl::Hardware => f = (f & !F_RTS_CONTROL) | RTS_CONTROL_HANDSHAKE | F_OUTX_CTS_FLOW,
            }
            dcb._bitfield = f;
            dcb.BaudRate = config.baud;
            dcb.ByteSize = match config.data_bits {
                DataBits::Five => 5,
                DataBits::Six => 6,
                DataBits::Seven => 7,
                DataBits::Eight => 8,
            };
            dcb.Parity = match config.parity {
                Parity::None => 0,
                Parity::Odd => 1,
                Parity::Even => 2,
            };
            dcb.StopBits = match config.stop_bits {
                StopBits::One => 0,
                StopBits::Two => 2,
            };
            dcb.XonChar = 0x11;
            dcb.XoffChar = 0x13;
            if unsafe { SetCommState(self.handle, &dcb) } == 0 {
                return Err(io::Error::last_os_error());
            }
            // PuTTY's timeouts: a read waits for the first byte, then returns
            // once the line has been quiet for 1 ms. Writes never time out.
            let timeouts = COMMTIMEOUTS {
                ReadIntervalTimeout: 1,
                ReadTotalTimeoutMultiplier: 0,
                ReadTotalTimeoutConstant: 0,
                WriteTotalTimeoutMultiplier: 0,
                WriteTotalTimeoutConstant: 0,
            };
            if unsafe { SetCommTimeouts(self.handle, &timeouts) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn set_break(&self, on: bool) -> io::Result<()> {
            let ok = unsafe { if on { SetCommBreak(self.handle) } else { ClearCommBreak(self.handle) } };
            if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
        }

        /// Waits for at least one byte. Gives up (as cancelled) once `alive`
        /// is cleared.
        pub fn read(&self, buf: &mut [u8], alive: &AtomicBool) -> io::Result<usize> {
            let len = buf.len().min(u32::MAX as usize) as u32;
            let ptr = buf.as_mut_ptr();
            self.overlapped(alive, |ov| unsafe { ReadFile(self.handle, ptr, len, ptr::null_mut(), ov) })
        }

        /// Writes some of `buf`; waits as long as the device holds the line
        /// (XOFF, CTS), until `alive` is cleared.
        pub fn write(&self, buf: &[u8], alive: &AtomicBool) -> io::Result<usize> {
            let len = buf.len().min(u32::MAX as usize) as u32;
            let ptr = buf.as_ptr();
            self.overlapped(alive, |ov| unsafe { WriteFile(self.handle, ptr, len, ptr::null_mut(), ov) })
        }

        fn overlapped(&self, alive: &AtomicBool, start: impl FnOnce(*mut OVERLAPPED) -> i32) -> io::Result<usize> {
            let event = Event::new()?;
            let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
            ov.hEvent = event.0;
            if start(&mut ov) == 0 {
                let err = unsafe { GetLastError() };
                if err != ERROR_IO_PENDING {
                    return Err(io::Error::from_raw_os_error(err as i32));
                }
                // Pending. The buffer and `ov` must outlive the call, so a
                // kill cancels it and still waits for it to finish below.
                while unsafe { WaitForSingleObject(event.0, KILL_CHECK_MS) } != WAIT_OBJECT_0 {
                    if !alive.load(Ordering::Relaxed) {
                        unsafe { CancelIoEx(self.handle, &ov) };
                        break;
                    }
                }
            }
            let mut n = 0u32;
            if unsafe { GetOverlappedResult(self.handle, &ov, &mut n, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(n as usize)
        }
    }

    /// No COM port on a CI runner: a named pipe stands in. Windows applies
    /// the same rule to both: synchronous calls on one file object run one
    /// at a time, overlapped calls don't wait for each other.
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        use std::time::{Duration, Instant};
        use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS};
        use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
        use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_TYPE_BYTE, PIPE_WAIT};
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        struct Owned(HANDLE);
        unsafe impl Send for Owned {}
        unsafe impl Sync for Owned {}
        impl Drop for Owned {
            fn drop(&mut self) {
                unsafe { CloseHandle(self.0) };
            }
        }

        /// A pipe: the "device" end (synchronous) and the session's end.
        fn pipe(name: &str, overlapped: bool) -> (Owned, HANDLE) {
            let wide: Vec<u16> = format!(r"\\.\pipe\plinky-test-{name}-{}", std::process::id())
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let server = unsafe {
                CreateNamedPipeW(wide.as_ptr(), PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_WAIT, 1, 4096, 4096, 0, ptr::null())
            };
            assert_ne!(server, INVALID_HANDLE_VALUE, "{}", io::Error::last_os_error());
            let flags = if overlapped { FILE_FLAG_OVERLAPPED } else { 0 };
            let client = unsafe {
                CreateFileW(wide.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, ptr::null(), OPEN_EXISTING, flags, 0)
            };
            assert_ne!(client, INVALID_HANDLE_VALUE, "{}", io::Error::last_os_error());
            unsafe { ConnectNamedPipe(server, ptr::null_mut()) }; // already connected
            (Owned(server), client)
        }

        fn sync_write(h: HANDLE, data: &[u8]) {
            let mut n = 0u32;
            assert_ne!(unsafe { WriteFile(h, data.as_ptr(), data.len() as u32, &mut n, ptr::null_mut()) }, 0);
        }

        fn sync_read(h: HANDLE) -> Vec<u8> {
            let mut buf = [0u8; 64];
            let mut n = 0u32;
            assert_ne!(unsafe { ReadFile(h, buf.as_mut_ptr(), 64, &mut n, ptr::null_mut()) }, 0);
            buf[..n as usize].to_vec()
        }

        #[test]
        fn a_synchronous_handle_holds_a_keystroke_behind_a_waiting_read() {
            // How the serialport crate opened COM ports: one synchronous
            // handle, duplicated for the writer. The cause of the lag, kept
            // so the fix below stays measured against it.
            let (device, client) = pipe("sync", false);
            let reader = Owned(client);
            let mut dup: HANDLE = 0;
            let me = unsafe { GetCurrentProcess() };
            assert_ne!(unsafe { DuplicateHandle(me, reader.0, me, &mut dup, 0, 0, DUPLICATE_SAME_ACCESS) }, 0);
            let writer = Owned(dup);

            let reader = Arc::new(reader);
            let r = reader.clone();
            let read = std::thread::spawn(move || sync_read(r.0));
            std::thread::sleep(Duration::from_millis(100)); // the read is waiting

            let started = Instant::now();
            let w = Arc::new(writer);
            let w2 = w.clone();
            let write = std::thread::spawn(move || sync_write(w2.0, b"a"));
            std::thread::sleep(Duration::from_millis(500));
            assert!(!write.is_finished(), "the key went out while the read waited");

            // Only output from the device frees the line.
            sync_write(device.0, b"#");
            assert_eq!(read.join().unwrap(), b"#");
            write.join().unwrap();
            assert!(started.elapsed() >= Duration::from_millis(500));
            assert_eq!(sync_read(device.0), b"a");
        }

        #[test]
        fn an_overlapped_port_sends_a_keystroke_while_its_read_waits() {
            let (device, client) = pipe("overlapped", true);
            let port = Arc::new(ComPort::from_handle(client));
            let alive = Arc::new(AtomicBool::new(true));

            let (p, a) = (port.clone(), alive.clone());
            let read = std::thread::spawn(move || {
                let mut buf = [0u8; 64];
                let n = p.read(&mut buf, &a).unwrap();
                buf[..n].to_vec()
            });
            std::thread::sleep(Duration::from_millis(100)); // the read is waiting

            let started = Instant::now();
            assert_eq!(port.write(b"a", &alive).unwrap(), 1);
            assert!(started.elapsed() < Duration::from_millis(50), "the key took {:?}", started.elapsed());
            assert_eq!(sync_read(device.0), b"a");

            sync_write(device.0, b"a");
            assert_eq!(read.join().unwrap(), b"a", "the echo");
        }

        #[test]
        fn closing_the_session_ends_a_waiting_read() {
            let (_device, client) = pipe("kill", true);
            let port = Arc::new(ComPort::from_handle(client));
            let alive = Arc::new(AtomicBool::new(true));
            let (p, a) = (port.clone(), alive.clone());
            let read = std::thread::spawn(move || {
                let mut buf = [0u8; 64];
                p.read(&mut buf, &a)
            });
            std::thread::sleep(Duration::from_millis(100));
            let started = Instant::now();
            alive.store(false, Ordering::Relaxed);
            let res = read.join().unwrap();
            assert!(matches!(res, Err(ref e) if was_cancelled(e)), "{res:?}");
            assert!(started.elapsed() < Duration::from_millis(1000));
        }
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
