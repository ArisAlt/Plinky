# ADR-002: PuTTY Discovery, Minimum Version Enforcement & No Bundling

## Status
**Accepted** (Owner decision, 2026-09-20)

## Deciders
- Project Owner
- Antigravity (Gemini 3.8 Flash High)
- Claude Sonnet 5 (Architecture Review)

---

## Context
Plinky relies on installed PuTTY binaries (`plink`, `psftp`, `pscp`, `puttygen`, `pageant`) to execute connections.
We must decide how PuTTY is discovered, whether PuTTY binaries should be bundled inside Plinky installers, and how minimum version compatibility is enforced.

---

## Options Considered

* **Option A: Bundle PuTTY binaries with Plinky**
  * *Pros*: Out-of-the-box experience on clean Windows machines.
  * *Cons*: Requires Plinky maintainers to build, sign, and distribute third-party PuTTY binaries for every platform; obligates Plinky to issue emergency releases whenever PuTTY patches upstream CVEs (e.g. CVE-2024-31497); creates licensing and code-signing friction.

* **Option B: Require system PuTTY installation with auto-discovery & version check (Selected)**
  * *Pros*: Zero bundling liability; users get upstream PuTTY security patches automatically via system package managers (apt, pacman, winget, chocolatey); completely transparent.
  * *Cons*: User must have PuTTY installed, or specify custom path.

---

## Decision
**Adopt Option B (Detect installed PuTTY; do NOT bundle in v1).**

### Discovery Rules:
1. **Linux**: Probe `PATH`, `/usr/bin`, `/usr/local/bin`.
2. **Windows**: Probe `C:\Program Files\PuTTY`, `C:\Program Files (x86)\PuTTY`, and `PATH`.
3. **User Override**: Allow configuring an explicit PuTTY toolchain directory in Plinky Settings.

### Minimum Version Floor:
* **Minimum Supported Version**: **PuTTY 0.75+**.
  * Rationale: `.ppk` v3 key format (Argon2id KDF) was introduced in PuTTY 0.75. Versions older than 0.75 cannot parse modern PPK v3 keys.
* If a detected PuTTY binary is `< 0.75`, Plinky refuses to launch sessions and presents a clear error dialog with upgrade instructions.
* The detected PuTTY version (e.g. `PuTTY Release 0.85`) is logged in Plinky diagnostic telemetry and system status bar.

### Platform Target Scope:
* **Linux and Windows are Tier 1**. macOS is explicitly placed on hold for v1 (no documentation or scaffolding effort allocated to macOS).
* Verification uses local Linux workstation (CachyOS) and the owner's Windows machine, supported by GitHub Actions CI for both OSes.
