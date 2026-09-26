# Technical Specifications, Proposal & Architecture Suite

This directory contains the in-depth architectural breakdown, community feature analysis, technical specifications for building the open-source **PuTTY Wrapper**, and the implementation designs for **Plinky**.

---

## Documents in this Directory

1. **[WINDTERM_ANALYSIS.md](specs/WINDTERM_ANALYSIS.md)**
   * Autopsy of `kingToolbox/WindTerm`: why it took the community by storm, why it stalled, the "partial open source" controversy, and the top issues and unfulfilled pull requests on GitHub.

2. **[PROPOSAL.md](specs/PROPOSAL.md)**
   * The complete technical proposal for **Plinky**: the PuTTY-powered successor (named after `plink`) combining PuTTY's rock-solid protocols with WindTerm's IDE-style features (Free Type Mode, Sync Input, SFTP Pane, Regex Markers).

3. **[PUTTY_WRAPPER_SPEC.md](specs/PUTTY_WRAPPER_SPEC.md)**
   * Low-level architectural specification for the PuTTY wrapper engine:
     * Reading/writing Linux `~/.putty/sessions/` files and Windows PuTTY Registry (`HKCU\Software\SimonTatham\PuTTY\Sessions`).
     * Parsing and decrypting `.ppk` (v2 and v3) private keys.
     * Connecting to Linux Unix Domain Socket agent (`$SSH_AUTH_SOCK`) and Windows Pageant.
     * Wrapping `/usr/bin/plink`, `psftp`, and serial devices (`/dev/ttyUSB*`).

4. **[FEATURE_MATRIX.md](specs/FEATURE_MATRIX.md)**
   * Feature-by-feature breakdown comparing WindTerm, PuTTY, and Plinky, including concrete implementation mechanisms for every signature WindTerm feature.

5. **[adr/ (Architecture Decision Records)](specs/adr/)**
   * Formal Architectural Decision Records:
     * **[ADR-001](specs/adr/ADR-001-primary-ssh-transport.md)**: Primary SSH Transport Architecture (`plink` only in v1, `russh` deferred behind spikes).
     * **[ADR-002](specs/adr/ADR-002-putty-discovery-and-versioning.md)**: PuTTY Discovery, Version Floor (0.75+), and No Bundling.

6. **[ARCHITECTURE_REVIEW_2026-09-26.md](ARCHITECTURE_REVIEW_2026-09-26.md)**
   * Architecture review of v0.1.3 against SYSTEM_DESIGN: nine findings (vault secret not bound to its session, Windows console flashes, one SSH login per SFTP operation, Plinky fields in PuTTY files, localStorage persistence, PuTTY discovery) and a phased plan P0–P7 for Linux + Windows. macOS on hold.
