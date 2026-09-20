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

