# ADR-006: Terminal Renderer and Output Flow Control (Spike S1)

## Status
**Proposed** (2026-09-26). Linux (WebKitGTK) measured; Windows (WebView2) not yet — needs the owner's machine, CI runners have no GPU.

## Deciders
- Project Owner
- Claude (backend, measurements)

---

## Context
Spike S1 (PROPOSAL.md §6) sets echo-latency thresholds for the terminal:
unloaded p95 ≤ 16 ms; under a ≥ 50 MB/s stream p95 ≤ 50 ms, p99 ≤ 100 ms,
no UI freeze; DOM fallback if WebGL fails. It was never run (T-009).

How output reaches xterm today:
- The backend reads the PTY in 4 KB chunks (`transport/mod.rs`, `[0u8; 4096]`)
  and sends each one over a `Channel<Vec<u8>>`.
- The page writes every chunk straight into xterm. **There is no flow
  control**: nothing tells the backend to stop reading when the page falls
  behind.
- Only the DOM renderer is used. `@xterm/addon-webgl` is installed but never
  loaded.
- Every terminal tab shares one page, so one flooding session slows all of
  them, and the sidebar and dialogs too.

## Method
Harness: `specs/spikes/s1-renderer/` (run `python3 server.py`, open
`http://127.0.0.1:8765/?order=dom,webgl`). Run in WebKitGTK's own
MiniBrowser, `webkit2gtk-4.1 2.52.6` — the library Tauri uses on Linux.
AMD RX 9070, KDE Wayland, 60 Hz as WebKit sees it (idle frame gap p50 16 ms).

- Terminal options copied from `TerminalView.tsx`, fitted to 1280×800
  (**162×36**, as the app's FitAddon would).
- **Throughput**: 64 KB writes, ≤ 1 MB in flight, 64 MB plain / 32 MB
  coloured (one SGR run per word, syslog-like).
- **Stream**: a Web Worker plays the backend — 4 KB chunks at a target rate,
  sent whether or not the page keeps up, with a 10 Hz echo marker in the same
  ordered stream. Echo latency = worker send time → the frame that shows it.
  "256 KB window" = the page acknowledges rendered bytes and the source
  pauses past 256 KB unacknowledged (what flow control would do).
- **Not measured**: the Tauri IPC hop. See Consequences.

## Results (Linux, WebKitGTK)

| | DOM | WebGL |
|---|---|---|
| Idle echo latency p95 / max | 16 / 17 ms | 13 / 21 ms |
| Max throughput, plain text | 76–86 MB/s | 78 MB/s |
| Max throughput, coloured text | **36–38 MB/s** | **53 MB/s** |
| 50 MB/s plain, no flow control: echo p95 / p99 / max | 18–19 / 20–32 / 20–32 ms | 18 / 20 / 20 ms |
| 50 MB/s plain: longest frame gap | 24–36 ms | 20 ms |
| 20 MB/s coloured, no flow control: echo p95 / p99 | 19–33 / 22–72 ms | 18 / 20 ms |
| 20 MB/s coloured: page timers late by, max | 47 ms | — |
| **50 MB/s coloured, no flow control** | **page stopped making progress, twice** | kept up (phase done in 10.6 s) |

Raw data: `results-linux-2026-09-26-run2.json` (full, DOM first),
`…-run4-partial.json` (DOM up to the failing phase). A third run with WebGL
first confirmed WebGL finishes the 50 MB/s coloured phase; its file was not
saved (results were only posted at the end then, since fixed).

The DOM failure is the one that matters. At 50 MB/s of coloured output, DOM
can draw only ~37 MB/s, so the backlog grows by ~13 MB/s with nothing to
stop it. Both times, the page never finished that phase, and the window closed
about two minutes later. There are no numbers from inside it because the page
itself stopped running. In the app, that is every tab and the whole UI.

## Decision (proposed)
1. **Add flow control between backend and page.** The page acknowledges
   bytes as xterm's write callbacks fire; the backend stops reading the PTY
   once a window (256 KB measured here) is unacknowledged, which pushes back
   on plink through the PTY. With a window, latency is bounded by the
   window, not by how long the flood lasts; without one it is unbounded
   whenever output outruns rendering.
2. **Load the WebGL renderer, with DOM as the fallback** on addon failure
   or `onContextLoss` (as S1 already specified). +40% on coloured output,
   the kind network gear produces, and flatter frame times.

## Consequences
- **Still to measure: the IPC path.** A `Channel<Vec<u8>>` serialises each
  chunk as a JSON number array. A full 4 KB read is about 14 KB of JSON,
  over Tauri's 8 KB direct-delivery threshold
  (`MAX_JSON_DIRECT_EXECUTE_THRESHOLD`, `tauri-2.11.6/src/ipc/channel.rs`).
  So each chunk costs an extra `plugin:__TAURI_CHANNEL__|fetch` round trip
  plus a JSON parse on the page. This is likely a lower ceiling than
  rendering. Sending raw bytes (`tauri::ipc::Response`,
  `InvokeResponseBody::Raw`) would avoid the JSON, but raw payloads over
  1 KB take the fetch path too. Measure the end-to-end path in the real app
  before choosing.
- Keystroke echo when idle is small (a few bytes), so it takes the direct
  path: the 12–16 ms figures above are close to what a user sees on Linux.
- Windows: re-run this harness in Edge (Chromium, like WebView2) on the
  owner's machine; GPU and driver differ from CI.
