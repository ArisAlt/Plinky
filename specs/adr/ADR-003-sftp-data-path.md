# ADR-003: SFTP Data Path — How Plinky Talks SFTP Over a Shared Connection

**Status:** Accepted (Owner decision, 2026-09-22 — Option B)
**Date:** 2026-09-22
**Deciders:** Project Owner (final call); Antigravity (implementer); Claude (author, architecture)

---

## Context

ADR-001 committed Plinky to `plink` as the *only* SSH transport in v1, with `russh`/`ssh2` deferred unless a spike proves a gap. `specs/wrapper/DEEP_DESIGN.md` §5 and `PUTTY_WRAPPER_SPEC.md` §4.5 built the SFTP design on top of that: the terminal's `plink -share` becomes the **connection owner**, and `psftp -share` attaches as a **sharer** to reuse the same authenticated connection — no second handshake, no second host-key or credential prompt.

That assumption has now failed a real test. On 2026-09-22 Claude ran `psftp -share` against a throwaway, unprivileged, localhost `sshd` (the same fixture used for the S2/S3 spikes), with a `plink -share` owner already connected:

- `psftp -share` **does** reuse the connection correctly — identical to a `plink` sharer: `Using existing shared connection at <path>/socket` / `Reusing a shared connection to this server.`
- It then goes **completely silent**. No `psftp>` prompt, no `Connected to <host>`, no error — on either side (the owner's own `-v` output shows zero mention of the sharer's channel request). Reproduced twice, waited up to 15s, the process stays alive but never reaches a usable state.
- Plain `psftp` (no `-share`) against the same server works instantly and correctly — full `ls -l`-style output format received byte for byte.

Root cause is **not diagnosed**. It could be a PuTTY 0.85 bug specific to psftp+connection-sharing, a flag-ordering issue, something about this `sshd`'s `internal-sftp` subsystem, or something else entirely. What's established is that it's reproducible and silent, not a one-off timing fluke.

This is exactly the kind of evidence ADR-001 said would justify revisiting the plink-only decision — but only for the SFTP path, not the terminal path (the terminal path has no such finding against it; D8/D9/S2/S3 all confirm `plink` works as designed there).

## Decision

**Option B, accepted by the owner.** SFTP does not use `-share`. Each SFTP pane opens its own plain `psftp` connection against the session (host key already cached per D2, so silent; auth via agent or key, also silent). This keeps ADR-001's plink-only boundary fully intact and matches the transport that is actually proven to work.

## Options Considered

### Option A: Diagnose and fix the `psftp -share` hang, keep the design as-is
Spend real investigation time (not a spot-check): try `psftp -share` against a second `sshd` config (`Subsystem sftp /usr/lib/openssh/sftp-server` instead of `internal-sftp`, in case that's a factor), check PuTTY's bug tracker/changelog for known connection-sharing + psftp issues, try older/newer flag orderings, and see if it's version-specific (only 0.85 was tested).

| Dimension | Assessment |
|---|---|
| Complexity | Unknown — could be a one-line flag fix or an unfixable upstream bug |
| Cost | A few hours of investigation, paid once, with no guarantee of success |
| Scalability | N/A |
| Team familiarity | Low — nobody on this project has debugged PuTTY's connection-sharing internals before |

**Pros:** if it works, this is the cheapest, most-PuTTY-faithful design — zero new protocol code, SFTP pane opens with no extra auth prompt.
**Cons:** open-ended time sink chasing a third-party binary's undocumented behavior; ADR-002 already commits to *not* patching or forking PuTTY, so a genuine upstream bug is not fixable by Plinky at all, only reportable.

### Option B: SFTP does not share the connection — `psftp` opens its own connection
Drop `-share` for the SFTP path specifically. The SFTP pane spawns a plain `psftp` (as verified working) against the same session. It goes through its own host-key check (already cached, so silent — no new prompt, per D2's read-only host-key store) and its own auth (agent or key, also silent if non-interactive).

| Dimension | Assessment |
|---|---|
| Complexity | Low — this is the transport that already, demonstrably works today |
| Cost | One extra TCP handshake + SSH auth round-trip (milliseconds on a LAN, more on a slow WAN link) each time the SFTP pane opens |
| Scalability | Fine — SFTP panes are opened rarely relative to keystrokes |
| Team familiarity | High — same `Transport`-trait shape as the terminal path, no new concept |

**Pros:** works today, verified; no dependency on a mystery bug being fixed; keeps ADR-001 (plink-only) fully intact; simplest to implement and test.
**Cons:** loses the "-share" pitch's efficiency argument (though the cost is small); a second `PreAuth` state machine instance now exists per SFTP pane (already designed for terminals, so this is reuse, not new work) — but it also means D3's interceptor logic has to run for SFTP opens too, which DEEP_DESIGN.md didn't explicitly say applied there before.

### Option C: The owning `plink -share` process speaks SFTP itself (no separate `psftp`)
Have the Rust core ask the *owner* process to open an `sftp` subsystem channel directly, multiplexed inside the single `plink -share` process Plinky already controls, and implement the client side of the SFTP wire protocol (SSH_FXP_* messages) in Rust against that channel.

| Dimension | Assessment |
|---|---|
| Complexity | High — this is writing an SFTP client from the wire protocol up, in Rust, even though ADR-001 avoided exactly this class of work for the SSH layer itself |
| Cost | Real implementation and testing effort; a new fuzz/test surface (SFTP is a binary protocol with its own edge cases) |
| Scalability | Best of the three at scale — no subprocess per SFTP pane, no re-auth cost ever |
| Team familiarity | Low — nobody has built this; would likely pull in `russh-sftp` or hand-roll, which edges back toward the `russh` dependency ADR-001 deferred |

**Pros:** truly instant SFTP open, no re-auth, no subprocess management for SFTP; the cleanest architecture on paper.
**Cons:** directly undercuts ADR-001's rationale (minimize non-PuTTY code in the trust path) by putting hand-written protocol code exactly where ADR-001 tried to avoid it; largest v1 scope increase of the three options; `plink` itself doesn't expose "let another process ride my channel" as a supported interface — this would mean either patching plink's invocation model or building a private control channel to it, neither of which is in scope today.

## Trade-off Analysis

Option A is a time-boxed gamble against a third-party binary Plinky has already committed (ADR-002) not to patch — if it's a genuine PuTTY bug, no amount of Plinky-side effort fixes it, and the project has no channel to get it fixed upstream on this timeline. Option C reopens exactly the question ADR-001 settled (own crypto/protocol vs. lean on PuTTY) for a net-new, harder protocol (SFTP has more message types than the terminal channel), which is a lot to take on to save one handshake per SFTP-pane-open.

Option B is the only one that is *proven* to work right now, costs a genuinely small amount (one auth round-trip, not visible to the user beyond a slightly slower open), and changes nothing about ADR-001's boundary. It does mean writing down explicitly that D3's PreAuth state machine covers SFTP opens too — that's a real, small addition to DEEP_DESIGN.md, not a hidden gap, since a hostile server's host-key/auth surface exists for a psftp connection exactly as much as a terminal one.

## Consequences

- **Easier:** `crates/plinky-core`'s SFTP module can be scaffolded now, against a `Transport`-shaped interface identical to the terminal one, no dependency on Option A's outcome.
- **Harder:** the "-share" efficiency story is weaker than originally pitched — worth being honest about in any user-facing docs, since `PUTTY_WRAPPER_SPEC.md` §4.5 currently overstates it.
- **To revisit:** if Option A's investigation ever happens and finds a real fix (e.g., a flag or version bump), switching from B to the original shared design is a contained change — one module, not an architecture rewrite. Worth keeping Option A as a tracked follow-up issue rather than closing the door on it.

## Action Items
1. [x] Owner accepted Option B, 2026-09-22.
2. [x] Land `specs/adr/ADR-003-sftp-data-path.md`.
3. [ ] Update `specs/wrapper/DEEP_DESIGN.md` §5 and `PUTTY_WRAPPER_SPEC.md` §4.5 to match: SFTP opens its own plain `psftp` connection, not `-share`.
4. [ ] Add PreAuth-state-machine-applies-to-SFTP note explicitly.
5. [ ] Track Option-A investigation (diagnosing the `psftp -share` hang) as a non-blocking follow-up.
6. [ ] Scaffold `crates/plinky-core` SFTP module against Option B (plain psftp per pane).
