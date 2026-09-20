# Project Scaffold (`scaffold.md`)

This document tracks the directory architecture, file structure, component relationships, and implementation boundaries of **Plinky** (PuTTY Modern Wrapper & IDE-Grade Terminal Emulator).

```
/home/citizenzero/Dev/WinPutty/
├── GEMINI.md                             # AI operational rules, project overview, memory governance
├── past_memory.md                        # Dense ledger of architectural decisions and context
├── README.md                             # Master user guide, project vision, feature breakdown
├── scaffold.md                           # Living directory and module architecture map (this file)
│
├── windterm/                             # WindTerm Analysis, Proposal, & Technical Specifications
│   ├── README.md                         # Overview of the WindTerm research & specifications
│   ├── PROPOSAL.md                       # Comprehensive proposal: PuTTY Wrapper + WindTerm features
│   ├── WINDTERM_ANALYSIS.md              # In-depth autopsy of kingToolbox/WindTerm & community requests
│   ├── PUTTY_WRAPPER_SPEC.md             # Technical specification for PuTTY bridge & wrappers
│   └── FEATURE_MATRIX.md                 # Detailed feature comparison: WindTerm vs PuTTY vs WinPutty
│
└── src/                                  # Planned Implementation Codebase
    ├── main/                             # Desktop Runtime / Backend Process
    │   ├── index.ts                      # Application lifecycle & window management
    │   ├── ipc/                          # Inter-process communication handlers
    │   │   ├── terminalIpc.ts            # PTY session spawning, resize, data streams
    │   │   ├── sftpIpc.ts                # Remote FS operations, transfers, cancel
    │   │   └── puttyIpc.ts               # PuTTY registry & key reader requests
    │   ├── putty/                        # PuTTY Integration Subsystem
    │   │   ├── sessionRegistry.ts        # Reads HKCU\Software\SimonTatham\PuTTY and .reg files
    │   │   ├── ppkParser.ts              # .ppk v2 / v3 private key reader & converter
    │   │   ├── pageantClient.ts          # Pageant IPC (named pipe / shared memory)
    │   │   └── plinkRunner.ts            # Wrapper process for plink, psftp, pscp
    │   ├── sftp/                         # SFTP Subsystem
    │   │   ├── sftpClient.ts             # Direct SSH2/SFTP client connection pool
    │   │   └── transferManager.ts        # Chunked upload/download queue & bandwidth throttling
    │   └── pty/                          # Local & Remote Terminal Process Engine
    │       ├── ptyManager.ts             # Node-pty / child process allocator
    │       └── tunnelManager.ts          # Local/Remote/Dynamic SOCKS5 SSH tunnels
    │
    ├── renderer/                         # UI Frontend (React + TypeScript + xterm.js)
    │   ├── index.html                    # HTML shell
    │   ├── index.tsx                     # React root
    │   ├── App.tsx                       # Main workbench layout (Dockable panels)
    │   ├── components/
    │   │   ├── layout/                   # Docking layout manager
    │   │   │   ├── DockPanel.tsx         # Resizable, split-pane dock system
    │   │   │   ├── StatusBar.tsx         # Connection status, sync channel indicator, latency
    │   │   │   └── TitleBar.tsx          # Custom title bar, tabs, quick connect
    │   │   ├── terminal/                 # Terminal Engine & Enhancements
    │   │   │   ├── TerminalTab.tsx       # xterm.js wrapper instance with WebGL addon
    │   │   │   ├── FreeTypeMode.ts       # WindTerm-style free text placement engine
    │   │   │   ├── RegexHighlighter.ts   # Live regex token decorator (IPs, errors, URLs)
    │   │   │   ├── SyncInputBar.tsx      # Broadcast channels (A, B, C, D) toolbar
    │   │   │   └── PromptDetector.ts     # OSC 133 semantic prompt & command tracker
    │   │   ├── sftp/                     # WindTerm-style SFTP Sidebar
    │   │   │   ├── DualPaneExplorer.tsx  # Side-by-side local & remote filesystem trees
    │   │   │   ├── FileTable.tsx         # File list, permissions, owner, date modified
    │   │   │   └── TransferQueue.tsx     # Active transfers, speed graph, pause/resume
    │   │   ├── sessions/                 # Session Management Tree
    │   │   │   ├── SessionTree.tsx       # Hierarchical folder view, tags, search filter
    │   │   │   ├── SessionDialog.tsx     # Session editor (SSH, PuTTY profile, Serial, Telnet)
    │   │   │   └── PuTTYImportModal.tsx  # 1-click import from PuTTY registry or .reg
    │   │   ├── snippets/                 # Snippets & Quick Command Bar
    │   │   │   ├── QuickBar.tsx          # One-click macro execution buttons
    │   │   │   └── SnippetManager.tsx    # Parameterized commands (e.g. {{user}}, {{ip}})
    │   │   └── tunnels/                  # Visual Port Forwarding
    │   │       └── TunnelModal.tsx       # Local, Remote, and SOCKS5 tunnel visualizer
    │   ├── hooks/                        # React state hooks
    │   │   ├── useTerminalSession.ts     # Terminal tab state & socket bindings
    │   │   ├── useSyncChannels.ts        # Broadcast routing hook
    │   │   └── useSFTP.ts                # Remote directory navigation hook
    │   └── styles/                       # CSS / Tailwind / Theme variables
    │       ├── themes/                   # WindTerm Dark, PuTTY Classic, Dracula, Solarized
    │       └── main.css                  # Core layout & docking styles
    │
    ├── shared/                           # Shared Types & Protocols
    │   ├── types.ts                      # Session, Channel, SFTP, and Config interfaces
    │   └── puttyTypes.ts                 # PuTTY registry schema and PPK structures
    │
    └── test/                             # Automated Tests
        ├── putty/                        # PuTTY registry deserializer & PPK parser tests
        ├── terminal/                     # Sync input router & regex matcher tests
        └── sftp/                         # Transfer queue & path normalization tests
```
