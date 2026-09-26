// Plinky S1 spike: xterm.js DOM vs WebGL renderer on WebKitGTK.
//
// Mirrors the app's terminal options (TerminalView.tsx) and its data path:
// the backend reads the PTY in 4 KB chunks and the frontend writes every
// chunk straight into xterm, with no backpressure. "Echo latency" is the
// time from writing a marker (what a keystroke echo is, once it arrives)
// to the frame that shows it -- it waits behind whatever is queued ahead.

const LINE = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n'; // spec's `yes` line, 64 B
const enc = new TextEncoder();
const CHUNK_4K = enc.encode(LINE.repeat(64));      // one PTY read (transport/mod.rs: [0u8; 4096])
const CHUNK_64K = enc.encode(LINE.repeat(1024));
const MARKER = enc.encode('\x1b[7m#\x1b[0m');
const COLORS = [31, 32, 33, 34, 35, 36];
const LINE_COLOR = '0123456789 abcdefghij klmnopqrst uvwxyzABCD EFGHIJKLMN OPQRSTUVWX\r\n'
  .split(' ').map((w, i) => `\x1b[${COLORS[i % COLORS.length]}m${w}\x1b[0m`).join(' ');
const CHUNK_COLOR_64K = enc.encode(LINE_COLOR.repeat(Math.floor(65536 / LINE_COLOR.length)));
const nowAbs = () => performance.timeOrigin + performance.now();

const statusEl = document.getElementById('status');
const status = (t) => {
  statusEl.textContent = t;
  fetch('/progress', { method: 'POST', body: `${new Date().toISOString()} ${t}` }).catch(() => {});
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x) => (x == null ? null : Math.round(x * 10) / 10);
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const stats = (arr) => ({
  n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), p99: pct(arr, 99),
  max: arr.length ? round(Math.max(...arr)) : null,
});

function frameMonitor() {
  const gaps = [];
  let last = performance.now();
  let on = true;
  const tick = (t) => { gaps.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return { stop() { on = false; return gaps; } };
}

function gpuInfo() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { webgl2: false };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      webgl2: true,
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  } catch (e) {
    return { webgl2: false, error: String(e) };
  }
}

function makeTerm(renderer) {
  const el = document.getElementById('term');
  el.innerHTML = '';
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, lineHeight: 1.25, allowTransparency: true, allowProposedApi: true,
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
    theme: { background: '#090d16', foreground: '#e2e8f0' },
  });
  term.open(el);
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  fit.fit(); // the app fits to its pane; v1 of this bench ran at 80x24
  const info = { requested: renderer };
  if (renderer === 'webgl') {
    try {
      const addon = new WebglAddon.WebglAddon();
      addon.onContextLoss(() => { info.contextLost = true; });
      term.loadAddon(addon);
      info.webglLoaded = true;
    } catch (e) {
      info.webglLoaded = false;
      info.webglError = String(e);
    }
  }
  info.canvasCount = el.querySelectorAll('canvas').length;
  info.domRows = !!el.querySelector('.xterm-rows');
  info.cols = term.cols;
  info.rows = term.rows;
  return { term, info };
}

// Write a marker; resolve with ms until the frame that rendered it.
function markerLatency(term, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), timeoutMs);
    term.write(MARKER, () => {
      const d = term.onRender(() => { d.dispose(); finish(performance.now() - t0); });
    });
  });
}

async function idleLatency(term, samples = 50) {
  const lat = [];
  for (let i = 0; i < samples; i++) {
    const ms = await markerLatency(term);
    if (ms != null) lat.push(ms);
    await sleep(100);
  }
  return stats(lat);
}

// Fastest sustained rate: 64 KB writes, at most 1 MB in flight.
async function throughput(term, totalBytes, chunk = CHUNK_64K) {
  const mon = frameMonitor();
  const t0 = performance.now();
  let sent = 0;
  let acked = 0;
  await new Promise((done) => {
    const pump = () => {
      while (sent < totalBytes && sent - acked < (1 << 20)) {
        sent += chunk.length;
        term.write(chunk, () => {
          acked += chunk.length;
          if (acked >= totalBytes) done();
          else pump();
        });
      }
    };
    pump();
  });
  const secs = (performance.now() - t0) / 1000;
  return { mb: round(totalBytes / 1e6), secs: round(secs), mbps: round(totalBytes / 1e6 / secs), frameGapsMs: stats(mon.stop()) };
}

// The source runs in a Worker (worker.js), like plink output arriving from
// the backend process: it keeps producing whether or not the page keeps
// up. Echo markers ride in the same ordered stream; latency is measured
// from the worker's send time to the frame that shows the marker.
// windowBytes = null: no flow control (the app today). Otherwise the page
// acknowledges rendered bytes and the source pauses past the window.
async function stream(term, { targetMBps, seconds, windowBytes, colored = false }) {
  const w = new Worker('/worker.js');
  const mon = frameMonitor();
  const lat = [];
  const queueDelay = [];
  let received = 0;
  let rendered = 0;
  let ackSent = 0;
  let msgs = 0;
  let markersSent = 0;
  let endInfo = null;
  let runaway = false;
  let maxBacklog = 0;
  w.onmessage = (e) => {
    const m = e.data;
    if (m.kind === 'data') {
      if ((msgs++ & 63) === 0) queueDelay.push(nowAbs() - m.t);
      received += m.bytes.length;
      term.write(m.bytes, () => {
        rendered += m.bytes.length;
        if (windowBytes != null && rendered - ackSent >= 65536) { ackSent = rendered; w.postMessage({ ack: rendered }); }
      });
      maxBacklog = Math.max(maxBacklog, received - rendered);
      if (windowBytes == null && (received - rendered > 128e6 || nowAbs() - m.t > 15000)) runaway = true;
    } else if (m.kind === 'marker') {
      markersSent++;
      const t = m.t;
      term.write(MARKER, () => {
        const d = term.onRender(() => { d.dispose(); lat.push(nowAbs() - t); });
      });
    } else if (m.kind === 'end') {
      endInfo = m;
    }
  };
  // How late the page's own 50 ms timer fires: the app's UI (every tab,
  // the sidebar, dialogs) runs on this same thread.
  const timerLate = [];
  let expect = performance.now() + 50;
  const probe = setInterval(() => { const t = performance.now(); timerLate.push(t - expect); expect = t + 50; }, 50);
  w.postMessage({ cmd: 'start', targetMBps, window: windowBytes, colored, seconds });
  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000 && !runaway) await sleep(100);
  w.postMessage({ cmd: 'stop' });
  const wall = (performance.now() - t0) / 1000;
  const renderedAtStop = rendered;
  const receivedAtStop = received;
  const drainStart = performance.now();
  while ((!endInfo || rendered < endInfo.sent || lat.length < markersSent) && performance.now() - drainStart < 90000) await sleep(50);
  const drainSecs = (performance.now() - drainStart) / 1000;
  clearInterval(probe);
  w.terminate();
  return {
    targetMBps, windowBytes, colored, seconds: round(wall), runawayStopped: runaway,
    offeredMBps: endInfo ? round(endInfo.sent / 1e6 / endInfo.secs) : null,
    renderedMBps: round(renderedAtStop / 1e6 / wall),
    unrenderedAtStopMB: endInfo ? round((endInfo.sent - renderedAtStop) / 1e6) : null,
    receivedNotRenderedAtStopMB: round((receivedAtStop - renderedAtStop) / 1e6),
    maxXtermBacklogMB: round(maxBacklog / 1e6),
    drainAfterStopSecs: round(drainSecs),
    markersSent, markersRendered: lat.length,
    echoLatencyMs: stats(lat),
    messageQueueDelayMs: stats(queueDelay),
    frameGapsMs: stats(mon.stop()),
    uiTimerLateMs: stats(timerLate),
  };
}

let partial = {};
const savePartial = () => fetch('/result', { method: 'POST', body: JSON.stringify({ partial: true, ...partial }, null, 2) }).catch(() => {});

async function runRenderer(renderer) {
  const { term, info } = makeTerm(renderer);
  await sleep(500);
  const out = { info };
  status(`${renderer}: idle latency`);
  out.idle = await idleLatency(term);
  status(`${renderer}: throughput`);
  out.throughputPlain = await throughput(term, 64 * 1024 * 1024);
  out.throughputColored = await throughput(term, 32 * 1024 * 1024, CHUNK_COLOR_64K);
  partial[renderer] = out; savePartial();
  await sleep(500);
  status(`${renderer}: 50 MB/s stream, no flow control (app today)`);
  out.stream50NoFlow = await stream(term, { targetMBps: 50, seconds: 10, windowBytes: null });
  partial[renderer] = out; savePartial();
  await sleep(500);
  status(`${renderer}: 50 MB/s stream, 256 KB window`);
  out.stream50Window256K = await stream(term, { targetMBps: 50, seconds: 10, windowBytes: 256 * 1024 });
  partial[renderer] = out; savePartial();
  await sleep(500);
  status(`${renderer}: 20 MB/s coloured stream, no flow control`);
  out.stream20ColoredNoFlow = await stream(term, { targetMBps: 20, seconds: 10, windowBytes: null, colored: true });
  partial[renderer] = out; savePartial();
  await sleep(500);
  status(`${renderer}: 50 MB/s coloured stream, no flow control`);
  out.stream50ColoredNoFlow = await stream(term, { targetMBps: 50, seconds: 10, windowBytes: null, colored: true });
  partial[renderer] = out; savePartial();
  await sleep(500);
  status(`${renderer}: 50 MB/s coloured stream, 256 KB window`);
  out.stream50ColoredWindow256K = await stream(term, { targetMBps: 50, seconds: 10, windowBytes: 256 * 1024, colored: true });
  partial[renderer] = out; savePartial();
  await sleep(500);
  status(`${renderer}: idle latency after load`);
  out.idleAfter = await idleLatency(term, 30);
  info.contextLostDuringRun = !!info.contextLost;
  term.dispose();
  return out;
}

(async () => {
  const results = {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    gpu: gpuInfo(),
    startedAt: new Date().toISOString(),
  };
  try {
    // Idle frame interval: the display's refresh as WebKit sees it.
    const mon = frameMonitor();
    await sleep(1000);
    results.idleFrameGapMs = stats(mon.stop());
    const order = (new URLSearchParams(location.search).get('order') || 'dom,webgl').split(',');
    for (const r of order) results[r] = await runRenderer(r);
  } catch (e) {
    results.error = String(e && e.stack || e);
  }
  results.finishedAt = new Date().toISOString();
  status('done');
  await fetch('/result', { method: 'POST', body: JSON.stringify(results, null, 2) });
})();
