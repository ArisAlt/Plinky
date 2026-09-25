# ADR-005: Native Serial Transport

## Status
**Accepted** (Owner decision, 2026-09-25)

## Deciders
- Project Owner
- Claude (backend)

---

## Context
Network engineers need serial console sessions (switch/router console ports, USB-serial adapters), including **Send Break** — required for Cisco ROMMON password recovery and similar vendor procedures.

ADR-001 made `plink` the only transport in v1. That decision was about SSH: not re-implementing SSH cryptography, keeping PuTTY's audited stack and its host-key store as the single source of truth.

Serial sessions don't fit that reasoning, and `plink` falls short for them:
1. **No Break.** `plink` 0.85 has no special-command or break interface (`plink --help`; no stdin escape). A serial Break cannot be sent through it at all.
2. **Nothing security-relevant to preserve.** A serial line has no cryptography, no host keys, no authentication handshake — none of the ADR-001 concerns apply.
3. **Workarounds are platform-specific.** Sending a break on Linux via a second handle to the device (`tcsendbreak`) works only where the device isn't opened exclusively; on Windows the COM port is exclusive, so it's impossible while `plink` holds it.

---

## Options Considered

* **Option A: plink for serial, no Break**
  * *Pros*: No new code or dependency.
  * *Cons*: Leaves out a core network-engineer workflow.

* **Option B: plink for serial + Linux-only Break via a second device handle**
  * *Pros*: No new dependency.
  * *Cons*: No Break on Windows; depends on plink not locking the device; fragile.

* **Option C: Native serial transport for serial sessions only (Selected)**
  * *Pros*: Break on Linux and Windows; direct control of line settings; no subprocess.
  * *Cons*: One new dependency (`serialport`, MPL-2.0 — already allowed by `deny.toml`); a second transport to maintain (small: no protocol logic).

---

## Decision
**Adopt Option C.**

- Saved sessions with `Protocol=serial` are opened by a native `SerialTransport` (`serialport` crate) instead of `plink`. SSH, Telnet, Raw and Rlogin stay on `plink` exactly as in ADR-001.
- Line settings are still read from the **PuTTY session file**, using PuTTY's own keys, so the same session opens identically in real PuTTY:
  `SerialLine`, `SerialSpeed`, `SerialDataBits`, `SerialStopHalfbits`, `SerialParity`, `SerialFlowControl`.
- Values the native driver can't reproduce faithfully (mark/space parity, 1.5 stop bits, DSR/DTR flow control) are **refused with a clear error**, never silently approximated.
- Serial sessions start Live (no pre-auth phase — same reasoning as the non-SSH `plink` fix in `b561c4f`).

---

## Consequences
- New Tauri command `send_break(session_id)`; returns an error for transports that can't send one.
- Serial is testable without hardware on Linux via a pseudo-terminal pair; Break itself still needs a real adapter to verify end to end.
- If a future `plink` gains a special-command interface, this can be revisited; nothing else depends on the native transport.
