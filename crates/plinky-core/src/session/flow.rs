//! Output flow control between a session and the page drawing it (ADR-006).
//!
//! Without it, the PTY reader read as fast as plink wrote and every byte was
//! queued for the page. When output outran rendering (measured: the DOM
//! renderer draws coloured text at ~37 MB/s), the backlog grew without
//! bound; a coloured flood at 50 MB/s left the page unable to finish, and
//! all tabs share that one page.
//!
//! The page acknowledges bytes as xterm finishes with them; once `window`
//! bytes are sent but unacknowledged, the PTY reader stops reading. The
//! kernel's PTY buffer fills, plink blocks on its write, and SSH's own flow
//! control slows the far end. Echo latency is then bounded by the window,
//! not by how long the flood lasts.
//!
//! Only a session with a page attached is gated. A detached one (its tab not
//! on screen) free-runs into scrollback, as before: a background tab must
//! never pause the program running in it.

use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// Bytes the page may be behind before the reader waits. At the ~37 MB/s the
/// slowest measured renderer manages, a full window is ~14 ms of drawing.
pub const OUTPUT_WINDOW: u64 = 512 * 1024;

#[derive(Debug, Default)]
struct FlowState {
    unacked: u64,
    attached: bool,
    closed: bool,
}

#[derive(Debug)]
pub struct FlowGate {
    window: u64,
    state: Mutex<FlowState>,
    room: Condvar,
}

impl FlowGate {
    /// A gate for a session whose page is attached from the start (the tab
    /// that opened it).
    pub fn new(window: u64) -> Self {
        Self {
            window,
            state: Mutex::new(FlowState { attached: true, ..Default::default() }),
            room: Condvar::new(),
        }
    }

    /// `n` bytes were handed to the page. Not counted while detached.
    pub fn charge(&self, n: usize) {
        let mut s = self.state.lock().unwrap();
        if s.attached {
            s.unacked = s.unacked.saturating_add(n as u64);
        }
    }

    /// The page is done with `n` bytes.
    pub fn ack(&self, n: u64) {
        let mut s = self.state.lock().unwrap();
        s.unacked = s.unacked.saturating_sub(n);
        self.room.notify_all();
    }

    /// A page attached: it starts with nothing outstanding (it gets the
    /// scrollback as a replay, which is never charged).
    pub fn attach(&self) {
        let mut s = self.state.lock().unwrap();
        s.attached = true;
        s.unacked = 0;
        self.room.notify_all();
    }

    /// No page is drawing this session: stop gating, so the reader runs free.
    pub fn detach(&self) {
        let mut s = self.state.lock().unwrap();
        s.attached = false;
        s.unacked = 0;
        self.room.notify_all();
    }

    /// The session is ending: release a waiting reader for good.
    pub fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.room.notify_all();
    }

    pub fn unacked(&self) -> u64 {
        self.state.lock().unwrap().unacked
    }

    fn has_room(&self, s: &FlowState) -> bool {
        !s.attached || s.closed || s.unacked < self.window
    }

    /// Blocks the reader while the page is a full window behind. Wakes on an
    /// ack, a detach or a close; the timeout is a backstop, never the
    /// mechanism.
    pub fn wait_for_room(&self) {
        let mut s = self.state.lock().unwrap();
        while !self.has_room(&s) {
            s = self.room.wait_timeout(s, Duration::from_millis(250)).unwrap().0;
        }
    }

    /// For tests: whether the reader would go ahead right now.
    pub fn would_read(&self) -> bool {
        self.has_room(&self.state.lock().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn stops_the_reader_at_a_full_window_and_an_ack_lets_it_go() {
        let gate = Arc::new(FlowGate::new(8));
        gate.charge(5);
        assert!(gate.would_read());
        gate.charge(3);
        assert!(!gate.would_read(), "8 of 8 outstanding");

        let done = Arc::new(AtomicBool::new(false));
        let (g, d) = (gate.clone(), done.clone());
        let t = std::thread::spawn(move || {
            g.wait_for_room();
            d.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(50));
        assert!(!done.load(Ordering::SeqCst), "the reader waits");
        let t0 = Instant::now();
        gate.ack(4);
        t.join().unwrap();
        assert!(t0.elapsed() < Duration::from_millis(200), "woken by the ack, not the timeout");
        assert_eq!(gate.unacked(), 4);
    }

    #[test]
    fn a_detached_session_runs_free_and_is_not_charged() {
        let gate = FlowGate::new(8);
        gate.charge(8);
        assert!(!gate.would_read());
        gate.detach();
        assert!(gate.would_read());
        gate.charge(1_000_000);
        assert_eq!(gate.unacked(), 0, "a background tab never builds up a debt");
        assert!(gate.would_read());
    }

    #[test]
    fn attaching_starts_from_nothing_outstanding() {
        let gate = FlowGate::new(8);
        gate.charge(8);
        gate.attach();
        assert_eq!(gate.unacked(), 0);
        assert!(gate.would_read());
    }

    #[test]
    fn closing_releases_a_waiting_reader() {
        let gate = Arc::new(FlowGate::new(1));
        gate.charge(1);
        let g = gate.clone();
        let t = std::thread::spawn(move || g.wait_for_room());
        std::thread::sleep(Duration::from_millis(30));
        gate.close();
        t.join().unwrap();
    }

    #[test]
    fn late_acks_from_an_old_page_never_go_below_zero() {
        let gate = FlowGate::new(8);
        gate.charge(2);
        gate.ack(10);
        assert_eq!(gate.unacked(), 0);
    }
}
