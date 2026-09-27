# Plinky — Developer Documentation

Architecture, milestones, build and test instructions. The project's front
page is [README.md](../README.md).

---

## 1. Overview

Plinky is a desktop terminal and session manager built on PuTTY's
command-line tools. SSH, telnet and raw connections are made by `plink`, file
transfers by `psftp`; Plinky does not implement SSH itself. Serial consoles
use a native serial transport so they can send Break
([ADR-005](../specs/adr/ADR-005-native-serial-transport.md)).

Plinky reads and writes PuTTY's own saved sessions (`~/.putty/sessions` or
`PUTTYDIR` on Linux, the registry on Windows) and adds tabs, split layouts, a
dual-pane file browser, an encrypted credential vault, broadcast input
channels, command snippets and GNS3 console support.

It is a Cargo workspace with a Tauri v2 desktop shell and a React + xterm.js
interface. Linux and Windows are supported; macOS is on hold.

Deferred (not in v1): decrypting `.ppk` keys, an in-app SSH agent client,
Zmodem. `plink` handles keys and agents itself.

---

## 2. Documentation Index

* **[SYSTEM_DESIGN.md](../specs/SYSTEM_DESIGN.md)**: the v1 system design.
* **[DEEP_DESIGN.md](../specs/wrapper/DEEP_DESIGN.md)**: the `plink` wrapper in depth.
* **[PUTTY_WRAPPER_SPEC.md](../specs/PUTTY_WRAPPER_SPEC.md)**: PuTTY session storage, `plink`/`psftp` invocation.
* **[adr/](../specs/adr/)**: architecture decision records.
* **[THREAT_MODEL.md](THREAT_MODEL.md)**: trust boundaries and mitigations.
* **[ARCHITECTURE_REVIEW_2026-09-26.md](../specs/ARCHITECTURE_REVIEW_2026-09-26.md)**: review of v0.1.3 and the plan that followed.
* **[GNS3_CONSOLE_PLAN.md](../specs/GNS3_CONSOLE_PLAN.md)**: GNS3 console support.

---

## 3. Architectural Overview

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

## 4. Architectural Specifications & Milestones

### Core Technical Specifications
* **[SYSTEM_DESIGN.md](../specs/SYSTEM_DESIGN.md)**: **Master v1 System Design** (IPC contracts, data flow, pre-auth state machine, threat model, persistence rules R1–R3, milestones M0–M7).
* **[DEEP_DESIGN.md](../specs/wrapper/DEEP_DESIGN.md)**: **PuTTY-Wrapper Subsystem Deep Design** (Empirical `plink 0.85` evidence, D8 interactive launching, D9 `Access granted` boundary marker, R3 v1 scope, OpenSSH key conversion).
* **[ADR-001](../specs/adr/ADR-001-primary-ssh-transport.md)**: **`plink` Only for v1**. `russh` is deferred behind empirical spike results to preserve single-stack auditability and 100% PuTTY fidelity.
* **[ADR-002](../specs/adr/ADR-002-putty-discovery-and-versioning.md)**: **System PuTTY Detection (Floor: 0.75+)**. No binary bundling in v1; Tier 1 platforms: Linux & Windows (macOS on hold).

### Phased Implementation Milestones (D7: Vertical Slice Before Breadth)
* **M0: Phase 0 Empirical Spikes (Numeric Thresholds)**:
  * **S1**: `xterm.js` WebGL throughput & keystroke latency on WebKitGTK (Wayland) and WebView2 (Windows) during saturated stream (`cat bigfile` / `yes`).
  * **S2**: `plink` under `portable-pty`: terminal resize propagation (Linux vs Windows ConPTY), pre-auth to live boundary detection, and exact prompt text matching.
  * **S3**: `plink -share` lifecycle: **CONFIRMED** — owner survives sharer churn, sharer fails closed on owner death, `/tmp/putty-connshare.<user>/<hash>/socket` verified.
  * **S4**: `psftp` batch parsing: **PARTIALLY RESOLVED** — `ls -l` space-in-filename parser confirmed; `psftp -share` hangs silently; fallback paths designed.
* **M1: CI, Cargo-Deny, Threat Model & SSHD Fixture**: ✅ **DONE** (39/39 tests pass) — Linux + Windows multi-platform CI matrix (`.github/workflows/ci.yml`) with automated `cargo-deny`, frontend verification, workspace tests, and headless Xvfb launch smoke test (`timeout 8s ./target/debug/plinky-desktop`). Complete `deny.toml` passing with 0 errors. Living security architecture specification (`docs/THREAT_MODEL.md`) detailing trust boundaries and mitigations for remote escape sequences, pre-auth state machine bypass, sync input leakage, and vault crypto hygiene. Localhost unprivileged `sshd` test fixture (`crates/plinky-core/tests/sshd_fixture_tests.rs`) exercising real `plink` session with ed25519 host key / PPK auth, hostkey prompt answering, D9 Live transition, and scrollback reattach.
* **M2: Walking Skeleton**: ✅ **DONE** (7/7 tests pass) — `crates/plinky-core` Transport trait, `LocalTransport` and `PlinkTransport` under `portable-pty`, D3/D9 PreAuth state machine with verbatim prompt matching, structured `HostKeyPromptInfo`, 8 KiB bounded default-deny, `ScrollbackRingBuffer` with sequence tracking and O(1) replay, `SessionRegistry` with `attach_session`, `answer_prompt`, dedicated `session:prompt` events, keystroke blocking during prompts, and Tauri v2 binary streaming channel (`tauri::ipc::Channel<Vec<u8>>`).
* **M3: `putty-compat` v1**: ✅ **DONE** (7/7 tests pass) — Standalone session parser (`PUTTYDIR`, `~/.putty`, WinReg), atomic `.bak` writes, `.ppk` v2/v3 header parser & SHA256 fingerprinting matching `puttygen -l`, OpenSSH rejection, and real system `sshhostkeys` parsing. *(D1 Option A accepted by owner: hand-written Argon2id decryption deferred to v2)*.
* **M4: Pre-Auth State Machine & Vault**: ✅ **DONE** (9 vault tests pass, 76/76 workspace tests pass) — Argon2id KDF (64 MiB, 3 iterations) + AES-256-GCM container authenticated with AAD header binding (`PLKV_AAD_v1`), in-memory zeroization (`ZeroizeOnDrop`), debug redaction (`[REDACTED]`), atomic disk synchronization (`vault.bin.tmp` -> `vault.bin` with 0600 permissions), Tauri IPC (`vault_create`, `vault_unlock`, `vault_lock`, `vault_get`, `vault_set`, `vault_get_entry`, `vault_set_entry`, `vault_delete`, `vault_list_keys`), and interactive UI workbench (`VaultManager.tsx`). **Saved Session Vault Integration**: PuTTY sessions link to encrypted vault credentials via reference key (`extra.PlinkyVaultKey`), never storing plaintext passwords in session files or Windows registry. Supports network devices (routers, switches, firewalls) with privileged EXEC "enable passwords" (`enable_secret`), 1-click terminal autofill floating banner, right-click context menu injection, and 25-second auto-clearing clipboard hygiene.
* **M5: Docking Layout, Sync Router & Shell Integration**: ✅ **DONE** (38/38 workspace tests pass) — `SyncInputRouter` in `crates/plinky-core::sync` (D6 Live-only state filtering, protected session skip, global arm toggle, in-memory fan-out, Tauri IPC). Multi-pane split engine in UI (Single, 2-Pane Column, 2-Pane Row, 4-Pane Grid). Shell integration bootstrap in `crates/plinky-core::session::shell_integration` (`OSC 133` prompt markers A/B/C/D and `OSC 7` working directory reporting for Bash, Zsh, and Fish). Real-time SFTP directory following via OSC 7. `Ctrl+Up` / `Ctrl+Down` prompt jumping via OSC 133. R1–R3 layout persistence with fail-closed quarantine (`layoutPersistence.ts`). Hardened write path with `write_input_live_only` to prevent pre-auth password leakage.
* **M6: Productivity**: ✅ **DONE** — Free Type Mode with coordinate delta calculation, alternate buffer suppression, DECCKM application cursor keys mode check (`\x1bOC`/`\x1bOD` vs `\x1b[C`/`\x1b[D`), and OSC 133 semantic prompt region gating (`B..C`). Real-time regex token decorator (`registerLinkProvider` for IPv4 & URLs), in-terminal search bar (`@xterm/addon-search`), quick snippet macro bar, and custom terminal context menu.
* **M7: SFTP & Port Forwarding**: ✅ **SFTP BACKEND & UI COMPLETE** — ADR-003 plain `psftp` engine in `crates/plinky-core::sftp` (`parser.rs` with space/symlink support, `client.rs` with non-blocking async I/O). Tauri IPC commands (`sftp_list`, `sftp_mkdir`, `sftp_rm`). Interactive dual-pane file manager (`SftpDualPane.tsx`) with directory drill-down, `mkdir`, `rm`, breadcrumbs, and transfer queue. Visual SSH tunnel manager (`TunnelManager.tsx`).
* **Hardware Serial & Jump Host Bastion **: ✅ **DONE** — Zero-dependency `/sys/class/tty` & Windows registry serial port auto-discovery (`detect_serial_ports()`), dedicated Serial GUI with active USB indicator dots (`●`), baud presets, advanced parity/flow control, and an SSH gateway / jump host route diagram with saved session preset picker, serialized directly into native PuTTY configuration keys (`SerialLine`, `SerialSpeed`, `ProxyMethod: '6'`, PuTTY's own SSH proxy). The jump host can log in with a username and password stored in the encrypted vault, and the target then logs in with the session's own vault credentials; each password is typed only at its own host's prompt, once.

---

## 5. Development & Build Instructions

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
```

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



