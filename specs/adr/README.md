# Architecture Decision Records (ADRs)

This directory houses the formal Architectural Decision Records for **Plinky**.

| ADR # | Title | Status | Date | Key Decision |
| :---: | :--- | :---: | :---: | :--- |
| **[ADR-001](specs/adr/ADR-001-primary-ssh-transport.md)** | Primary SSH Transport Architecture | **Accepted** | 2026-09-20 | `plink` only in v1 with connection sharing (`-share`); `russh` deferred behind spikes (S3/S4). |
| **[ADR-002](specs/adr/ADR-002-putty-discovery-and-versioning.md)** | PuTTY Discovery & Version Enforcement | **Accepted** | 2026-09-20 | Detect system PuTTY (floor: 0.75+); do not bundle binaries in v1; focus strictly on Linux & Windows. |
| **[ADR-003](specs/adr/ADR-003-sftp-data-path.md)** | SFTP Data Path Architecture | **Accepted** | 2026-09-22 | Option B: SFTP does not use `-share` (avoids upstream hang); each pane opens plain `psftp` connection with cached hostkey. |
| **[ADR-005](specs/adr/ADR-005-native-serial-transport.md)** | Native Serial Transport | **Accepted** | 2026-09-25 | Serial sessions use a native `serialport` transport (enables Send Break); settings still read from PuTTY's own `Serial*` session keys. SSH/Telnet/Raw stay on `plink`. |
| **[ADR-006](specs/adr/ADR-006-s1-renderer-throughput.md)** | Terminal Renderer and Output Flow Control (S1) | **Accepted** | 2026-09-26 | Flow control (512 KB ack window, raw bytes, batched) implemented: the real app went from freezing under a `yes` flood to 32 MB/s with key echo p95 21 ms. WebGL with DOM fallback accepted (T-019). Windows still to measure. |
