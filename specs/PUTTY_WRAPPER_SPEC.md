# PuTTY Wrapper Technical Specification (`PUTTY_WRAPPER_SPEC.md`)

This document defines the low-level protocols, data schemas, and IPC mechanisms for interfacing with the **PuTTY** toolchain and ecosystem.

---

## 1. PuTTY Session Storage Architecture (Cross-Platform)

PuTTY uses different storage backends depending on the operating system. Plinky natively supports both:

### 1.1. Linux / Unix PuTTY Storage Directory Lookup Precedence
On Linux systems, PuTTY binaries (such as `/usr/bin/putty`, `plink`, `psftp`) resolve the configuration directory using the following strict precedence:
1. `$PUTTYDIR/sessions` (if environment variable `PUTTYDIR` is defined and non-empty).
2. `$XDG_CONFIG_HOME/putty/sessions` (if `XDG_CONFIG_HOME` is set).
3. `$HOME/.putty/sessions` (default canonical Unix location).

```
~/.putty/ (or $PUTTYDIR/)
├── sessions/             # Directory containing individual session files
│   ├── Default%20Settings
│   ├── 10.10.10.10%20
│   └── COM%20USB0
├── sshhostkeys           # Known SSH server host key fingerprints
└── randomseed            # Cryptographic random seed entropy
```

#### Linux Session Filename Encoding
Session names containing spaces or punctuation are percent-encoded directly in the filename:
* `"10.10.10.10 "` $\rightarrow$ `~/.putty/sessions/10.10.10.10%20`
* `"COM USB0"` $\rightarrow$ `~/.putty/sessions/COM%20USB0`
* `"Default Settings"` $\rightarrow$ `~/.putty/sessions/Default%20Settings`

#### Linux Session File Format
Each file is a key-value format parsed line-by-line:
```ini
HostName=10.10.10.10
PortNumber=22
AddressFamily=0
CloseOnExit=2
WarnOnClose=1
TCPNoDelay=1
RemoteCommand=
NoPTY=0
Compression=0
SerialLine=/dev/ttyUSB0
SerialSpeed=9600
SerialDataBits=8
SerialStopHalfbits=2
SerialParity=0
SerialFlowControl=1
PublicKeyFile=/home/user/.ssh/key.ppk
```

### 1.2. Host Key Verification & Pre-Auth Prompt State Machine (D2, D3)
PuTTY stores verified host keys in:
- **Linux**: `~/.putty/sshhostkeys` (or `$PUTTYDIR/sshhostkeys`)
- **Windows**: Windows Registry under `HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\SshHostKeys` **[?]**

Each entry follows the PuTTY format:
```
<key-type>@<port>:<hostname> <key-data-hex>
```
Canonical format examples (verified from PuTTY 0.85 on Linux):
```
rsa2@22:10.10.10.10 0x10001,0x9f4a12...
ssh-ed25519@22:10.10.10.10 0x28b56069f86246d18d5ff08c40029803e298d3f5d21cb1b615792024cf0c8711,0x7cadb38df766f23fda4f284a023dce62099329de4693c01852ff997703cbd588
ecdsa-sha2-nistp256@22:host 0x...
```

* **D2: Plinky Never Writes Host Keys Directly**:
  `plink` owns host key verification and storage. Plinky never writes or appends directly to `sshhostkeys` or the registry. Plinky presents the host key fingerprint to the user via a native UI dialog and feeds `plink`'s interactive prompt (`y`/`n`). This avoids divergent host-key formats, race conditions with external PuTTY processes, and cross-platform registry/file store discrepancies.

* **D3: Per-Session Pre-Authentication State Machine (Refined with D8, D9, R3)**:
  Scraping prompts out of an unconstrained PTY stream creates a severe security hazard where a compromised remote server could emit synthetic prompt strings to manipulate local trust or capture credentials. Plinky enforces a strict per-session lifecycle:
  ```
  Created -> Spawning -> PreAuth{HostKeyPending} -> Live -> Closing -> Closed{exit | error}
                    \-> PreAuth{PasswordPrompted}  (Display-only in v1: shown to user, typed by
                                                     user directly into PTY; no Plinky auto-fill)
  ```
  1. **Prompt Interceptors Armed Exclusively in `PreAuth`**: Interceptors exist only while in `PreAuth`. They match exact `plink 0.85` text, answer once, and default to deny on anything unparsed.
  2. **R3: v1 Scope Narrowing (HostKeyPending Only)**: Per D1, vault crypto dependencies are deferred to v2. Auto-filling credentials from scraped text carries significant attack surface. In v1, Plinky's PreAuth state machine handles `HostKeyPending` only. Password and passphrase prompts are display-only (shown to user, typed directly into PTY). Keystroke sync broadcast is suppressed while in `PasswordPrompted` (D6).
  3. **D8: Launch plink without `-batch`**: Plinky always launches plink without `-batch`, driving the interactive host-key prompt via the PreAuth state machine. `-batch` is reserved for unattended cached-key verification (e.g., auto-reconnect fails loudly and safely if the host key has changed: `"Cannot confirm a host key in batch mode"`).
  4. **D9: PreAuth → Live Boundary Marker (`Access granted`)**: Plink prints the diagnostic string `Access granted` right after authentication succeeds across all tested modes (interactive, single command, `-batch`, `-v`). On observing `Access granted`, the state machine transitions immediately to `Live` and permanently destroys all interceptors. In-session terminal output can **never** trigger trust dialogs or prompts.
  5. **No Auth in Process Arguments**: `plink -pw` is strictly prohibited to prevent credential exposure in `ps` and `/proc/<pid>/cmdline`.
  6. **Default-Deny Capped Buffer**: If 8 KiB of PreAuth output accumulates without a recognized prompt or `Access granted`, transition to `Closed{Error("unrecognised pre-auth output — plink version mismatch?")}` rather than guessing.

* **D4: Read-Only PuTTY Session Store by Default**:
  PuTTY's session store is treated as read-only by default. Plinky-specific metadata (hierarchical folders, tags, tab colors, `protected` server flags, default sync channel) lives in Plinky's dedicated configuration store (`$XDG_CONFIG_HOME/plinky/settings.json` / `%APPDATA%\Plinky\settings.json`) keyed by session name. PuTTY rewrites session files in full and drops unknown keys, so Plinky fields are never stored in PuTTY's files.
  "Save back to PuTTY" is an explicit user opt-in: writes a backup first, writes atomically (temp file + `fsync` + rename), and requires passing a round-trip test on real session files.

### 1.3. Windows PuTTY Storage (Registry)
On Windows, PuTTY persists sessions in the Windows Registry under:
```
HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\[Session%20Name]
```

### 1.4. Key Registry / Session Attributes to Parse & Replicate

| Session / Registry Field | Type | PuTTY Default | Description |
| :--- | :--- | :--- | :--- |
| `HostName` | `String` | `""` | Target server hostname or IP address |
| `PortNumber` | `Integer` | `22` | Connection port |
| `Protocol` | `String` | `"ssh"` | Protocol (`"ssh"`, `"telnet"`, `"rlogin"`, `"raw"`, `"serial"`) |
| `UserName` | `String` | `""` | Auto-login username |
| `PublicKeyFile` | `String` | `""` | Absolute path to `.ppk` private key file |
| `PortForwardings` | `String` | `""` | Comma-delimited list of tunnels (e.g. `L8080=127.0.0.1:80,D1080`) |
| `RemoteCommand` | `String` | `""` | Command to execute immediately upon connection |
| `TerminalType` | `String` | `"xterm"` | Terminal emulation type string |
| `AgentFwd` | `Integer` | `0` or `1` | Enable/disable Pageant SSH agent forwarding |
| `Compression` | `Integer` | `0` or `1` | Enable zlib compression |
| `Colour0` – `Colour21` | `String` | RGB CSV | Custom RGB color palette entries (e.g. `"187,187,187"`) |
| `FontName` / `FontSize` | `String` / `Int` | `"Courier New"` / `10` | Session font configuration |

### 1.5. Unified Cross-Platform Storage Adapter (`crates/putty-compat`)
Plinky provides a standalone Rust crate (`crates/putty-compat`) with zero Tauri dependencies:
* Detects runtime platform (`cfg!(target_os = "linux")` vs `cfg!(target_os = "windows")`).
* On Linux: Checks `PUTTYDIR` first, then `XDG_CONFIG_HOME`, then `$HOME/.putty/sessions/` using `std::fs`.
* On Windows: Queries and writes to the Windows Registry using the `winreg` crate.
* Also supports reading `.reg` exports and portable INI session files (e.g., KiTTY / PuTTY Portable).
* Fully fuzzable and testable headless in CI across operating systems.

---

## 2. PuTTY Private Key (`.ppk`) Specification (v1 Scope: Header & Fingerprint Only)

Per **Decision D1 (Option A Accepted)**, `crates/putty-compat` in v1 parses `.ppk` **headers and public metadata only**. Private key decryption (Argon2id KDF, AES-256-CBC, HMAC verification) is handled directly at runtime by `/usr/bin/plink`. Hand-written Rust decryption is deferred to v2 / Key Manager to eliminate attack surface and hand-written crypto in v1.

### 2.1. v1 `putty-compat` Interface & Detection
```rust
pub struct PpkHeader {
    pub version: u8,            // 2 or 3
    pub algo: String,           // ssh-rsa, ssh-ed25519, etc.
    pub encrypted: bool,        // true if Encryption != "none"
    pub comment: String,
    pub fingerprint: String,    // SHA256 derived from public blob
}

pub fn read_header(path: &Path) -> Result<PpkHeader>;
pub fn looks_like_ppk(path: &Path) -> bool;
```
* `read_header` physically stops reading the file after the last `Public-Lines` line. It never reads or touches `Private-Lines` or `Private-MAC`.
* `looks_like_ppk` inspects the initial header (`PuTTY-User-Key-File-2:` or `PuTTY-User-Key-File-3:`).

### 2.2. OpenSSH Key Handling & Conversion Flow
* `[VERIFIED]` Plink cannot read OpenSSH-format private keys (`Unable to use this key file (OpenSSH SSH-2 private key (new format))`).
* When a user imports a non-PPK key, Plinky detects this via `looks_like_ppk(path) == false` and offers conversion via the pre-installed `puttygen` binary:
  ```bash
  puttygen -O private -o <destination.ppk> <source_openssh_key>
  ```
* This prevents cryptic downstream connection failures while maintaining the zero-binary-bundling rule (ADR-002).

### 2.3. [DEFERRED TO V2 — KEY MANAGER] In-Rust PPK Decryption Pipeline
The complete in-Rust decryption pipeline below is deferred to v2 when standalone key management is introduced:
```
[ PPK File ] 
     │
     ▼
[ Header & Params Parser ] ─── If Encrypted ───► [ Argon2id / SHA-1 KDF (Passphrase) ]
     │                                                        │
     ▼                                                        ▼
[ Extract Public & Private Blobs ] ◄────────────── [ AES-256-CBC Decryptor ]
     │
     ▼
[ Verify Private-MAC (HMAC-SHA-256) ]
     │
     ▼
[ In-Memory Decrypted Key (RFC 4716 / OpenSSH PEM) ] ──► Used by Key Manager
```

---

## 3. PuTTY Pageant & SSH Agent IPC Protocol Specification [DEFERRED TO V2 — KEY MANAGER]

*(Note: In v1, Pageant / SSH Agent forwarding and authentication are handled natively by `plink` subprocesses without requiring an in-app agent client).*


Plinky integrates natively with SSH key agents across platforms:

### 3.1. Linux / Unix SSH Agent Protocol (`$SSH_AUTH_SOCK`)
* On Linux, PuTTY's Pageant or system OpenSSH agent (`ssh-agent`, `gnome-keyring`, `gpg-agent`) exposes a Unix Domain Socket specified by the environment variable:
  ```bash
  $SSH_AUTH_SOCK (e.g. /tmp/ssh-XXXXXX/agent.<pid> or /run/user/1000/keyring/ssh)
  ```
* Plinky connects directly to this Unix Domain Socket using Rust's `tokio::net::UnixStream::connect(socket_path).await`.
* Communication adheres to the standard IETF SSH Agent Protocol:
  * Length prefix (4 bytes, big endian `u32`)
  * Message code (1 byte `u8`)
  * Payload bytes

### 3.2. Windows IPC Mechanisms

#### Method A: Named Pipe IPC (Modern Pageant / Windows 10 & 11)
* Pageant exposes a named pipe at:
  ```
  \\.\pipe\pageant.<UserName>.<RandomHex>
  ```
* Plinky opens the pipe stream directly using standard Windows asynchronous I/O.

#### Method B: Win32 Shared Memory & `WM_COPYDATA` (Classic Pageant)
* Find Window handle `HWND hwnd = FindWindow("Pageant", "Pageant")`.
* Create a unique named file mapping in memory:
  ```c
  HANDLE hMap = CreateFileMapping(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0, 8192, mapName);
  ```
* Send `WM_COPYDATA` with `dwData = 0x804e50ba` (`AGENT_COPYDATA_ID`).

---

## 4. PuTTY CLI Process Wrapper (`plink`, `psftp`, `pscp`, `puttygen`)

Plinky uses `/usr/bin/plink` running under `portable-pty` as its primary transport engine. This provides 100% bug-for-bug fidelity with PuTTY's session loading, proxy chains, host key caching, and Pageant authentication.

### 4.1. Binary Detection
Plinky automatically scans standard paths on startup:
* **Linux**: `/usr/bin/plink`, `/usr/bin/psftp`, `/usr/bin/pscp`, `/usr/bin/puttygen`, `/usr/bin/pageant`
* **Windows**: `C:\Program Files\PuTTY\plink.exe`, `PATH`

### 4.2. Linux Serial Port Support (`/dev/ttyUSB*`, `/dev/ttyACM*`)
PuTTY for Linux is widely used for embedded serial consoles (e.g. `SerialLine=/dev/ttyUSB0`, `SerialSpeed=115200`).
* Plinky provides direct serial communication via the Rust `serialport` crate or by launching `plink -serial /dev/ttyUSB0 -sercfg 115200,8,n,1,N`.
* Full support for hardware flow control (RTS/CTS, DTR/DSR, XON/XOFF).

### 4.3. `plink` Execution Protocol & Connection Sharing
Plinky invokes `plink` inside a `portable-pty` pseudo-terminal instance:
```bash
plink -load "<SessionName>" \
      -P <Port> \
      -l <Username> \
      -i "<PPK_Path>" \
      -agent \
      -share \
      -t \
      <HostName>
```

#### Command Line Flags & Operational Rules:
* `-load "<SessionName>"`: Applies session configurations directly from `PUTTYDIR` / `~/.putty/sessions/`.
* `-share`: **Connection Sharing**. Creates a shared master SSH connection socket. Secondary terminals and SFTP (`psftp -share`) reuse this encrypted pipe without redundant TCP handshakes or credential re-authentication.
* `-agent`: Enables Pageant / `$SSH_AUTH_SOCK` forwarding.
* `-t`: Forces remote pseudo-terminal allocation (vital for full-screen curses apps like `vim`, `htop`, `tmux`).
* `-L`, `-R`, `-D`: Forward port tunnels statically defined in the session.
* **CRITICAL SECURITY RULE: NO `-pw` FLAG**: Plinky strictly **prohibits passing passwords via `plink -pw`**. Arguments passed on the command line are visible to all users via `ps aux` and `/proc/<pid>/cmdline`. Plinky supplies credentials exclusively via Pageant agent, PPK private keys, or interactive PTY prompt injection.

### 4.4. Stream Piping via `tauri::ipc::Channel`
Rather than inundating Tauri's event system with high-frequency ANSI terminal streams, Plinky uses Tauri v2's high-throughput `tauri::ipc::Channel` with raw binary slices:

```mermaid
flowchart LR
    UI["xterm.js Viewport (WebGL)"] <-->|"tauri::ipc::Channel (Raw Binary)"| Backend["Rust SessionManager (crates/plinky-core)"]
    Backend <-->|"Raw PTY Master (portable-pty)"| Plink["plink Process (-share)"]
    Plink <-->|"Encrypted SSH Protocol"| Remote["Remote SSH Server"]
```

### 4.5. `psftp` File System Bridge & Connection Sharing Lifecycle
For graphical SFTP file exploration:
* Spawns `psftp -load "<SessionName>" -share`.
* Because `-share` is enabled, `psftp` connects instantaneously over the active `plink` master connection without reconnecting or re-authenticating.
* Plinky interacts via standard SFTP batch commands or native binary SFTP channel, feeding directory hierarchies directly into the dual-pane file manager.

#### Lifecycle & Teardown Boundary (`-share` Ownership)
Under PuTTY's connection sharing model, the process that opened the master connection (`plink -share`) owns the Unix domain sharing socket. If that process exits, all downstream sharers (`psftp -share`, secondary terminal tabs) are abruptly disconnected.
* **Phase 0 Empirical Spike Requirement**: Test downstream behavior on Linux when upstream terminates, and test reverse teardown (closing SFTP while terminal continues).
* **Architecture Solution**: In Plinky, the Rust backend (`crates/plinky-core`) owns the process lifecycle. To prevent premature SFTP termination when a user closes a terminal tab, the connection master can be decoupled into a Rust-managed background master process, with both the interactive terminal PTY and the SFTP client attaching as sharers. Alternatively, closing a terminal tab with active SFTP transfers prompts the user or detaches the master PTY gracefully.
