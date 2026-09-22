# Project Scaffold (`scaffold.md`)

This document tracks the directory architecture, file structure, component relationships, and implementation boundaries of **Plinky** (PuTTY Modern Wrapper & IDE-Grade Terminal Emulator).

```
./
├── GEMINI.md                             # AI operational rules, project overview, memory governance
├── past_memory.md                        # Dense ledger of architectural decisions and context
├── README.md                             # Master user guide, project vision, feature breakdown
├── scaffold.md                           # Living directory and module architecture map (this file)
│
├── specs/                                # Technical Specifications & Proposal Suite
│   ├── README.md                         # Overview of the research & specifications
│   ├── SYSTEM_DESIGN.md                  # Comprehensive v1 System Design (M0-M7, IPC, security, threat model)
│   ├── wrapper/                          # PuTTY Wrapper Deep Technical Subsystem Design
│   │   └── DEEP_DESIGN.md                # Empirical evidence (0.85), D8 (-batch), D9 (Access granted), R3, share ownership
│   ├── PROPOSAL.md                       # Comprehensive proposal: PuTTY Wrapper + WindTerm features
│   ├── WINDTERM_ANALYSIS.md              # In-depth autopsy of kingToolbox/WindTerm & community requests
│   ├── PUTTY_WRAPPER_SPEC.md             # Technical specification for PuTTY bridge & wrappers
│   ├── FEATURE_MATRIX.md                 # Detailed feature comparison: WindTerm vs PuTTY vs Plinky
│   └── adr/                              # Architecture Decision Records
│       ├── README.md                     # ADR index and status table
│       ├── ADR-001-primary-ssh-transport.md # Decision: plink-only in v1, russh deferred
│       └── ADR-002-putty-discovery-and-versioning.md # Decision: detect installed PuTTY (0.75+), no bundling
│
├── Cargo.toml                            # Root Cargo Workspace definition
│
├── crates/
│   ├── putty-compat/                     # Standalone PuTTY Compatibility Crate (Zero Tauri dependencies)
│   │   │                                 # ✅ IMPLEMENTED & VERIFIED (7/7 tests pass)
│   │   │                                 # [D1 ACCEPTED BY OWNER - Option A: narrow v1 to session r/w,
│   │   │                                 #  .ppk header inspection/fingerprinting, and read-only hostkey listing;
│   │   │                                 #  deferring .ppk decryption & agent client to v2 / key manager]
│   │   ├── Cargo.toml                    # Dependencies: winreg (Windows), serde, serde_json, thiserror, base64, sha2, tempfile
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── errors.rs                 # PuttyCompatError and Result<T>
│   │   │   ├── sessions.rs               # PUTTYDIR / ~/.putty/sessions and WinReg parser/atomic writer with .bak
│   │   │   ├── ppk.rs                    # .ppk v2/v3 header parsing, fingerprinting, looks_like_ppk detection
│   │   │   └── hostkeys.rs               # Read-only hostkey listing (~/.putty/sshhostkeys & WinReg)
│   │   ├── tests/                        # Headless cross-platform integration tests (real puttygen 0.85 & ~/.putty fixtures)
│   │   └── fuzz/                         # cargo-fuzz harness for untrusted .ppk and session files
│   │
│   └── plinky-core/                      # Core Terminal & Connection Engine (D5: minimal dependencies)
│       ├── Cargo.toml                    # Dependencies: portable-pty, tokio, serde, tracing, zeroize, argon2, aes-gcm, winreg
│       └── src/
│           ├── lib.rs
│           ├── transport/                # Unified Transport Abstraction
│           │   ├── mod.rs                # Transport trait (read, write, resize, close)
│           │   ├── plink.rs              # Primary: plink under portable-pty with -share (D8: interactive, no -batch)
│           │   ├── local_pty.rs          # Local shell PTY (bash, zsh, powershell)
│           │   └── serial.rs             # Hardware serial port (via `plink -serial`)
│           ├── session/                  # Session Lifecycle & State Persistence (D3/D8/D9 state machine)
│           │   ├── mod.rs
│           │   ├── manager.rs            # Active session registry (survives webview reload; owns -share master)
│           │   ├── state_machine.rs      # PreAuth state machine (HostKeyPending -> Live on 'Access granted', display-only password)
│           │   └── ring_buffer.rs        # Scrollback memory buffer (2 MiB per session credit window)
│           ├── sync/                     # Multi-Session Input Broadcasting (D6)
│           │   └── router.rs             # SyncInputRouter (Rust fanout, Live-only filtering, paste guard)
│           ├── tunnel/                   # Port Forwarding & Tunnels
│           │   ├── mod.rs
│           │   └── forwarder.rs          # Dynamic, Local, and Remote tunnel manager (via plink)
│           └── shell_integration/        # Semantic Shell Support
│               ├── mod.rs
│               └── bootstrap.rs          # Auto-injection snippets for bash, zsh, fish (OSC 133 + OSC 7)
│
├── src-tauri/                            # Tauri v2 Application Shell & IPC Bindings
│   ├── Cargo.toml                        # Workspace member: tauri, putty-compat, plinky-core
│   ├── tauri.conf.json                   # Tauri v2 window, security capabilities, and permissions
│   └── src/
│       ├── main.rs                       # Desktop entrypoint & lifecycle hooks
│       ├── lib.rs                        # Tauri plugin setup & command registration
│       └── commands/                     # Tauri IPC Commands
│           ├── mod.rs
│           ├── terminal.rs               # tauri::ipc::Channel binary streaming & watermarks
│           ├── sftp.rs                   # SFTP directory navigation and chunked transfer queue
│           └── sessions.rs               # Session CRUD operations
│
└── src/                                  # Frontend UI Workbench (TypeScript + React 19 + xterm.js)
    ├── package.json                      # Dependencies (react, @xterm/xterm, dockview, lucide-react)
    ├── vite.config.ts                    # Vite build configuration
    ├── index.html                        # Application shell
    ├── main.tsx                          # React entrypoint
    ├── App.tsx                           # Main IDE-style workbench (Dockview container)
    ├── services/                         # Terminal & Session Services (Outside React Lifecycle)
    │   ├── xtermRegistry.ts              # Global xterm instances keyed by sessionId (prevents teardown)
    │   └── channelStream.ts              # tauri::ipc::Channel raw binary reader & flow control
    ├── components/
    │   ├── layout/                       # Docking layout manager
    │   │   ├── DockManager.tsx           # dockview container with renderer: 'always' & layout persistence
    │   │   ├── StatusBar.tsx             # Connection status, sync channel indicator, latency
    │   │   └── TitleBar.tsx              # Custom window frame, quick connect bar
    │   ├── terminal/                     # Terminal Viewport & WindTerm Enhancements
    │   │   ├── TerminalTab.tsx           # xterm.js instance with WebGL addon
    │   │   ├── FreeTypeMode.ts           # Gated Free Type Mode (OSC 133 prompt region, DECCKM aware)
    │   │   ├── RegexMarkers.ts           # IDecoration color markers & registerLinkProvider
    │   │   ├── SyncInputBar.tsx          # Multi-session broadcast channels (A, B, C, D) toolbar
    │   │   └── PromptDetector.ts         # OSC 133 semantic prompt & command status tracker
    │   ├── sftp/                         # WindTerm-style SFTP Explorer
    │   │   ├── DualPaneExplorer.tsx      # Side-by-side local & remote filesystem trees
    │   │   ├── FileTable.tsx             # File list, permissions, owner, date modified
    │   │   └── TransferQueue.tsx         # Active background transfers, speed graph, pause/resume
    │   ├── sessions/                     # Session Management Tree
    │   │   ├── SessionTree.tsx           # Hierarchical folder view, tags, search filter
    │   │   ├── SessionDialog.tsx         # Session editor (SSH, PuTTY profile, Serial, Telnet)
    │   │   ├── PuTTYImportModal.tsx      # Direct import from PUTTYDIR / ~/.putty / WinReg
    │   │   └── KeyImportModal.tsx        # SSH key importer with puttygen OpenSSH -> PPK conversion flow
    │   ├── snippets/                     # Snippets & Quick Command Bar
    │   │   ├── QuickBar.tsx              # One-click macro execution buttons
    │   │   └── SnippetManager.tsx        # Parameterized command templates (e.g. {{user}}, {{ip}})
    │   └── tunnels/                      # Visual SSH Port Forwarding
    │       └── TunnelModal.tsx           # Local, Remote, and Dynamic SOCKS5 visualizer
    ├── hooks/                            # React state hooks
    │   ├── useSessionStream.ts           # Hook binding xterm to Tauri IPC binary channel
    │   ├── useSyncChannels.ts            # 4-channel broadcast router hook
    │   └── useSFTP.ts                    # Remote filesystem navigation and directory following
    └── styles/                           # Styling & Theme Variables
        ├── themes/                       # WindTerm Dark, PuTTY Classic, Dracula, Nord
```

---

## Phased Implementation Milestones (D7: Vertical Slice Before Breadth)

| Milestone | Deliverable | Acceptance Criteria |
| :--- | :--- | :--- |
| **M0** | **Phase 0 Spikes (S1–S4)**: WebGL throughput, plink under PTY (auth boundary, resize, exact prompt text), `-share` lifecycle, psftp parsing on Linux and Windows | Numeric thresholds fixed before spikes; results documented as ADRs; unknowns tagged `[?]` resolved. |
| **M1** | **CI & Threat Model**: GitHub Actions CI (Linux + Windows), `cargo-deny`, threat-model doc, localhost `sshd` test fixture | All automated CI jobs green on both platforms. |
| **M2** | **Walking Skeleton**: Hard-coded session, single tab, `tauri::ipc::Channel` + flow control + ring buffer, reload-and-reattach | Webview reload keeps session alive; keystroke latency & throughput meet M0 thresholds. |
| **M3** | **`putty-compat` v1**: Sessions r/w, `.ppk` header parser/fingerprinter, read-only hostkey listing, session tree | Fixtures generated via real `/usr/bin/puttygen 0.85`; parser edge cases covered; `cargo-fuzz` clean. |
| **M4** | **Pre-Auth State Machine & Vault**: State machine (D3), Argon2id vault (R1–R3), `putty_detect` command | Scripted host-key and password flows pass; hostile banner cannot trigger credential auto-fill. |
| **M5** | **Docking Layout & Sync Router**: `dockview` multi-tab/split layout, layout persistence, `SyncInputRouter` (D6), shell integration bootstrap | Sync race conditions audited; state-filtering tests pass (`Live` sessions only). |
| **M6** | **WindTerm Productivity Features**: Free Type Mode, regex markers/link provider, snippet bar | Gating tests pass (alternate buffer suppression, DECCKM, OSC 133 semantic region). |
| **M7** | **SFTP & Port Forwarding**: Dual-pane file manager, directory following, visual tunnels (scoped by S3/S4) | Transfers resume; unsupported tunnel types cleanly documented. |
