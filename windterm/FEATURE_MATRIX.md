# Feature Matrix & Implementation Blueprint (`FEATURE_MATRIX.md`)

This document compares **WinPutty** against **PuTTY**, **KiTTY**, **MobaXterm**, and **WindTerm**, detailing how each signature capability from WindTerm and top community requests is engineered.

---

## 1. Comprehensive Feature Comparison Table

| Capability | PuTTY | KiTTY | MobaXterm | WindTerm | **WinPutty** |
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
| **Master Password Encrypted Vault** | ❌ | ❌ | ✅ (Master pass) | ✅ (AES-256) | **✅ PBKDF2 + AES-GCM Vault** |
| **Zmodem (rz / sz) Support** | ❌ | ✅ | ✅ | ✅ | **✅ Zmodem Protocol Parser** |

---

## 2. Deep-Dive Implementation Blueprints

### 2.1. Free Type Mode
* **WindTerm Behavior**: Allows clicking anywhere on the terminal screen to move the cursor to that text position, type text, or drag-and-drop arguments without pressing backspace or arrow keys.
* **WinPutty Implementation Design**:
  1. `FreeTypeMode` class attaches an event listener to the `xterm.js` viewport DOM element.
  2. On `Alt+Click` or click event:
     * Calculates grid column $C_{target}$ and row $R_{target}$ relative to the terminal buffer.
     * Checks if the clicked coordinate falls within the active command prompt line (detected via OSC 133 marker or current cursor line $R_{cursor}$).
     * Delta $\Delta = C_{target} - C_{cursor}$.
     * If $\Delta > 0$: Sends $\Delta$ right-arrow escape codes (`\x1b[C`) or word jumps (`\x1b[1;5C` / `Alt+F`).
     * If $\Delta < 0$: Sends $|\Delta|$ left-arrow escape codes (`\x1b[D`) or word jumps (`\x1b[1;5D` / `Alt+B`).
  3. Drag-and-drop text manipulation:
     * Selected text range can be dragged and dropped into any position on the command line, generating the appropriate shell input sequence.

### 2.2. Multi-Channel Sync Input (Broadcast Channels)
* **WindTerm Behavior**: Users assign tabs to Channel A, B, C, or D. Keystrokes in any tab belonging to Channel A are instantly forwarded to all other tabs in Channel A.
* **WinPutty Implementation Design**:
  1. `SyncInputManager` state machine maintains session sets:
     $$\mathcal{C}_A, \mathcal{C}_B, \mathcal{C}_C, \mathcal{C}_D \subset \mathcal{S}_{\text{active}}$$
  2. In the `TerminalTab` input pipeline:
     ```typescript
     terminal.onData((data: string) => {
       const activeChannels = syncManager.getChannelsForSession(sessionId);
       if (activeChannels.length > 0) {
         for (const channel of activeChannels) {
           const recipientSessions = syncManager.getSessionsInChannel(channel);
           for (const targetSessionId of recipientSessions) {
             if (targetSessionId !== sessionId) {
               ipcRenderer.send('terminal:write', { sessionId: targetSessionId, data });
             }
           }
         }
       }
       // Send to current session
       ipcRenderer.send('terminal:write', { sessionId, data });
     });
     ```
  3. Visual badge indicates channel assignment on tabs (e.g., Red badge for Channel A).
  4. Global safety lock: Toggle shortcut (`Ctrl+Alt+S`) enables or disables broadcast instantly with an on-screen HUD alert.

### 2.3. Integrated SFTP Explorer & Directory Following
* **WindTerm Behavior**: Side pane displays remote directory and tracks the terminal's working directory automatically.
* **WinPutty Implementation Design**:
  1. Spawns an SFTP subsystem channel on the existing SSH connection (or parallel connection if using `plink`).
  2. **Directory Synchronization**:
     * Implements OSC 7 escape sequence parser (`\x1b]7;file://hostname/path\x07`).
     * Fallback: Monitors terminal command output for `cd <path>` executions.
     * Automatically requests remote directory listing `sftp.readdir(targetPath)` and updates the GUI tree.
  3. **Transfer Queue Manager**:
     * Chunked pipeline with configurable concurrency (1–8 parallel streams).
     * Calculates transfer speed (KB/s), estimated completion time (ETA), and progress bar.
     * Resumes interrupted transfers using SFTP offset writes.

### 2.4. Real-Time Regex Text Highlighters & Markers
* **WindTerm Behavior**: Automatically colors IP addresses, timestamps, error keywords, and user patterns in real-time.
* **WinPutty Implementation Design**:
  1. Integrates with `xterm.js` Decoration API or custom canvas rendering overlay.
  2. Main line buffer parser compiles user rules into high-speed regular expressions:
     ```typescript
     const BUILTIN_RULES = [
       { id: 'ipv4', regex: /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, color: '#38bdf8' },
       { id: 'error', regex: /\b(ERROR|FATAL|CRITICAL|FAIL|FAILED)\b/gi, color: '#ef4444', bold: true },
       { id: 'warning', regex: /\b(WARN|WARNING)\b/gi, color: '#f59e0b', bold: true },
       { id: 'success', regex: /\b(SUCCESS|OK|200 OK)\b/gi, color: '#10b981', bold: true },
       { id: 'url', regex: /https?:\/\/[^\s/$.?#].[^\s]*/gi, color: '#6366f1', underline: true }
     ];
     ```
  3. Interactive markers: Clicking a highlighted IP opens a quick action menu (*"Ping", "SSH to this IP", "Copy"*). Clicking a URL opens it in the default browser.

### 2.5. Snippet & Quick Command Bar
* **WindTerm Behavior**: Dockable buttons running common commands with macro parameter prompts.
* **WinPutty Implementation Design**:
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
* **WinPutty Implementation Design**:
  1. Visual configuration builder for:
     * **Local (-L)**: `[Listen Port]` $\rightarrow$ `[Remote Host:Port]`
     * **Remote (-R)**: `[Remote Listen Port]` $\rightarrow$ `[Local Host:Port]`
     * **Dynamic (-D)**: SOCKS5 proxy port.
  2. Reads existing PuTTY `PortForwardings` registry strings.
  3. Visual monitoring: Shows active connection count, data throughput, and reconnect button.

### 2.7. OSC 133 Semantic Shell Integration
* Top requested feature in WindTerm (#3542) that remained unfinished.
* WinPutty adds native support for OSC 133 semantic prompt escapes:
  * `OSC 133 ; A ST`: Prompt start
  * `OSC 133 ; B ST`: Command start (user pressed enter)
  * `OSC 133 ; C ST`: Command executed (output start)
  * `OSC 133 ; D ; <exit_code> ST`: Command finished with exit code
* Enables:
  * One-click navigation to previous command prompts (`Ctrl+Up` / `Ctrl+Down`).
  * Right-click *"Copy Command Output"*.
  * Desktop notification when a long-running command finishes with non-zero exit code.
