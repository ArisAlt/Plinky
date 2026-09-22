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
* Frontend Wiring:
  - `src/services/tauriBridge.ts`: Added `detectPutty()`, `startTerminalSession()`, `attachTerminalSession()`, `writeTerminalInput()`, `resizeTerminal()`, and `closeTerminalSession()`.
  - `TerminalView.tsx`: Live PTY binary channel connection with graceful browser-preview fallback banner.
* Verification: 13/13 tests pass in `cargo test --workspace` (`putty-compat`: 7, `plinky-core`: 6). `npm run build` compiles 1,911 modules into `dist/` with 0 TS errors in 1.78s.
