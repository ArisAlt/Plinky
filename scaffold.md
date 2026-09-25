# Project Scaffold (`scaffold.md`)

This document tracks the directory architecture, file structure, component relationships, and implementation boundaries of **Plinky** (PuTTY Modern Wrapper & IDE-Grade Terminal Emulator).

```
./
├── GEMINI.md                             # AI operational rules, project overview, memory governance
├── past_memory.md                        # Dense ledger of architectural decisions and context
├── README.md                             # Master user guide, project vision, feature breakdown
├── scaffold.md                           # Living directory and module architecture map (this file)
├── deny.toml                             # Cargo-deny configuration (licenses, bans, advisories, sources)
│
├── .github/
│   └── workflows/
│       └── ci.yml                        # Multi-platform CI (Ubuntu + Windows, cargo-deny, Xvfb smoke)
│
├── docs/
│   └── THREAT_MODEL.md                   # Threat model & security architecture specification
│
├── specs/                                # Technical Specifications & Proposal Suite
├── specs/README.md                       # Overview of the research & specifications
├── specs/SYSTEM_DESIGN.md                # Comprehensive v1 System Design (M0-M7, IPC, security, threat model)
├── specs/wrapper/                        # PuTTY Wrapper Deep Technical Subsystem Design
│   └── DEEP_DESIGN.md                    # Empirical evidence (0.85), D8 (-batch), D9 (Access granted), R3, share ownership
├── specs/PROPOSAL.md                     # Comprehensive proposal: PuTTY Wrapper + WindTerm features
├── specs/WINDTERM_ANALYSIS.md            # In-depth autopsy of kingToolbox/WindTerm & community requests
├── specs/PUTTY_WRAPPER_SPEC.md           # Technical specification for PuTTY bridge & wrappers
├── specs/FEATURE_MATRIX.md               # Detailed feature comparison: WindTerm vs PuTTY vs Plinky
└── specs/adr/                            # Architecture Decision Records
    ├── README.md                         # ADR index and status table
    ├── ADR-001-primary-ssh-transport.md  # Decision: plink-only in v1, russh deferred
    └── ADR-002-putty-discovery-and-versioning.md # Decision: detect installed PuTTY (0.75+), no bundling
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
│       │                                 # ✅ IMPLEMENTED & VERIFIED (36 core unit tests, 70/70 workspace tests pass)
│       ├── Cargo.toml                    # Dependencies: portable-pty, tokio, serde, regex, thiserror, serialport
│       └── src/
│           ├── lib.rs
│           ├── errors.rs                 # PlinkyError, Result
│           ├── transport/                # Unified Transport Abstraction
│           │   ├── mod.rs                # Transport trait (write, resize, kill, is_alive) bound to Send
│           │   ├── plink.rs              # Primary: plink under portable-pty, ADR-002 detect_putty probe
│           │   ├── serial.rs             # Serial transport + zero-dependency USB/COM port auto-discovery
│           │   └── local.rs              # Local shell PTY (sh, bash) under portable-pty
│           ├── sync/                     # Multi-session command broadcast (M5 SyncInputRouter)
│           │   ├── mod.rs
│           │   └── router.rs             # In-memory fan-out, D6 state filtering (Live-only), protected exclusion
│           ├── sftp/                     # SFTP subsystem via dedicated psftp process (ADR-003 Option B)
│           │   ├── mod.rs
│           │   ├── parser.rs             # psftp ls -l parser, space-in-filename tokenizer, symlink handling
│           │   └── client.rs             # PsftpClient process runner (list_dir, create_dir, remove_file)
│           ├── vault/                    # Credential Vault (M4 Argon2id + AES-256-GCM + Zeroize)
│           │   ├── mod.rs                # Vault in-memory struct, SecretString with ZeroizeOnDrop and redaction
│           │   └── storage.rs            # PLKV container format (36-byte header, AAD binding, atomic disk writes)
│           └── session/                  # Session Lifecycle & State Persistence (D3/D8/D9 state machine)
│               ├── mod.rs
│               ├── manager.rs            # Active session registry, attach_session reattach, answer_prompt, prompt events
│               ├── state_machine.rs      # PreAuth state machine (HostKeyPromptInfo, verbatim prompts, 8 KiB default-deny, D9 marker)
│               ├── ring_buffer.rs        # Scrollback ring buffer with monotonic sequence tracking & get_since replay
│               └── shell_integration.rs  # Shell integration bootstrap (OSC 133 prompt markers + OSC 7 CWD reporting)
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
│                                         # list_putty_hostkeys, inspect_ppk, start/attach/write/resize/close,
│                                         # sync channels & broadcast, sftp_list, sftp_mkdir, sftp_rm
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
    │   ├── terminalManager.ts            # Terminal registry, broadcast sync router
    │   ├── layoutPersistence.ts          # R1-R3 compliant layout state auto-saving and fail-closed quarantine
    │   └── sessionMetadata.ts            # D4 compliant session folder and tags sidecar persistence service
    ├── test/                             # Frontend Vitest Test Suites (30 tests across 9 suites)
    │   ├── setup.ts                      # jsdom and canvas test polyfills
    │   ├── layoutPersistence.test.ts     # R1-R3 layout state and quarantine tests
    │   ├── terminalManager.test.ts       # Multi-terminal channel routing tests
    │   ├── sessionMetadata.test.ts       # Session folder and user custom folders persistence tests
    │   ├── VaultManager.test.tsx         # Vault Close X button and Escape key dismiss tests
    │   ├── SettingsModal.test.tsx        # Preference modal rendering and change callbacks
    │   ├── SessionExplorer.test.tsx      # Tree rendering, double-click connect, density toggle tests
    │   ├── TitleBar.test.tsx             # Quick Connect history and auto-complete dropdown tests
    │   ├── tauriBridge.sessions.test.ts  # PuTTY session normalization & metadata test suite
    │   └── NewSessionModal.test.tsx      # Serial USB auto-detection & MobaXterm jump host GUI tests
    └── components/
        ├── layout/
        │   ├── TitleBar.tsx              # Quick connect with history and autocomplete, view switchers, new session action
        │   └── StatusBar.tsx             # Active tabs, plink transport status, sync channel metrics, R3 safety
        ├── sidebar/
        │   └── SessionExplorer.tsx       # Native PuTTY session tree, compact/comfortable density toggle, fuzzy search, tags/folders
        ├── terminal/
        │   └── TerminalView.tsx          # xterm.js canvas, status state reporting, drag-drop path pasting, event logs
        ├── sftp/
        │   └── SftpDualPane.tsx          # Dual-pane local/remote filesystem explorer, drag-drop remote upload, transfer queue
        ├── tunnels/
        │   └── TunnelManager.tsx         # Visual SSH tunnels (Local -L, Remote -R, Dynamic -D SOCKS5)
        ├── keys/
        │   └── HostKeyManager.tsx        # Trusted PuTTY host keys viewer and PPK header inspection
        ├── vault/
        │   └── VaultManager.tsx          # Argon2id + AES-256-GCM Credential Vault UI with redaction & zeroize
        ├── sync/
        │   └── SyncBroadcastBar.tsx      # Multi-session command broadcast bar (All, A, B, C, D)
        └── modals/
            ├── NewSessionModal.tsx       # PuTTY session modal with atomic persistence and edit capability
            └── SettingsModal.tsx         # User preferences (fonts, cursor, copy on select, right-click action, cache clear)
    └── styles/                           # Styling & Theme Variables
        ├── themes/                       # WindTerm Dark, PuTTY Classic, Dracula, Nord
```

---

## Phased Implementation Milestones (D7: Vertical Slice Before Breadth)

| Milestone | Deliverable | Acceptance Criteria |
| :--- | :--- | :--- |
| **M0** | **Phase 0 Spikes (S1–S4)**: WebGL throughput, plink under PTY (auth boundary, resize, exact prompt text), `-share` lifecycle, psftp parsing on Linux and Windows | Numeric thresholds fixed before spikes; results documented as ADRs; unknowns tagged `[?]` resolved. |
| **M1** | **CI & Threat Model**: ✅ **DONE** - GitHub Actions CI (Linux + Windows), `cargo-deny` (0 errors), `docs/THREAT_MODEL.md`, localhost `sshd` test fixture (`sshd_fixture_tests.rs`) | All automated CI jobs defined; cargo-deny passing; 39/39 workspace tests pass. |
| **M2** | **Walking Skeleton**: Hard-coded session, single tab, `tauri::ipc::Channel` + flow control + ring buffer, reload-and-reattach | Webview reload keeps session alive; keystroke latency & throughput meet M0 thresholds. |
| **M3** | **`putty-compat` v1**: Sessions r/w, `.ppk` header parser/fingerprinter, read-only hostkey listing, session tree | Fixtures generated via real `/usr/bin/puttygen 0.85`; parser edge cases covered; `cargo-fuzz` clean. |
| **M4** | **Pre-Auth State Machine & Vault**: ✅ **DONE** - PreAuth state machine (D3/D9), Argon2id + AES-256-GCM vault (R1–R3, AAD, zeroize), `putty_detect` | 6/6 vault tests pass, 29/29 workspace tests pass; hostile banner cannot trigger credential auto-fill; full memory zeroization. |
| **M5** | **Docking Layout, Sync Router & Shell Integration**: ✅ **DONE** - Multi-tab/split layouts, R1-R3 layout persistence (`layoutPersistence.ts`), `SyncInputRouter` (D6), shell integration bootstrap (OSC 133 + OSC 7) | Sync race conditions audited; state-filtering tests pass (`Live` only); 33/33 workspace tests pass; real-time SFTP directory following via OSC 7. |
| **M6** | **WindTerm Productivity Features**: Free Type Mode, regex markers/link provider, snippet bar | Gating tests pass (alternate buffer suppression, DECCKM, OSC 133 semantic region). |
| **M7** | **SFTP & Port Forwarding**: Dual-pane file manager, directory following, visual tunnels (scoped by S3/S4) | Transfers resume; unsupported tunnel types cleanly documented. |
