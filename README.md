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

The complete proposal, analysis, and technical specifications are structured in the [`specs/`](file:///home/citizenzero/Dev/Plinky/windterm) directory:

* 📄 **[PROPOSAL.md](file:///home/citizenzero/Dev/Plinky/specs/PROPOSAL.md)**: The end-to-end architectural and functional proposal for the PuTTY wrapper and feature expansion.
* 📄 **[WINDTERM_ANALYSIS.md](file:///home/citizenzero/Dev/Plinky/specs/WINDTERM_ANALYSIS.md)**: Deep forensic analysis of WindTerm, GitHub issue backlog, community pain points, and why it stalled.
* 📄 **[PUTTY_WRAPPER_SPEC.md](file:///home/citizenzero/Dev/Plinky/specs/PUTTY_WRAPPER_SPEC.md)**: Technical protocol specification for interfacing with PuTTY sessions, `.ppk` keys, Pageant IPC, and `plink`/`psftp`.
* 📄 **[FEATURE_MATRIX.md](file:///home/citizenzero/Dev/Plinky/specs/FEATURE_MATRIX.md)**: Comprehensive breakdown of WindTerm community feature requests and their implementation design.

---

## 4. Architectural Overview

Plinky adopts a high-performance, memory-safe architecture powered by **Rust (Tauri v2)** and modern web technologies:

```mermaid
flowchart TD
    subgraph UI_Workbench ["UI Workbench (Tauri Webview: TypeScript + React + xterm.js)"]
        Docking["Multi-Tab & Split Pane Docking (dockview)"]
        FreeType["Free Type Mode Engine (DOM Click Interceptor)"]
        SyncManager["Sync Input Broadcast Router (Channels A-D)"]
        RegexEngine["Regex Token Decorator (xterm.js buffer parser)"]
        SFTPPane["Dual-Pane SFTP Explorer & Transfer Queue"]
        SnippetBar["Quick Command / Snippet Palette"]
        TunnelGUI["Visual SSH Tunnel Manager"]
    end

    subgraph Rust_Backend ["Core Backend (Rust / Tauri v2 Native Engine)"]
        PTYMgr["PTY & Process Lifecycle (portable-pty)"]
        SFTPClient["Async SFTP Client (russh / ssh2)"]
        SerialEngine["Hardware Serial Port Manager (serialport)"]
        MasterVault["AES-256-GCM Credential Vault (Argon2id)"]
    end

    subgraph PuTTY_Subsystem ["PuTTY Native Subsystem (Rust)"]
        LinuxReg["Linux ~/.putty/sessions File Parser & Writer"]
        WinReg["Windows Registry Bridge (winreg crate)"]
        PPKEngine[".ppk (v2/v3) Parser, Argon2id & AES Decryptor"]
        AgentBridge["Unix Domain Socket ($SSH_AUTH_SOCK) & Pageant Named Pipe"]
        PlinkRunner["Subprocess Stream Wrapper (/usr/bin/plink & plink.exe)"]
    end

    UI_Workbench <-->|Typed Tauri IPC Events & Streams| Rust_Backend
    Rust_Backend <--> PuTTY_Subsystem
    Rust_Backend <--> RemoteServers["Remote SSH Servers / Serial Consoles"]
```

---

## 5. Getting Started & Roadmap

1. **Phase 1 (Current)**: Research, WindTerm autopsy, and technical specifications (`specs/` documentation).
2. **Phase 2**: Core PuTTY session importer, `.ppk` parser, and Pageant bridge.
3. **Phase 3**: Terminal workbench with xterm.js, multi-tab docking, and Free Type Mode.
4. **Phase 4**: Sync Input multi-channel broadcasting and real-time regex text highlighters.
5. **Phase 5**: Integrated SFTP dual-pane explorer, transfer queue, and visual tunnel manager.
