# WindTerm Research, Proposal & Specification Suite

This directory contains the in-depth architectural breakdown of **WindTerm** (`kingToolbox/WindTerm`), the analysis of its community requests and abandonment issues, the technical specifications for building an open-source **PuTTY Wrapper**, and the implementation designs for reproducing and improving upon WindTerm's key capabilities.

---

## Documents in this Directory

1. **[WINDTERM_ANALYSIS.md](file:///home/citizenzero/Dev/WinPutty/windterm/WINDTERM_ANALYSIS.md)**
   * Autopsy of `kingToolbox/WindTerm`: why it took the community by storm, why it stalled, the "partial open source" controversy, and the top issues and unfulfilled pull requests on GitHub.

2. **[PROPOSAL.md](file:///home/citizenzero/Dev/WinPutty/windterm/PROPOSAL.md)**
   * The complete technical proposal for **Plinky**: the PuTTY-powered successor (named after `plink`) combining PuTTY's rock-solid protocols with WindTerm's IDE-style features (Free Type Mode, Sync Input, SFTP Pane, Regex Markers).

3. **[PUTTY_WRAPPER_SPEC.md](file:///home/citizenzero/Dev/WinPutty/windterm/PUTTY_WRAPPER_SPEC.md)**
   * Low-level architectural specification for the PuTTY wrapper engine:
     * Reading/writing Linux `~/.putty/sessions/` files and Windows PuTTY Registry (`HKCU\Software\SimonTatham\PuTTY\Sessions`).
     * Parsing and decrypting `.ppk` (v2 and v3) private keys.
     * Connecting to Linux Unix Domain Socket agent (`$SSH_AUTH_SOCK`) and Windows Pageant.
     * Wrapping `/usr/bin/plink`, `psftp`, and serial devices (`/dev/ttyUSB*`).

4. **[FEATURE_MATRIX.md](file:///home/citizenzero/Dev/WinPutty/windterm/FEATURE_MATRIX.md)**
   * Feature-by-feature breakdown comparing WindTerm, PuTTY, and Plinky, including concrete implementation mechanisms for every signature WindTerm feature.
