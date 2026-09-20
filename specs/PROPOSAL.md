# Comprehensive Technical Proposal: Plinky

> **Project Vision**: An open-source, modern, IDE-grade terminal emulator and session manager engineered as an advanced wrapper and successor to **PuTTY**, embedding the beloved capabilities of **WindTerm** (Free Type Mode, Sync Input, Integrated SFTP, Regex Markers) while providing 100% transparent open-source security.

---

## 1. Motivation & Opportunity

Modern operations engineers face a frustrating dichotomy:
* **The Legacy Trust Camp (PuTTY, KiTTY)**: Flawless security track record, ultra-fast, native `.ppk` and Pageant support. But the user interface is stuck in 1999—no native tabs, no split panes, no SFTP file explorer, no command broadcasting, and no modern text handling.
* **The Modern UX Camp (WindTerm, Termius, MobaXterm)**: Feature-rich and IDE-like, but marred by closed-source proprietary cores, vendor lock-in, commercial paywalls, or maintainer abandonment (as seen in WindTerm).

**Plinky** bridges this divide by using **PuTTY** as its cryptographic and session bedrock while offering an open-source, modern desktop frontend delivering WindTerm's exact feature set.

```
       [ PuTTY Foundation ]                  [ WindTerm Innovation ]
   • MIT Licensed & Audited              • Free Type Mode (click-to-edit)
   • Windows Registry Sessions           • 4-Channel Sync Input Broadcast
   • Native .ppk (v2/v3) Keys            • Integrated Dual-Pane SFTP
   • Pageant SSH Agent IPC               • Regex Highlighters & Triggers
               \                                    /
                \                                  /
                 ▼                                ▼
             ═════════════════════════════════════════════
                        Plinky
             • 100% Genuine Open Source (MIT/Apache 2.0)
             • Cross-Platform (Win / Mac / Linux)
             • IDE-Grade Terminal Workbench
             ═════════════════════════════════════════════
```

---

## 2. System Architecture

Plinky follows a high-performance modular architecture separating the **UI Terminal Workbench**, the **Rust Core Runtime & Session Router**, and the **PuTTY Subsystem**:

```mermaid
flowchart TD
    subgraph UI_Workbench ["UI Workbench (Renderer: React + xterm.js + WebGL)"]
        TabDock["Docking Tab & Split Pane System (dockview)"]
        FreeTypeCanvas["Free Type Mode (OSC 133 prompt gated)"]
        SyncBroadcast["Sync Input Channels (A, B, C, D UI)"]
        RegexDecorator["Real-time Regex Syntax Decorator (Color + LinkProvider)"]
        SFTPDualPane["Dual-Pane SFTP Explorer (psftp -share)"]
        SnippetBar["Snippet & Quick Command Palette"]
        TunnelVisualizer["Visual SSH Tunnel Manager"]
    end

    subgraph Backend_Runtime ["Core Desktop Backend (Rust + Tauri v2)"]
        IPCChannel["tauri::ipc::Channel (Raw Binary + Watermark Flow Control)"]
        PTYSessionMgr["Session Manager & Scrollback Ring Buffers"]
        SyncRouter["SyncInputRouter (Rust Keystroke Broadcast & Safety Guard)"]
        SFTPService["SFTP Transfer & Queue Service"]
        CredentialVault["Argon2id + AES-256-GCM Session Vault"]
    end

    subgraph PuTTY_Compatibility ["PuTTY Subsystem (crates/putty-compat)"]
        RegParser["PuTTY Sessions (PUTTYDIR / ~/.putty & WinReg)"]
        PPKEngine[".ppk (v2/v3) Key Parser & Decryptor (Argon2id)"]
        PageantClient["Pageant IPC Client (Named Pipe / Unix Socket)"]
        HostKeyVerifier["Host Key Verification (~/.putty/sshhostkeys + TOFU)"]
        PlinkPrimary["Primary: /usr/bin/plink under portable-pty (-share)"]
    end

    UI_Workbench <-->|tauri::ipc::Channel (Raw Binary)| Backend_Runtime
    Backend_Runtime <--> PuTTY_Compatibility
    Backend_Runtime <-->|SSH via plink -share / Serial / russh fallback| RemoteEndpoints["Remote Infrastructure / Servers"]
```

---

## 3. Detailed Feature Specifications

### 3.1. PuTTY Ecosystem Native Bridge (Linux & Windows)
* **Linux PuTTY Native Storage (`~/.putty/sessions`)**:
  * On Linux systems, PuTTY stores sessions directly under `~/.putty/sessions/` in percent-encoded filenames (e.g. `10.10.10.10%20`, `COM%20USB0`).
  * Plinky reads and parses these session files directly, giving Linux users instant zero-setup access to all their existing PuTTY profiles.
  * Writes and modifications sync back to `~/.putty/sessions/`, ensuring 100% interoperability with `/usr/bin/putty`.
* **Windows PuTTY Registry**:
  * On Windows, automatically reads and writes `HKCU\Software\SimonTatham\PuTTY\Sessions`.
* **Linux PuTTY Toolchain Integration**:
  * Native execution of `/usr/bin/plink`, `/usr/bin/psftp`, `/usr/bin/pscp`, and `/usr/bin/puttygen`.
  * Support for Linux hardware serial interfaces (`/dev/ttyUSB0`, `/dev/ttyACM0`).
* **PPK Key Engine**:
  * Native parsing of `.ppk` v2 (SHA-1) and `.ppk` v3 (Argon2id) keys without external dependencies.
  * In-memory key decryption with zero disk caching of unencrypted private keys.
* **Linux SSH Agent & Pageant IPC**:
  * On Linux, connects natively via Unix domain socket (`$SSH_AUTH_SOCK`) to Pageant or OpenSSH agent.
  * On Windows, connects via Named Pipe (`\\.\pipe\pageant.*`) or shared memory.

### 3.2. WindTerm "Free Type Mode" Engine
* **The Mechanism**:
  * In standard terminals, mouse clicks only trigger xterm mouse reporting or text selection.
  * When **Free Type Mode** is toggled (`Alt+Click` or toolbar toggle):
    1. The UI captures mouse click coordinates `(row, col)` within the terminal buffer.
    2. The engine detects the command prompt boundary via OSC 133 or heuristics.
    3. The engine computes the delta between the current cursor position and the click point.
    4. Emits the exact sequence of cursor movement escape sequences (`\x1b[C`, `\x1b[D`) or shell navigation keys (`Alt+F`, `Alt+B`, `Ctrl+A`) to position the shell cursor right under the mouse.
    5. Allows direct text replacement and drag-and-drop argument reordering directly on the terminal canvas.

### 3.3. WindTerm "Sync Input" Channels (Broadcast Channels)
* **The Mechanism**:
  * 4 discrete broadcast channels: **Channel A (Red)**, **Channel B (Blue)**, **Channel C (Green)**, **Channel D (Yellow)**.
  * Any open terminal tab can be assigned to one or more channels via a toolbar selector.
  * When typing into an active tab with Channel A active:
    * Keystrokes are captured before PTY transmission.
    * A broadcast router mirrors the keystrokes simultaneously to all session PTYs assigned to Channel A.
    * Latency and execution status are tracked per session.
    * A persistent warning banner ensures users know when Sync Input is engaged to prevent unintended cluster commands.

### 3.4. Integrated Dual-Pane SFTP with Directory Following
* **The Mechanism**:
  * Dockable side or bottom panel displaying:
    * Left pane: Local filesystem.
    * Right pane: Remote filesystem via SFTP.
  * **OSC 7 / Shell Directory Following**: When the terminal executes `cd /var/log`, an OSC 7 escape sequence or prompt hook notifies the SFTP client, which automatically navigates the remote pane to `/var/log`.
  * **Drag and Drop**: Dropping files from desktop or local explorer into the SFTP pane or directly into the terminal window initiates background chunked SFTP upload.
  * **Transfer Queue**: Concurrent transfer manager with pause, resume, progress percentage, and transfer speed telemetry.

### 3.5. Real-Time Regex Syntax Highlighters & Triggers
* **The Mechanism**:
  * Custom `xterm.js` decoration provider scanning incoming screen buffer lines against compiled regex rules:
    * **Network**: IPv4 (`\b(?:\d{1,3}\.){3}\d{1,3}\b`), IPv6, MAC addresses.
    * **URLs & Endpoints**: `https?://[^\s/$.?#].[^\s]*`.
    * **Log Levels**: `ERROR|FATAL|CRITICAL` (bold red), `WARN|WARNING` (amber), `SUCCESS|OK|200` (green).
    * **Timestamps & UUIDs**: ISO-8601, RFC-2822, GUIDs.
  * **Expect-Style Automated Triggers**:
    * Configure rules such as: *When output matches `Password for .*: `, automatically send stored credential or prompt user.*

### 3.6. Visual SSH Tunneling & Port Forwarding
* Visual GUI for creating and inspecting tunnels:
  * **Local Port Forwarding (`-L`)**: Forward local port `8080` to remote `db.internal:5432`.
  * **Remote Port Forwarding (`-R`)**: Expose local port `3000` on remote server port `9000`.
  * **Dynamic SOCKS5 Proxy (`-D`)**: Open local SOCKS5 proxy on port `1080` routing traffic through the SSH bastion.
* Real-time traffic indicators: Active connections, bytes sent/received, error state.

### 3.7. Snippet & Quick Command Bar
* Dockable button ribbon with user-defined macros and scripts.
* **Variable Interpolation**:
  ```bash
  journalctl -u {{service_name}} -n {{lines=100}} --no-pager
  ```
  * Clicking the button opens a quick modal with parameter defaults, then feeds the interpolated string into the terminal buffer.

---

## 4. Security & Trust Architecture

Unlike WindTerm's controversial closed-source core:
1. **Zero Proprietary Binary Blobs**: The entire codebase is 100% open-source TypeScript, Rust, and HTML/CSS. Anyone can inspect, build, and verify reproducible binaries.
2. **Master Key Argon2id Vault**: Saved credentials and passwords are encrypted using **AES-256-GCM** derived with **Argon2id** (matching PPK v3 key derivation parameters) from a user-supplied master password.
3. **Agent Isolation**: When using PuTTY's Pageant or system SSH agents, private keys never enter Plinky's memory space—cryptographic signing is performed securely inside Pageant.
4. **No Plaintext Passwords in Process Lists**: Plinky strictly prohibits `plink -pw` invocation. Credentials are never exposed in `/proc` or `ps aux`. Authentication is handled exclusively via Pageant, PPK keys, or interactive PTY password prompts.
5. **Prompt Confirmation for Automated Triggers**: Expect-style response hooks never auto-dispatch credentials without session identity verification and explicit user authorization, preventing rogue-host prompt-baiting attacks.
6. **Strict Remote Escape Policies**: Remote clipboard read/write via OSC 52 requires explicit permission dialogs. OSC 8 clickable hyperlinks undergo strict scheme filtering (HTTP/HTTPS only).

---

## 5. Technology Stack Architecture (Rust + Tauri v2)

| Component | Selected Technology | Rationale |
| :--- | :--- | :--- |
| **Desktop Runtime** | **Tauri v2 (Rust)** | Linux & Windows Tier 1 targets (macOS on hold per ADR-002). Minimal memory footprint, native security. |
| **PTY Management** | **`portable-pty` (Rust)** | Battle-tested cross-platform PTY engine supporting Unix PTY on Linux and ConPTY on Windows. |
| **Primary Transport** | **`/usr/bin/plink` with `-share`** | Full PuTTY fidelity (ADR-001): honours `-load`, `sshhostkeys`, Pageant, proxies. Multiplexes SFTP (`psftp -share`). |
| **Auxiliary Transport** | **Deferred behind spikes** | `russh` is deferred per ADR-001; evaluated only if Phase 0 spikes prove a feature cannot be achieved via `plink`. |
| **IPC Streaming** | **`tauri::ipc::Channel`** | High-throughput binary streaming with backpressure watermarks. Session state & ring buffers live in Rust core. |
| **Terminal Core** | **`xterm.js` + `@xterm/addon-webgl`** | Hardware-accelerated terminal renderer with direct buffer access for Free Type Mode and regex markers. |
| **UI Framework & Docking** | **React 19 + TypeScript + `dockview`** | Professional IDE docking framework; supports `renderer: 'always'` to prevent tab destruction during layout manipulation. |
| **PuTTY Subsystem** | **`crates/putty-compat`** | Standalone Rust crate (no Tauri dependencies) parsing `PUTTYDIR` / `~/.putty/sessions`, Windows Registry, and `.ppk` (v2/v3). |
| **Agent IPC** | **Rust `tokio::net` / Windows Pipes** | Native Unix Domain Sockets (`$SSH_AUTH_SOCK`) on Linux and Named Pipes (`\\.\pipe\pageant.*`) on Windows. |
| **Host Key TOFU** | **Rust `hostkeys` module** | Strict pre-authentication state machine against `~/.putty/sshhostkeys` or fail-closed `plink -batch` pattern. |
| **PuTTY Discovery** | **System Detection (ADR-002)** | Detects installed PuTTY (PATH / Program Files); enforces 0.75+ version floor; no binary bundling in v1. |
| **Serial Communication** | **`serialport` (Rust)** | Direct communication with embedded hardware and USB consoles (`/dev/ttyUSB*`, `COM*`). |
| **Credential Vault** | **Rust `aes-gcm` + `argon2`** | Memory-safe, audited cryptographic primitives for master password vault. |

---

## 6. Implementation Phasing & Formal Plan (Linux + Windows)

### Phase 0: Empirical Spikes (Numeric Pass/Fail Thresholds)
Before committing to implementation details, four concrete spikes with predefined thresholds must be executed on Linux (CachyOS Wayland) and Windows (owner test script):
* **Spike S1 (Renderer & Keystroke-Echo Latency)**:
  * **Measurement Methodology**: High-resolution timer (`performance.now()`) measuring duration from DOM `keydown` event dispatch $\rightarrow$ Tauri IPC `session_write` $\rightarrow$ PTY echo $\rightarrow$ `tauri::ipc::Channel` chunk arrival $\rightarrow$ `xterm.write` callback / buffer write $\rightarrow$ `requestAnimationFrame` render timestamp.
  * **Load Profile**: Continuous heavy stream generated by `yes "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"` or `cat bigfile` generating $\ge 50\text{ MB/s}$ sustained throughput.
  * **Keystroke Sample Rate**: 10 Hz (every 100 ms) for 30 seconds (300 samples) under heavy stream load.
  * **Numeric Thresholds**:
    * Unloaded: p95 $\le 16\text{ ms}$ (60 FPS target).
    * Saturated Stream ($\ge 50\text{ MB/s}$): p95 $\le 50\text{ ms}$, p99 $\le 100\text{ ms}$, zero UI/event loop freeze.
    * Fallback: Automatic DOM-renderer fallback if WebGL initialization fails or context is lost.
* **Spike S2 (PTY, Prompts & Resize)**: Verify `plink` under `portable-pty`: test terminal resize signal propagation on Linux PTY and Windows ConPTY; record exact `plink 0.85` host-key prompt text and evaluate reliable markers for the `PreAuth -> Live` transition boundary (verbose `-v` markers, first prompt / OSC 133, timeout); verify `-batch` fail-closed / `-hostkey` behavior.
* **Spike S3 (`-share` Lifecycle)**: Test upstream `plink -share` terminal tab closure while downstream `psftp -share` transfer is active; test reverse teardown; verify whether downstream connections can carry `-L` and `-R` port forwards.
* **Spike S4 (`psftp` Parsing Robustness)**: Evaluate robustness of parsing `psftp` batch listings containing spaces, newlines, Unicode, and symlinks vs `russh-sftp`.
* **Phase 0 Gate**: Record all empirical results as ADRs; finalize the `russh` decision (ADR-001).

### Phase 1: CI & Threat Model
* Setup GitHub Actions CI matrix for Linux and Windows runners.
* Configure localhost `sshd` integration test target.
* Enforce `cargo-deny` (license compliance and vulnerability audit).
* Draft comprehensive threat model document covering remote-controlled terminal escapes (OSC 52, OSC 8, synthetic prompt injection).

### Phase 2: PuTTY Compatibility Crate (`crates/putty-compat`)
* Implement standalone session parsers (`PUTTYDIR`, `XDG_CONFIG_HOME`, `~/.putty/sessions`, Windows Registry), `.ppk` v2/v3 decryptor, `sshhostkeys`, and Pageant IPC.
* **Gate**: Real test vectors generated via host oracle (`/usr/bin/puttygen 0.85`) across RSA, ECDSA, Ed25519 (unencrypted + passphrase-protected), cross-checked against `puttygen -O private-openssh`.
* Fuzz corpus clean (`cargo-fuzz`) for tampered-MAC, truncated-file, and escaped session strings (`uxstore.c`).
* Diff audit by Claude with explicit test coverage annotations.

### Phase 3: Core Runtime & Connection Engine (`crates/plinky-core`)
* Implement `Transport` trait, `plink` process manager, session lifecycle registry with scrollback ring buffer, `tauri::ipc::Channel` binary flow control, and Rust `SyncInputRouter` (multi-line paste guard, protected session tags).
* Implement shell integration bootstrap (`OSC 133` + `OSC 7` snippets for bash/zsh/fish).
* **Gate**: Headless integration tests against localhost `sshd`; Claude race review of sync broadcast.

### Phase 4: Frontend UI Workbench (`src/`)
* React 19 + `dockview` (configured with `renderer: 'always'`) + `xterm.js` terminal tabs.
* External `xtermRegistry` outside React lifecycle for tab-drag persistence.
* Gated Free Type Mode (alternate buffer suppression, DECCKM cursor keys, OSC 133 B..C prompt gating) and real-time regex markers (color decorations + `registerLinkProvider`).
* **Gate**: Window reload-and-reattach preserves active sessions; Free Type gating tests pass.

### Phase 5: SFTP Explorer & Port Forwarding
* Dual-pane SFTP file manager and visual tunnel monitor, scoped according to S3 and S4 spike findings.
