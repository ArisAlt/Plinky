[PROJECT]: Plinky (PuTTY Modern Wrapper & IDE-grade Terminal Emulator, named after 'plink')
[ROOT]: /home/citizenzero/Dev/Plinky
[WORKSPACE_ALT]: /home/citizenzero/Documents/antigravity/modest-darwin
[DATE_INIT]: 2026-09-20
[STATUS]: Scaffolding & Specifications Complete; Name Finalized as Plinky

### 1. WINDTERM FORENSIC ANALYSIS & FAILURE REASONS
* Target: kingToolbox/WindTerm (C++/Qt terminal emulator).
* Core strengths: Free Type Mode (mouse click cursor placement & canvas edit), Sync Input (up to 4 broadcast channels), integrated SFTP file manager with drag & drop, real-time regex highlighting (IPs, errors, URLs, keywords), snippet bar, session hierarchy, local/remote/dynamic SSH tunnels, OSC 133 semantic prompt detection.
* Community backlash & demise: Advertised Apache-2.0 license but kept terminal engine & networking backend closed-source binary blobs ("gradual open-sourcing" was never fulfilled). Single maintainer bottleneck. Updates ceased/stalled (>1 year silence). Over 3,000 issues left unattended. Enterprise & security users abandoned due to proprietary binary handling of SSH keys, passwords, and root credentials.

### 2. PUTTY LINUX & WINDOWS ARCHITECTURE
* Linux Host Environment Verified:
  - System has full PuTTY 0.85 suite installed: `/usr/bin/putty`, `/usr/bin/plink`, `/usr/bin/pscp`, `/usr/bin/psftp`, `/usr/bin/puttygen`, `/usr/bin/pageant`.
  - Local sessions verified at `~/.putty/sessions/`: `10.10.10.10%20`, `COM%20USB0`, `Default%20Settings`.
  - Session format: Plaintext key-value pairs (`HostName=`, `PortNumber=`, `SerialLine=`, `PublicKeyFile=`), percent-encoded filenames.
  - SSH Host keys: `~/.putty/sshhostkeys`.
  - Agent protocol: Native Unix Domain Socket `$SSH_AUTH_SOCK` (standard on Linux).
  - Serial protocol: Linux character devices (`/dev/ttyUSB0`, `/dev/ttyACM0`).
* Windows Compatibility:
  - Registry storage under `HKCU\Software\SimonTatham\PuTTY\Sessions`.
  - Named Pipe IPC `\\.\pipe\pageant.*` and Win32 `WM_COPYDATA`.
* Selected Architecture:
  - Unified Session Provider: platform-aware, bi-directionally syncs `~/.putty/sessions/` on Linux and Registry on Windows.
  - Frontend: TypeScript + xterm.js + WebGL. Full buffer access for Free Type Mode, 4-channel sync input, and live regex markers.
  - Subprocess engine: Auto-wraps `/usr/bin/plink` or native SSH2.
* Naming Resolution:
  - Selected name: **Plinky** (homage to `/usr/bin/plink`; friendly, memorable, cross-platform, eliminating the "Win" Windows-only connotation).

### 3. MANDATORY DIRECTIVES & GOVERNANCE
* User Global Rules:
  - `GEMINI.md` in root with project description, dense `past_memory.md`, and instructions to always update `README.md` and `scaffold.md` with implementation plan.
  - All documentation and architectural proposals housed in root and `specs/` directory.

### 4. KEY DELIVERABLES (DOCS & PROPOSALS)
* `GEMINI.md`: Governance and project definition.
* `past_memory.md`: This dense memory ledger.
* `README.md`: Master project guide, feature comparison matrix, installation and vision.
* `scaffold.md`: Component layout, module boundaries, and file directory tree.
* `specs/PROPOSAL.md`: Deep technical proposal for the PuTTY wrapper and feature replication.
* `specs/WINDTERM_ANALYSIS.md`: Exhaustive dissection of WindTerm, GitHub issue metrics, and community feature requests.
* `specs/PUTTY_WRAPPER_SPEC.md`: Low-level protocol and interface specification for PuTTY session importing, PPK parsing, Pageant IPC, and Plink piping.
* `specs/FEATURE_MATRIX.md`: Side-by-side feature comparison table and implementation strategy.
