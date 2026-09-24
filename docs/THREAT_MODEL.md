# Plinky Threat Model & Security Architecture

> **Document Version**: 1.0  
> **Target Milestone**: M1 (CI & Threat Model)  
> **Status**: Living Architectural Specification  

---

## 1. System Overview & Trust Boundaries

Plinky is an open-source terminal emulator and session manager combining PuTTY/Pageant security with modern IDE productivity features (WindTerm superpowers).

```mermaid
flowchart TD
    subgraph Hostile_World ["Untrusted / Adversarial Zone"]
        RemoteSSH["Remote SSH Servers (Potentially Compromised)"]
        UntrustedPPK["Untrusted .ppk Key Files & Sessions"]
        HostileInput["Hostile Network Streams & Escape Sequences"]
    end

    subgraph Desktop_Process ["Local Operating System (User Context)"]
        subgraph Webview_Heap ["Frontend Webview (WebKitGTK / WebView2)"]
            ReactUI["React 19 + TypeScript Workbench UI"]
            XtermJS["xterm.js Canvas Engine & Addons"]
            LayoutCache["localStorage (Quarantined Layout State)"]
        end

        subgraph Core_Rust ["crates/plinky-core & Tauri Core"]
            PTYManager["portable-pty Subprocess Manager"]
            PreAuthSM["D3 / D9 PreAuth State Machine (8 KiB Cap)"]
            SyncRouter["SyncInputRouter (D6 Live-Only Filtering)"]
            VaultEngine["Argon2id + AES-256-GCM Vault (Zeroize)"]
            PsftpEngine["Dedicated psftp Batch Client"]
        end

        subgraph Subprocesses ["System Toolchain (Unprivileged)"]
            PlinkProc["/usr/bin/plink (Isolated PTY)"]
            PsftpProc["/usr/bin/psftp (Isolated Pipe)"]
            LocalShell["/bin/bash, /bin/zsh, /bin/fish"]
        end

        subgraph Local_Storage ["Local Disk Storage (POSIX 0600)"]
            VaultFile[".vault.bin (Authenticated Ciphertext)"]
            PuttyRegistry["~/.putty/sessions & sshhostkeys"]
        end
    end

    RemoteSSH <-->|SSH Protocol| PlinkProc
    RemoteSSH <-->|SFTP Protocol| PsftpProc
    PlinkProc <-->|Master PTY| PTYManager
    PTYManager -->|D3/D9 Gate| PreAuthSM
    PreAuthSM -->|tauri::ipc::Channel| XtermJS
    ReactUI <-->|Tauri IPC (Invoke/Events)| Core_Rust
    VaultEngine <-->|Atomic Sync (0600)| VaultFile
    Core_Rust <--> PuttyRegistry
```

---

## 2. Threat Analysis & Attack Vectors

### T1: Remote Escape Sequence Injection & Terminal Hijacking
* **Threat**: A compromised or malicious remote server emits malicious ANSI/DEC/OSC escape sequences designed to exploit parser vulnerabilities in xterm.js or trigger uncommanded local actions.
* **Attack Vectors**:
  - `OSC 52` (Clipboard hijacking): An attacker sends an OSC 52 sequence attempting to read or overwrite the user's system clipboard.
  - Title/Window manipulation (`CSI 21 t`, etc.): Attempting to query window titles to exfiltrate terminal content.
  - APC / DCS / PM escape injection: Exploiting terminal escape parsers to break canvas layout or trigger webview sandbox escapes.
* **Mitigations**:
  1. **Strict Feature Gating in xterm.js**: Plinky disables terminal-driven clipboard reads via OSC 52 by default.
  2. **Sanitized Link Decorators**: Real-time link providers (IPv4 and URLs) match strictly bound regular expressions (`ipRegex`, `urlRegex`), validating URI protocols (`https?://` only, rejecting `javascript:` or `file://`).
  3. **Canvas Rendering Isolation**: xterm.js renders into HTML5 canvas/WebGL elements; escape sequences are parsed into text cell glyph buffers rather than injected into the DOM as HTML, preventing DOM-based Cross-Site Scripting (XSS).

---

### T2: Pre-Authentication State Machine Bypass & Host Key Spoofing
* **Threat**: A Man-in-the-Middle (MitM) attacker or malicious host presents a forged host key or crafts adversarial banner text attempting to trick the pre-auth state machine into assuming the connection is authenticated.
* **Attack Vectors**:
  - Emitting `"Access granted"` inside a pre-login banner text (e.g. MOTD / Issue banner) before genuine authentication completes.
  - Overflowing the pre-auth buffer with line noise or fake prompt text.
  - User keystroke leaking into an unauthenticated prompt, inadvertently answering a host-key replacement prompt with `y`.
* **Mitigations**:
  1. **Verbatim Prompt Matching**: Plinky matches exact verbatim PuTTY prompt strings (`"The host key is not cached for this server:"`, `"Store key in cache? (y/n, Return cancels connection, i for more info)"`).
  2. **8 KiB Bounded Buffer with Default-Deny**: Pre-auth buffer is capped at `MAX_PREAUTH_BUFFER_LEN = 8192` bytes. If unrecognised output exceeds 8 KiB without matching an armed prompt or `Access granted`, the session fails closed immediately to `Closed{Error}`.
  3. **Keystroke Blocking during Pending Host Key**: When a session is `HostKeyPending`, `write_input` explicitly intercepts and rejects all terminal keystrokes. Only the dedicated native trust modal (`answer_prompt`) can emit `y\r`, `n\r`, or `\r`.
  4. **Strict `write_input_live_only` Boundary**: All automated write paths (shell integration hook injection, multi-session sync broadcast) use `write_input_live_only`, which enforces `is_live()` and strictly rejects any session in `PreAuth` (preventing password trial exhaustion and lockout).

---

### T3: Sync Input Broadcast Leakage & Cross-Session Contamination
* **Threat**: Multi-session command broadcast (WindTerm-style sync input) inadvertently broadcasts sensitive credentials (passwords, sudo tokens) or destructive commands to inappropriate sessions.
* **Attack Vectors**:
  - Broadcasting keystrokes into a session currently displaying a password prompt.
  - Accidentally including production server sessions in a bulk cluster broadcast.
  - Large multi-line paste executing instantly across multiple servers without review.
* **Mitigations**:
  1. **In-Memory Rust Fan-out**: All keystroke replication executes in Rust core memory; no multi-call webview IPC fanout.
  2. **D6 State Filtering**: Broadcasts strictly target sessions in `SessionState::Live`. Any session in `Connecting`, `PreAuth`, or `HostKeyPending` is automatically skipped.
  3. **Protected Session Exclusion**: Sessions flagged with `is_protected = true` (e.g., production targets) are excluded by default from broadcast fanout.
  4. **Emergency Disarm**: Global `armed` toggle allows instantaneous suspension of all broadcast channels with one click.
  5. **Multi-Line Paste Confirmation Guard**: Pasting or broadcasting $\ge 2$ lines triggers a modal confirmation dialog displaying line count and script preview.

---

### T4: SFTP Subsystem & Command Injection
* **Threat**: A hostile remote server returns filenames containing shell metacharacters, null bytes, or directory traversal sequences (`../`) to attack the client during SFTP operations.
* **Attack Vectors**:
  - Filenames containing `\n`, `\r`, or `;` injected into `psftp` batch commands.
  - Directory traversal filenames (`../../etc/shadow`).
  - Filenames with unescaped control characters.
* **Mitigations**:
  1. **Input Validation (`sftp::client::validate_path`)**: Rejects any path containing carriage returns (`\r`), newlines (`\n`), or null bytes (`\0`).
  2. **Path Escaping (`escape_psftp_path`)**: Wraps paths in quotes and escapes internal double-quotes.
  3. **Robust Output Parser (`sftp::parser`)**:
     - Strips `.` and `..` listings.
     - Scans 9th-column token boundaries to preserve embedded spaces safely.
     - Normalizes symlink arrows (`-> target`).
     - Rejects filenames containing ASCII control characters ($< 32$).
  4. **Process Isolation (ADR-003)**: Each SFTP operation runs in an isolated `psftp` batch subprocess rather than sharing a fragile multiplexed socket.

---

### T5: Credential Vault & Master Key Security
* **Threat**: An attacker with access to the user's local disk attempts to read saved credentials, passwords, or private key passphrases.
* **Attack Vectors**:
  - Offline brute-force dictionary attacks against the vault container.
  - Memory dumps of the Plinky process extracting unencrypted master keys.
  - Tampering with cryptographic parameters or salt in the vault file.
  - Plaintext secret leakage into the webview JavaScript heap.
* **Mitigations**:
  1. **OWASP-Grade KDF**: Derives master encryption key via Argon2id with 64 MiB memory (`65536 KiB`), 3 iterations (`t_cost = 3`), and 1 parallel lane (`p_cost = 1`), with a cryptographically secure 16-byte random salt.
  2. **Tamper-Evident Authenticated Encryption (AEAD)**: Uses AES-256-GCM. Cryptographically binds domain prefix `b"PLKV_AAD_v1:"` + 36-byte header as Additional Authenticated Data (AAD). Any bit-flip in Argon2 parameters, salt, or ciphertext fails authentication instantly.
  3. **Zeroization & Memory Hygiene**: `SecretString` wraps all plaintext secrets and implements `zeroize::Zeroize` and `zeroize::ZeroizeOnDrop`. Explicit locking (`vault_lock`) immediately zeroes master keys and drops entries.
  4. **Redacted Logging**: Custom `Debug` and `Display` implementations print `"[REDACTED]"`. Plaintext is never formatted into logs.
  5. **POSIX Permissions & Atomic Writes**: Written with restrictive POSIX `0600` permissions via a temporary file with `sync_all()` before atomic rename.
  6. **IPC Isolation**: Plaintext credentials for pre-auth auto-fill do not cross into the webview JavaScript heap; the Rust backend pipes credentials directly to child PTY stdin.

---

### T6: Webview & IPC Boundary Security
* **Threat**: A vulnerability in the webview runtime (WebKitGTK / WebView2) or malicious local script attempts to execute unauthorized commands or access system resources.
* **Attack Vectors**:
  - Malicious URLs loaded in webview executing arbitrary IPC commands.
  - Right-click browser context menus exposing developer tools or reload actions.
* **Mitigations**:
  1. **Strict Context Isolation**: Tauri v2 context isolation ensures frontend scripts cannot invoke arbitrary system APIs without explicit command definitions.
  2. **Suppressed Browser Menu**: Default WebKitGTK context menu (`Reload`, `Inspect Element`) is globally suppressed.
  3. **Strict Parameter Validation**: Every Tauri IPC command rigorously type-checks and validates its arguments (e.g. bounds checking terminal dimensions, session identifiers).

---

## 3. Security Invariants Summary

| Invariant | Description | Enforcement Mechanism |
| :--- | :--- | :--- |
| **I1: No Unauthenticated PTY Output** | No bytes received prior to `Access granted` reach the live terminal canvas. | PreAuth state machine 8 KiB default-deny buffer cap. |
| **I2: No Keystroke Spoofing** | User keystrokes cannot answer a host key prompt. | `write_input` blocks input when `HostKeyPending`. |
| **I3: No Pre-Auth Automated Writes** | Automated scripts/broadcasts cannot write to unauthenticated sessions. | `write_input_live_only` rejects non-Live states. |
| **I4: No Plaintext Secrets in Logs** | Plaintext credentials never appear in debug logs or errors. | `SecretString` redaction (`[REDACTED]`). |
| **I5: Memory Zeroization on Lock** | Locking the vault purges all keys and credentials from RAM. | `ZeroizeOnDrop` and explicit in-place zeroing. |
| **I6: Fail-Closed Cryptographic Verification** | Tampered vault files or invalid headers never decrypt partial data. | AES-256-GCM authenticated encryption with AAD binding. |
| **I7: POSIX 0600 Protection** | Vault files and temporary buffers are inaccessible to other local users. | Explicit file permission masking on creation. |
| **I8: Process Lifetime Safety** | Plinky process maintains an ambient Tokio reactor without panicking across FFI boundaries. | `#[tokio::main]` async process initialization. |
