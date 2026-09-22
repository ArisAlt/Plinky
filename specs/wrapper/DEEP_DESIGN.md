# Plinky: the PuTTY-wrapper subsystem — deep design

Author: Claude (Critic/Architect). Date: 2026-09-22. Complements `specs/SYSTEM_DESIGN.md` (D1–D7, M0–M7); this document goes one level deeper on the part that carries the trust pitch: the `plink` process wrapper (`crates/plinky-core::transport::plink`), its pre-auth state machine, and `crates/putty-compat`. It does not repeat what SYSTEM_DESIGN.md already covers (IPC contract, ring buffer, milestones).

**Evidence basis.** Sections marked `[VERIFIED]` come from actually running `plink 0.85` (the version on this machine) through a real PTY against a throwaway, unprivileged, localhost-only `sshd` fixture (pubkey auth, ephemeral ed25519 host key, ephemeral user key). No system files, no new users, no root. Torn down after capture; nothing left running. This is a spot-check, not the full Phase 0 spike matrix in SYSTEM_DESIGN.md §6 (M0) — it directly closes one open question and narrows two others, but S1–S4 still need to run for real, on both OSes, before M0 is called done.

---

## 1. Requirements specific to this subsystem

- **R1** Never put a secret in argv (`ps`, `/proc/<pid>/cmdline` are both world-readable).
- **R2** A hostile remote host must not be able to trigger a credential fill or a trust decision once the session is live. `[VERIFIED]` the attack surface is real: plink interleaves diagnostic text and remote-controlled text on the *same* PTY stream with no framing.
- **R3** The wrapper must work whether the user authenticates by agent, by `.ppk` key, or (deferred, D1) never by password typed into Plinky — v1 does not auto-fill passwords at all, since D1 deferred the vault-bound auto-fill's key infrastructure. Re-scope from SYSTEM_DESIGN.md D3: **v1's PreAuth state machine handles HostKeyPending only.** PasswordPending/PassphrasePending are display-only (show the prompt, let the user type into the terminal) until a later milestone, because auto-fill needs the vault and D1 deferred the crypto dependencies vault would share. This is a real simplification, not a deferral of security — it removes the highest-risk piece of D3 (auto-filling a credential based on parsed text) from v1 entirely.
- **R4** `putty-compat` v1 scope per D1: session store read/write, `.ppk` **header** parsing only, host-key **listing** only. No decryption, no agent client, no host-key writer.

---

## 2. plink invocation: what actually works `[VERIFIED]`

**Finding 1 — plink cannot use an OpenSSH-format private key.** Tried a standard `ssh-keygen -t ed25519` key with `-i`:
```
Reading key file ".../userkey"
Unable to use this key file (OpenSSH SSH-2 private key (new format))
FATAL ERROR: No supported authentication methods available (server sent: publickey)
```
This means **`putty-compat` must be able to at least detect "this is not a `.ppk`"** and Plinky must either (a) only ever offer `.ppk` files in the key picker, filtering by header (`PuTTY-User-Key-File-2:` / `-3:`), or (b) shell out to `puttygen -O private -o out.ppk in.key` to convert on import. (b) is a nicer UX and stays inside "detect PuTTY, don't reimplement it" (ADR-002) — `puttygen` is already a required binary. **Add to scaffold:** an explicit "import OpenSSH key" flow that calls `puttygen`, not a silent expectation that users already have `.ppk` files.

**Finding 2 — the exact unknown-host-key prompt, verbatim, PuTTY 0.85:**
```
The host key is not cached for this server:
  <host> (port <port>)
You have no guarantee that the server is the computer you
think it is.
The server's ssh-ed25519 key fingerprint is:
  ssh-ed25519 255 SHA256:<...>
If you trust this host, enter "y" to add the key to Plink's
cache and carry on connecting.
If you want to carry on connecting just once, without adding
the key to the cache, enter "n".
If you do not trust this host, press Return to abandon the
connection.
Store key in cache? (y/n, Return cancels connection, i for more info) 
```
This confirms D3/PUTTY_WRAPPER_SPEC §1.2's claim empirically, closes it from "documented" to "measured", and gives the exact bytes for the interceptor's match table (needed verbatim, not paraphrased, since a hostile server's banner text must never accidentally match it).

**Finding 3 — `-batch` on an unknown host key fails loudly and safely**, which is the correct default for any *unattended* reconnect (SYSTEM_DESIGN.md's auto-reconnect):
```
Connection abandoned.
Cannot confirm a host key in batch mode
FATAL ERROR: Cannot confirm a host key in batch mode
```
**Design decision D8: Plinky always launches plink WITHOUT `-batch`**, and drives the prompt itself via the PreAuth state machine below. `-batch` is reserved for a specific "verify unattended" pre-flight check (e.g. auto-reconnect only proceeds if the host key is *already* cached — checked with `-batch` first, so an auto-reconnect can never itself become a trust decision. This directly implements SYSTEM_DESIGN.md §4.3's "never auto-reconnect after a host-key mismatch": with D8, an auto-reconnect against a since-changed host key gets `-batch`'s hard failure, not a live prompt for something that ran without the user watching.

**Finding 4 — the PreAuth→Live boundary marker exists and is stable.** SYSTEM_DESIGN.md open question #1 said *"plink prints no explicit 'authenticated' marker"*. That's wrong — measured across four scenarios (interactive shell, single command, `-batch`+cached-key, verbose `-v`):

| Scenario | Exact bytes observed right after auth succeeds |
|---|---|
| Interactive shell, host key cached, non-verbose | `Access granted. Press Return to begin session. \r\n` then shell escape sequences |
| Single remote command, non-verbose | `Access granted. Press Return to begin session. ` then command output |
| `-v`, any mode | `...Sent public key signature\r\nAccess granted\r\n` then (non-batch) the same "Press Return" line, or (`-batch`) straight to `Opening main session channel` |

**Design decision D9 (resolves open question #1):** the state machine transitions `PreAuth → Live` on the exact byte sequence `Access granted` appearing in the stream (present in every mode tested, verbose or not, batch or not — the trailing "Press Return..." varies by mode so match on the shorter, invariant substring). This is diagnostic text plink itself emits, not something the remote host controls, so it is safe to trust as a boundary — **but it must never be treated as authorization for anything except "stop arming PreAuth interceptors"**: it is not itself a place to answer a prompt, and once observed, no further byte in the stream is ever inspected by the state machine again for this session (this is what makes D3's "disarmed in Live" property real rather than aspirational).
Two things this spot-check did **not** cover and S2 must: (a) password/keyboard-interactive auth (I only tested pubkey, since PAM setup was out of scope for an unprivileged fixture) — likely the same marker, but unverified; (b) whether `Access granted` can appear as part of a numbered/localized server banner on some OpenSSH configurations (low risk — it's plink's own string, not relayed from the server — but confirm against a couple of real `sshd` configs, and specifically confirm it's never present in the pre-auth banner text since that IS attacker-controlled).

**Finding 5 — the on-disk `sshhostkeys` line format, byte for byte** `[VERIFIED]`, differs from what `PUTTY_WRAPPER_SPEC.md` §1.2 shows as an example:
```
ssh-ed25519@12222:127.0.0.1 0x<pub-exponent-or-point-hex>,0x<pub-modulus-or-y-hex>
```
Matches the spec's *format description* (`<key-type>@<port>:<hostname> <key-data-hex>`), confirming `putty-compat::hostkeys` can parse it as documented. Good — no change needed there, just now backed by a real sample instead of a hand-typed one.

---

## 3. The pre-auth state machine, concretely

Building on SYSTEM_DESIGN.md D3's state names, with D8/D9 folded in and R3's v1 narrowing applied:

```
Created -> Spawning -> PreAuth{HostKeyPending} -> Live -> Closing -> Closed{Ok|AuthFailed|HostKeyRejected|Error}
                  \-> PreAuth{PasswordPrompted}  (display-only in v1: shown to the user, typed by the
                                                   user directly into the PTY; the state machine does
                                                   not parse or answer it, only tracks "a prompt is
                                                   showing" for the UI to react to — e.g. don't broadcast
                                                   sync-input keystrokes into a password field, D6)
```

Interceptor table (v1, exact match, case-sensitive, on assembled PTY output not per-`read()` chunks — plink's writes are not prompt-aligned):

| Match (regex on the byte stream, anchored to interceptor state) | Action | Only armed in |
|---|---|---|
| `Store key in cache\? \(y/n, Return cancels connection, i for more info\) $` | Hold. Surface fingerprint + host to a native dialog. Write `y\r`, `n\r`, or nothing (Return / cancel) once, from the dialog's answer. | `HostKeyPending` |
| `FATAL ERROR: Cannot confirm a host key in batch mode` | `Closed{HostKeyRejected}` (only reachable via D8's `-batch` pre-flight, never in the normal launch) | `HostKeyPending` |
| `Access granted` | `PreAuth -> Live`. Destroy all interceptors for this session (D9). | any `PreAuth` substate |
| `FATAL ERROR:` (anything else) / process exit before `Access granted` | `Closed{AuthFailed}` or `Closed{Error}`, message = last FATAL line | any `PreAuth` substate |
| *(no match)* | Buffer capped (e.g. 8 KiB) and unmatched output is **not** forwarded to the terminal while `PreAuth` — it's either a prompt we don't recognise (default-deny per D3) or line noise; show it in a "connecting…" panel, not the live terminal, so nothing pre-auth ever reaches the same render path as post-auth remote output |

The **default-deny** requirement (SYSTEM_DESIGN.md D3) means: if 8 KiB of `PreAuth` output accumulates with no recognised marker and no `Access granted`, transition to `Closed{Error("unrecognised pre-auth output — plink version mismatch?")}` rather than guessing. This is also the practical guard against a version drift: if a future PuTTY changes this text, Plinky fails safe (blocks the connection, visibly) instead of either silently answering the wrong prompt or leaking the unrecognised text into the live terminal.

---

## 4. `putty-compat` v1: concrete module contracts

(Per D1/scaffold.md, already correctly narrowed to session r/w + `.ppk` headers + hostkey listing — this section makes the contracts concrete, it doesn't change scope.)

```rust
// sessions.rs
pub fn session_dir() -> PathBuf;                 // PUTTYDIR > XDG_CONFIG_HOME/putty > ~/.putty (Linux)
pub fn list_sessions() -> Result<Vec<SessionRef>>;
pub fn read_session(name: &str) -> Result<PuttySession>;   // never fails on an unknown key: PuttySession keeps an `extra: BTreeMap<String,String>` for round-trip fidelity (R3-style: unknown fields survive)
pub fn write_session(s: &PuttySession) -> Result<()>;       // ONLY called from the explicit "save back to PuTTY" opt-in (D4); backs up first

// ppk.rs — HEADER ONLY, per D1. No decrypt(), on purpose.
pub struct PpkHeader { pub version: u8, pub algo: String, pub encrypted: bool, pub comment: String, pub fingerprint: String }
pub fn read_header(path: &Path) -> Result<PpkHeader>;   // reads up through Public-Lines, computes fingerprint from the public blob only; stops before Private-Lines
pub fn looks_like_ppk(path: &Path) -> bool;              // used by the key-import UI (§2 Finding 1) to decide "offer puttygen conversion" vs "use directly"

// hostkeys.rs — READ-ONLY, per D2.
pub fn list_host_keys() -> Result<Vec<HostKeyEntry>>;    // parses ~/.putty/sshhostkeys (Linux, format per §2 Finding 5) AND HKCU\...\SshHostKeys (Windows, ADR-002) into one shape
// no write_host_key(): plink owns this (D2). putty-compat only ever displays what's already there.
```

`PpkHeader` deliberately never touches `Private-Lines` or `Private-MAC` — this is what keeps `.ppk` decryption (Argon2id, AES-256-CBC, HMAC) out of the v1 dependency graph per D1, and it's enforced by the type, not just by convention: `read_header` physically stops reading the file after the last `Public-Lines` line.

**Doc debt to flag (not fixed here — Antigravity's file):** `specs/PUTTY_WRAPPER_SPEC.md` §2 ("PPK Private Key Specification", the Argon2id/AES-256-CBC/HMAC pipeline diagram) still reads as v1 scope. `0b24b8a` updated `scaffold.md` and `past_memory.md` for D1 but not this file. It should either move under a "§2 (deferred to v2 — key manager)" heading or be trimmed to header-only, matching `ppk.rs` above, so a reader of the wrapper spec doesn't design against a decrypt path that v1 doesn't build.

---

## 5. `-share` lifecycle: a concrete ownership design (narrows open question #3)

Not yet spiked (S3 is still open), but the SYSTEM_DESIGN.md §3 D-note already reasoned about it; here is the concrete shape to spike against, so S3 has a specific design to falsify rather than starting blank:

- **The Rust core, not any UI tab, owns the `-share` upstream.** `SessionRegistry` distinguishes a session's *presentation* (a terminal tab, an SFTP pane) from its *transport ownership*. The first thing that needs a connection to `host:port` under a given PuTTY session name spawns `plink -share ... -N`-equivalent as a **connection owner** with no tab attached; the terminal tab and the SFTP pane both attach as **sharers** (plain `plink -share`, `psftp -share`) against it.
- Closing the last sharer (tab or SFTP pane) does **not** kill the connection owner immediately — it starts a short idle timer (e.g. 30s **[A]**, tunable), so re-opening a tab to the same host right after closing one doesn't pay a fresh handshake. The owner is torn down explicitly on "disconnect" or when the idle timer fires with zero sharers.
- **What S3 must still verify empirically** (this is design, not evidence, unlike §2): whether a `psftp -share` sharer can outlive the tab that originally spawned the owning `plink -share`, and whether `-R`/`-L` forwards declared on the owner survive a sharer attaching/detaching. If the owner model above turns out to be unnecessary (i.e., PuTTY's own socket already survives any single sharer's exit, including the first), simplify to "first spawn is unprivileged, just don't kill the socket file" — S3's job is to tell us which.

---

## 6. Revised open-questions status (SYSTEM_DESIGN.md §7)

| # | Question | Status after this pass |
|---|---|---|
| 1 | PreAuth→Live boundary | **Resolved** by D9 (§2 Finding 4), pubkey path only — password/kbd-interactive path still needs S2 |
| 2 | plink.exe resize under ConPTY | Still open — Windows-only, needs the owner's machine |
| 3 | `-share` lifecycle / downstream forwards | Narrowed to a concrete ownership design (§5) — still needs S3 to verify |
| 4 | `psftp` parsing robustness | Still open — unrelated to this pass |
| 5 | WebKitGTK/WebGL, WebView2 | Still open — S1, needs the Tauri app to exist (M2) |
| 6 | Windows host-key store | Documented in ADR-002 (registry path) — still needs verification against a real Windows PuTTY install |
| **new** | Does plink accept OpenSSH-format keys? | **Resolved**: no (§2 Finding 1). Import flow must convert via `puttygen`. |

---

## 7. What I'd revisit as this grows
The v1 narrowing in R3 (no password auto-fill) is the biggest scope cut in this document and is not yet in SYSTEM_DESIGN.md's D3 text — it should be reconciled there so the two docs don't disagree about whether `PasswordPending` is interactive or display-only. `-share` ownership (§5) may turn out to need its own small state machine once S3's answer is in. The `Access granted` marker (D9) should be re-verified whenever the target PuTTY floor version changes (ADR-002's 0.75+ floor) — it was only checked against 0.85.
