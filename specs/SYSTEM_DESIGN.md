# Plinky: System Design (v1, Linux + Windows)

Author: Claude (Critic / Architect). Date: 2026-09-20. Basis: repo at `25e482f` (docs only, no code), ADR-001 (plink only), ADR-002 (detect PuTTY, no bundling).
Tags: **[A]** assumption to confirm, **[?]** unverified claim to settle in a Phase 0 spike, **D#** design decision.

---

## 1. Requirements

**Functional (v1)**
- F1 Open PuTTY saved sessions (Linux `PUTTYDIR` / `XDG_CONFIG_HOME/putty` / `~/.putty`; Windows registry) and quick-connect.
- F2 Terminals over `plink` (ssh, telnet, raw, serial), plus a local shell.
- F3 Tabs and split panes, with the layout persisted.
- F4 Free Type Mode. F5 four sync-input channels (A to D). F6 regex markers and clickable links.
- F7 SFTP dual pane with directory following. F8 tunnels. F9 snippets. F10 credential vault.

**Non-functional**
- **Security first.** The remote host is hostile input. No secret ever appears in argv.
- Keystroke echo p95 under 50 ms while a heavy stream runs **[A]**. Sustained 50 MB/s output with no UI freeze **[A]**. Both thresholds are fixed before the Phase 0 spike, not after.
- A webview reload must not kill sessions. A plink crash must not kill the app.
- Up to 50 concurrent sessions and a sync fan-out of 20 **[A]**.

**Constraints:** Rust + Tauri v2. Linux + Windows first. PuTTY 0.75 or newer, detected and never bundled. Team: owner, Antigravity (writer), Claude (critic).

**Non-goals for v1:** macOS, `russh`, plugin API, cloud sync, Zmodem, session recording.

---

## 2. High-level design

```
 Webview (React 19 + xterm.js + dockview)            src-tauri (thin: commands only)
 +-------------------------------------+   invoke   +---------------------------+
 | xtermRegistry (outside React)       |----------->| commands -> plinky-core   |
 | OSC 133 / OSC 7 handlers            |<-----------| Channel<OutputChunk>      |
 | FreeType, markers, sync bar, layout |  Channels  | small events: state/prompt|
 +-------------------------------------+   (raw)    +-------------+-------------+
                                                                  |
              +---------------------- plinky-core ---------------+--------------+
              | SessionRegistry (state machine + ring buffer per session)        |
              | Transport trait: PlinkTransport | LocalPty | (SerialViaPlink)    |
              | SyncInputRouter | ShellIntegration | SftpService | TunnelService |
              | Vault | Settings/Layout store | PuttyLocator                      |
              +---------------------------------+--------------------------------+
                                                |
                       putty-compat (no Tauri dep): sessions r/w, ppk METADATA,
                       hostkey listing (read-only), winreg
                                                |
                     spawns: plink / psftp (with -share)  <-- detected, version-checked
```

**Data flow:** keystroke -> xterm `onData` -> `session_write(id, bytes)` -> `SyncInputRouter` -> `Transport.write`.
Output: transport read loop -> ring buffer append -> `Channel` chunk `{seq, bytes}` -> `xterm.write(cb)` -> `session_ack(seq)`.

---

## 3. Design decisions (new or changed, with reasons)

**D1. `putty-compat` v1 is smaller than the current scaffold.** With plink as the only transport, plink itself reads `.ppk` keys, talks to the agent, verifies and stores host keys. v1 needs only: session read/write, `.ppk` header parsing (list, fingerprint, encrypted?), and read-only host-key listing. **Defer `.ppk` decryption, the agent client and the hostkey writer** until a feature needs them (a key manager, or `russh`). This removes most of the attack surface of the hand-written crypto and parsers. *Owner call:* Antigravity's briefing lists `.ppk` Argon2id decryption as a headline feature.

**D2. Plinky never writes host keys.** Plink owns verification and storage. Plinky shows the fingerprint to the user and answers plink's own prompt (`y`/`n`). This supersedes `PUTTY_WRAPPER_SPEC` line 65, which has Plinky appending to `sshhostkeys`. On Windows PuTTY keeps host keys in the registry (I believe `HKCU\Software\SimonTatham\PuTTY\SshHostKeys` **[?]**), so any listing must handle both stores.

**D3. Prompt handling is a per-session state machine, armed only before authentication.**
`Created -> Spawning -> PreAuth{HostKeyPending | PasswordPending | PassphrasePending} -> Live -> Closing -> Closed{exit | error}`
- Interceptors exist only in `PreAuth`, match exact plink 0.85 text, answer once, and default to deny on anything unparsed.
- A hostile server controls its pre-auth banner and keyboard-interactive challenge text. Auto-fill only the standard password prompt, once, from the vault credential bound to that session. Never fill a keyboard-interactive challenge.
- **Open problem [?]:** plink prints no explicit "authenticated" marker. Candidates: verbose (`-v`) markers, first prompt/OSC 133 marker, or a timeout. Settle in spike S2.
- No auth material in argv. `-pw` is prohibited.

**D4. PuTTY's store is read-only by default.** Plinky metadata (folder, tags, colour, `protected`, default sync channel) lives in Plinky's own config keyed by session name. PuTTY rewrites session files in full and may drop unknown keys, so never store our fields there. "Save back to PuTTY" is an explicit opt-in: backup first, atomic write, round-trip test on real files.

**D5. Fewer dependencies in v1.** `tauri`, `portable-pty`, `tokio`, `serde`, `tracing`, `zeroize`, `argon2` + `aes-gcm` (vault), `winreg` (Windows). No `russh`, no `ssh2`. Serial goes through `plink -serial`; enumerating device names needs only a directory listing on Linux and the registry on Windows.

**D6. The sync router filters by state.** Broadcast only to `Live` sessions, never into another session's password or host-key prompt. Sessions tagged `protected` receive broadcast only when explicitly opted in. A multi-line paste to a channel of 2 or more sessions asks for confirmation.

**D7. Vertical slice before breadth** (this revises my earlier "crates first" ordering). The high risks are transport, prompts and rendering, not parsers. Build one session end to end before the store, docking or features.

---

## 4. Deep dive

### 4.1 IPC contract (Tauri v2)

| Command | Purpose |
|---|---|
| `putty_detect() -> PuttyInfo{path, version, ok, reason}` | ADR-002 discovery and floor check |
| `session_open(spec, on_data: Channel<OutputChunk>) -> SessionId` | spawn |
| `session_attach(id, on_data, from_seq) -> AttachInfo{replay, truncated}` | reattach after a reload |
| `session_write(id, Bytes)` / `session_resize(id, cols, rows)` / `session_close(id)` | I/O |
| `session_ack(id, seq)` | flow control |
| `prompt_answer(id, prompt_id, Answer)` | host key and passphrase |
| `sync_set(id, mask_u8)` / `sync_arm(bool)` | channels A to D |
| `cwd_report(id, path)` | OSC 7 from the frontend to the SFTP service |

- **Bulk data uses `Channel` with raw bytes.** Small, low-rate items use events (`session:state`, `session:prompt`), because events are not meant for throughput (from memory **[?]**).
- **OSC parsing lives in xterm.js** (`registerOscHandler`), which gives exact buffer coordinates. Rust receives only what it needs (cwd).
- **Flow control:** credit window `W` (start at 256 KiB **[A]**). The core stops reading the PTY when unacked bytes reach `W`, and back-pressure reaches plink through the PTY buffer. The ring buffer (start at 2 MiB per session **[A]**, about 100 MiB at 50 sessions) keeps the last bytes whether or not a consumer is attached and sets `truncated` when it drops the oldest.

### 4.2 Persisted data (Linux `$XDG_CONFIG_HOME/plinky`, Windows `%APPDATA%\Plinky`)

`settings.json`, `layout.json` (dockview JSON plus session ids), `snippets.json`, `markers.json` (all carry a `schema_version`), and `vault.bin`. The vault has a header with the Argon2id parameters and salt, then one record per entry with a fresh random nonce and the record id as AAD (AES-256-GCM). Use `zeroize` for secrets in memory.

**Persistence rules, taken from the bugs found in the bridge locking review:**
- R1: write to a temp file, fsync, rename. Never report "saved" unless the rename succeeded.
- R2: a missing file means defaults. A present but corrupt file is moved aside (`*.corrupt.<ts>`) and reported, never silently overwritten. A read error fails the write.
- R3: unknown fields survive a read-modify-write.

### 4.3 Errors and retry

| Failure | Behaviour |
|---|---|
| plink missing or below 0.75 | typed error, UI shows the detected path and version, user can set a path |
| Connection lost (plink exit) | `Closed{exit, last N bytes classified best-effort}`. Auto-reconnect is opt-in per session, only after a previous `Live`, with exponential backoff capped at 30 s. **Never** auto-reconnect after an auth failure or host-key mismatch. |
| Core task panic | supervised per session, so one session dies and the app stays up |
| psftp | one queued coprocess per connection with per-command timeouts. No automatic retry of `put`/`rm`. Resume with `reget`/`reput` **[?]**. |
| Config write failure | surfaced to the user (R1), never swallowed |

### 4.4 Threat model, summary
Hostile server output (OSC 52 clipboard, title reports, OSC 8 links), hostile banners (D3), argv leakage, `-share` sockets (same-uid trust only), vault at rest, webview XSS (strict CSP, output never goes through innerHTML), minimal Tauri capabilities (no shell or fs exposed to the webview), supply chain (`cargo-deny`, `cargo-audit`, committed lockfile), parser fuzzing (sessions, `.ppk` headers).

---

## 5. Scale and reliability

- Load: 50 sessions x up to 50 MB/s bursts is bounded by the credit window, not by memory. Sync fan-out is done in Rust with one IPC call per keystroke, regardless of channel size.
- Failure containment: session, prompt, SFTP and tunnel each have their own supervised task.
- Observability: `tracing` to a rotating local log with secret redaction. A "diagnostics" export contains plink/psftp versions, OS, webview version and settings with no secrets.
- Testing: unit, fuzz corpus, headless integration against a localhost `sshd` on both OSes, a scripted Phase 0 benchmark, and a Windows manual pass on the owner's machine.

---

## 6. Build order and acceptance

| M | Deliverable | Accept when |
|---|---|---|
| **M0** | Spikes S1 to S4 (WebGL throughput; plink under PTY incl. auth-boundary detection, resize, exact prompt text; `-share` lifecycle and downstream forwards; psftp parsing) on Linux and Windows | thresholds set first; results written as ADRs; unknowns marked [?] above are closed |
| **M1** | CI (Linux + Windows), `cargo-deny`, threat-model doc, localhost `sshd` fixture | green on both |
| **M2** | **Walking skeleton:** hard-coded session, one tab, `Channel` + flow control + ring buffer, reload-and-reattach | reload keeps the session; throughput meets M0 thresholds |
| **M3** | `putty-compat` v1 (D1): sessions, `.ppk` headers, hostkey listing; session tree | fixtures from real `puttygen`; every parser behaviour tested; fuzz clean |
| **M4** | Pre-auth state machine (D3), vault, `putty_detect` | scripted host-key and password flows pass; a hostile-banner test cannot trigger a fill |
| **M5** | dockview multi-tab/split, layout persistence, `SyncInputRouter` (D6), shell-integration bootstrap | sync race review passed; state-filter tests pass |
| **M6** | Free Type, markers/link provider, snippets | gating tests (alt buffer, DECCKM, wide chars, OSC 133 region) pass |
| **M7** | SFTP and tunnels, scoped by S3/S4 | transfers resume; unsupported tunnel types documented |

Review gate on every milestone: I audit the diff before commit, and each post lists behaviours covered by tests and those not.

---

## 7. Open questions (all resolvable by M0)
1. How to detect the pre-auth to live boundary reliably (D3)?
2. Does plink.exe on Windows propagate terminal resizes under ConPTY?
3. What happens to a `psftp -share` downstream when the owning tab closes, and which forwarding types work from a downstream?
4. Is `psftp` output parsing robust enough for SFTP (spaces, newlines, unicode, symlinks)?
5. WebKitGTK/WebGL throughput on this Wayland box, and WebView2 on Windows.
6. Windows host-key store location and format.

## 8. Revisit as the system grows
`russh` (only if a spike proves a gap), `.ppk` decryption and an agent client (key manager), PuTTY bundling, macOS, plugin API, session recording, Zmodem, cloud/Git profile sync.
