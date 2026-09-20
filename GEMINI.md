# GEMINI.md - Project Overview & AI Operational Guidelines

## Project Description
**WinPutty (WindPutty / OpenWind)** is an open-source, modern terminal emulator and session manager designed to serve as a high-powered wrapper and successor to **PuTTY**, embedding the beloved IDE-like features of **WindTerm** (kingToolbox/WindTerm) while resolving WindTerm's critical shortcomings (abandoned/slow updates, proprietary closed-source core, security transparency concerns).

It combines the rock-solid reliability, profile compatibility, and credential protocols of PuTTY/Pageant with the advanced productivity features of WindTerm:
- **Free Type Mode**: Arbitrary cursor placement and text editing directly in the terminal canvas.
- **Sync Input (Broadcast Channels)**: Multi-session simultaneous command execution across server clusters.
- **Integrated Graphical SFTP**: Dual-pane file manager with background transfers, drag-and-drop, and directory following.
- **Regex Syntax Highlighters & Triggers**: Real-time coloring of IPs, logs, errors, and automated response hooks.
- **Visual SSH Tunneling & Port Forwarding**: Local, Remote, and Dynamic SOCKS5 GUI management.
- **PuTTY Ecosystem Native**: Full reading/writing of PuTTY registry and file sessions, `.ppk` (v2/v3) private keys, and Pageant agent forwarding.

---

## Memory Governance & Dense Past Memory
- For maintaining continuous context across interactions, consult and update `past_memory.md` located in the root directory.
- `past_memory.md` preserves dense, high-signal records of architectural decisions, research findings, user directives, technical tradeoffs, and evolutionary state.
- Keep the format of `past_memory.md` **dense**, structured, and token-efficient.

---

## Documentation Protocol
- **Always use and update `README.md`**: Reflect the current state, capabilities, installation/usage instructions, and feature roadmap of the project.
- **Always use and update `scaffold.md`**: Maintain an accurate, up-to-date map of directory structure, module responsibilities, and planned components.
- **Always use an implementation plan**: Any non-trivial modification, architectural extension, or implementation phase must follow a structured plan before execution.
