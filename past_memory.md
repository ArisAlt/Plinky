# Dense Past Memory

[PROJECT]: WinPutty (PuTTY Modern Wrapper + WindTerm IDE-grade Terminal Emulator)
[ROOT]: /home/citizenzero/Dev/WinPutty
[WORKSPACE_ALT]: /home/citizenzero/Documents/antigravity/modest-darwin
[DATE_INIT]: 2026-09-20
[STATUS]: Scaffolding & Comprehensive Documentation Suite Phase

### 1. WINDTERM FORENSIC ANALYSIS & FAILURE REASONS
* Target: kingToolbox/WindTerm (C++/Qt terminal emulator).
* Core strengths: Free Type Mode (mouse click cursor placement & canvas edit), Sync Input (up to 4 broadcast channels), integrated SFTP file manager with drag & drop, real-time regex highlighting (IPs, errors, URLs, keywords), snippet bar, session hierarchy, local/remote/dynamic SSH tunnels, OSC 133 semantic prompt detection.
* Community backlash & demise: Advertised Apache-2.0 license but kept terminal engine & networking backend closed-source binary blobs ("gradual open-sourcing" was never fulfilled). Single maintainer bottleneck. Updates ceased/stalled (>1 year silence). Over 3,000 issues left unattended. Enterprise & security users abandoned due to proprietary binary handling of SSH keys, passwords, and root credentials.

### 2. PUTTY WRAPPER ARCHITECTURE SELECTION
* Win32 HWND Reparenting (`SetParent` API) Rejected:
  - Fails on Linux/macOS. Win32 repaint and focus-stealing bugs. Black box window prevents terminal DOM access, making Free Type Mode, custom regex highlighting, and inline triggers technically impossible.
* PuTTY Compatibility Subsystem + Modern Terminal Engine Selected:
  - Frontend: TypeScript + xterm.js + WebGL addon + Canvas. Full access to viewport buffer enables Free Type Mode, on-the-fly regex syntax tokenization, and multi-session sync input.
  - PuTTY Integration Layer:
    * Session Registry: Parse Windows Registry (`HKCU\Software\SimonTatham\PuTTY\Sessions`) and portable `.reg`/`.session` files.
    * Key Engine: Native `.ppk` v2/v3 parser, decryptor, and OpenSSH/PuTTY cross-conversion.
    * Agent Bridge: Named pipe IPC to PuTTY Pageant on Windows, Unix domain socket for SSH agent on Linux/macOS.
    * Backend Runner: Dual-mode connection executor — (a) Native SSH2 engine with PPK/Pageant auth, or (b) PTY-wrapped `plink.exe` / `psftp.exe` / `pscp.exe` process execution.
    * File Transfer: Embedded SFTP client mirroring WindTerm's dual-pane layout with transfer progress queue.

### 3. MANDATORY DIRECTIVES & GOVERNANCE
* User Global Rules:
  - `GEMINI.md` in root with project description, dense `past_memory.md`, and instructions to always update `README.md` and `scaffold.md` with implementation plan.
  - All documentation and architectural proposals housed in root and `windterm/` directory.

### 4. KEY DELIVERABLES (DOCS & PROPOSALS)
* `GEMINI.md`: Governance and project definition.
* `past_memory.md`: This dense memory ledger.
* `README.md`: Master project guide, feature comparison matrix, installation and vision.
* `scaffold.md`: Component layout, module boundaries, and file directory tree.
* `windterm/PROPOSAL.md`: Deep technical proposal for the PuTTY wrapper and feature replication.
* `windterm/WINDTERM_ANALYSIS.md`: Exhaustive dissection of WindTerm, GitHub issue metrics, and community feature requests.
* `windterm/PUTTY_WRAPPER_SPEC.md`: Low-level protocol and interface specification for PuTTY session importing, PPK parsing, Pageant IPC, and Plink piping.
* `windterm/FEATURE_MATRIX.md`: Side-by-side feature comparison table and implementation strategy.
