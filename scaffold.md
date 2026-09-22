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
│       │                                 # ✅ IMPLEMENTED & VERIFIED (7/7 tests pass)
│       ├── Cargo.toml                    # Dependencies: portable-pty, tokio, serde, regex, thiserror
│       └── src/
│           ├── lib.rs
│           ├── errors.rs                 # PlinkyError, Result
│           ├── transport/                # Unified Transport Abstraction
│           │   ├── mod.rs                # Transport trait (write, resize, kill, is_alive) bound to Send
│           │   ├── plink.rs              # Primary: plink under portable-pty, ADR-002 detect_putty probe
│           │   └── local.rs              # Local shell PTY (sh, bash) under portable-pty
│           └── session/                  # Session Lifecycle & State Persistence (D3/D8/D9 state machine)
│               ├── mod.rs
│               ├── manager.rs            # Active session registry, attach_session reattach, answer_prompt, prompt events
│               ├── state_machine.rs      # PreAuth state machine (HostKeyPromptInfo, verbatim prompts, 8 KiB default-deny, D9 marker)
│               └── ring_buffer.rs        # Scrollback ring buffer with monotonic sequence tracking & get_since replay
│
├── src-tauri/                            # Tauri v2 Application Shell & IPC Bindings (IMPLEMENTED)
│   ├── Cargo.toml                        # Workspace member: tauri, putty-compat, tokio
│   ├── tauri.conf.json                   # Tauri v2 window, dimensions (1280x820), security, icons
│   ├── build.rs                          # tauri_build entry
│   ├── icons/                            # Desktop app icons (32x32, 128x128, 256x256, .ico, .icns)
│   └── src/
│       ├── main.rs                       # Desktop entrypoint & windows subsystem flags
│       └── lib.rs                        # Tauri plugin setup & command registration:
│                                         # list_putty_sessions, read_putty_session, write_putty_session,
│                                         # list_putty_hostkeys, inspect_ppk
│
└── src/                                  # Frontend UI Workbench (TypeScript + React 19 + xterm.js)
    ├── package.json                      # Dependencies: React 19, @xterm/xterm, dockview, lucide-react, tailwindcss
    ├── vite.config.ts                    # Vite 6 config with Tauri dev port 1420 & aliases
    ├── tsconfig.json                     # TypeScript strict bundler configuration
    ├── tailwind.config.js                # Dark terminal slate palette + broadcast channel colors (A-D)
    ├── postcss.config.js                 # Tailwind PostCSS configuration
    ├── index.html                        # Application shell with font preconnects
    ├── main.tsx                          # React 19 entrypoint
    ├── App.tsx                           # Master IDE-style workbench with tab management & view routing
    ├── index.css                         # CSS styling, dockview overrides, xterm customisation, free-type styles
    ├── types/
    │   └── session.ts                    # TypeScript models (PuttySession, TerminalTab, SyncChannel, Sftp, Tunnels)
    ├── services/
    │   ├── tauriBridge.ts                # Dual-mode IPC bridge (Tauri native + browser preview fallbacks)
    │   └── terminalManager.ts            # Terminal registry, broadcast sync router, prompt simulation
    └── components/
        ├── layout/
        │   ├── TitleBar.tsx              # Quick connect, view switchers, new session action
        │   └── StatusBar.tsx             # Active tabs, plink transport status, sync channel metrics, R3 safety
        ├── sidebar/
        │   └── SessionExplorer.tsx       # Native PuTTY session tree, fuzzy search, tags/folders, launch actions
        ├── terminal/
        │   └── TerminalView.tsx          # xterm.js canvas, Free Type Mode, live regex highlighting, channel badge
        ├── sftp/
        │   └── SftpDualPane.tsx          # Dual-pane local/remote filesystem explorer, transfer queue, ADR-003 Option B
        ├── tunnels/
        │   └── TunnelManager.tsx         # Visual SSH tunnels (Local -L, Remote -R, Dynamic -D SOCKS5)
        ├── keys/
        │   └── HostKeyManager.tsx        # Trusted PuTTY host keys viewer and PPK header inspection
        ├── sync/
        │   └── SyncBroadcastBar.tsx      # Multi-session command broadcast bar (All, A, B, C, D)
        └── modals/
            └── NewSessionModal.tsx       # New PuTTY session modal with atomic persistence
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
