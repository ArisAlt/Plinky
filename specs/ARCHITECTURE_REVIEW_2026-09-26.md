# Plinky — Architecture Review & Plan (2026-09-26)

**Status:** Proposed · **Reviewer:** Claude (critic/architect) · **Basis:** `7ca9b1f` (v0.1.3)
**Scope:** Linux + Windows. macOS is **halted** (owner, 2026-09-26) — no macOS work, CI, or packaging in this plan.
**Owner directive in force:** Plinky uses the installed PuTTY toolchain (`plink`/`psftp`) on every supported platform.

Numbers below were read from the code; items marked **[verify]** need a run on the owner's Windows machine.

---

## 1. Verdict

The foundation is sound. The ADRs are good (ADR-001 plink-only, ADR-003 plain psftp,
ADR-006 flow control measured before and after), the core crates are small and have
no Tauri dependency, and the security invariants that matter most (pre-auth state
machine, `write_input_live_only`, no `-pw`, secrets zeroized) exist and are tested.

What is wrong is **drift**: the code has outgrown the design in five places without an
ADR recording the change, and one of those is a security boundary. Fix the drift and
the Windows gaps before adding features.

---

## 2. Findings (ranked)

### F1 — `vault_send_secret` is not bound to the session. **High (security)**
`src-tauri/src/lib.rs:808`: takes `(session_id, key, field)` from the webview and types
**any** vault entry into **any** session. The only backend gate is `write_input`
(refuses `HostKeyPending`, nothing else). The session↔credential link
(`extra.PlinkyVaultKey`) is enforced only in React.

- Failure: a UI bug or anything that can call `invoke` sends the production router's
  enable password to a different host, or types it into a Live shell where it echoes
  and lands in history.
- Fix: resolve the vault key **in the core at spawn time** (same lookup `vault_lookup`
  already does) and store it on `ActiveSession`. The command becomes
  `vault_send_secret(session_id, field)` — no `key` parameter. Additionally refuse
  `login` unless the state machine is at a password prompt (PreAuth) or the last
  output line matches the prompt detector, and refuse `enable` outside Live.
- Test: sending with a session that has no linked key fails; sending into a Live shell
  with no prompt on the last line fails.

### F2 — Windows: every helper process flashes a console window. **High (Windows UX)** [verify]
No `CREATE_NO_WINDOW` anywhere (`grep creation_flags` → 0 hits). A GUI-subsystem app
spawning console programs gets a visible console per spawn:
`where plink.exe` / `plink -V` (detection), and **every** psftp call
(`sftp/client.rs:202` — one per directory listing, mkdir, rm, upload, download).
- Fix: one `command_no_window()` helper in `plinky-core` that sets
  `creation_flags(0x0800_0000)` under `cfg(windows)`; route every `Command::new` through it.
  plink under ConPTY is unaffected (portable-pty owns that).

### F3 — SFTP opens a new SSH connection per operation. **Medium (perf, auth load)**
`PsftpClient::run_batch` spawns `psftp -batch -b <script>` for each call. Every folder
click is a full TCP + key exchange + authentication. SYSTEM_DESIGN §4.3 specified
"one queued coprocess per connection with per-command timeouts"; the code diverged.
- Consequences: 0.3–1.5 s per click on real links; a password-auth server sees one
  login per click (fail2ban / `MaxStartups` risk); MFA/keyboard-interactive servers
  are unusable.
- Fix (ADR-007): a long-lived `psftp` per SFTP pane, driven over stdin, commands
  serialized through a queue, completion detected by a sentinel command
  (e.g. `pwd` after each op) because psftp returns 0 on failed commands via stdin
  (the reason the batch approach was chosen — keep failure detection by parsing
  the sentinel and the error text). Keep the batch path as the fallback.

### F4 — Plinky metadata lives in PuTTY session files, contrary to D4. **Medium (data loss)**
D4 said "never store our fields there": PuTTY rewrites Unix session files in full.
The code stores `PlinkyFolder`, `PlinkyTags`, `PlinkyVaultKey`, `PlinkyAutoEnable`,
`PlinkyAutoLogin` as extra keys. On **Linux**, saving the session in PuTTY's own GUI
drops them — folder, tags and vault link vanish silently. (Windows registry keeps
unknown values — so the two platforms behave differently.) [verify on Linux with
`putty` → Load → Save]
- Fix: move Plinky fields to Plinky's own store (see F5) keyed by session name; keep
  reading the `Plinky*` keys once as a migration source. Record the reversal of the
  current practice in ADR-008.

### F5 — Persistence is in `localStorage`, not the app data dir. **Medium**
Snippets, session metadata, folders, recent sessions and layout use webview
`localStorage` (`src/services/*.ts`). SYSTEM_DESIGN §4.2 put them in
`$XDG_CONFIG_HOME/plinky` / `%APPDATA%\Plinky` with R1–R3 (atomic write,
corrupt-file quarantine, unknown fields preserved).
- Consequences: not backed up with the user's config, invisible to diagnostics,
  wiped by a WebView2 profile reset, and `migrate_identifier_dir` only protects it by
  accident. `sessionMetadata.ts` also swallows a corrupt value with `console.warn`
  and then overwrites it — an R2 violation.
- Fix: a `plinky-core::store` module (JSON files, `schema_version`, R1–R3) behind
  three Tauri commands (`store_get/put/list`); one-shot import from `localStorage`.

### F6 — PuTTY discovery is incomplete on Windows and brittle everywhere. **Medium**
`find_plink_binary` / `PsftpClient::find_binary`:
- Windows: checks only `Program Files\PuTTY`. Misses per-user installs
  (`%LOCALAPPDATA%\Programs\PuTTY`), Scoop/Chocolatey shims, portable copies, and
  **the Windows Store / winget build**. No user-configured path (the error text even
  mentions `PUTTY_PSFTP_PATH`, which nothing reads).
- Version check parses `"0.85"` as `f64 >= 0.75`: PuTTY **0.100** would parse as
  0.1 and be refused. Compare `(major, minor)` as integers.
- The two finders are copy-pasted and can disagree (plink from one install, psftp
  from another, different versions).
- Fix: one `PuttyLocator` (as SYSTEM_DESIGN §2 already names it) returning a
  `PuttyToolchain { dir, plink, psftp, puttygen?, version }` from **one** directory,
  order: user setting → env `PLINKY_PUTTY_DIR` → PATH → known install dirs (both
  `Program Files`, `%LOCALAPPDATA%`, Scoop). Cache it; re-probe on settings change.

### F7 — Password files on Windows rely on inherited ACLs. **Low–Medium (security)**
`-pwfile` temp files: `tempfile` creates 0600 on Unix. On Windows they land in
`%TEMP%` with the profile's inherited ACL (normally user-only, not guaranteed on
redirected/roaming profiles). The plink file lives `PWFILE_LIFETIME = 5 s`; the psftp
file lives for the whole operation.
- Fix: on Windows create the file with an explicit owner-only DACL, or, better,
  prefer plink's stdin prompt answered by the core (the PreAuth machine already sees
  `password:`), which removes the file entirely. Decide in ADR-008.

### F8 — Two god files. **Low (maintainability, merge conflicts between agents)**
`src-tauri/src/lib.rs` 1263 lines / 47 commands; `TerminalView.tsx` 2141 lines.
`SessionRegistry::create_*_session` duplicates the reader loop (manager.rs ~160–270 and
~310–450). Two agents editing the same file is where your writer/critic loop loses time.
- Fix: split `lib.rs` into `commands/{session,sftp,vault,putty,sync}.rs`; split
  `TerminalView` into `useTerminalSession` (IPC/flow/attach), `useVaultPrompt`,
  `FreeTypeController`, `TerminalContextMenu`. Extract the reader loop into one
  `spawn_reader(transport_kind)` function. No behaviour change; tests must pass unchanged.

### F9 — Records are stale. **Low**
`STATUS.md` still shows T-011…T-014 and T-017 as `todo`; git log shows T-012/13/14
delivered. `scaffold.md` lists `styles/themes/` that does not exist and omits
`flow.rs`, `paste.rs`, `legacy_import.rs`, `registry.rs`. SYSTEM_DESIGN D3/R3 still says
"no auto-fill in v1" while §38 of past_memory added `-pwfile` auto-login.
- Fix: update the three files; add a short "Superseded by" note to D3/R3 and D4.

### Not a finding: ADR-005 (native serial)
It is compatible with the "use PuTTY" directive: settings still come from PuTTY's own
`Serial*` keys, and plink cannot send Break. Keep it. If the owner reads the directive
strictly, the only alternative is Option A (plink, no Break) — say so and it is a
one-line switch in `create_serial_session`.

---

## 3. Plan

Ordered so that each phase is independently shippable and nothing waits on macOS.
Writer/critic split as in GEMINI.md: Antigravity writes, Claude reviews each PR diff.

| Phase | Work | Finding | Accept when |
|---|---|---|---|
| **P0 — Records** (½ day) | STATUS.md, scaffold.md, SYSTEM_DESIGN "superseded" notes; ADR-007 (SFTP coprocess) and ADR-008 (Plinky store + credential delivery) drafted | F9 | docs match `git log` and the tree |
| **P1 — Security** (1–2 days) | Bind vault key to session in core; drop `key` param; prompt gate | F1 | new tests: unlinked session refused; Live-shell-without-prompt refused; existing 121 + 99 tests green |
| **P2 — Windows parity** (2–3 days) | `command_no_window()`; `PuttyLocator` with one-directory toolchain, integer version compare, user path setting; Windows DACL for pwfile or stdin answer | F2 F6 F7 | owner's Windows machine: no console flash on SFTP browse; detection finds per-user + Scoop installs; unit test for `0.100` |
| **P3 — Windows measurements** (owner machine) | Close T-009: S1 harness in Edge/WebView2; ConPTY resize with `plink.exe` (open Q2); sshd fixture against Windows OpenSSH server in CI if feasible | — | ADR-006 Windows column filled; Q2 answered |
| **P4 — Persistence** (2–3 days) | `plinky-core::store` with R1–R3; move snippets/metadata/folders/recent/layout; one-shot localStorage import; stop writing `Plinky*` keys to PuTTY (read-once migration) | F4 F5 | round-trip test: PuTTY GUI save on Linux keeps folder/tags/vault link; corrupt file quarantined not overwritten |
| **P5 — SFTP coprocess** (3–4 days) | Per-pane long-lived psftp, queue, sentinel completion, timeouts, batch fallback | F3 | folder browse: 1 auth per pane (count sshd log lines in fixture); failure of one command does not kill the pane |
| **P6 — Refactor** (2 days, can overlap P5) | Split `lib.rs`, `TerminalView.tsx`, dedupe reader loop | F8 | zero behaviour change; diff reviewed as pure moves |
| **P7 — Features resume** | T-016 keepalive/reconnect (uses `-batch` pre-flight per D8), T-017 keyword highlighting, T-019 WebGL | — | per task |

**Deliberately not in this plan:** macOS (halted), `russh`, bundling PuTTY, plugin API.

### Risks
- P4 changes where user data lives; a bad migration loses folders/vault links. Mitigate:
  import is additive, the old keys are left in place for one release, and a backup of
  the old values is written before the first run of the new store.
- P5 depends on psftp's stdin behaviour, which already surprised once (exit 0 on
  failure). Spike it first (½ day) against the sshd fixture before committing to it.

---

## 4. Decisions needed from the owner
1. F1 gate strictness: refuse `login` outside a detected prompt — acceptable, or keep a
   "send anyway" with a confirmation?
2. F7: explicit DACL on the password file, or drop `-pwfile` and answer plink's prompt
   from the core?
3. ADR-005: keep native serial (recommended), or switch serial back to plink and lose Break?
