[PROJECT]: Plinky (PuTTY Modern Wrapper & IDE-grade Terminal Emulator, named after 'plink')
[ROOT]: /home/citizenzero/Dev/Plinky
[WORKSPACE_ALT]: /home/citizenzero/Documents/antigravity/modest-darwin
[DATE_INIT]: 2026-09-20
[STATUS]: Scaffolding & Specifications Complete; Name Finalized as Plinky

### 1. WINDTERM FORENSIC ANALYSIS & FAILURE REASONS
* Target: kingToolbox/WindTerm (C++/Qt terminal emulator).
* Core strengths: Free Type Mode (mouse click cursor placement & canvas edit), Sync Input (up to 4 broadcast channels), integrated SFTP file manager with drag & drop, real-time regex highlighting (IPs, errors, URLs, keywords), snippet bar, session hierarchy, local/remote/dynamic SSH tunnels, OSC 133 semantic prompt detection.
* Community backlash & demise: Advertised Apache-2.0 license but kept terminal engine & networking backend closed-source binary blobs ("gradual open-sourcing" was never fulfilled). Single maintainer bottleneck. Updates ceased/stalled (>1 year silence). Over 3,000 issues left unattended. Enterprise & security users abandoned due to proprietary binary handling of SSH keys, passwords, and root credentials.

### 2. PUTTY LINUX & WINDOWS ARCHITECTURE
* Linux Host Environment Verified:
  - System has full PuTTY 0.85 suite installed: `/usr/bin/putty`, `/usr/bin/plink`, `/usr/bin/pscp`, `/usr/bin/psftp`, `/usr/bin/puttygen`, `/usr/bin/pageant`.
  - Local sessions verified at `~/.putty/sessions/`: `10.10.10.10%20`, `COM%20USB0`, `Default%20Settings`.
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
* Standalone MCP Bridge: Extracted from ABtools into `/home/citizenzero/Dev/mcp_dual_agent/` with passing pytest suite and client configs.

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

