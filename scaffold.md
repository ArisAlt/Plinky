# Project Scaffold (`scaffold.md`)

This document tracks the directory architecture, file structure, component relationships, and implementation boundaries of **Plinky** (PuTTY Modern Wrapper & IDE-Grade Terminal Emulator).

```
/home/citizenzero/Dev/Plinky/
├── GEMINI.md                             # AI operational rules, project overview, memory governance
├── past_memory.md                        # Dense ledger of architectural decisions and context
├── README.md                             # Master user guide, project vision, feature breakdown
├── scaffold.md                           # Living directory and module architecture map (this file)
│
├── specs/                                # Technical Specifications & Proposal Suite
│   ├── README.md                         # Overview of the research & specifications
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
│   │   ├── Cargo.toml                    # Dependencies: argon2, aes, cbc, hmac, sha1, sha2, winreg (Windows)
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── sessions.rs               # PUTTYDIR / ~/.putty/sessions and WinReg parser
│   │   │   ├── ppk.rs                    # Native .ppk v2/v3 parser with Argon2id decryption
│   │   │   ├── hostkeys.rs               # ~/.putty/sshhostkeys verification and TOFU generator
│   │   │   └── pageant.rs                # Unix Domain Socket ($SSH_AUTH_SOCK) & Windows Named Pipe IPC
│   │   ├── tests/                        # Headless cross-platform integration tests
│   │   └── fuzz/                         # cargo-fuzz harness for untrusted .ppk and session files
│   │
│   └── plinky-core/                      # Core Terminal & Connection Engine
│       ├── Cargo.toml                    # Dependencies: portable-pty, serialport, tokio, russh
│       └── src/
│           ├── lib.rs
│           ├── transport/                # Unified Transport Abstraction
│           │   ├── mod.rs                # Transport trait (read, write, resize, close)
│           │   ├── plink.rs              # Primary: /usr/bin/plink under portable-pty with -share
│           │   ├── local_pty.rs          # Local shell PTY (bash, zsh, powershell)
│           │   ├── serial.rs             # Hardware serial port (/dev/ttyUSB*, COM*)
│           │   └── russh_fallback.rs     # In-process SSH fallback for dynamic port forwarding
│           ├── session/                  # Session Lifecycle & State Persistence
│           │   ├── mod.rs
│           │   ├── manager.rs            # Active session registry (survives webview reload)
│           │   └── ring_buffer.rs        # Scrollback memory buffer for fast re-attachment
│           ├── sync/                     # Multi-Session Input Broadcasting
│           │   └── router.rs             # SyncInputRouter (Rust-side fanout, paste guard, safety locks)
│           ├── tunnel/                   # Port Forwarding & Tunnels
│           │   ├── mod.rs
│           │   └── forwarder.rs          # Dynamic, Local, and Remote tunnel manager
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
    │   │   └── PuTTYImportModal.tsx      # Direct import from PUTTYDIR / ~/.putty / WinReg
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
        └── main.css                      # Global layout & docking styles
```
