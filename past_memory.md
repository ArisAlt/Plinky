[PROJECT]: Plinky (PuTTY Modern Wrapper & IDE-grade Terminal Emulator, named after 'plink')
[ROOT]: .
[WORKSPACE_ALT]: (local IDE workspace mirror)
[DATE_INIT]: 2026-09-20
[STATUS]: Scaffolding & Specifications Complete; Name Finalized as Plinky

### 1. WINDTERM FORENSIC ANALYSIS & FAILURE REASONS
* Target: kingToolbox/WindTerm (C++/Qt terminal emulator).
* Core strengths: Free Type Mode (mouse click cursor placement & canvas edit), Sync Input (up to 4 broadcast channels), integrated SFTP file manager with drag & drop, real-time regex highlighting (IPs, errors, URLs, keywords), snippet bar, session hierarchy, local/remote/dynamic SSH tunnels, OSC 133 semantic prompt detection.
* Community backlash & demise: Advertised Apache-2.0 license but kept terminal engine & networking backend closed-source binary blobs ("gradual open-sourcing" was never fulfilled). Single maintainer bottleneck. Updates ceased/stalled (>1 year silence). Over 3,000 issues left unattended. Enterprise & security users abandoned due to proprietary binary handling of SSH keys, passwords, and root credentials.

### 2. PUTTY LINUX & WINDOWS ARCHITECTURE
* Linux Host Environment Verified:
  - System has full PuTTY 0.85 suite installed: `/usr/bin/putty`, `/usr/bin/plink`, `/usr/bin/pscp`, `/usr/bin/psftp`, `/usr/bin/puttygen`, `/usr/bin/pageant`.
  - Local sessions verified at `~/.putty/sessions/`: `192.0.2.10%20`, `COM%20USB0`, `Default%20Settings`.
  - Session format: Plaintext key-value pairs (`HostName=`, `PortNumber=`, `SerialLine=`, `PublicKeyFile=`), percent-encoded filenames.
  - SSH Host keys: `~/.putty/sshhostkeys`.
  - Agent protocol: Native Unix Domain Socket `$SSH_AUTH_SOCK` (standard on Linux).
  - Serial protocol: Linux character devices (`/dev/ttyUSB0`, `/dev/ttyACM0`).
* Windows Compatibility:
  - Registry storage under `HKCU\Software\SimonTatham\PuTTY\Sessions`.
  - Named Pipe IPC `\\.\pipe\pageant.*` and Win32 `WM_COPYDATA`.
* Confirmed Architecture: **Rust + Tauri v2 (with TypeScript & xterm.js)**
  - Backend: Rust (Tauri v2)
    * PTY Management: `portable-pty` crate (handles Unix PTYs on Linux/macOS and ConPTY on Windows).
    * PuTTY Sessions: Native parser for `~/.putty/sessions/` on Linux and `winreg` on Windows.
    * PuTTY Keys: `.ppk` v2 (SHA-1) and v3 (Argon2id + AES-256-CBC) native parser & decryptor.
    * Agent Bridge: Unix Domain Socket (`$SSH_AUTH_SOCK`) on Linux/macOS, Windows Named Pipe (`\\.\pipe\pageant.*`).
    * Subprocess Runner: Spawns `/usr/bin/plink` or `plink.exe` with async streaming.
    * Serial Port: `serialport` crate for `/dev/ttyUSB*` on Linux and `COM*` on Windows.
    * SFTP Subsystem: Async SFTP client via `russh` / `ssh2` with concurrent chunked transfers.
  - Frontend: TypeScript + React/Vite + xterm.js
    * Terminal Rendering: `xterm.js` with `@xterm/addon-webgl` for 60 FPS hardware acceleration.
    * IDE Docking: `dockview` for multi-tab split panes, dockable SFTP sidebars, and session trees.
    * Free Type Mode: DOM mouse event interceptor calculating cursor offsets and emitting navigation escapes.
    * Sync Input: Multi-channel broadcast router (Channels A, B, C, D) over typed Tauri IPC events.
    * Regex Markers: Real-time token decoration provider styling IPs, URLs, and log levels.
* Naming Resolution:
  - Selected name: **Plinky** (homage to `/usr/bin/plink`; friendly, memorable, cross-platform, eliminating the "Win" Windows-only connotation).
* Agent Collaboration Bridge:
  - Connected via `abtools-bridge` MCP server.
  - Message #86 sent to Claude Desktop with structured payload `0086-plinky_project_briefing.json`.
  - Division of Labor Formally Adopted:
    * Gemini (Antigravity): Explorer / Fast Implementer (large context ingestion, rapid scaffolding, tool execution, file edits, test running, live repo sync).
    * Claude Sonnet 5: Deep Architect / Critic (code review, race condition detection, edge cases in PTY/crypto/sync protocols, structural validation).
    * Pattern: Writer/Critic loop — Gemini writes implementation -> notifies Claude via bridge -> Claude reviews and spots subtle logic flaws -> Gemini integrates and verifies.

### 3. MANDATORY DIRECTIVES & GOVERNANCE
* User Global Rules:
  - `GEMINI.md` in root with project description, dense `past_memory.md`, and instructions to always update `README.md` and `scaffold.md` with implementation plan.
  - All documentation and architectural proposals housed in root and `specs/` directory.

### 4. KEY DELIVERABLES (DOCS & PROPOSALS)
* `GEMINI.md`: Governance and project definition.
* `past_memory.md`: This dense memory ledger.
* `README.md`: Master project guide, feature comparison matrix, installation and vision.
* `scaffold.md`: Component layout, module boundaries, and file directory tree.
* `specs/PROPOSAL.md`: Deep technical proposal for the PuTTY wrapper and feature replication.
* `specs/WINDTERM_ANALYSIS.md`: Exhaustive dissection of WindTerm, GitHub issue metrics, and community feature requests.
* `specs/PUTTY_WRAPPER_SPEC.md`: Low-level protocol and interface specification for PuTTY session importing, PPK parsing, Pageant IPC, and Plink piping.
* `specs/FEATURE_MATRIX.md`: Side-by-side feature comparison table and implementation strategy.

### 5. CLAUDE CRITIC REVIEW (MSG #91) & ARCHITECTURAL CONSENSUS
* Empirical Corrections: GitHub API check on `kingToolbox/WindTerm` verified 2,450 open issues/PRs (not "over 3,000"). Real top issues: #1596 (abandoned, +152), #2106 (large file download bug, +18), #2238 (closed core, +14). Non-existent citations (#1850, #2910, #1204) eliminated.
* Primary Transport: `/usr/bin/plink` under `portable-pty` with `-share` connection sharing is primary. `psftp -share` multiplexes on the active pipe without duplicate auth. `russh` preserved strictly for dynamic runtime port forwarding.
* IPC Streaming: Switched from Tauri events to `tauri::ipc::Channel` with raw binary bytes and watermark flow control. Sessions & scrollback ring buffers live in Rust core so webview reloads do not terminate connections.
* Cargo Workspace: Refactored to `crates/putty-compat` (zero Tauri dependency, fully fuzzable), `crates/plinky-core`, and `src-tauri`.
* Missing Modules Added: Rust `tunnel/` module, `sshhostkeys` TOFU verification, shell integration bootstrap (`shell_integration/` for OSC 133 + OSC 7), unified `Transport` trait, Rust `SyncInputRouter`.
* Precedence: PuTTY session lookup checks `$PUTTYDIR` first, `$XDG_CONFIG_HOME/putty`, then `~/.putty`.
* Security Hardening: Prohibited `plink -pw` (ps leak); Expect triggers require session binding + explicit user confirmation; OSC 52 clipboard access gated; Vault KDF unified to Argon2id.
* Feature Gating: Free Type Mode disabled in alternate buffer (`vim`, `htop`), handles `DECCKM` application cursor keys, requires verified OSC 133 B..C command region. `xterm.js` `IDecorationOptions` constrained to color styling; clickable IPs/URLs handled via `registerLinkProvider`.
* Layout: Dockview terminal panels use `renderer: 'always'` with external `xtermRegistry` outside React.
* Standalone MCP Bridge: Extracted from ABtools into a sibling project (`mcp_dual_agent`) with passing pytest suite and client configs.

### 6. CLAUDE REVIEW ROUND 2 (MSG #95) & PROTOCOL RIGOR
* Empirical Hostkey Verification: Confirmed `~/.putty/sshhostkeys` on host uses `ssh-ed25519@22:<host>` (with `ssh-` prefix) and `rsa2@22:<host>`. Fixed spec.
* TOFU Trust Boundary: Strict pre-auth state machine (`Connecting` -> `Authenticated`) prevents rogue host in-session prompt injection. Fallback: `plink -batch` fails closed, parses fingerprint, and re-launches with `-hostkey <fp>` on user confirmation.
* `-share` Lifecycle in Phase 0: Test upstream terminal tab closure vs active downstream SFTP transfers; decouple master connection owner in Rust (`crates/plinky-core`) so closing terminal does not kill SFTP.
* Real Oracle Test Vectors (R1): Fixtures must be generated via `/usr/bin/puttygen 0.85` (RSA, ECDSA, Ed25519; unencrypted + passphrase-protected) and cross-checked against `puttygen -O private-openssh`. Tampered MAC, truncated file, and escaped sessions (`uxstore.c`) added to `cargo-fuzz` harness.

### 7. ADRS ACCEPTED & FORMAL PHASED PLAN (MSG #98)
* ADR-001 Accepted (Owner): Primary SSH transport is `plink` only in v1. `russh` is deferred behind empirical spike results (S3/S4) to ensure single-stack auditability and eliminate dual host-key stores.
* ADR-002 Accepted (Owner): System PuTTY auto-discovery with minimum version floor (PuTTY >= 0.75 for PPK v3 Argon2id support). No binary bundling in v1 to avoid shipping/signing/CVE maintenance liabilities. Diagnostic logging of detected version. User custom path override.
* Scope Bound: Tier 1 targets are Linux and Windows. macOS is on hold for v1. Windows verification uses the owner's Windows machine (with test harness scripts) + GitHub Actions CI.
* Phase 0 Spikes (Numeric Thresholds):
  - S1: xterm.js WebGL throughput & keystroke latency on WebKitGTK (Wayland) and WebView2 (Windows) during saturated stream (`cat bigfile` / `yes`), p95 <= 16ms, DOM fallback.
  - S2: `plink` under `portable-pty`: resize propagation (Linux vs Windows ConPTY), exact host-key prompt text, `-batch` & `-hostkey`.
  - S3: `plink -share` lifecycle (terminal closure vs active SFTP; downstream -L and -R forwarding).
  - S4: `psftp` batch parsing robustness (spaces, newlines, unicode, symlinks) vs `russh-sftp`.
* Phased Plan Gateways: Phase 1 (CI & Threat Model) -> Phase 2 (`crates/putty-compat` with real oracle fixtures & fuzzing) -> Phase 3 (`crates/plinky-core`) -> Phase 4 (React 19 + dockview frontend) -> Phase 5 (SFTP & tunnels). Claude audits each phase diff before commit with explicit test coverage annotations.

### 8. SYSTEM DESIGN V1 (CLAUDE MSG #105) & ARCHITECTURAL CONSENSUS
* Document Landed: `specs/SYSTEM_DESIGN.md` (authored by Claude, landed at `25e482f` / `b907f02`).
* D2 (Hostkey Ownership): Plinky never writes host keys directly. Plink owns verification & storage; Plinky presents fingerprint and answers plink prompt (`y`/`n`). Handles Linux file (`~/.putty/sshhostkeys`) and Windows registry (`HKCU\Software\SimonTatham\PuTTY\SshHostKeys` [?]).
* D3 (Pre-Auth State Machine): `Created -> Spawning -> PreAuth{HostKeyPending | PasswordPending | PassphrasePending} -> Live -> Closing -> Closed`. Interceptors active strictly in `PreAuth`, match exact `plink 0.85` text, answer once, default to deny. Auto-fill only standard password prompt from vault bound to session; NEVER auto-fill keyboard-interactive challenges. No `-pw`. Open problem for Spike S2: detect `PreAuth -> Live` boundary without explicit plink delimiter.
* D4 (Read-Only PuTTY Store): PuTTY store is read-only by default. Plinky metadata (folders, tags, colors, `protected`, sync channels) stored in Plinky config sidecar (`settings.json`). "Save back to PuTTY" is opt-in with backup, atomic write, and round-trip verification.
* D5 (Minimal Dependencies v1): `tauri`, `portable-pty`, `tokio`, `serde`, `tracing`, `zeroize`, `argon2`, `aes-gcm`, `winreg`. No `russh`/`ssh2`. Serial through `plink -serial`.
* D6 (SyncInputRouter Safety): Broadcast only to `Live` sessions (never into `PreAuth` prompts); honours `protected` tag; requires confirmation on multi-line paste to >= 2 sessions.
* D7 (Vertical Slice Roadmap M0-M7): M0 Spikes -> M1 CI & Threat Model -> M2 Walking Skeleton (one session, one tab, `Channel` flow control + ring buffer, reload-reattach) before breadth/crates -> M3 `putty-compat` v1 -> M4 PreAuth/Vault -> M5 Dockview/Sync -> M6 FreeType/Markers -> M7 SFTP/Tunnels.
* R1-R3 (Persistence Invariants): Atomic temp + fsync + rename (R1); corrupt state quarantined (`*.corrupt.<ts>`) & fail-closed on write (R2); schema versioning & unknown fields preserved (R3).
* D1 (Owner Decision ACCEPTED - Option A): Owner officially accepted Option A to narrow `putty-compat` v1 to session read/write, `.ppk` header parsing/fingerprinting, and read-only host-key listing. Hand-written Argon2id `.ppk` decryption and Pageant agent client are deferred to v2 / key manager, removing attack surface and hand-written crypto in v1.

### 9. MCP DUAL AGENT CONCURRENCY & RECOVERY HARDENING (MSG #146-#147)
* Findings A-E in `locking.py` audited & verified by Claude (#146).
* New Sibling Finding in `pm.py` (`ProjectBoard`) addressed (commit `541b136`):
  - Check-then-act race & task overwrite eliminated via single `file_lock(board_file)` holding transactional `mutate_board(mutator)` across load, quarantine, mutate, and save.
  - Fail-closed quarantine on corrupt `board.json` preserves bad state in `board.json.corrupt.<ts>`. Fail-closed on rename failure leaves corrupt file untouched byte-for-byte.
  - Monotonic task ID generation derived from `max(existing_ids) + 1` across `T-(\d+)` keys (prevents collisions from gaps or concurrent creations).
  - Atomic `_save` and `sync_markdown` with PID+thread+timestamp temp file and `os.fsync`.
  - `server.py` handles `StateCorruptError` across board and orchestrator endpoints.
  - Regression tests in `tests/test_pm.py` verify 20-thread concurrency without collisions, quarantine on corruption, and failure fail-closed. 21/21 tests pass in 0.28s.
* Plinky Environment Verification:
  - Rust toolchain verified present: `~/.cargo/bin/cargo` 1.96.0, `rustc` 1.96.0.
  - System binaries verified: `/usr/bin/plink`, `/usr/bin/puttygen`, `/usr/bin/psftp`, `/usr/bin/sshd` (0.85).
  - Next focus: Milestone M0 Spikes (S2/S3/S4) & `tools/sshd-fixture`.

### 10. CLAUDE REVIEW & WRAPPER DEEP DESIGN (MSG #149)
* Empirical Spot-Check Landed: `specs/wrapper/DEEP_DESIGN.md` (authored by Claude, landed from `plinky_wrapper_design.md`). Tested with real `plink 0.85` against user-level localhost `sshd` fixture.
* Decision D8 (Launch without `-batch`): Plinky always launches `plink` interactively to drive the PreAuth state machine. `-batch` is reserved for unattended cached-key verification (e.g., auto-reconnect fails closed loudly on unknown/changed key: `"Cannot confirm a host key in batch mode"`).
* Decision D9 (PreAuth -> Live Marker `Access granted`): Plink emits diagnostic string `Access granted` right after authentication succeeds across all tested modes (interactive, single command, `-batch`, `-v`). State machine transitions to `Live` on this marker and permanently destroys all interceptors.
* Requirement R3 (v1 Scope Narrowing): PreAuth handles `HostKeyPending` only in v1. `PasswordPending` and `PassphrasePending` are display-only (shown to user, typed directly into PTY; no Plinky auto-fill in v1 since vault crypto dependencies are deferred per D1). Eliminates scraped password risk.
* OpenSSH Private Key Finding & Fix: Plink cannot read OpenSSH format keys (`Unable to use this key file`). Added `putty_compat::looks_like_ppk(path)` and explicit `puttygen -O private -o out.ppk in.key` conversion flow to scaffold and UI (`KeyImportModal.tsx`).
* Doc Debt Settled: `specs/PUTTY_WRAPPER_SPEC.md` §2 and §3 updated to reflect v1 header-only scope (`PpkHeader`, `read_header`), moving in-Rust decryption pipeline and agent client to `[DEFERRED TO V2 — KEY MANAGER]`.
* Connection Ownership Architecture: `-share` upstream owned by Rust core `SessionRegistry` with an idle timer (e.g. 30s) rather than UI tabs, so tab closure does not terminate active SFTP transfers or port forwards. Concrete model ready for falsification in Spike S3.

### 11. SPIKE S3 (-SHARE LIFECYCLE) CONFIRMED (CLAUDE MSG #152)
* Verification: Real `plink 0.85` tested against throwaway localhost `sshd` fixture by Claude.
* Key Findings:
  1. Share socket path: `/tmp/putty-connshare.<unix-username>/<hash-of-destination>/socket` (keyed by username in `/tmp`, not `$HOME`).
  2. No re-auth on sharer attach: outputs `Using existing shared connection` and `Reusing a shared connection`, bypassing host-key prompts and `Access granted`. D9 marker verified clean.
  3. Fail-closed on owner death: owner dies -> sharer receives `FATAL ERROR: Connection reset by peer` immediately.
  4. Owner survives sharer churn: tested both natural exit and SIGTERM; 3rd subsequent sharer connected cleanly without fresh auth.
* Architecture Confirmed: `SessionRegistry` connection-owner model in `specs/wrapper/DEEP_DESIGN.md` §5 verified. Updated open questions table in §6.

### 12. CRATES/PUTTY-COMPAT IMPLEMENTED & PASSING (M1/M3)
* Standalone Rust Crate: Created `crates/putty-compat` under root workspace `Cargo.toml`.
* Modules:
  - `sessions`: PuTTY session percent-encoding/decoding, `PuttySession` preserving unknown fields in `extra: BTreeMap<String, String>` (R3 invariant), platform session directory resolution (`PUTTYDIR` -> XDG -> `~/.putty/sessions`), atomic writing with `NamedTempFile` + sync + `.bak` backup.
  - `ppk`: Version 2 and 3 `.ppk` header parsing (`PpkHeader`), SHA256 public key fingerprinting matching `puttygen -l`, and `looks_like_ppk` format detection terminating before private key bytes (D1 header-only scope).
  - `hostkeys`: PuTTY `sshhostkeys` parsing (`<type>@<port>:<host> <key>`).
* Verification: 7/7 integration tests pass in 0.00s (`cargo test --workspace`), verifying session round-trip fidelity, backup creation, ppk header parsing, OpenSSH format rejection, and real system `~/.putty/sshhostkeys` ingestion.

### 13. SPIKE S4 (PSFTP PARSING & -SHARE LIFECYCLE) FINDINGS (CLAUDE MSG #158)
* psftp `ls` Format: Classic `ls -l` line-by-line format. Entries are ASCII-sorted, include `.` and `..` (must filter), and omit `-> target` on symlinks.
* CRITICAL Gotcha: Filenames with embedded spaces are unquoted (e.g. `drwxr-xr-x 2 user group 60 Sep 22 20:03 a dir with spaces`). Parser must match fixed-width/regex columns for metadata and take the rest of the line verbatim as filename.
* CRITICAL Blocker / Bug: `psftp -share` connects to the shared socket (`Using existing shared connection...`), but then hangs silently without completing SFTP subsystem negotiation (reproduced 2x against OpenSSH internal-sftp).
* Action & Fallbacks: Flagged in `specs/wrapper/DEEP_DESIGN.md` §6 and `specs/SYSTEM_DESIGN.md` §7 as suspected blocker before Phase 5. Fallback options: dedicated unshared psftp connection or plink-native SFTP subsystem channel.

### 14. ADR-003 ACCEPTED (SFTP DATA PATH) & REPO PUBLIC HYGIENE (CLAUDE MSG #160, #161)
* ADR-003 Accepted by Owner (Option B): SFTP does NOT use `-share`. Each SFTP pane spawns a dedicated plain `psftp` connection against the session. Host keys are already cached in PuTTY store (D2), so connection is silent. Credentials authenticate silently via Pageant agent or key. Each connection passes through D3 `PreAuth` state machine.
* Layering Invariant: `crates/putty-compat` remains strictly config storage (sessions, ppk headers, hostkeys). Runtime SFTP `ls` output parsing lives in `crates/plinky-core::sftp`.
* Public Repo Hygiene: Plinky is now public on GitHub (`https://github.com/ArisAlt/Plinky`). All documentation, logs, and comments must use generic placeholders (`/path/to/...`, RFC 5737 `192.0.2.10`, generic usernames) and relative Markdown links. ABtools and Plinky memory/specs are strictly segregated.

### 15. FRONTEND WORKBENCH & TAURI V2 DESKTOP HOST (M5 / M6 UI SHELL)
* Frontend Implementation & Production Verification: Built modern IDE workbench in `src/` (React 19, TypeScript 5.7, Vite 6, Tailwind CSS, Dockview, @xterm/xterm, lucide-react). `npm run build` compiled 1,911 modules in 1.93s into `dist/` with 0 TypeScript errors.
* IPC-Wired PuTTY Config UI (Verified Real):
  - `SessionExplorer.tsx`: Hierarchical folder/tag tree reading native PuTTY sessions via IPC (`list_putty_sessions`), instant search, launch triggers, atomic New Session modal with `.bak` safety (`write_putty_session`).
  - `HostKeyManager.tsx`: Viewing trusted host keys via IPC (`list_putty_hostkeys`) and inspecting `.ppk` headers with SHA256 fingerprints (`inspect_ppk`).
* Visual Workbench Shells (Ready for M2 Backend Wiring):
  - `TerminalView.tsx`: Real xterm.js canvas with fit addon, resize lifecycle, theme, discrete broadcast channel badges (Off, A, B, C, D), and UI affordances for Free Type Mode and regex highlighting. (Buffer delta calculations, DECCKM gating, and IDecoration regex markers await M2 live backend PTY connection).
  - `SyncBroadcastBar.tsx`: Command broadcast UI and target selector (All, A-D).
  - `SftpDualPane.tsx`: Dual-pane local/remote filesystem visual shell and transfer queue mockup aligned with ADR-003 Option B (plain psftp).
  - `TunnelManager.tsx`: Visual SSH port forward visualizer (Local -L, Remote -R, Dynamic -D SOCKS5).
* Next Milestone: M2 Walking Skeleton — `crates/plinky-core` (Transport trait, `portable-pty`, `PlinkTransport`, D3/D9 PreAuth state machine) wired to ONE live terminal tab via `tauri::ipc::Channel` binary streaming.

### 16. M2 WALKING SKELETON IMPLEMENTED & AUDIT HARDENED (CLAUDE MSG #168 RESOLUTIONS)
* Crates/Plinky-Core Implemented:
  - `Transport` trait: `write`, `resize`, `kill`, `is_alive` bound to `Send`.
  - `LocalTransport`: native local shell spawned under `portable-pty`.
  - `PlinkTransport`: ADR-002 PuTTY binary discovery, `plink -load <Session> -t` spawned under `portable-pty`. Omitted hardcoded `-agent` flag per Claude audit (deferring to session's native `AgentFwd`). Implemented `detect_putty()` probing `plink -V` against >= 0.75 floor.
  - `PreAuthStateMachine`: Fixed host-key regex to match verbatim plink 0.85 text (`"The host key is not cached for this server:"`, `"Store key in cache? (y/n, Return cancels connection, i for more info)"`). Implemented strict 8 KiB buffer cap (`MAX_PREAUTH_BUFFER_LEN = 8192`) with default-deny (holds unmatched bytes, fails closed to `Closed{Error}` upon overflow). D9 boundary marker (`"Access granted"`) transitions to `Live` with zero post-auth regex overhead.
  - `ScrollbackRingBuffer`: Monotonic sequence counter `total_bytes_written: usize`, O(1) unread replay via `get_since(from_seq) -> (Vec<u8>, bool)` with truncation detection.
  - `SessionRegistry`: Thread-safe session management (`ActiveSession`), streaming reader task, and `attach_session(id, out_tx, from_seq) -> Result<AttachInfo>` enabling webview reload-and-reattach without losing PTY process.
* Tauri v2 Streaming IPC (`src-tauri`):
  - Added binary streaming IPC handlers: `start_terminal_session` using `tauri::ipc::Channel<Vec<u8>>`, `attach_terminal_session`, `write_terminal_input`, `resize_terminal`, `close_terminal_session`, and `putty_detect`.
* Frontend Wiring & WindTerm Superpowers:
  - `src/services/tauriBridge.ts`: Added `detectPutty()`, `startTerminalSession()`, `attachTerminalSession()`, `writeTerminalInput()`, `resizeTerminal()`, and `closeTerminalSession()`.
  - `TerminalView.tsx`: Live PTY binary channel connection with graceful browser-preview fallback banner. Integrated `attachTerminalSession` for reload reattachment.
  - **Free Type Mode (M6 Verified)**: Implemented coordinate delta calculation $\Delta = C_{target} - C_{cursor}$ emitting right/left arrow sequences (`\x1b[C` / `\x1b[D`), gated by alternate screen buffer suppression (`terminal.buffer.active.type !== 'alternate'`) and active line boundaries.
  - **Regex Token Decorator (M6 Verified)**: Integrated `@xterm/xterm` `registerLinkProvider` for real-time IPv4 and URL token identification with click-to-copy and browser-open actions.
* Verification: 13/13 tests pass in `cargo test --workspace` (`putty-compat`: 7, `plinky-core`: 6). `npm run build` compiles 1,911 modules into `dist/` with 0 TS errors in 1.94s.

### 17. PREAUTH HOST KEY PROMPT MEDIATION & SECURITY ISOLATION (CLAUDE MSG #172 RESOLUTIONS)
* Structured Prompt Parsing & Security Boundary:
  - `HostKeyPromptInfo`: Parses `host`, `port`, `key_type`, `fingerprint` (SHA256), and `raw_prompt` from raw plink prompt text.
  - Zero Terminal Leakage: `HostKeyPrompt` action never sends raw bytes to the terminal `out_tx` channel. Prompts are broadcast exclusively via `SessionRegistry.prompt_tx` broadcast channel.
  - Isolated Tauri Event: App setup forwards `subscribe_prompts()` to Tauri `session:prompt` event with structured payload.
* Dedicated Response Command & Keystroke Blocking:
  - `answer_prompt(id, PromptAnswer::AcceptAndStore | AcceptOnce | Reject)`: The ONLY authority writing `y\n`, `n\n`, or `\n` to PTY.
  - Keystroke Guard: `write_input()` explicitly checks state and rejects terminal keystrokes with an error if the session is `HostKeyPending`. Users cannot accidentally answer or bypass trust prompts via terminal typing.
  - Tauri Command: Registered `answer_hostkey_prompt` in `src-tauri`.
* Frontend Native Trust Dialog (`TerminalView.tsx`):
  - Subscribes to `session:prompt` via `listenHostKeyPrompts()`.
  - Renders secure modal displaying Host, Port, Key Type, and Fingerprint with explicit action buttons: "Store Key in Cache & Connect", "Connect Just Once", "Abandon Connection".
* Verification: 14/14 tests pass in `cargo test --workspace` (`test_write_input_blocked_during_hostkey_pending` verified). `npm run build` compiles 1,912 modules with 0 TS errors in 1.91s.

### 18. M5 SYNC INPUT ROUTER (MULTI-SESSION BROADCAST FANOUT & D6 SAFETY)
* `crates/plinky-core::sync`: Implemented thread-safe `SyncInputRouter` coordinating multi-session broadcast fanout across discrete channels (All, A, B, C, D).
* In-Memory Rust Fan-out: All keystroke replication executes inside Rust in-memory, eliminating multi-call IPC roundtrip overhead from the webview.
* D6 State Filtering: Keystrokes are strictly broadcast to sessions currently in `SessionState::Live`. Sessions in `Connecting`, `PreAuth`, or `HostKeyPending` are safely skipped, preventing keystroke leakage and authentication corruption.
* Protected Sessions & Global Disarm: Protected sessions (`is_protected = true`, e.g. production targets) are excluded from broadcast fanout by default. Global `armed` toggle allows instant emergency suspension of all broadcasts.
* Tauri IPC & Frontend UI:
  - Registered `set_sync_channel`, `set_sync_protected`, `set_sync_armed`, and `broadcast_sync_input` commands in `src-tauri/src/lib.rs`.
  - Added frontend bindings in `src/services/tauriBridge.ts`.
  - `SyncBroadcastBar.tsx` wired directly to backend broadcast fanout.
* Verification: Added `test_sync_input_router_d6_safety`. 15/15 tests pass in `cargo test --workspace` (`putty-compat`: 7, `plinky-core`: 8). `npm run build` compiles 1,912 modules with 0 TS errors.

### 19. UX OVERHAUL & CLAUDE MSG #175 AUDIT RESOLUTIONS
* PTY Return Byte Standardisation: Updated `crates/plinky-core::session::manager::answer_prompt` to send `\r` (carriage return: `b"y\r"`, `b"n\r"`, `b"\r"`) instead of `\n`, matching standard terminal line-discipline and PTY expectations for plink CLI prompts.
* Free Type Mode Gating Hardening (M6 Verified):
  - DECCKM Application Cursor Keys Mode: Added inspection of `term.modes.applicationCursorKeysMode`. When DECCKM is active, emits SS3 sequences (`\x1bOC` / `\x1bOD`); when normal, emits CSI sequences (`\x1b[C` / `\x1b[D`).
  - OSC 133 Semantic Prompt Gating: Registered OSC 133 parser handler in `@xterm/xterm`. Tracks `B..C` input region (command line editing). Suppresses Free Type cursor repositioning when outside the editable prompt region.
* D6 Multi-Line Broadcast Safety Warning (`SyncBroadcastBar.tsx`):
  - Detects multi-line pastes or multi-line commands ($\ge 2$ lines) before calling `broadcastSyncInput`.
  - Displays a modal warning dialog previewing the script and line count, requiring explicit confirmation before multi-session execution.
* IDE-Grade Terminal UX Features:
  - In-Terminal Search Bar: Integrated `@xterm/addon-search` with floating UI, match counting, regex, whole-word, case-sensitivity toggles, and `Ctrl+F` / `Esc` hotkeys.
  - Multi-Pane Split Layout Engine: Supported Single, 2-Pane Vertical Split (Columns), 2-Pane Horizontal Split (Rows), and 4-Pane Cluster Grid (2x2) with active pane focus indicators.
  - Quick Snippet Bar (`QuickSnippetBar.tsx`): Parameterized DevOps macros (Docker, System, Network, Logs, Custom) with 1-click execution into the active terminal or broadcast channel.
  - Interactive SFTP Dual-Pane (`SftpDualPane.tsx`): Double-click directory drill-down, `..` upward navigation, clickable breadcrumb paths, in-pane search filters, and real-time transfer queue.
  - Custom Dark Context Menu: Copy, Paste, Select All, Find (`Ctrl+F`), Clear, and Split actions on right-click.
* Verification: Full workspace test suite passes (15/15 tests, `cargo test --workspace`). Frontend compiles cleanly (`npm run build`, 1,916 modules, 0 TS errors in 1.83s).

### 20. M7 SFTP DATA PATH ENGINE & TAURI IPC INTEGRATION (ADR-003 OPTION B)
* Core Subsystem Architecture:
  - ADR-003 Option B: Plain dedicated `psftp` subprocess spawned per SFTP operation/session, avoiding the PuTTY 0.85 `-share` socket hang identified in S4 spikes. Host keys and auth inherit existing PuTTY registry/session credentials silently.
* `crates/plinky-core::sftp`:
  - `parser.rs`: `parse_psftp_ls_line` and `parse_psftp_ls_output`. Uses 9th-column token boundary scanning to preserve arbitrary whitespace and spaces in filenames. Normalizes symlink targets (`link_target -> real_file`). Filters `.` and `..` listings. Uses `#[serde(rename_all = "camelCase")]` matching frontend `SftpFileEntry` TypeScript interface.
  - `client.rs`: `PsftpClient` discovers `psftp` binary across system paths and `PUTTY_PSFTP_PATH`. Runs non-blocking asynchronous batch I/O (`stdin.write_all(..).await; stdin.flush().await;`) on `tokio::process::ChildStdin`. Implements `list_dir`, `create_dir`, and `remove_file`.
* Tauri v2 IPC Command Registration (`src-tauri/src/lib.rs`):
  - Registered `sftp_list`, `sftp_mkdir`, and `sftp_rm` in Tauri `invoke_handler!`.
* Frontend Wiring & Interactive File Management:
  - `src/services/tauriBridge.ts`: Implemented `listRemoteFiles`, `createRemoteDir`, and `removeRemoteFile` calling Tauri native commands with fallback for browser preview mode.
  - `src/components/sftp/SftpDualPane.tsx`: Added remote directory creation (`FolderPlus` / `mkdir`), remote file deletion (`Trash2` / `rm` with confirmation prompt), breadcrumbs, double-click traversal, and transfer queue status.
* Verification: 18/18 tests pass across workspace (`cargo test --workspace`: 7 `putty-compat`, 11 `plinky-core`). `npm run build` succeeds with 0 TS errors (1,916 modules).

### 21. M7 VISUAL SSH TUNNEL MANAGER & PUTTY SESSION FORWARDINGS PERSISTENCE
* Protocol & Format Integration:
  - PuTTY `PortForwardings` format: `L<src>=<destHost>:<destPort>`, `R<src>=<destHost>:<destPort>`, `D<src>`.
  - Implemented `parsePortForwardings` and `serializePortForwardings` in `src/services/tauriBridge.ts`.
  - Added serde aliases in `crates/putty-compat::sessions::PuttySession` for bidirectional compatibility between snake_case Rust and camelCase TypeScript models.
* Dynamic Tunnel Management (`src/components/tunnels/TunnelManager.tsx`):
  - Automatically loads session port forwardings from PuTTY configuration on mount/session selection.
  - Adding, deleting (`Trash2`), or toggling tunnels immediately updates and persists the session configuration to disk/registry via `writePuttySession`.
  - PuTTY's native `plink` runner inherits these port forwardings on session connection without requiring external proxy processes.
  - UI visualizes TCP pipes, source/destination endpoints, and transfer metrics with feedback notifications.
* Verification: 18/18 workspace tests pass, frontend builds cleanly with 0 TS errors.

### 22. M4 CREDENTIAL VAULT (ARGON2ID + AES-256-GCM WITH AAD & ZEROIZE HYGIENE)
* Cryptographic Container Architecture (`crates/plinky-core::vault`):
  - Storage Format (`storage.rs`): 36-byte binary header (`PLKV` magic, `u32` version 1, `u32` m_cost, `u32` t_cost, `u32` p_cost, 16-byte random salt). OWASP interactive defaults: Argon2id with 64 MiB memory (`65536 KiB`), 3 iterations, 1 lane.
  - AAD Binding: AES-256-GCM authenticated encryption binds domain prefix `b"PLKV_AAD_v1:"` + 36-byte header to guarantee tamper-evidence across Argon2 parameters and salt. Bit-flipped header or ciphertext fails closed immediately.
  - Memory Hygiene & Redaction (`mod.rs`): `SecretString` wrapper implementing `zeroize::Zeroize` and `zeroize::ZeroizeOnDrop`. Custom `Debug` and `Display` implementations strictly redact plaintext (`"[REDACTED]"`).
  - Atomic File Persistence: Writes via temporary hidden file (`.vault.tmp.<rand>`) with POSIX 0600 restrictive file permissions, `sync_all()`, and atomic rename.
  - In-Memory Lifecycle (`Vault`): Holds zeroizing master key and secrets. Methods: `create`, `create_fast`, `load`, `save`, `lock`, `is_locked`, `get`, `get_entry`, `set`, `set_entry`, `remove`, `list_keys`. Locking immediately purges the key and all entries from memory.
* Tauri v2 IPC Command Suite (`src-tauri/src/lib.rs`):
  - Managed `VaultState` with mutex-protected unlocked `Option<Vault>`.
  - Registered commands: `vault_is_initialized`, `vault_is_unlocked`, `vault_create`, `vault_unlock`, `vault_lock`, `vault_get`, `vault_set`, `vault_get_entry`, `vault_set_entry`, `vault_delete`, `vault_list_keys`.
* Frontend UI & TypeScript Bindings:
  - `src/services/tauriBridge.ts`: TypeScript async API bindings with fallback support.
  - `src/components/vault/VaultManager.tsx`: Interactive credential management workbench allowing vault initialization, master password unlocking, instant locking, secret addition, reveal/copy toggles, and deletion. Integrated into `TitleBar.tsx` and `App.tsx` via the Shield tab.
* Verification:
  - 6 new vault tests in `plinky-core` (redaction, create/save/load roundtrip, wrong password rejection, tampered header detection, tampered ciphertext detection, memory zeroization).
  - 29/29 tests pass across workspace (`cargo test --workspace`: 7 `putty-compat`, 22 `plinky-core`).
  - `npm run build` compiles 1,917 modules with 0 TS errors in 1.90s.

### 23. M5 SHELL INTEGRATION BOOTSTRAP & LAYOUT PERSISTENCE
* Shell Integration Architecture (`crates/plinky-core::session::shell_integration`):
  - Multi-Shell Scripts: Bash (`PROMPT_COMMAND` + `DEBUG` trap), Zsh (`add-zsh-hook precmd`/`preexec`), and Fish (`--on-event fish_prompt`/`fish_preexec`).
  - Semantic Markers: Emits `OSC 133 ; A` (prompt start), `OSC 133 ; B` (command start), `OSC 133 ; C` (execution start), `OSC 133 ; D ; <exit_code>` (completion).
  - Working Directory Tracking: Emits `OSC 7` (`\x1b]7;file://${HOSTNAME}${PWD}\x07`) reporting remote path changes on prompt return.
  - Safe Injection: `inject_shell_integration` Tauri command writes scripts to live PTY sessions (fail-closed if not `Live`).
* Frontend Terminal & SFTP Synchronization:
  - Real-Time Directory Following: `TerminalView.tsx` parses `OSC 7` sequences and emits `onCwdChange(path)` to parent `App.tsx`, dynamically updating `remotePath` in `SftpDualPane.tsx`.
  - Prompt Navigation: `Ctrl+Up` / `Ctrl+Down` jumps viewport directly between `OSC 133 ; A` command prompts.
  - One-Click Activation: "Shell Hooks" button in terminal toolbar injects hooks seamlessly into active session.
* R1-R3 Layout & State Persistence (`src/services/layoutPersistence.ts`):
  - Tracks open sessions, active tab, and split mode (`single`, `split-col`, `split-row`, `grid`).
  - Auto-persists on tab/layout state changes with `schema_version: 1`.
  - Fail-closed quarantine: invalid or corrupt JSON is quarantined with a timestamp (`plinky_layout_corrupt_<ts>`) rather than overwritten.
  - Restores active sessions and pane layout on application reload.
* Verification: 33/33 tests pass in `cargo test --workspace` (4 new shell integration unit tests), frontend builds cleanly with 0 TS errors in 1.89s.

### 24. M5 APPROVAL & POST-DEPLOY AUDIT HARDENING (CLAUDE MSG #12-#15 RESOLUTIONS)
* Milestone M5 Approved: `T-006` marked `done` by Claude.
* Tokio Process Runtime Initialization (`7a2f2fe`):
  - Fixed runtime panic on launch: `src-tauri/src/main.rs` decorated with `#[tokio::main] async fn main()`. Provides an ambient Tokio 1.x reactor required by `plinky-core` async operations (`portable-pty`, `tokio::process`) without hardcoupling `plinky-core` to Tauri.
* Pre-Auth Write Path Separation (`2ad9d21`):
  - Addressed real SSH authentication issue where shell injection or broadcast input into a password prompt exhausted `MaxAuthTries`.
  - Split `write_input` into:
    1. `write_input`: Permissive user keystroke path, allowing interactive password typing during display-only `PreAuth`.
    2. `write_input_live_only`: Strict path requiring `is_live()`. Used by `inject_shell_integration` and `SyncInputRouter::broadcast()` to reject any `PreAuth` session.
  - Added 4 regression tests in `crates/plinky-core/tests/core_tests.rs`.
* Plink Banner Auto-Advance (`ca6f42f`):
  - When plink outputs `"Press Return to begin session."` upon transitioning to live, `manager.rs` automatically responds with `\r` to avoid requiring double Enter.
* Session Explorer Discoverability (`f0a720b`):
  - Added "New" text label to header button and clear empty-state CTA ("Create your first connection") when zero sessions exist.
* AppImage Packaging & CI Requirements:
  - Discovered `linuxdeploy` vendored strip fails on `.relr.dyn` ELF sections emitted by modern toolchains. Setting `NO_STRIP=true` works around this locally.
  - Pinned requirement for CI (M1 / `T-002`): Build AppImages inside an older LTS container (Ubuntu 20.04/22.04) for glibc compatibility and include a headless Xvfb launch smoke test to catch launch-time panics.
* Verification: 38/38 tests pass across workspace (`cargo test --workspace`). `npm run build` succeeds with 0 errors.

### 25. M1 CI WORKFLOWS, CARGO-DENY, THREAT MODEL & SSHD FIXTURE (T-002)
* `deny.toml`:
  - Complete cargo-deny configuration for licenses, bans, advisories, and sources.
  - Allowed licenses: MIT, Apache-2.0, BSD-2/3-Clause, ISC, Unicode-3.0/DFS-2016, OpenSSL, MPL-2.0.
  - Audited transitive advisories waived: `RUSTSEC-2024-0370`, `RUSTSEC-2017-0008`, `RUSTSEC-2025-0075`, `RUSTSEC-2025-0080`, `RUSTSEC-2025-0081`, `RUSTSEC-2025-0098`, `RUSTSEC-2025-0100`.
  - Passes cleanly with 0 errors (`advisories ok, bans ok, licenses ok, sources ok`).
* `.github/workflows/ci.yml`:
  - Multi-platform matrix (`ubuntu-latest` and `windows-latest`).
  - Automates system package installations (`putty-tools`, `openssh-server`, `xvfb`, `libwebkit2gtk-4.1-dev`), `npm run build`, `cargo test --workspace`, `cargo-deny`, and headless Xvfb launch smoke test (`timeout 8s ./target/debug/plinky-desktop`).
* `docs/THREAT_MODEL.md`:
  - Living security specification detailing system architecture, trust boundaries, and mitigations for attack vectors T1-T6 (terminal escape sequences, pre-auth state machine bypass, sync input leakage, psftp path traversal, vault compromise, and IPC context isolation).
* Localhost SSHD Test Fixture (`crates/plinky-core/tests/sshd_fixture_tests.rs`):
  - Ephemeral unprivileged `sshd` runner running on loopback high port.
  - Generates ed25519 host key and client PPK via `puttygen`, with isolated `PUTTYDIR`.
  - Spawns real `plink` session, catches `HostKeyPrompt`, answers `AcceptAndStore` via `answer_prompt`, validates D9 `Access granted` transition to `Live`, and verifies `attach_session` scrollback replay.
* GUI Polish & Usability Hardening:
  - Session rows feature visible "Connect" buttons, double-click to connect, and active session status indicators.
  - Browser right-click reload context menu suppressed via global `onContextMenu` handler; dedicated session context menu added.
  - Added `SettingsModal.tsx` for font family, font size, cursor style, PuTTY path status, and layout cache reset.
  - Font stack prioritized for `MesloLGS Nerd Font`, `FiraCode Nerd Font`, `JetBrainsMono Nerd Font` for seamless Starship prompt rendering.
  - Target forwarding for Quick Connect / split-pane clones in `plink.rs` via `ExplicitTarget`.
  - Visible error banner on Shell Hooks failure and toast hint on Free Type toggle.

### 26. UI TESTING HARNESS, PUTTY PARITY, PREAUTH INTERACTIVE PASS-THROUGH & CONNECT WORKFLOW
* Frontend Unit Testing Harness:
  - Installed Vitest, `@testing-library/react`, `jsdom`, `@testing-library/jest-dom`.
  - Configured `vitest.config.ts`, `src/test/setup.ts`, and `"test": "vitest run"` script.
  - 13/13 passing tests across 4 suites: `layoutPersistence.test.ts`, `terminalManager.test.ts`, `SettingsModal.test.tsx`, `SessionExplorer.test.tsx`.
* PuTTY Feature Parity:
  - PuTTY Classic Mouse & Clipboard: Implemented `copyOnSelect` (default: true) and `rightClickAction` (`'paste'` vs `'contextMenu'`) persisted in `localStorage`. Configurable in `SettingsModal.tsx`.
  - PuTTY Event Log: Dedicated modal in `TerminalView.tsx` tracking timestamps, connection milestones, PTY stream events, and OSC hooks, with "Copy All to Clipboard" matching classic PuTTY.
  - PuTTY Session Logging: Backend file writer in `plinky-core::session::manager` (opened in append mode, capturing all raw bytes before state branching) wired with `PuttySession.log_file_name`. Frontend recording indicator badge and `.log` file export.
* PreAuth Password Prompt Pass-Through Fix (Critical Connection Bug Resolved):
  - Root Cause: In `crates/plinky-core/src/session/manager.rs`, `PreAuthAction::Hold` discarded output bytes, swallowing username and password prompts (`Using username "citizenzero"`, `password: `). The user terminal sat blank until `sshd` timed out after 60s with `FATAL ERROR: Remote side unexpectedly closed network connection`.
  - Fix: Forward `chunk` on `PreAuthAction::Hold` to `sub_clone` so prompts and banners stream to the xterm terminal in real time, enabling interactive password entry.
  - Formatted `CloseReason::AuthFailed` to extract and display clean `FATAL ERROR:` strings in PuTTY red ANSI rather than raw Rust enum debug dumps.
* Elimination of Fake Server Simulation & Clean Connection UX:
  - Removed `simulateEcho` and fake prompt responses (`deploy@server:~$`, `ls`, `uptime`) from `src/services/terminalManager.ts`.
  - Removed redundant mock injection from `SyncBroadcastBar.tsx`.
  - In `TerminalView.tsx`, replaced preview fallback banner with explicit error notifications in Tauri mode (`[Plinky Error: Failed to start session...]`) and clear non-interactive preview banners in browser dev mode.
  - Fixed `isLocalSession` detection: only tabs explicitly named `'Local Shell'` or flagged local spawn `/bin/bash`; all other sessions connect via `plink`.
  - Removed hardcoded `'deploy'` default username fallbacks.
  - Dropped direct per-row `Connect` button in session tree: sessions connect exclusively via double-click on card or right-click context menu -> "Connect Terminal", preventing accidental connection clicks. Single-clicking a card is a safe no-op.
* Verification:
  - `npm test`: 13/13 tests pass.
  - `npm run build`: 0 TypeScript errors (2.13s).
  - `cargo test --workspace`: 44/44 tests pass.
  - `cargo deny check`: 0 advisories, bans, licenses, or source errors.

### 27. TOP 5 HIGH-IMPACT REFINEMENTS IMPLEMENTATION PLAN
* Scope & Operationalization: Formulated comprehensive implementation plan addressing key UX & ergonomic bottlenecks:
  1. Tree Density & Compact Mode Toggle in `SessionExplorer.tsx`: Single-line compact view for 30+ PuTTY sessions vs comfortable cards, persisted in localStorage.
  2. Split-Pane Terminal + SFTP Side-by-Side Mode in `App.tsx` & `SftpDualPane.tsx`: Real-time split layout linked to active tab with OSC 7 CWD synchronization.
  3. Quick Connect History & Auto-Complete Dropdown in `TitleBar.tsx`: LRU history (15 entries) and fuzzy session completion with full keyboard navigation.
  4. Connecting / Handshake Spinner in Tab Header: Dynamic visual feedback ('connecting' spinner, 'preauth' amber pulse, 'live' green indicator, 'disconnected' red indicator).
  5. HTML5 Drag-and-Drop File Handling: Shell-quoted path pasting in terminal; remote upload drop target in SFTP pane.
* Dual-Agent Status: Dispatched plan to Claude via MCP bridge (msg #28); user approved ("procced").

### 28. EXECUTION OF TOP 5 HIGH-IMPACT REFINEMENTS (M1-M7 UX HARDENING)
* 1. Session Tree Density Toggle (`SessionExplorer.tsx`):
  - Compact (single-line row `h-7`, inline host:port, preserved double-click/context menu/drag-and-drop) vs Comfortable (cards).
  - Persisted in localStorage (`plinky_session_tree_density`). Unit tested in `SessionExplorer.test.tsx`.
* 2. Split-Pane Terminal + SFTP Side-by-Side Mode (`App.tsx`, `SftpDualPane.tsx`):
  - Added `terminal-sftp` layout mode alongside single, split-v, split-h, and grid-4.
  - Left pane: active TerminalView (58% width). Right pane: SftpDualPane (42% width) tied to active tab's session and synchronized via `onCwdChange` (OSC 7 directory tracking).
* 3. Quick Connect History & Auto-Complete Dropdown (`TitleBar.tsx`):
  - LRU history (15 entries) persisted in localStorage (`plinky_quick_connect_history`).
  - Fuzzy auto-completion popover matching both recent history and saved PuTTY sessions. Keyboard navigation (`ArrowUp`/`ArrowDown`/`Enter`/`Esc`) and single-click removal. New test suite `TitleBar.test.tsx` (4 tests).
* 4. Connecting / Handshake Spinner in Tab Header (`App.tsx`, `session.ts`, `TerminalView.tsx`):
  - Tabs initialize with `status: 'connecting'`.
  - TerminalView emits status transitions on chunks/prompts (`connecting` -> `preauth` on password/hostkey prompts -> `live` on access granted/prompt -> `disconnected` on close/error).
  - Tab header displays animated `Loader2` spinner during handshake, amber `Key` pulse for preauth, green `Terminal` icon for live, and red dot for disconnected.
* 5. HTML5 Native Drag-and-Drop File Handling:
  - `TerminalView.tsx`: Dragging files into terminal pastes shell-quoted absolute path(s) directly into stdin with visual drop zone overlay.
  - `SftpDualPane.tsx`: Dragging files onto remote files pane triggers upload task queue to current remote directory with visual drop zone indicator.
* Verification: 18/18 Vitest tests pass across 5 test suites; `npm run build` compiles 0 TS errors in 2.13s; 44/44 workspace tests pass; `cargo deny check` clean.

### 29. UI CODEBASE AUDIT & POLISH REFINEMENTS
* 1. Terminal Canvas Fit & ResizeObserver (`TerminalView.tsx`):
  - Solved terminal canvas size mismatch when toggling split views (`terminal-sftp`, `two-horizontal`, etc.) or collapsing sidebar.
  - Attached `ResizeObserver` on `containerRef.current` dispatching `fitAddon.fit()` and syncing PTY dimensions via `resizeTerminal(tab.id, cols, rows)`.
* 2. PuTTY Classic `copyOnSelect` Stale Closure (`TerminalView.tsx`):
  - Retained `copyOnSelectRef` updated on every render to ensure setting changes in modal immediately reflect in `term.onSelectionChange`.
* 3. Connection Status Detection Hardening (`TerminalView.tsx`):
  - Eliminated false-positive `'live'` triggers caused by MOTD/banner lines containing `$` or `#`.
  - Added strict prompt boundary checking `/(?:[\$#%❯]\s*)$/m` and pre-auth marker prioritization (`login as:`, `password:`, `passphrase`, `(yes/no`, `Store key in cache?`).
* 4. Shell Quoting Security Fix (Claude #31, Commit `022005e`):
  - Replaced ad-hoc character blocklist in terminal file drag-and-drop with unconditional POSIX single-quoting to prevent command injection via crafted filenames.
* 5. Layout Mode Preservation on Tab Close (`App.tsx`):
  - Fixed `handleCloseTab` resetting layout to `'single'` prematurely; `'terminal-sftp'` mode is now preserved when >= 1 terminal tab remains.
* 6. Bracketed IPv6 Quick Connect Parsing (`TitleBar.tsx`):
  - Added support for bracketed IPv6 endpoints (e.g., `user@[2001:db8::1]:2222` and `[fe80::1]`) without colon-split corruption. Added 5th test to `TitleBar.test.tsx`.
* 7. SFTP Single/Dual Pane View Selector (`SftpDualPane.tsx`):
  - Added 3-way toggle button group (`[Dual | Remote | Local]`) in SFTP header for cramped split-screen environments.
* Verification: 19/19 Vitest tests pass across 5 test suites; `npm run build` compiles with 0 TS errors in 1.88s; 44/44 workspace tests pass; `cargo deny check` clean.

### 30. DEEP LOGIC ERRORS AUDIT & COMPREHENSIVE SYSTEM HARDENING
* 1. `attachTerminalSession` Fall-Through Spawning Duplicate PTY (`TerminalView.tsx`):
  - Fix: Checked `if (attachInfo)` instead of `if (attachInfo && attachInfo.replay_data.length > 0)`. Fresh sessions (0 bytes scrollback) no longer fall through into `startTerminalSession`, preventing duplicate PTY allocation and orphaned processes in `SessionRegistry`.
* 2. Closed Tabs Resurrecting on App Restart (`App.tsx`):
  - Fix: Added `else { clearLayout(); }` to layout persistence effect when `tabs.length === 0`. Closing all tabs now properly clears `localStorage`, preventing zombie tabs resurrecting on relaunch.
* 3. "ALL TABS" Broadcast Router Coverage (`SyncBroadcastBar.tsx`, `router.rs`, `manager.rs`, `lib.rs`):
  - Fix: "ALL TABS" broadcast previously looped over channels A-D, missing default `none` tabs. Implemented `SyncInputRouter::broadcast_all`, `SessionRegistry::broadcast_sync_all`, and wired Tauri IPC `broadcast_sync_input` to fan out across all live, unprotected sessions. Added full unit tests in `core_tests.rs`.
* 4. PuTTY `extra` Fields Preserved on Session Edit (`NewSessionModal.tsx`):
  - Fix: Preserved existing `extra: editingSession?.extra ? { ...editingSession.extra } : {}` and `lastConnected` instead of overwriting with `{}`. Avoids wiping PuTTY-specific configurations (port forwardings, proxies, keys).
* 5. Phantom Demo Tunnels Elimination in Real PuTTY Sessions (`TunnelManager.tsx`):
  - Fix: Real PuTTY sessions without port forwardings now initialize with `tunnels: []` rather than hardcoded mock tunnels (`8080->localhost:80`, `1080 SOCKS5`). Added clean "+ Configure a tunnel" empty state.
* 6. Memory Leak in `protected_sessions` Purged on Session Close (`router.rs`, `manager.rs`):
  - Fix: Implemented `SyncInputRouter::remove_session` to clear both channel mapping and protected set when a session closes. Re-created sessions no longer inherit stale protection flags. Added unit test in `core_tests.rs`.
* 7. SFTP Support for Unsaved & Quick Connect Sessions (`client.rs`, `lib.rs`, `tauriBridge.ts`, `SftpDualPane.tsx`):
  - Fix: Replaced hardcoded `-load <session_name>` with `build_psftp_args` matching `PlinkTransport::build_args`: uses `[user@]host -P port` when session is unsaved. Added unit tests for arg generation in `client.rs`.
* Verification: 19/19 Vitest tests passing; 49/49 Cargo tests passing (+5 new tests); `cargo deny check` clean; `npm run build` 0 TS errors.

### 31. VIEW NAVIGATION ESCAPE/CLOSE RESOLUTION & SESSION FOLDER PERSISTENCE HARDENING
* 1. Full-Screen View Close (X) Buttons & Escape Key Listeners:
  - `VaultManager.tsx`: Added `onClose` prop, header `X` close button with "Close" label, and `Escape` key listener. User is no longer trapped in the Vault view. Added unit tests in `VaultManager.test.tsx`.
  - `HostKeyManager.tsx`: Added `onClose` prop, header `X` button, and `Escape` key listener.
  - `TunnelManager.tsx`: Added `onClose` prop, header `X` button, `Escape` key listener, and inner "Add Forward" modal backdrop click dismiss + header `X` button.
  - `SftpDualPane.tsx`: Added `onClose` prop, header `X` button, and `Escape` key listener when rendered in full view.
  - `TitleBar.tsx`: View buttons (`SFTP`, `Tunnels`, `Host Keys`, `Vault`) now toggle back to `sessions` when clicked while already active.
  - `NewSessionModal.tsx` & `SettingsModal.tsx`: Added `Escape` key listener and backdrop click dismiss.
* 2. Comprehensive Session Folder Organization & Persistence:
  - Root Cause Fixed: `normalizeSession` in `tauriBridge.ts` previously evaluated `raw.folder || 'Saved Sessions'`. Since PuTTY session structs in Rust lack a native `folder` field, `raw.folder` was undefined and all sessions were unconditionally reset to `'Saved Sessions'` on reload. Furthermore, `writePuttySession` dropped `folder` and `tags`.
  - Implemented `sessionMetadata.ts`: Manages session metadata (`folder`, `tags`) in sidecar storage (`plinky_session_metadata_v1`) and tracks custom user folders (`plinky_user_folders_v1`). Added unit tests in `sessionMetadata.test.ts`.
  - `tauriBridge.ts`: `normalizeSession` reads folder from `raw.folder || raw.extra?.PlinkyFolder || getSessionMetadata(raw.name)?.folder || 'Saved Sessions'`, and tags from `extra.PlinkyTags` / metadata. `writePuttySession` serializes `extra.PlinkyFolder` and `extra.PlinkyTags` to preserve them inside PuTTY session files and sidecar storage.
  - `SessionExplorer.tsx`: Added `+ Folder` header button with inline input creation, empty folder preservation, dashed drop zone ("Empty folder — drag sessions here"), empty folder deletion via trash icon, and `addUserFolder` invocation in context menu "Move to Folder".
* Verification: 23/23 Vitest tests passing across 7 suites; 49/49 Cargo workspace tests passing; `npm run build` compiles with 0 TS errors; AppImage bundled.

### 32. SIDEBAR HEADER UI COLLISION RESOLUTION & PTY CHUNK TIMEOUT HARDENING
* 1. SessionExplorer Header UI Collision Resolution (`SessionExplorer.tsx`):
  - Solved header layout collision where "PuTTY Sessions" title wrapped into two lines ("PUTTY" / "SESSIONS") and the "+ New" button was truncated to "+ Ne...".
  - Refactored `+ Folder` to an icon-only button (`FolderPlus`, `w-3.5 h-3.5 text-amber-400`, `aria-label="Create New Folder"`, `title="Create New Folder"`).
  - Applied `whitespace-nowrap truncate` to the title and `shrink-0` to the button container.
  - Reduced total header width demand from 287px to 209px, fitting comfortably inside `w-64` (232px usable) with zero wrapping or truncation.
* 2. PTY Echo Chunk Accumulation in Core Tests (`crates/plinky-core/tests/core_tests.rs`):
  - Fixed test flakiness in `test_sync_input_router_broadcast_all` and `test_sync_input_router_remove_session_purges_protection` where `rx.recv().await` captured initial PTY shell startup bytes instead of the broadcast echo.
  - Replaced single `recv()` calls with timeout-backed accumulation loops until expected tokens are found.
* Verification: 23/23 Vitest tests pass across 7 suites; 49/49 Cargo workspace tests pass; `npm run build` succeeds in 1.97s with 0 TS errors.

### 33. ACTIVE USB / COM PORT AUTO-DETECTION & MOBAXTERM-STYLE JUMP HOST GUI
* Zero-Dependency System Serial Port Discovery (`crates/plinky-core/src/transport/serial.rs`):
  - Pure Rust `/sys/class/tty` scanner for Linux (filters out `/virtual/`, extracts manufacturer and product strings from sysfs `/device/../product` and `/device/../manufacturer`, flags USB vs standard COM).
  - Windows registry scanner querying `HARDWARE\DEVICEMAP\SERIALCOMM` via `winreg`.
  - macOS `/dev/cu.usb*` fallback glob.
  - Zero dynamic C library linking (`libudev` not required), preserving static AppImage portability.
  - Tauri IPC command `list_serial_ports` registered in `src-tauri/src/lib.rs` returning `Vec<DetectedSerialPort>`.
* Dual-Mode Bridge Support (`src/services/tauriBridge.ts`):
  - Added `DetectedSerialPort` interface and `listSerialPorts()` bridge function with browser preview fallback.
* Dedicated Serial Session GUI (`NewSessionModal.tsx`):
  - When `Protocol === 'serial'`, hides SSH Host/Port/Credentials and presents dedicated hardware serial controls.
  - Port dropdown dynamically populated with detected active USB/serial devices with green activity dot (`● [USB] /dev/ttyUSB0 (FTDI - FT232R USB UART)`) and manual path override.
  - Refresh (↻) scan button.
  - Common Baud Rate preset pills (9600, 19200, 38400, 57600, 115200, 230400, 921600).
  - Collapsible Advanced Serial Parameters: Data bits (5, 6, 7, 8, 9), Stop bits (1, 1.5, 2), Parity (None, Odd, Even, Mark, Space), Flow control (None, XON/XOFF, RTS/CTS, DSR/DTR).
  - PuTTY compatibility: Serial settings serialize directly to PuTTY keys (`SerialLine`, `SerialSpeed`, `SerialDataBits`, `SerialStopHalfbits`, `SerialParity`, `SerialFlow`).
* MobaXterm-Style SSH Gateway / Jump Host GUI (`NewSessionModal.tsx`):
  - Added dedicated SSH Jump Host / Bastion section for SSH sessions.
  - Visual route topology banner: `[You (Local)] ──SSH──> [Bastion: host:port (user)] ──SSH──> [Target: host:port]`.
  - Preset picker dropdown populating bastion configuration directly from existing saved PuTTY sessions.
  - PuTTY compatibility: Serializes gateway to PuTTY Proxy parameters (`ProxyMethod: '5'`, `ProxyHost`, `ProxyPort`, `ProxyUsername`, `ProxyTelnetCommand: plink -agent -P %proxyport %proxyuser@%proxyhost -nc %host:%port`).
* Verification & Test Coverage:
  - Added `src/test/NewSessionModal.test.tsx` (4 tests: open/close, standard SSH save, Serial USB detection & PuTTY key serialization, MobaXterm jump host route topology & Proxy key serialization).
  - Added Rust unit test `test_detect_serial_ports_does_not_panic` in `crates/plinky-core/src/transport/serial.rs`.
  - Test suites: 30/30 Vitest tests pass across 9 suites; 70/70 Cargo workspace tests pass; `npm run build` succeeds in 1.89s with 0 TS errors.

### 34. PRODUCTION PACKAGING, VAULT CLOSE FIX & RELEASE PIPELINE
* Vault Window Close & Cancel Resolution (`src/components/vault/VaultManager.tsx`):
  - Solved missing close button issue: previously, the header was trapped inside `max-w-4xl mx-auto`, leaving the top right corner of the window empty, and the Initialize/Unlock cards had no cancel buttons.
  - Refactored `VaultManager` with a full-width header (`bg-plinky-900/70 border-b border-plinky-800`) spanning 100% of the viewport with a prominent `[✕ Close]` button in the top-right corner.
  - Added dedicated top-right `✕` close buttons and "Cancel" buttons directly onto the Initialize Vault card (View 1) and Unlock Vault card (View 2) allowing immediate return to the terminal session.
  - Added test coverage in `src/test/VaultManager.test.tsx` verifying card Cancel and card Close buttons (32/32 tests pass).
* Serial Phantom UART Port Filtering (`crates/plinky-core/src/transport/serial.rs`):
  - Added `is_phantom_uart()` checking `/sys/class/tty/<name>/type`: Linux registers `ttyS0-ttyS31` regardless of hardware; type 0 (`PORT_UNKNOWN`) ports are filtered so real USB/serial ports are not buried.
* Bundle Identifier Migration & Data Preservation (`src-tauri/src/lib.rs`):
  - Added `migrate_identifier_dir()`: copies user data from legacy `com.plinky.app` to `com.plinky.desktop` across platforms prior to webview initialization, preventing data or vault loss.
* Local Distribution Packaging:
  - Compiled release binaries and bundles via `NO_STRIP=true npx tauri build`:
    - `target/release/bundle/appimage/Plinky_0.1.0_amd64.AppImage` (107 MiB, portable ELF 64-bit)
    - `target/release/bundle/deb/Plinky_0.1.0_amd64.deb` (5.4 MiB)
    - `target/release/bundle/rpm/Plinky-0.1.0-1.x86_64.rpm` (5.4 MiB)
    - `target/release/plinky-desktop` (17 MiB optimized executable).
* CI/CD Release Automation:
  - Added `.github/workflows/release.yml` triggering on tag pushes `v*`.
  - Builds Linux AppImage, deb, rpm bundles and Windows MSI/NSIS installer packages.
  - Automatically creates and attaches distribution assets to GitHub Releases using `softprops/action-gh-release@v2`.
  - Pushed tag `v0.1.0` triggering the remote release pipeline.
* Windows Portable Distribution Packaging:
  - Added standalone Windows portable executable (`Plinky-Portable.exe`) and portable zip archive (`Plinky_0.1.0_x64_portable.zip`) to `.github/workflows/release.yml`.
  - Windows users can run `Plinky.exe` directly without installation or administrator privileges.
* Verification: 34/34 Vitest tests pass across 9 suites; 73/73 Cargo workspace tests pass; `npm run build` succeeds in 1.94s with 0 TS errors.

### 35. ENCRYPTED VAULT USAGE BY SAVED SESSIONS & NETWORK DEVICE ENABLE PASSWORDS
* Scope & Security Invariant:
  - User Requirement: Allow saved PuTTY sessions to use encrypted Vault credentials, supporting both standard login passwords and network device privileged EXEC "enable passwords" (e.g. Cisco/Arista/Huawei), recognizing that only some network devices have enable passwords, not all.
  - PuTTY Storage Invariant: Plaintext passwords are NEVER stored in PuTTY session files (`~/.putty/sessions`) or Windows registry (`HKCU\Software\SimonTatham\PuTTY\Sessions`). Sessions link to vault entries via reference key (`extra.PlinkyVaultKey = "<key-id>"`).
* Cryptographic Backend Extension (`crates/plinky-core/src/vault/mod.rs`):
  - Added `pub enable_secret: Option<SecretString>` with `#[serde(default, skip_serializing_if = "Option::is_none")]` to `VaultEntry`. Zeroized on drop, redacted from debug/display logs.
  - Added `pub has_enable_secret: bool` to `VaultEntryMeta` with `#[serde(default)]` to safely indicate enable secret presence without leaking plaintext or cipher bytes.
  - Added builder method `with_enable_secret(mut self, enable_secret: impl Into<String>) -> Self`.
  - Added unit tests: `test_vault_entry_enable_secret_roundtrip`, `test_vault_entry_meta_has_enable_secret`, `test_vault_backward_compatibility_without_enable_secret`. Fixed metadata test to assert `!json.contains("\"secret\"")`.
  - 40/40 tests pass in `plinky-core`; 76/76 tests pass across workspace.
* Types & IPC Bridge (`src/types/session.ts`, `src/services/tauriBridge.ts`):
  - Updated `VaultEntry` interface with optional `enable_secret?: string`.
  - Updated `VaultEntryMeta` interface with optional `has_enable_secret?: boolean`.
  - Updated `TerminalTab` interface with optional `vaultKey?: string`.
* Vault Manager GUI Updates (`src/components/vault/VaultManager.tsx`):
  - Added "Network Device (Enable Password / Privileged Exec)" toggle in "Add Credential" form.
  - Added `copyEnableToClipboard(key)` with 25s auto-clearing clipboard hygiene.
  - Added `+ Enable Pwd` badge and `[Enable]` copy button in credential list card.
* Session Configuration GUI Updates (`src/components/modals/NewSessionModal.tsx`):
  - Added "Save credentials in Encrypted Vault" section with toggle between "Create New Vault Entry" and "Link to Existing Vault Entry".
  - Includes Vault Key ID, Login Password, and conditional Network Device Enable Password fields.
  - On save: writes encrypted entry to vault via `vaultSetEntry` and persists `extra.PlinkyVaultKey = finalKeyId` in PuTTY session.
* Session Tree Lock Indicator (`src/components/sidebar/SessionExplorer.tsx`):
  - Displays amber `Lock` badge next to sessions linked to encrypted vault credentials in both Compact and Comfortable views.
* Terminal View Vault Integration (`src/components/terminal/TerminalView.tsx`):
  - Reads `tab.vaultKey` and fetches decrypted `VaultEntry` when vault is unlocked.
  - Real-time prompt detection in `handleIncomingChunk`: distinguishes between standard login password prompts (`[pP]assword:\s*$`) and network device privileged EXEC prompts (`enable\s*password:\s*$` / `[pP]assword:\s*$` in session).
  - Added floating 1-click autofill banner (`[⚡ Autofill Enable]` / `[🔑 Autofill Password]`) appearing directly above terminal canvas on prompt detection.
  - Added `[🔑 Vault]` dropdown toolbar menu with 1-click password injection, enable password injection, and 25s auto-clearing clipboard copy.
  - Added Vault actions to terminal right-click context menu ("Send Login Password", "Send Enable Password").
* Frontend Unit Tests & Verification:
  - Added test cases in `src/test/NewSessionModal.test.tsx` verifying session creation with new vault credentials (including enable secret) and session linking to existing vault entries.
  - 36/36 Vitest tests pass across 9 suites; `npm run build` succeeds with 0 TS errors (1.90s); 76/76 Cargo tests pass.

### 36. FULL SFTP SUBSYSTEM STABILIZATION & REAL TRANSFERS
* psftp Script Runner & Failure Detection (`crates/plinky-core/src/sftp/client.rs`):
  - Fixed S1 blocker: `psftp` exits 0 for failed commands when fed through stdin. Re-engineered all SFTP operations (`list_dir`, `create_dir`, `remove_file`, `remove_dir`, `upload_file`, `download_file`) to write commands to a temporary batch script and run `psftp -batch -b <file>` without `-be`. Failures now properly exit with non-zero status and extract real error diagnostics.
  - S2 & S3: Removed arbitrary timeouts on large file transfers; downloads write to `.plinky-part` temporary files and atomically rename upon completion, cleaning up on failure.
  - Standardized error prefixes: `[password] ` when interactive authentication is needed; `[hostkey] ` when host key is not yet trusted.
  - S4 & S5: Local directory listings and home directory resolution (`list_local_dir`, `get_local_home_dir`) with permission checking and path sanitization.
* SFTP Dual-Pane Frontend (`src/components/sftp/SftpDualPane.tsx`):
  - Real local filesystem exploration with breadcrumbs, folder traversal, search filtering, and cross-platform path handling.
  - Real remote file listing and transfers via target-based bridge API (`sftpList`, `sftpUpload`, `sftpDownload`, `sftpMkdir`, `sftpRm`, `sftpRmdir`).
  - Active session switcher in header allowing instant targeting of active terminal tabs or saved PuTTY sessions.
  - Error diagnostic banner and inline password authentication prompt when server requires credentials. Automatically retries once vault is unlocked.
  - Added test coverage in `src/test/SftpDualPane.test.tsx` (8 tests pass).

### 37. VAULT SECURITY HARDENING & PROMPT DETECTION
* Security Invariants & Audit Resolutions (V1-V4, E1-E3):
  - V1: Eliminated caching of decrypted `VaultEntry` secrets in React component state. Created backend command `vault_send_secret(sessionId, key, field)` so credentials are written directly into the session PTY in Rust and never cross into JS memory.
  - V2: Copy to clipboard fetches on-demand and immediately drops the secret without making unverified auto-clear claims.
  - V3: Real Cisco IOS prompt detection (`src/services/promptDetect.ts`). Detects enable context (`enable`, `en`, `super` command or `>` device prompt) before `Password:` prompt, offering privileged EXEC password rather than login password.
  - V4: Send items gated to active password prompts; chip explicitly displays the matched vault key identifier before sending.
  - E1-E3: `NewSessionModal` properly awaits `vaultSetEntry` with clear user errors on failure; prevents dangling `PlinkyVaultKey` links; secrets are preserved without trimming.
  - Backend vault entry lookup (`src-tauri/src/lib.rs`): Matches explicit `extra.PlinkyVaultKey`, then `session:<name>`, `<name>`, `<user>@<host>`, `<host>`.
  - Added `VAULT_CHANGED_EVENT` notifying open tabs and views on vault create, unlock, lock, set, or delete.

### 38. AUTOMATED LOGIN & PRIVILEGED EXEC ENABLE
* Automated Authentication Protocol (`crates/plinky-core/src/transport/plink.rs`):
  - SSH: Automatically provides passwords via ephemeral 0600 `-pwfile` temp file deleted after startup.
  - Network Device Enable: Opt-in per session via `extra.PlinkyAutoEnable = "1"`, triggering strictly after typed `enable`/`en` command.
  - Telnet / Serial Login: Opt-in per session via `extra.PlinkyAutoLogin = "1"`, triggering strictly on connection start.
  - All automated prompts verified in `src/test/promptDetect.test.ts` (8 tests pass) and integration fixtures.

### 39. PUTTY WINDOWS REGISTRY & UNIX FILENAME COMPATIBILITY
* Windows Registry Native Storage (`crates/putty-compat/src/registry.rs`):
  - On Windows, reads/writes PuTTY sessions and host keys directly in `HKCU\Software\SimonTatham\PuTTY\Sessions` and `SshHostKeys` matching PuTTY's native Win32 registry format.
* Unix Session Filename Mapping (`crates/putty-compat/src/sessions.rs`):
  - Session filenames match PuTTY 0.85 specification exactly (+ and @ kept literal; legacy `%40` and `%2B` filenames automatically migrated on first read; legacy files cleaned up on session delete).
  - Added unit and integration tests covering session listing, roundtrip editing, and deletion.

### 40. KEEPASS KDBX EXPORT & VAULT DESTRUCTION
* KeePass Export (`crates/plinky-core/src/vault/keepass_export.rs`, `src/components/vault/VaultManager.tsx`):
  - Added `vault_export_kdbx(masterPassword)` exporting all vault entries, login secrets, enable secrets, and metadata to encrypted KDBX4 database.
  - Added "Export to KeePass" action and modal in VaultManager.
* Vault Destruction with Dual Confirmation (`src/components/modals/SettingsModal.tsx`):
  - Settings -> Credential Vault -> Delete Vault permanently destroys vault file with two progressive confirmation warnings and zeroization on drop.

### 41. COMPREHENSIVE VERIFICATION & TEST METRICS
* Rust Workspace: 99/99 automated tests pass across `plinky-core`, `putty-compat`, `plinky-desktop-lib`, and integration fixtures.
* Frontend: 121/121 Vitest tests pass across 22 test suites (`npm test`).
* Build: `npm run build` succeeds in 1.93s with 0 TypeScript compiler warnings or errors.



### 42. NESTED SESSION FOLDERS (T-010)
* Folder paths (`src/services/folderTree.ts`): a session's `PlinkyFolder` is now a '/'-joined path ("Corp 1/Site 1/Site 1 Production"). PuTTY's store stays flat; PuTTY never reads `PlinkyFolder`.
  - '/' is **refused** in a folder name, not escaped: an escape would have to survive every tool that hand-edits a PuTTY file, and a name silently split into two levels is what this exists to prevent. A legacy name that already held '/' now reads as nested.
  - Path logic is segment-wise, so renaming "Site 1" never touches "Site 10".
* All-or-nothing folder rewrite (`putty_compat::set_session_folders`, Tauri `set_session_folders`): a rename or move rewrites one session file (or registry key) per session below the folder. It reads every session first (a missing one fails before anything is written) and, if a write fails, rewrites the ones already saved back to their originals. If a restore also fails the error names those sessions (`PartialFolderMove`). The sidecar folder list and the collapsed state only change after the backend succeeds.
* Tree UI (`SessionExplorer.tsx`): recursive tree with recursive session counts; folder right-click menu: New Subfolder, Rename, Connect All (N) behind a confirmation that lists every session, Delete (empty folders only). Folders drag into other folders or to the top level; a drop into itself or its own subfolder is refused, and so is a rename or move onto an existing folder (no silent merge). Collapsed state is saved by full path (`plinky_collapsed_folders_v1`), moved with a renamed folder, and pruned when a folder disappears. "Saved Sessions" (sessions with no folder) cannot be renamed or moved.
* Deferred: "New Session here..." needs `onCreateSession(folder)` through App.tsx and NewSessionModal.tsx, both being edited by other work at the time.
* Tests: `folderTree.test.ts` (13), `SessionExplorerNested.test.tsx` (9), 3 Rust tests in `putty-compat/tests/integration_tests.rs`. The rollback test and the drop-into-descendant test were each checked to fail with their guard removed.

### 43. ARCHITECTURE REVIEW v0.1.3 (Claude, 2026-09-26)
* `specs/ARCHITECTURE_REVIEW_2026-09-26.md`: code drifted from SYSTEM_DESIGN in 5 places without an ADR. F1 (high): `vault_send_secret(session, key, field)` types ANY vault entry into ANY session; link enforced only in React -> bind key in core at spawn. F2: no `CREATE_NO_WINDOW` -> console flash per psftp/`where` spawn on Windows [verify]. F3: psftp = new SSH login per SFTP op (design: coprocess). F4: `Plinky*` keys in PuTTY files, dropped when PuTTY (Unix) re-saves; contradicts D4. F5: config in localStorage, not app dir; R2 violated. F6: f64 version compare rejects 0.100; Windows finder misses per-user/Scoop.
* Plan P0 docs -> P1 security -> P2 Windows parity -> P3 Windows measurements -> P4 store -> P5 SFTP coprocess -> P6 split lib.rs/TerminalView -> P7 features. macOS on hold (owner).
* ADR-005 native serial kept: settings still from PuTTY keys; plink has no Break. Owner decisions open: F1 gate strictness, F7 pwfile ACL vs core-answered prompt, ADR-005.

### 44. APPIMAGE GREY WINDOW (libwayland) — 2026-09-26
* Symptom: v0.1.3 AppImage from Releases, double-clicked on owner's KDE Wayland / AMD box: window opens, stays grey. Owner read it as "moved the app, terminal blank"; the working copy before was not this AppImage.
* Terminal output: `Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...` (WebKitWebProcess). `WEBKIT_DISABLE_DMABUF_RENDERER=1` did NOT help (hypothesis dropped, commit discarded).
* Cause: AppImage bundles Ubuntu 24.04 `libwayland-{client,cursor,egl,server}`; host Mesa loads against them. Owner-verified: extract, `rm usr/lib/libwayland-*`, run AppRun -> UI works.
* Fix: `scripts/appimage-drop-wayland.sh` repacks the AppImage without those 4 files (appimagetool continuous); release.yml runs it after `tauri build`. Verified here: repacked AppImage starts, local shell works (Xvfb). .deb/.rpm unaffected (system libs).
* Harmless noise on KDE: `Failed to load module "colorreload-gtk-module"` / `"window-decorations-gtk-module"` — GTK_PATH points into the AppImage.
