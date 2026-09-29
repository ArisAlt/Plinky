# Plinky — Developer Documentation

Architecture, build and test instructions. The project's front
page is [README.md](../README.md).

---

## 1. Overview

Plinky is a desktop terminal and session manager built on PuTTY's
command-line tools. SSH, telnet and raw connections are made by `plink`, file
transfers by `psftp`; Plinky does not implement SSH itself. Serial consoles
use a native serial transport so they can send Break.

Plinky reads and writes PuTTY's own saved sessions (`~/.putty/sessions` or
`PUTTYDIR` on Linux, the registry on Windows) and adds tabs, split layouts, a
dual-pane file browser, an encrypted credential vault, broadcast input
channels, command snippets and GNS3 console support.

It is a Cargo workspace with a Tauri v2 desktop shell and a React + xterm.js
interface. Linux and Windows are supported; macOS is on hold.

Deferred (not in v1): decrypting `.ppk` keys, an in-app SSH agent client,
Zmodem. `plink` handles keys and agents itself.

---

## 2. Architecture

Plinky is organised as a Cargo workspace with a Tauri v2 shell and a web interface:

```mermaid
flowchart TD
    subgraph UI_Workbench ["UI Workbench (Tauri Webview: TypeScript + React 19 + xterm.js)"]
        Docking["Multi-Tab & Split Pane Docking (dockview)"]
        FreeType["Free Type Mode Engine (OSC 133 prompt gated)"]
        SyncManager["Sync Input Broadcast UI (Channels A-D)"]
        RegexEngine["Regex Token Decorator (IDecoration + registerLinkProvider)"]
        SFTPPane["Dual-Pane SFTP Explorer (psftp)"]
        SnippetBar["Quick Command / Snippet Palette"]
        TunnelGUI["Visual SSH Tunnel Manager"]
    end

    subgraph Rust_Backend ["crates/plinky-core (Core Terminal Engine)"]
        ChannelStream["tauri::ipc::Channel (Binary Streaming & Watermarks)"]
        PTYMgr["PTY & Process Lifecycle (portable-pty)"]
        SyncRouter["SyncInputRouter (Live-Only Filtering & Paste Guard)"]
        SessionMgr["Session Manager & Scrollback Ring Buffers"]
        ShellBootstrap["Shell Integration Bootstrap (OSC 133 + OSC 7)"]
        PlinkRunner["Plink Transport (plink: SSH / telnet / raw)"]
    end

    subgraph PuTTY_Subsystem ["crates/putty-compat (Standalone PuTTY Crate)"]
        LinuxReg["Linux PUTTYDIR / ~/.putty/sessions File Parser & Writer"]
        WinReg["Windows Registry Bridge (winreg crate)"]
        PPKEngine[".ppk (v2/v3) Header Parser & Fingerprinting"]
        HostKeyVerifier["Host Key Listing (~/.putty/sshhostkeys & WinReg)"]
    end

    UI_Workbench <-->|tauri::ipc::Channel (Raw Binary)| Rust_Backend
    Rust_Backend <--> PuTTY_Subsystem
    Rust_Backend <--> RemoteServers["Remote SSH Servers / Serial Consoles"]
```

---

## 3. Development & Build Instructions

### Prerequisites
- **Rust**: 1.77+ (`rustup toolchain install stable`)
- **Node.js**: 20+ & `npm`
- **System Binaries**: `plink`, `psftp`, `puttygen` (version 0.75+, 0.85+ recommended)
- **Linux Libraries**: `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`

### Verification & Testing
```bash
# Run frontend unit tests (Vitest)
npm test

# Check frontend TypeScript compilation & bundle
npm run build

# Run workspace Rust tests (including the localhost sshd fixture)
cargo test --workspace

# Run dependency license, advisory, and ban validation
cargo deny check

# End-to-end: the real app, backend and plink against stand-in consoles,
# a private sshd and a socat serial line, on a hidden screen (Linux)
npm run e2e -- --build      # builds a debug app first; later runs can skip --build
npm run e2e -- --only paste # only tests whose name contains "paste"
```

The end-to-end suite (`e2e/`) drives the app's page through WebKitGTK's
remote inspector, so it needs no WebDriver: Node 22+, `plink`, and either
`kwin_wayland` (its `--virtual` screen) or `Xvfb`. The SSH tests also need
`sshd`, `ssh-keygen` and `puttygen`; the serial tests need `socat`. Each
scenario runs in a throwaway home directory with its own runtime directory
and no session bus, so it never touches your sessions, host keys or vault,
and never hands its tabs to a Plinky you have open. Tests named "like PuTTY"
expect PuTTY's default behaviour.

### Command Line (GNS3 consoles)
Plinky opens console tabs from its launch arguments. A second launch hands
them to the window that is already running (single instance) and exits.

```bash
plinky --telnet HOST PORT [--title NAME]   # a telnet console, e.g. a GNS3 device
plinky --raw HOST PORT [--title NAME]      # a raw TCP console
plinky --ssh [USER@]HOST[:PORT] [--title NAME]
```

- Several targets may be given at once; `--title` applies to the target
  before it (or, first on the line, to the next one).
- IPv6 hosts may be bracketed: `--telnet [::1] 5000`, `--ssh ops@[2001:db8::1]:22`.
- Arguments are untrusted: hosts or users starting with `-` are refused (plink
  would read them as options), titles lose control characters and are capped
  at 80 characters, anything unrecognised is ignored.
- On Linux the handoff also works without a D-Bus session bus, over a
  socket in `$XDG_RUNTIME_DIR` (or a private `/tmp/com.plinky.desktop-<uid>/`
  directory). Only a socket owned by the same user is ever used; otherwise
  the launch opens its own window.
- GNS3 (Preferences → General → Console applications → Custom):
  Linux `plinky --telnet {host} {port} --title "{name}"`,
  Windows `"C:\Program Files\Plinky\Plinky.exe" --telnet %h %p --title "%d"`.

### Local Packaging & AppImage Notice
```bash
# Development desktop launch
npm run tauri dev

# Bundling Linux AppImage
cargo tauri build
```

> [!NOTE]
> **Rolling-Release Linux Build Notice**: On bleeding-edge distributions (CachyOS, Arch Linux) where the system glibc and binutils emit `.relr.dyn` relative relocation sections, `linuxdeploy`'s vendored `strip` tool may abort with an unknown section error. Set `NO_STRIP=true` in your environment prior to packaging:
> ```bash
> NO_STRIP=true cargo tauri build
> ```
> For release distributions targeting general Linux distributions, AppImages must be packaged within an older, pinned base container (e.g., Ubuntu 20.04/22.04 LTS) to guarantee glibc dynamic linker compatibility across target environments.



