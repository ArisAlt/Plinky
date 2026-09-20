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
│   └── FEATURE_MATRIX.md                 # Detailed feature comparison: WindTerm vs PuTTY vs Plinky
│
├── src-tauri/                            # Rust Backend (Tauri v2 Native Engine)
│   ├── Cargo.toml                        # Rust dependencies (tauri, portable-pty, russh, serialport, argon2)
│   ├── tauri.conf.json                   # Tauri v2 window, security, and permission capabilities
│   └── src/
│       ├── main.rs                       # Tauri application entrypoint
│       ├── lib.rs                        # Command handlers and plugin registrations
│       ├── putty/                        # PuTTY Integration Subsystem
│       │   ├── mod.rs                    # Module exports
│       │   ├── sessions.rs               # Parser for Linux ~/.putty/sessions and Windows Registry
│       │   ├── ppk.rs                    # Native .ppk v2/v3 parser, Argon2id KDF, AES-256-CBC decryptor
│       │   ├── pageant.rs                # Unix Domain Socket ($SSH_AUTH_SOCK) & Windows Named Pipe IPC
│       │   └── plink.rs                  # Subprocess harness for /usr/bin/plink and plink.exe
│       ├── pty/                          # Terminal PTY Management
│       │   ├── mod.rs
│       │   ├── manager.rs                # PTY session lifecycle via portable-pty crate
│       │   └── stream.rs                 # Async bidirectional stdin/stdout Tauri event channels
│       ├── sftp/                         # SFTP & Remote Filesystem Subsystem
│       │   ├── mod.rs
│       │   ├── client.rs                 # Async SFTP connection and directory traversal
│       │   └── transfer.rs               # Chunked upload/download queue with bandwidth throttling
│       ├── serial/                       # Hardware Serial Communication
│       │   └── port.rs                   # Direct access to /dev/ttyUSB* on Linux and COM* on Windows
│       └── vault/                        # Secure Storage
│           └── crypto.rs                 # Master password encryption (Argon2id + AES-256-GCM)
│
└── src/                                  # Frontend UI Workbench (TypeScript + React/Vite + xterm.js)
    ├── package.json                      # Dependencies (react, @xterm/xterm, dockview, lucide-react)
    ├── vite.config.ts                    # Vite build configuration
    ├── index.html                        # Application shell
    ├── main.tsx                          # React entrypoint
    ├── App.tsx                           # Main IDE-style workbench (Dockview container)
    ├── components/
    │   ├── layout/                       # Docking layout manager
    │   │   ├── DockManager.tsx           # Resizable, multi-tab split pane system (dockview)
    │   │   ├── StatusBar.tsx             # Connection status, sync channel indicator, latency
    │   │   └── TitleBar.tsx              # Custom window frame, quick connect bar
    │   ├── terminal/                     # Terminal Viewport & WindTerm Enhancements
    │   │   ├── TerminalTab.tsx           # xterm.js instance with WebGL hardware acceleration
    │   │   ├── FreeTypeMode.ts           # WindTerm-style direct click-to-edit coordinate engine
    │   │   ├── RegexMarkers.ts           # Real-time regex token decorator (IPs, errors, URLs)
    │   │   ├── SyncInputBar.tsx          # Multi-session broadcast channels (A, B, C, D) toolbar
    │   │   └── PromptDetector.ts         # OSC 133 semantic prompt & command status tracker
    │   ├── sftp/                         # WindTerm-style SFTP Explorer
    │   │   ├── DualPaneExplorer.tsx      # Side-by-side local & remote filesystem trees
    │   │   ├── FileTable.tsx             # File list, permissions, owner, date modified
    │   │   └── TransferQueue.tsx         # Active background transfers, speed graph, pause/resume
    │   ├── sessions/                     # Session Management Tree
    │   │   ├── SessionTree.tsx           # Hierarchical folder view, tags, search filter
    │   │   ├── SessionDialog.tsx         # Session editor (SSH, PuTTY profile, Serial, Telnet)
    │   │   └── PuTTYImportModal.tsx      # Direct import from ~/.putty/sessions or Windows Registry
    │   ├── snippets/                     # Snippets & Quick Command Bar
    │   │   ├── QuickBar.tsx              # One-click macro execution buttons
    │   │   └── SnippetManager.tsx        # Parameterized command templates (e.g. {{user}}, {{ip}})
    │   └── tunnels/                      # Visual SSH Port Forwarding
    │       └── TunnelModal.tsx           # Local, Remote, and Dynamic SOCKS5 visualizer
    ├── hooks/                            # React state hooks
    │   ├── useTauriEvents.ts             # Typed event listeners for Tauri backend streams
    │   ├── useSyncChannels.ts            # 4-channel broadcast router hook
    │   └── useSFTP.ts                    # Remote filesystem navigation and directory following
    └── styles/                           # Styling & Theme Variables
        ├── themes/                       # WindTerm Dark, PuTTY Classic, Dracula, Nord
        └── main.css                      # Global layout & docking styles
```
