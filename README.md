# Plinky

> **The Open-Source PuTTY Wrapper with WindTerm's IDE Superpowers.**
> Named after PuTTY's iconic workhorse CLI tool `plink`. Combining PuTTY's battle-tested security, Linux `~/.putty/sessions`, Windows registry sessions, `.ppk` keys, and Pageant with WindTerm's beloved features: Free Type Mode, Multi-Session Sync Input, Integrated SFTP Pane, Real-time Regex Syntax Highlighting, and Visual SSH Tunneling.

---

## 1. Executive Summary

[WindTerm](https://github.com/kingToolbox/WindTerm) introduced a revolutionary concept: turning terminal emulators into an **IDE** for system administrators and DevOps engineers. However, the project hit a dead end for the community:
1. **The "Open Source" Illusion**: Despite claiming Apache-2.0, the core terminal engine and networking libraries were kept strictly proprietary as precompiled binary blobs.
2. **Stalled Development**: With a single maintainer and long stretches of silence (>1 year), pull requests were ignored and thousands of issues piled up.
3. **Security Impediments**: Enterprise and security-minded users cannot safely run closed-source binaries that handle production SSH keys, passwords, and server root access.

On the other end of the spectrum is **PuTTY**:
* Universally trusted, audited, MIT-licensed, and practically omnipresent on Linux (`/usr/bin/plink`) and Windows.
* However, PuTTY lacks modern conveniences: no native tabs, no integrated SFTP, no broadcast input, no regex highlighting, and no modern session management.

**Plinky** solves both problems: it provides an open-source, modern desktop workbench that uses PuTTY’s ecosystem (reading Linux `~/.putty/sessions`, Windows registry, `.ppk` keys, SSH Agent, and `plink`/`psftp`) while implementing the full suite of WindTerm features.

---

## 2. Feature Comparison Matrix

| Feature | Classic PuTTY | MobaXterm | WindTerm | **Plinky (Proposed)** |
| :--- | :---: | :---: | :---: | :---: |
| **Open Source** | ✅ (MIT) | ❌ (Proprietary / Free tier limits) | ⚠️ (Partial / Core closed) | ✅ **100% Open Source** |
| **Linux Native PuTTY (`~/.putty/sessions`)** | ✅ Native | ❌ | ⚠️ Import only | ✅ **100% Native Read/Write** |
| **Windows PuTTY Registry** | ✅ Native | ⚠️ Import only | ⚠️ Import only | ✅ **Native Read & Write** |
| **Linux PuTTY Toolchain (`plink`, etc.)** | ✅ Native | ❌ | ❌ | ✅ **Auto-detected & Wrapped** |
| **Linux Serial Devices (`/dev/ttyUSB*`)** | ✅ Native | ❌ | ⚠️ Manual | ✅ **Direct Enumeration** |
| **PuTTY .ppk v2/v3 Keys** | ✅ Native | ⚠️ Converted | ⚠️ Partial | ✅ **Native Support** |
| **Linux SSH Agent (`$SSH_AUTH_SOCK`)** | ✅ Native | ❌ | ⚠️ Partial | ✅ **Native Unix Socket IPC** |
| **Free Type Mode** (Click to edit) | ❌ | ❌ | ✅ | ✅ **Implemented** |
| **Sync Input Channels** (Broadcast) | ❌ | ✅ (All tabs only) | ✅ (4 discrete channels) | ✅ **4 Discrete Channels** |
| **Integrated SFTP Pane** | ❌ | ✅ (Embedded) | ✅ (Dual Pane / Dockable) | ✅ **Dual Pane / Dockable** |
| **Live Regex Text Markers** | ❌ | ⚠️ (Basic syntax) | ✅ (Full Regex coloring) | ✅ **Real-time Token Decorator** |
| **Visual Port Forwarding GUI** | ❌ | ⚠️ (Basic) | ✅ (Local/Remote/Dynamic) | ✅ **Visual Tunnel Manager** |
| **Snippet & Quick Command Bar** | ❌ | ⚠️ (Macros only) | ✅ (Parameterized) | ✅ **Parameterized Macros** |
| **OSC 133 Shell Integration** | ❌ | ❌ | ⚠️ (Incomplete) | ✅ **Full Semantic Prompts** |

---

## 3. Documentation Index

The complete proposal, analysis, and technical specifications are structured in the [`specs/`](specs) directory:

* 📄 **[PROPOSAL.md](specs/PROPOSAL.md)**: The end-to-end architectural and functional proposal for the PuTTY wrapper and feature expansion.
* 📄 **[WINDTERM_ANALYSIS.md](specs/WINDTERM_ANALYSIS.md)**: Deep forensic analysis of WindTerm, GitHub issue backlog, community pain points, and why it stalled.
* 📄 **[PUTTY_WRAPPER_SPEC.md](specs/PUTTY_WRAPPER_SPEC.md)**: Technical protocol specification for interfacing with PuTTY sessions, `.ppk` keys, Pageant IPC, and `plink`/`psftp`.
* 📄 **[FEATURE_MATRIX.md](specs/FEATURE_MATRIX.md)**: Comprehensive breakdown of WindTerm community feature requests and their implementation design.

---

## 4. Architectural Overview

Plinky adopts a high-performance, memory-safe architecture organized as a Cargo workspace with Tauri v2 and modern web technologies:

```mermaid
flowchart TD
    subgraph UI_Workbench ["UI Workbench (Tauri Webview: TypeScript + React 19 + xterm.js)"]
        Docking["Multi-Tab & Split Pane Docking (dockview)"]
        FreeType["Free Type Mode Engine (OSC 133 prompt gated)"]
        SyncManager["Sync Input Broadcast UI (Channels A-D)"]
        RegexEngine["Regex Token Decorator (IDecoration + registerLinkProvider)"]
        SFTPPane["Dual-Pane SFTP Explorer (psftp -share)"]
        SnippetBar["Quick Command / Snippet Palette"]
        TunnelGUI["Visual SSH Tunnel Manager"]
    end

    subgraph Rust_Backend ["crates/plinky-core (Core Terminal Engine)"]
        ChannelStream["tauri::ipc::Channel (Binary Streaming & Watermarks)"]
        PTYMgr["PTY & Process Lifecycle (portable-pty)"]
        SyncRouter["SyncInputRouter (Live-Only Filtering & Paste Guard)"]
        SessionMgr["Session Manager & Scrollback Ring Buffers"]
        ShellBootstrap["Shell Integration Bootstrap (OSC 133 + OSC 7)"]
        PlinkRunner["Plink Transport (/usr/bin/plink -share / -serial)"]
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

## 5. Architectural Specifications & Milestones

### Core Technical Specifications
* **[SYSTEM_DESIGN.md](specs/SYSTEM_DESIGN.md)**: **Master v1 System Design** (IPC contracts, data flow, pre-auth state machine, threat model, persistence rules R1–R3, milestones M0–M7).
* **[DEEP_DESIGN.md](specs/wrapper/DEEP_DESIGN.md)**: **PuTTY-Wrapper Subsystem Deep Design** (Empirical `plink 0.85` evidence, D8 interactive launching, D9 `Access granted` boundary marker, R3 v1 scope, OpenSSH key conversion).
* **[ADR-001](specs/adr/ADR-001-primary-ssh-transport.md)**: **`plink` Only for v1**. `russh` is deferred behind empirical spike results to preserve single-stack auditability and 100% PuTTY fidelity.
* **[ADR-002](specs/adr/ADR-002-putty-discovery-and-versioning.md)**: **System PuTTY Detection (Floor: 0.75+)**. No binary bundling in v1; Tier 1 platforms: Linux & Windows (macOS on hold).

### Phased Implementation Milestones (D7: Vertical Slice Before Breadth)
* **M0: Phase 0 Empirical Spikes (Numeric Thresholds)**:
  * **S1**: `xterm.js` WebGL throughput & keystroke latency on WebKitGTK (Wayland) and WebView2 (Windows) during saturated stream (`cat bigfile` / `yes`).
  * **S2**: `plink` under `portable-pty`: terminal resize propagation (Linux vs Windows ConPTY), pre-auth to live boundary detection, and exact prompt text matching.
  * **S3**: `plink -share` lifecycle: **CONFIRMED** (Claude MSG #152) — owner survives sharer churn, sharer fails closed on owner death, `/tmp/putty-connshare.<user>/<hash>/socket` verified.
  * **S4**: `psftp` batch parsing: **PARTIALLY RESOLVED / SUSPECTED BLOCKER** (Claude MSG #158) — `ls -l` space-in-filename parser confirmed; `psftp -share` hangs silently; fallback paths designed.
* **M1: CI, Cargo-Deny, Threat Model & SSHD Fixture**: ✅ **IMPLEMENTED & AUDITED** (39/39 tests pass) — Linux + Windows multi-platform CI matrix (`.github/workflows/ci.yml`) with automated `cargo-deny`, frontend verification, workspace tests, and headless Xvfb launch smoke test (`timeout 8s ./target/debug/plinky-desktop`). Complete `deny.toml` passing with 0 errors. Living security architecture specification (`docs/THREAT_MODEL.md`) detailing trust boundaries and mitigations for remote escape sequences, pre-auth state machine bypass, sync input leakage, and vault crypto hygiene. Localhost unprivileged `sshd` test fixture (`crates/plinky-core/tests/sshd_fixture_tests.rs`) exercising real `plink` session with ed25519 host key / PPK auth, hostkey prompt answering, D9 Live transition, and scrollback reattach.
* **M2: Walking Skeleton**: ✅ **IMPLEMENTED & AUDIT-HARDENED** (7/7 tests pass) — `crates/plinky-core` Transport trait, `LocalTransport` and `PlinkTransport` under `portable-pty`, D3/D9 PreAuth state machine with verbatim prompt matching, structured `HostKeyPromptInfo`, 8 KiB bounded default-deny, `ScrollbackRingBuffer` with sequence tracking and O(1) replay, `SessionRegistry` with `attach_session`, `answer_prompt`, dedicated `session:prompt` events, keystroke blocking during prompts, and Tauri v2 binary streaming channel (`tauri::ipc::Channel<Vec<u8>>`).
* **M3: `putty-compat` v1**: ✅ **IMPLEMENTED & VERIFIED** (7/7 tests pass) — Standalone session parser (`PUTTYDIR`, `~/.putty`, WinReg), atomic `.bak` writes, `.ppk` v2/v3 header parser & SHA256 fingerprinting matching `puttygen -l`, OpenSSH rejection, and real system `sshhostkeys` parsing. *(D1 Option A accepted by owner: hand-written Argon2id decryption deferred to v2)*.
* **M4: Pre-Auth State Machine & Vault**: ✅ **IMPLEMENTED & AUDIT-HARDENED** (6 vault tests pass, 29/29 workspace tests pass) — OWASP-grade Argon2id KDF (64 MiB, 3 iterations) + AES-256-GCM container authenticated with AAD header binding (`PLKV_AAD_v1`), in-memory zeroization (`ZeroizeOnDrop`), debug redaction (`[REDACTED]`), atomic disk synchronization (`vault.bin.tmp` -> `vault.bin` with 0600 permissions), Tauri IPC (`vault_create`, `vault_unlock`, `vault_lock`, `vault_get`, `vault_set`, `vault_get_entry`, `vault_set_entry`, `vault_delete`, `vault_list_keys`), and interactive UI workbench (`VaultManager.tsx`).
* **M5: Docking Layout, Sync Router & Shell Integration**: ✅ **DONE & AUDIT-HARDENED** (38/38 workspace tests pass) — `SyncInputRouter` in `crates/plinky-core::sync` (D6 Live-only state filtering, protected session skip, global arm toggle, in-memory fan-out, Tauri IPC). Multi-pane split engine in UI (Single, 2-Pane Column, 2-Pane Row, 4-Pane Grid). Shell integration bootstrap in `crates/plinky-core::session::shell_integration` (`OSC 133` prompt markers A/B/C/D and `OSC 7` working directory reporting for Bash, Zsh, and Fish). Real-time SFTP directory following via OSC 7. `Ctrl+Up` / `Ctrl+Down` prompt jumping via OSC 133. R1–R3 layout persistence with fail-closed quarantine (`layoutPersistence.ts`). Hardened write path with `write_input_live_only` to prevent pre-auth password leakage.
* **M6: WindTerm Productivity**: ✅ **IMPLEMENTED & AUDIT-HARDENED** — Free Type Mode with coordinate delta calculation, alternate buffer suppression, DECCKM application cursor keys mode check (`\x1bOC`/`\x1bOD` vs `\x1b[C`/`\x1b[D`), and OSC 133 semantic prompt region gating (`B..C`). Real-time regex token decorator (`registerLinkProvider` for IPv4 & URLs), in-terminal search bar (`@xterm/addon-search`), quick snippet macro bar, and custom terminal context menu.
* **M7: SFTP & Port Forwarding**: ✅ **SFTP BACKEND & UI COMPLETE** — ADR-003 plain `psftp` engine in `crates/plinky-core::sftp` (`parser.rs` with space/symlink support, `client.rs` with non-blocking async I/O). Tauri IPC commands (`sftp_list`, `sftp_mkdir`, `sftp_rm`). Interactive dual-pane file manager (`SftpDualPane.tsx`) with directory drill-down, `mkdir`, `rm`, breadcrumbs, and transfer queue. Visual SSH tunnel manager (`TunnelManager.tsx`).

---

## 6. Development & Build Instructions

### Prerequisites
- **Rust**: 1.77+ (`rustup toolchain install stable`)
- **Node.js**: 20+ & `npm`
- **System Binaries**: `plink`, `psftp`, `puttygen` (version 0.75+, 0.85+ recommended)
- **Linux Libraries**: `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`

### Verification & Testing
```bash
# Run workspace Rust tests (39 tests including localhost sshd fixture)
cargo test --workspace

# Run dependency license, advisory, and ban validation
cargo deny check

# Check frontend TypeScript compilation & bundle
npm run build
```

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



