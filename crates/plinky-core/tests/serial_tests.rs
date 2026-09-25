//! Serial sessions end to end without hardware (ADR-005): a pseudo-terminal
//! pair stands in for the USB-serial adapter. The master end plays the
//! device; the session opens the slave end by path, like /dev/ttyUSB0.
#![cfg(unix)]

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

use plinky_core::session::manager::SessionRegistry;
use plinky_core::transport::serial::SerialConfig;
use serialport::{SerialPort, TTYPort};
use tokio::sync::mpsc;

/// Opens a pty pair and returns the "device" end plus the line path a
/// session should open. The pair's own slave handle is closed so the
/// session can take the line exclusively, as it would a real adapter.
fn fake_device() -> (TTYPort, String) {
    let (mut device, line) = TTYPort::pair().expect("pty pair");
    let path = line.name().expect("pty slave path");
    drop(line);
    device.set_timeout(Duration::from_millis(100)).unwrap();
    (device, path)
}

fn config_for(path: &str) -> SerialConfig {
    let keys: BTreeMap<String, String> = [
        ("SerialLine", path),
        ("SerialSpeed", "115200"),
        ("SerialFlowControl", "0"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    SerialConfig::from_putty_keys(&keys).unwrap()
}

async fn recv_until(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>, needle: &str) -> String {
    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(Some(chunk)) = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            seen.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&seen).contains(needle) {
                break;
            }
        }
    }
    String::from_utf8_lossy(&seen).into_owned()
}

fn device_read_until(device: &mut TTYPort, needle: &[u8]) -> Vec<u8> {
    let mut seen = Vec::new();
    let mut buf = [0u8; 1024];
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && !seen.windows(needle.len()).any(|w| w == needle) {
        if let Ok(n) = device.read(&mut buf) {
            seen.extend_from_slice(&buf[..n]);
        }
    }
    seen
}

#[tokio::test]
async fn test_serial_session_is_live_both_ways_and_survives_a_break() {
    let (mut device, path) = fake_device();
    let registry = SessionRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    registry
        .create_serial_session("ser", "Console", &config_for(&path), None, tx)
        .expect("serial session opens");

    // Device -> terminal: a console prompt arrives with no pre-auth hold.
    device.write_all(b"\r\nSwitch> ").unwrap();
    let got = recv_until(&mut rx, "Switch> ").await;
    assert!(got.contains("Switch> "), "prompt never reached the terminal: {got:?}");

    // Terminal -> device, through the Live-only path paste uses.
    registry.write_input_live_only("ser", b"show version\r").expect("serial starts Live");
    let sent = device_read_until(&mut device, b"show version\r");
    assert!(
        sent.windows(13).any(|w| w == b"show version\r"),
        "keystrokes never reached the device: {:?}",
        String::from_utf8_lossy(&sent)
    );

    // A pty has no break line, so the kernel accepts the ioctl as a no-op:
    // this proves the plumbing, not the signal (that needs real hardware).
    registry.send_break("ser", Duration::from_millis(50)).await.expect("break on a serial line");

    device.write_all(b"after-break# ").unwrap();
    let got = recv_until(&mut rx, "after-break# ").await;
    assert!(got.contains("after-break# "), "session died after the break: {got:?}");

    registry.close_session("ser").unwrap();
}

#[tokio::test]
async fn test_large_serial_write_does_not_fail_or_block_the_caller() {
    // 256 KiB is past the kernel's pty buffering. The old synchronous write
    // hung here -- holding the session registry lock, which froze every
    // other tab -- until the device drained it. Now the caller returns at
    // once and the bytes all arrive, in order.
    let (mut device, path) = fake_device();
    let registry = SessionRegistry::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    registry.create_serial_session("big", "Console", &config_for(&path), None, tx).unwrap();

    let payload: Vec<u8> = (0..262144u32).map(|i| b'a' + (i % 26) as u8).collect();
    let started = Instant::now();
    registry.write_input("big", &payload).expect("write accepted");
    assert!(started.elapsed() < Duration::from_millis(50), "write blocked the caller");

    let mut got = Vec::new();
    let mut buf = [0u8; 4096];
    let deadline = Instant::now() + Duration::from_secs(5);
    while got.len() < payload.len() && Instant::now() < deadline {
        if let Ok(n) = device.read(&mut buf) {
            got.extend_from_slice(&buf[..n]);
        }
    }
    assert_eq!(got.len(), payload.len(), "bytes lost on the way to the device");
    assert!(got == payload, "bytes arrived out of order or corrupted");

    registry.close_session("big").unwrap();
}

#[tokio::test]
async fn test_unplugged_device_closes_the_session() {
    let (device, path) = fake_device();
    let registry = SessionRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    registry.create_serial_session("gone", "Console", &config_for(&path), None, tx).unwrap();

    // Closing the master hangs up the line, as unplugging an adapter does.
    drop(device);
    let got = recv_until(&mut rx, "[Plinky: Session closed]").await;
    assert!(got.contains("[Plinky: Session closed]"), "hangup not reported: {got:?}");
}

#[tokio::test]
async fn test_send_break_is_refused_on_non_serial_sessions() {
    let registry = SessionRegistry::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    registry.create_local_session("sh", "Local", None, 80, 24, tx).unwrap();

    let err = registry.send_break("sh", Duration::from_millis(10)).await.unwrap_err();
    assert!(err.to_string().contains("only supported on serial"), "{err}");

    registry.close_session("sh").unwrap();
}

#[test]
fn test_missing_device_is_a_clear_error() {
    let registry = SessionRegistry::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    let err = registry
        .create_serial_session("x", "x", &config_for("/dev/plinky-no-such-tty"), None, tx)
        .unwrap_err();
    assert!(err.to_string().contains("/dev/plinky-no-such-tty"), "{err}");
}
