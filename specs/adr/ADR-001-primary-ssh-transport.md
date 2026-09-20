# ADR-001: Primary SSH Transport Architecture

## Status
**Accepted** (Owner decision, 2026-09-20)

## Deciders
- Project Owner
- Antigravity (Gemini 3.8 Flash High)
- Claude Sonnet 5 (Architecture Review)

---

## Context
Plinky's core value proposition is combining PuTTY's 25-year audited cryptographic security, session configuration (`-load`), and Pageant integration with a modern IDE-grade terminal UI (Free Type, 4-channel sync broadcast, integrated SFTP).

Earlier drafts proposed a hybrid dual-engine architecture (`plink` under `portable-pty` primary, with `russh` as an in-process fallback). However, maintaining two separate SSH implementations:
1. Doubles the security audit surface and negates the core trust pitch (PuTTY's audit history does not apply to `russh`).
2. Creates split host-key verification paths (PuTTY `sshhostkeys` vs `russh` known_hosts).
3. Adds maintenance overhead for handling diverging feature support.

---

## Options Considered

* **Option A: plink primary + russh fallback**
  * *Pros*: Enables in-process dynamic runtime port forwarding (-L/-R/-D add/remove without restarting session).
  * *Cons*: High complexity, two cryptographic stacks, double the attack surface, dual host-key verification paths.

* **Option B: russh only**
  * *Pros*: Pure Rust, in-process control.
  * *Cons*: Destroys PuTTY fidelity (cannot natively honour `-load`, PuTTY registry sessions, proxy chains, or PuTTY bug workarounds). Abandons the project's primary reason to exist.

* **Option C: plink only for v1; russh deferred behind empirical spike results (Selected)**
  * *Pros*: Minimal attack surface, 100% PuTTY fidelity bug-for-bug, single host-key store (`~/.putty/sshhostkeys`), simpler dependency graph.
  * *Cons*: Relies on terminal PTY text prompts for authentication/TOFU; runtime dynamic tunnel reconfiguration is limited until proven via spikes.

---

## Decision
**Adopt Option C (`plink` only in v1).**
`russh` is removed from the active v1 dependencies and deferred behind written Phase 0 spike results (S3 and S4).

---

## Consequences

### Positive:
- **Single Trust Model**: All SSH crypto, host-key handling, and agent forwarding remain 100% inside PuTTY's audited code.
- **Unified Host Key Storage**: Only `PUTTYDIR`/`~/.putty/sshhostkeys` is used; zero sync issues between dual stores.
- **Streamlined Dependencies**: Strips complex Rust SSH stack dependencies from the v1 core.

### Constraints & Invariants:
- **Strict TOFU State Machine**: Because host-key verification runs via `plink`, Plinky must enforce an explicit pre-authentication state machine (`Connecting` $\rightarrow$ `AwaitingHostKeyDecision` $\rightarrow$ `Authenticated`). The TOFU prompt interceptor is armed exclusively before login and disarmed immediately upon authentication. Remote in-session output can never trigger a host-key dialog.
- **Fail-Closed Alternative**: Alternatively, `plink -batch` runs first to fail closed on unverified keys, extracts the fingerprint from stderr, prompts the user via a native GUI dialog, and re-launches with `-hostkey <fingerprint>`.
- **Prohibit `-pw`**: Plinky strictly prohibits passing passwords via command-line flags (`plink -pw`) to prevent exposure in process listings (`ps aux`, `/proc`).
- **Spike Gates (S3 & S4)**: Before finalizing Phase 5, Phase 0 spikes must verify:
  1. Can `plink -share` downstream carry `-R` (remote) forwards?
  2. Is parsing `psftp` batch output robust against spaces, newlines, unicode, and symlinks?
