# Feature Matrix & Implementation Blueprint (`FEATURE_MATRIX.md`)

This document compares **Plinky** against **PuTTY**, **KiTTY**, **MobaXterm**, and **WindTerm**, detailing how each signature capability from WindTerm and top community requests is engineered.

---

## 1. Comprehensive Feature Comparison Table

| Capability | PuTTY | KiTTY | MobaXterm | WindTerm | **Plinky** |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **License & Auditing** | MIT (Open) | GPL (Open) | Commercial / Proprietary | Apache-2.0 (Core Closed) | **MIT (100% Transparent)** |
| **Cross-Platform** | Partial (Ports) | Windows only | Windows only | Win / Mac / Linux | **Linux & Windows Native** |
| **Linux PuTTY Sessions (`~/.putty/sessions`)** | Native | ❌ | ❌ | ⚠️ Import only | **✅ 100% Native Read/Write** |
| **Windows PuTTY Registry Sessions** | Native | Native | Import only | Import only | **✅ Native Read/Write** |
| **Linux PuTTY Toolchain (`/usr/bin/plink`, etc.)**| Native | ❌ | ❌ | ❌ | **✅ Auto-detected & Wrapped** |
| **Linux Serial Devices (`/dev/ttyUSB*`)** | Native | ❌ | ❌ | ⚠️ Manual | **✅ Direct Device Enumeration** |
| **PuTTY .ppk Keys (v2/v3)** | Native | Native | Converted | Partial | **Native Parsing & Auth** |
| **Linux SSH Agent (`$SSH_AUTH_SOCK`)** | Native | ❌ | ❌ | ⚠️ Incomplete | **✅ Native Unix Domain Socket** |
| **Free Type Mode (Click to edit)** | ❌ | ❌ | ❌ | ✅ | **✅ Implemented** |
| **Multi-Channel Sync Input** | ❌ | ❌ | ⚠️ (All tabs) | ✅ (4 discrete channels) | **✅ 4 Discrete Channels** |
| **Integrated SFTP Pane** | ❌ | ❌ | ✅ (Sidebar) | ✅ (Dual Pane / Dockable) | **✅ Dual Pane / Dockable** |
| **Directory Following (Terminal $\leftrightarrow$ SFTP)** | ❌ | ❌ | ⚠️ (Slow) | ✅ | **✅ OSC 7 / Shell Hook** |
| **Live Regex Text Markers** | ❌ | ❌ | ⚠️ (Keywords) | ✅ (Regex engine) | **✅ Real-time Token Decorator** |
| **Snippet & Quick Macro Bar** | ❌ | ⚠️ (Basic) | ⚠️ (Basic) | ✅ (Parameterized) | **✅ Parameterized Macros** |
| **Visual Port Forwarding GUI** | ❌ | ❌ | ⚠️ (Dialog) | ✅ (Visual manager) | **✅ Live Tunnel Monitor** |
| **OSC 133 Shell Integration** | ❌ | ❌ | ❌ | ⚠️ (Incomplete) | **✅ Semantic Prompt Markers** |
| **Master Password Encrypted Vault** | ❌ | ❌ | ✅ (Master pass) | ✅ (AES-256) | **✅ Argon2id + AES-GCM Vault** |
| **Zmodem (rz / sz) Support** | ❌ | ✅ | ✅ | ✅ | **✅ Zmodem Protocol Parser** |

---

## 2. Deep-Dive Implementation Blueprints

### 2.1. Free Type Mode (Gated Semantic Canvas)
* **WindTerm Behavior**: Allows clicking anywhere on the terminal screen to move the cursor to that text position and edit command text directly.
* **Plinky Implementation Design & Guardrails**:
  1. **Strict State Gating**:
     * **Disabled in Alternate Screen Buffer**: When `terminal.buffer.active.type === 'alternate'` (e.g., inside `vim`, `nano`, `htop`, `less`, `tmux`), Free Type Mode is completely suppressed to prevent buffer corruption.
     * **Application Cursor Mode (`DECCKM`)**: Inspects terminal state; emits `\x1bOC` / `\x1bOD` when application cursor keys are active, and standard `\x1b[C` / `\x1b[D` otherwise.
     * **OSC 133 Semantic Region Gating**: Strictly requires a verified command input region between `OSC 133 ; B` (Command Start) and `OSC 133 ; C` (Command Executed). If shell integration is not active or cursor is outside the command region, Free Type does nothing rather than guessing coordinates.
  2. **Coordinate & Delta Calculation**:
     * Calculates grid column $C_{target}$ and row $R_{target}$ relative to the terminal buffer.
     * Accounts for Unicode double-width characters (CJK, emojis) and soft-wrapped multi-line commands.
     * Delta $\Delta = C_{target} - C_{cursor}$.
     * Emits calculated arrow movements (`\x1b[C` / `\x1b[D`) or word jumps (`Alt+F` / `Alt+B`).

### 2.2. Multi-Channel Sync Input (Rust `SyncInputRouter` - D6)
* **WindTerm Behavior**: Users assign tabs to Channel A, B, C, or D. Keystrokes in any tab belonging to Channel A are mirrored to all other tabs in Channel A.
* **Plinky Backend-Enforced Broadcast Architecture**:
  1. Keystroke fan-out is **never handled via multiple IPC roundtrips from the webview**. The frontend sends a single write payload to the backend session:
     ```rust
     // Rust backend owns broadcast channels and session fan-out
     pub struct SyncInputRouter {
         channels: HashMap<ChannelId, HashSet<SessionId>>,
         protected_sessions: HashSet<SessionId>,
     }
     ```
  2. **D6: Strict State Filtering & Safety Gates**:
     * **Filter by Session State (`Live` Only)**: The router broadcasts *strictly* to sessions in the `Live` state. It **never** broadcasts into a session that is in `PreAuth` (`HostKeyPending`, `PasswordPending`, `PassphrasePending`). Keystrokes meant for a remote bash cluster can never inadvertently be typed into an unauthenticated server's prompt.
     * **Multi-Line Paste Confirmation**: A multi-line paste or command containing newline characters targeting a channel with **2 or more sessions** always prompts for explicit user confirmation with a diff modal showing the target sessions and payload.
     * **Protected Session Tagging**: Sessions tagged `protected` (e.g. production servers) are excluded from broadcast by default and require explicit per-session opt-in before accepting synchronized input.
     * **Global Emergency Disconnect**: A global hotkey (`Ctrl+Alt+S`) immediately disarms all sync channels with an onscreen HUD alert.

### 2.3. Integrated SFTP Explorer & Directory Following
* **WindTerm Behavior**: Side pane displays remote directory and tracks the terminal's working directory automatically.
* **Plinky Implementation Design**:
  1. Reuses the active `plink` master connection via `psftp -share` (no redundant authentication or duplicate SSH handshakes).
  2. **Strict Semantic Directory Tracking**:
     * Listens for `OSC 7` shell integration escape sequences (`\x1b]7;file://<hostname>/<path>\x07`).
     * Automatically prompts user to inject or enable shell integration (OSC 7 + OSC 133) on first connect.
     * Avoids brittle stdout scraping of `cd` commands (which breaks on aliases, subshells, and relative paths).
  3. **Transfer Queue Manager**:
     * Background transfers with bandwidth throttling, progress telemetry, and resume capabilities.

### 2.4. Real-Time Regex Text Highlighters & Markers
* **WindTerm Behavior**: Automatically colors IP addresses, timestamps, error keywords, and user patterns in real-time.
* **Plinky Implementation Design**:
  1. **xterm.js Decoration Boundaries**:
     * `xterm.js` `IDecorationOptions` supports background and foreground color styling only (it does not support dynamic bold/italic/underline).
     * Plinky uses `IDecoration` for real-time token background/foreground coloring.
     * Plinky uses `terminal.registerLinkProvider()` for clickable interactive elements (IP addresses, URLs, error hashes).
  2. **Tightened Pattern Matching**:
     ```typescript
     export const BUILTIN_RULES = [
       { id: 'ipv4', regex: /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, color: '#38bdf8' },
       { id: 'error', regex: /\b(ERROR|FATAL|CRITICAL|FAIL|FAILED)\b/g, color: '#ef4444' },
       { id: 'warning', regex: /\b(WARN|WARNING)\b/g, color: '#f59e0b' },
       { id: 'http_status_ok', regex: /\bHTTP\/\d(?:\.\d)?\s+200\b|\bstatus[:=]\s*200\b/gi, color: '#10b981' },
       { id: 'url', regex: /https?:\/\/[^\s/$.?#].[^\s]*/g, color: '#6366f1', isLink: true }
     ];
     ```
  3. Interactive context menu on link click: *"Ping host", "SSH to IP", "Open URL in Browser", "Copy Token"*.

### 2.5. Snippet & Quick Command Bar
* **WindTerm Behavior**: Dockable buttons running common commands with macro parameter prompts.
* **Plinky Implementation Design**:
  1. JSON snippet store supporting parameter syntax:
     ```json
     {
       "title": "Check Docker Logs",
       "command": "docker logs -f --tail {{lines=50}} {{container_name}}",
       "category": "Docker"
     }
     ```
  2. Clicking the snippet triggers an inline popover modal if variables exist, pre-filled with defaults.
  3. User presses `Enter`, and the resolved command is sent directly to the active terminal session.

### 2.6. Visual SSH Tunneling & Port Forwarding
* **WindTerm Behavior**: Visual table of active Local, Remote, and Dynamic tunnels with state lights.
* **Plinky Implementation Design**:
  1. Visual configuration builder for:
     * **Local (-L)**: `[Listen Port]` $\rightarrow$ `[Remote Host:Port]`
     * **Remote (-R)**: `[Remote Listen Port]` $\rightarrow$ `[Local Host:Port]`
     * **Dynamic (-D)**: SOCKS5 proxy port.
  2. Reads existing PuTTY `PortForwardings` registry strings.
  3. Visual monitoring: Shows active connection count, data throughput, and reconnect button.

### 2.7. OSC 133 Semantic Shell Integration
* Top requested feature in WindTerm (#3542) that remained unfinished.
* Plinky adds native support for OSC 133 semantic prompt escapes:
  * `OSC 133 ; A ST`: Prompt start
  * `OSC 133 ; B ST`: Command start (user pressed enter)
  * `OSC 133 ; C ST`: Command executed (output start)
  * `OSC 133 ; D ; <exit_code> ST`: Command finished with exit code
* Enables:
  * One-click navigation to previous command prompts (`Ctrl+Up` / `Ctrl+Down`).
  * Right-click *"Copy Command Output"*.
  * Desktop notification when a long-running command finishes with non-zero exit code.

### 2.8. Storage & Configuration Persistence Invariants (R1 to R3)
Derived directly from the bridge concurrency audits and fail-closed security invariants:
* **R1 (Atomic Write & Fsync)**: Plinky configuration files (`settings.json`, `layout.json`, `snippets.json`, `markers.json`, `vault.bin`) are always written to a temporary sidecar file (`.tmp`), flushed, fsynced to disk (`os.fsync` / `File::sync_all`), and atomically renamed over the destination. Never report "saved" to the UI unless the atomic rename succeeded.
* **R2 (Fail-Closed on Corrupt State)**: A missing file loads default configuration. A present but corrupted or unparseable file is immediately quarantined (`*.corrupt.<timestamp>`), an alert is logged/displayed, and it is **never** silently overwritten with defaults. Any read error aborts the write path.
* **R3 (Schema Versioning & Unknown Field Preservation)**: All configuration files include a `schema_version` integer. Read-modify-write operations preserve unknown JSON fields so that upgrading/downgrading between versions never strips user settings.

