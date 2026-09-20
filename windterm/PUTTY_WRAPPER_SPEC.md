# PuTTY Wrapper Technical Specification (`PUTTY_WRAPPER_SPEC.md`)

This document defines the low-level protocols, data schemas, and IPC mechanisms for interfacing with the **PuTTY** toolchain and ecosystem.

---

## 1. PuTTY Session Storage Architecture

PuTTY persists sessions in the Windows Registry under:
```
HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions
```

### 1.1. Registry Key Escaping Format
Session names containing spaces, slashes, or special characters are percent-encoded by PuTTY:
* Space `' '` $\rightarrow$ `%20`
* Colon `':'` $\rightarrow$ `%3a`
* Slash `'/'` $\rightarrow$ `%2f`
* Percent `'%'` $\rightarrow$ `%25`

### 1.2. Key Registry Attributes to Parse & Replicate

| Registry Field | Type | PuTTY Default | Description |
| :--- | :--- | :--- | :--- |
| `HostName` | `REG_SZ` | `""` | Target server hostname or IP address |
| `PortNumber` | `REG_DWORD` | `22` | Connection port |
| `Protocol` | `REG_SZ` | `"ssh"` | Protocol (`"ssh"`, `"telnet"`, `"rlogin"`, `"raw"`, `"serial"`) |
| `UserName` | `REG_SZ` | `""` | Auto-login username |
| `PublicKeyFile` | `REG_SZ` | `""` | Absolute path to `.ppk` private key file |
| `PortForwardings` | `REG_SZ` | `""` | Comma-delimited list of tunnels (e.g. `L8080=127.0.0.1:80,D1080`) |
| `RemoteCommand` | `REG_SZ` | `""` | Command to execute immediately upon connection |
| `TerminalType` | `REG_SZ` | `"xterm"` | Terminal emulation type string |
| `AgentFwd` | `REG_DWORD` | `0` or `1` | Enable/disable Pageant SSH agent forwarding |
| `Compression` | `REG_DWORD` | `0` or `1` | Enable zlib compression |
| `Colour0` – `Colour21` | `REG_SZ` | RGB CSV | Custom RGB color palette entries (e.g. `"187,187,187"`) |
| `FontName` / `FontSize` | `REG_SZ` / `REG_DWORD` | `"Courier New"` / `10` | Session font configuration |

### 1.3. Portable Session File Format
WinPutty supports reading `.reg` file exports and portable INI-based PuTTY session files (from portable distributions like PuTTY Portable or KiTTY):
```ini
[Sessions\MyProductionServer]
HostName=prod.example.com
PortNumber=22
Protocol=ssh
UserName=admin
PublicKeyFile=C:\keys\id_prod.ppk
PortForwardings=L8080=127.0.0.1:8080,D1080
```

---

## 2. PuTTY Private Key (`.ppk`) Specification

PuTTY uses a custom container format for private keys (`.ppk`). WinPutty implements a native, zero-dependency parser supporting both **PPK v2** and **PPK v3**.

### 2.1. PPK Version Differences

| Attribute | PPK v2 | PPK v3 |
| :--- | :--- | :--- |
| **Header Identifier** | `PuTTY-User-Key-File-2: <algorithm>` | `PuTTY-User-Key-File-3: <algorithm>` |
| **Supported Algorithms** | `ssh-rsa`, `ssh-dss`, `ecdsa-*`, `ssh-ed25519` | `ssh-rsa`, `ecdsa-*`, `ssh-ed25519` |
| **Key Derivation Function** | SHA-1 (iterated) | **Argon2id** (memory, passes, parallelism) |
| **Encryption Cipher** | AES-256-CBC | AES-256-CBC |
| **Integrity MAC** | HMAC-SHA-1 | HMAC-SHA-256 |

### 2.2. PPK File Structure
```
PuTTY-User-Key-File-3: ssh-ed25519
Encryption: aes256-cbc
Comment: imported-key
Key-Derivation: Argon2id
Argon2-Memory: 8192
Argon2-Passes: 13
Argon2-Parallelism: 1
Argon2-Salt: 4a2b9f... (hex)
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAI...
Private-Lines: 1
49f81a7b... (encrypted Base64)
Private-MAC: e830... (HMAC-SHA-256)
```

### 2.3. Decryption & Conversion Pipeline
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
[ In-Memory Decrypted Key (RFC 4716 / OpenSSH PEM) ] ──► Used by SSH2 / PTY Engine
```

---

## 3. PuTTY Pageant IPC Protocol Specification

**Pageant** is the PuTTY authentication agent. WinPutty natively connects to Pageant so users do not need to enter key passphrases repeatedly.

### 3.1. Windows IPC Mechanisms

#### Method A: Named Pipe IPC (Modern Pageant / Windows 10 & 11)
* Pageant exposes a named pipe at:
  ```
  \\.\pipe\pageant.<UserName>.<RandomHex>
  ```
  or standard OpenSSH agent pipe `\\.\pipe\openssh-ssh-agent`.
* WinPutty opens the pipe stream directly using standard Windows asynchronous I/O.

#### Method B: Win32 Shared Memory & `WM_COPYDATA` (Classic Pageant)
* Find Window handle `HWND hwnd = FindWindow("Pageant", "Pageant")`.
* Create a unique named file mapping in memory:
  ```c
  HANDLE hMap = CreateFileMapping(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0, 8192, mapName);
  ```
* Populate the mapped buffer with the SSH Agent Request payload.
* Send `WM_COPYDATA` to Pageant:
  ```c
  COPYDATASTRUCT cds;
  cds.dwData = 0x804e50ba; // AGENT_COPYDATA_ID
  cds.cbData = strlen(mapName) + 1;
  cds.lpData = mapName;
  SendMessage(hwnd, WM_COPYDATA, myHwnd, (LPARAM)&cds);
  ```
* Read the agent response from the shared memory buffer.

### 3.2. Agent Message Types Handled
* `SSH2_AGENTC_REQUEST_IDENTITIES (11)`: List all loaded public keys.
* `SSH2_AGENT_IDENTITIES_ANSWER (12)`: Response with key blobs and comments.
* `SSH2_AGENTC_SIGN_REQUEST (13)`: Request Pageant to sign an SSH authentication challenge.
* `SSH2_AGENT_SIGN_RESPONSE (14)`: Return signature blob to complete SSH handshake.

---

## 4. PuTTY CLI Process Wrapper (`plink`, `psftp`, `pscp`)

When users choose the **Strict PuTTY CLI Runner** mode, WinPutty spawns the official PuTTY executables under a pseudo-terminal (PTY) interface.

### 4.1. `plink` Execution Harness
```bash
plink.exe -load "<SessionName>" \
          -P <Port> \
          -l <Username> \
          -i "<PPK_Path>" \
          -agent \
          -t \
          <HostName>
```
* **Flags**:
  * `-load "<SessionName>"`: Applies all configured registry settings.
  * `-agent`: Enables Pageant forwarding.
  * `-t`: Forces allocation of a remote pseudo-terminal (crucial for interactive applications like `htop`, `vim`, `tmux`).
  * `-L`, `-R`, `-D`: Forward port tunnels dynamically.

### 4.2. Stream Piping to `xterm.js`
```mermaid
flowchart LR
    UI["xterm.js Viewport"] <-->|"WebSocket / Typed IPC"| Backend["Node-PTY Process Manager"]
    Backend <-->|"stdin / stdout / stderr"| Plink["plink.exe Process"]
    Plink <-->|"Encrypted SSH Protocol"| Remote["Remote SSH Server"]
```

### 4.3. `psftp` File System Bridge
For file transfers when using strict PuTTY toolchains:
* Spawns `psftp.exe -load "<SessionName>"` in batch mode (`-b <script>`) or interactive coprocess mode.
* Parses directory listings from `ls -la` output and feeds data directly into the WinPutty SFTP GUI tree.
