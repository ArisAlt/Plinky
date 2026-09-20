# PuTTY Wrapper Technical Specification (`PUTTY_WRAPPER_SPEC.md`)

This document defines the low-level protocols, data schemas, and IPC mechanisms for interfacing with the **PuTTY** toolchain and ecosystem.

---

## 1. PuTTY Session Storage Architecture (Cross-Platform)

PuTTY uses different storage backends depending on the operating system. WinPutty natively supports both:

### 1.1. Linux / Unix PuTTY Storage (`~/.putty/`)
On Linux (such as Arch, Debian, Ubuntu, Fedora), PuTTY stores all configurations in plaintext files inside the user's home directory:
```
~/.putty/
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

### 1.2. Windows PuTTY Storage (Registry)
On Windows, PuTTY persists sessions in the Windows Registry under:
```
HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\[Session%20Name]
```

### 1.3. Unified Cross-Platform Storage Adapter
WinPutty provides a unified TypeScript session adapter:
* Detects runtime platform (`process.platform === 'linux'` vs `'win32'`).
* On Linux: Reads and writes directly to `path.join(os.homedir(), '.putty', 'sessions')`.
* On Windows: Queries and writes to the Windows Registry.
* Enables zero-friction migration: sessions created on Linux PuTTY are immediately visible and editable in WinPutty.

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

## 3. PuTTY Pageant & SSH Agent IPC Protocol Specification

WinPutty integrates natively with SSH key agents across platforms:

### 3.1. Linux / Unix SSH Agent Protocol (`$SSH_AUTH_SOCK`)
* On Linux, PuTTY's Pageant or system OpenSSH agent (`ssh-agent`, `gnome-keyring`, `gpg-agent`) exposes a Unix Domain Socket specified by the environment variable:
  ```bash
  $SSH_AUTH_SOCK (e.g. /tmp/ssh-XXXXXX/agent.<pid> or /run/user/1000/keyring/ssh)
  ```
* WinPutty connects directly to this Unix Domain Socket using Node.js `net.connect(process.env.SSH_AUTH_SOCK)`.
* Communication adheres to the standard IETF SSH Agent Protocol (RFC draft):
  * Length prefix (4 bytes, big endian)
  * Message code (1 byte)
  * Payload

### 3.2. Windows IPC Mechanisms

#### Method A: Named Pipe IPC (Modern Pageant / Windows 10 & 11)
* Pageant exposes a named pipe at:
  ```
  \\.\pipe\pageant.<UserName>.<RandomHex>
  ```
* WinPutty opens the pipe stream directly using standard Windows asynchronous I/O.

#### Method B: Win32 Shared Memory & `WM_COPYDATA` (Classic Pageant)
* Find Window handle `HWND hwnd = FindWindow("Pageant", "Pageant")`.
* Create a unique named file mapping in memory:
  ```c
  HANDLE hMap = CreateFileMapping(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0, 8192, mapName);
  ```
* Send `WM_COPYDATA` with `dwData = 0x804e50ba` (`AGENT_COPYDATA_ID`).

---

## 4. PuTTY CLI Process Wrapper (`plink`, `psftp`, `pscp`, `puttygen`)

When users select **PuTTY CLI Subprocess Mode**, WinPutty spawns the official PuTTY executables under a pseudo-terminal (PTY) interface.

### 4.1. Linux Binary Detection
WinPutty automatically scans standard paths:
* Linux: `/usr/bin/plink`, `/usr/bin/psftp`, `/usr/bin/pscp`, `/usr/bin/puttygen`, `/usr/bin/pageant`
* Windows: `C:\Program Files\PuTTY\plink.exe`, `PATH`

### 4.2. Linux Serial Port Support (`/dev/ttyUSB*`, `/dev/ttyACM*`)
PuTTY for Linux is widely used for hardware debugging and embedded serial consoles (e.g. `SerialLine=/dev/ttyUSB0`, `SerialSpeed=115200`).
* WinPutty provides direct serial communication via `node-serialport` or by launching `plink -serial /dev/ttyUSB0 -sercfg 115200,8,n,1,N`.
* Full support for hardware flow control (RTS/CTS, DTR/DSR, XON/XOFF).
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
