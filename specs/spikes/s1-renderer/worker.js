// The "backend": produces 4 KB chunks at a target rate off the page's
// thread, the way plink output reaches the webview from another process.
// Echo markers travel in the same ordered stream, stamped with send time.
// window = null: sends regardless (the app today). Otherwise it stops
// sending while more than `window` bytes are unacknowledged (flow control).

const LINE_PLAIN = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n';
const COLORS = [31, 32, 33, 34, 35, 36];
// A coloured line (syslog-ish): one SGR run per word, ~64 visible chars.
const LINE_COLOR = '0123456789 abcdefghij klmnopqrst uvwxyzABCD EFGHIJKLMN OPQRSTUVWX\r\n'
  .split(' ').map((w, i) => `\x1b[${COLORS[i % COLORS.length]}m${w}\x1b[0m`).join(' ');
const enc = new TextEncoder();
const now = () => performance.timeOrigin + performance.now();

let timer = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'start') {
    const line = m.colored ? LINE_COLOR : LINE_PLAIN;
    const chunk = enc.encode(line.repeat(Math.max(1, Math.floor(4096 / line.length))));
    const perTickBytes = (m.targetMBps * 1e6) / 200; // 5 ms ticks
    let credit = 0;
    let sent = 0;
    let acked = 0;
    let lastMarker = 0;
    const t0 = now();
    self.onmessage = (e2) => {
      if (e2.data.ack != null) acked = e2.data.ack;
      if (e2.data.cmd === 'stop') {
        clearInterval(timer);
        self.postMessage({ kind: 'end', sent, secs: (now() - t0) / 1000 });
      }
    };
    // Stop on the worker's own clock: a flooded page may never get to send
    // "stop" (its timers starve), and then the flood would never end.
    setTimeout(() => {
      clearInterval(timer);
      self.postMessage({ kind: 'end', sent, secs: (now() - t0) / 1000 });
    }, m.seconds * 1000);
    timer = setInterval(() => {
      credit += perTickBytes;
      while (credit >= chunk.length) {
        if (m.window != null && sent - acked >= m.window) { credit = Math.min(credit, perTickBytes); break; }
        credit -= chunk.length;
        sent += chunk.length;
        self.postMessage({ kind: 'data', bytes: chunk, t: now() });
      }
      const t = now();
      if (t - lastMarker >= 100) {
        lastMarker = t;
        self.postMessage({ kind: 'marker', t });
      }
    }, 5);
  }
};
