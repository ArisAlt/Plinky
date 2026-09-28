//! Whether a process has an established TCP connection, from the system's
//! own tables: /proc on Linux, GetExtendedTcpTable on Windows.
//!
//! plink prints nothing when a telnet or raw connection comes up, and a
//! router console sends nothing until something happens on the device:
//! measured on a GNS3 IOS console, 0 bytes in the first 5 s. Plinky waited
//! for output before it stopped showing "Connecting to host:port", so a
//! saved console session looked like it took ~10 s to connect when plink had
//! connected in milliseconds. Watching plink's own socket needs no second
//! connection to the device, which matters for a terminal server line that
//! takes only one client.

/// `Some(true)` once `pid`, or a process it started, holds an ESTABLISHED
/// TCP socket, `Some(false)` while none does, `None` where this can't be told: the tables can't be
/// read, the process is gone (Linux), or the platform has no way here.
pub fn has_established_tcp(pid: u32) -> Option<bool> {
    imp::has_established_tcp(pid)
}

/// A process and everything it started, from (pid, parent pid) pairs. The
/// connection can belong to a child: Chocolatey's and Scoop's plink.exe is
/// a shim that starts the real plink, and Windows CI never saw the
/// connection established through the shim's own pid.
#[cfg(any(windows, test))]
fn with_descendants(root: u32, pairs: &[(u32, u32)]) -> std::collections::HashSet<u32> {
    let mut family = std::collections::HashSet::from([root]);
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for &(pid, ppid) in pairs {
            // A pid is its own parent for the System Idle Process.
            if ppid == parent && pid != parent && family.insert(pid) {
                frontier.push(pid);
            }
        }
    }
    family
}

#[cfg(target_os = "linux")]
mod imp {
    use std::collections::HashSet;

    /// The inodes of the sockets `pid` has open (`/proc/<pid>/fd/* ->
    /// socket:[inode]`).
    pub(super) fn socket_inodes(pid: u32) -> Option<HashSet<u64>> {
        let dir = std::fs::read_dir(format!("/proc/{pid}/fd")).ok()?;
        Some(
            dir.flatten()
                .filter_map(|e| std::fs::read_link(e.path()).ok())
                .filter_map(|link| {
                    link.to_str()?
                        .strip_prefix("socket:[")?
                        .strip_suffix(']')?
                        .parse()
                        .ok()
                })
                .collect(),
        )
    }

    /// The inodes of the ESTABLISHED sockets in a `/proc/net/tcp` or
    /// `tcp6` table: state (4th column) `01`, inode in the 10th.
    pub(super) fn established_inodes(table: &str) -> HashSet<u64> {
        table
            .lines()
            .skip(1)
            .filter_map(|line| {
                let f: Vec<&str> = line.split_whitespace().collect();
                if f.get(3) != Some(&"01") {
                    return None;
                }
                f.get(9)?.parse().ok()
            })
            .collect()
    }

    /// `pid` and everything it started, from /proc/<pid>/task/*/children.
    fn with_descendants(pid: u32) -> Vec<u32> {
        let mut family = vec![pid];
        let mut i = 0;
        while i < family.len() && family.len() < 256 {
            let tasks = std::fs::read_dir(format!("/proc/{}/task", family[i]));
            for task in tasks.into_iter().flatten().flatten() {
                let children = std::fs::read_to_string(task.path().join("children")).unwrap_or_default();
                for child in children.split_whitespace().filter_map(|c| c.parse::<u32>().ok()) {
                    if !family.contains(&child) {
                        family.push(child);
                    }
                }
            }
            i += 1;
        }
        family
    }

    pub(super) fn has_established_tcp(pid: u32) -> Option<bool> {
        // The process itself must be there: gone, nothing can be told.
        let mut mine = socket_inodes(pid)?;
        for child in with_descendants(pid).into_iter().skip(1) {
            mine.extend(socket_inodes(child).unwrap_or_default());
        }
        if mine.is_empty() {
            return Some(false);
        }
        // The tables of the process's own network namespace.
        let mut established = HashSet::new();
        for table in ["tcp", "tcp6"] {
            if let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/net/{table}")) {
                established.extend(established_inodes(&text));
            }
        }
        Some(mine.iter().any(|inode| established.contains(inode)))
    }
}

/// Reading the rows of a Windows owner-pid TCP table: a u32 row count, then
/// the rows. Kept apart from the system call so it is tested everywhere.
#[cfg(any(windows, test))]
mod owner_pid_table {
    /// Where the fields sit in one row.
    pub(super) struct RowLayout {
        pub size: usize,
        pub state_at: usize,
        pub pid_at: usize,
    }
    /// MIB_TCPROW_OWNER_PID: state, local addr, local port, remote addr,
    /// remote port, owning pid -- six u32s.
    pub(super) const V4: RowLayout = RowLayout { size: 24, state_at: 0, pid_at: 20 };
    /// MIB_TCP6ROW_OWNER_PID: local addr [16], scope id, port, remote addr
    /// [16], scope id, port, state, owning pid.
    pub(super) const V6: RowLayout = RowLayout { size: 56, state_at: 48, pid_at: 52 };
    /// MIB_TCP_STATE_ESTAB.
    const ESTABLISHED: u32 = 5;

    fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
        Some(u32::from_ne_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
    }

    /// Whether `pid` owns an ESTABLISHED row. A count the bytes can't hold is
    /// read only as far as the bytes go.
    pub(super) fn owns_established(table: &[u8], pid: u32, row: &RowLayout) -> bool {
        let count = u32_at(table, 0).unwrap_or(0) as usize;
        (0..count).any(|i| {
            let start = 4 + i * row.size;
            u32_at(table, start + row.state_at) == Some(ESTABLISHED)
                && u32_at(table, start + row.pid_at) == Some(pid)
        })
    }
}

#[cfg(windows)]
mod imp {
    use super::owner_pid_table::{owns_established, V4, V6};
    use std::ffi::c_void;

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    /// TCP_TABLE_OWNER_PID_CONNECTIONS: every connection that isn't
    /// listening, with the process that owns it.
    const OWNER_PID_CONNECTIONS: i32 = 4;
    const NO_ERROR: u32 = 0;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

    const TH32CS_SNAPPROCESS: u32 = 0x2;
    const INVALID_HANDLE_VALUE: isize = -1;

    /// PROCESSENTRY32W.
    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        usage: u32,
        process_id: u32,
        default_heap_id: usize,
        module_id: u32,
        threads: u32,
        parent_process_id: u32,
        priority: i32,
        flags: u32,
        exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        fn Process32FirstW(snapshot: isize, entry: *mut ProcessEntry) -> i32;
        fn Process32NextW(snapshot: isize, entry: *mut ProcessEntry) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }

    /// (pid, parent pid) of every process running now.
    fn process_pairs() -> Vec<(u32, u32)> {
        let mut pairs = Vec::new();
        // SAFETY: a snapshot handle is closed below; entry.size is set as
        // the calls require, and they write only within the struct.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return pairs;
            }
            let mut entry: ProcessEntry = std::mem::zeroed();
            entry.size = std::mem::size_of::<ProcessEntry>() as u32;
            let mut more = Process32FirstW(snapshot, &mut entry) != 0;
            while more {
                pairs.push((entry.process_id, entry.parent_process_id));
                more = Process32NextW(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
        }
        pairs
    }

    #[link(name = "iphlpapi")]
    extern "system" {
        fn GetExtendedTcpTable(
            table: *mut c_void,
            size: *mut u32,
            order: i32,
            family: u32,
            class: i32,
            reserved: u32,
        ) -> u32;
    }

    /// One family's table, as bytes. The table can grow between the call
    /// that sizes it and the one that fills it, so it is asked again.
    fn table(family: u32) -> Option<Vec<u8>> {
        let mut size: u32 = 0;
        for _ in 0..4 {
            // u32s, so the rows (all u32-aligned) are aligned too.
            let mut buf = vec![0u32; (size as usize).div_ceil(4).max(1)];
            let mut len = (buf.len() * 4) as u32;
            // SAFETY: buf holds len bytes; the call writes at most len and
            // sets len to what it needs when that is not enough.
            let rc = unsafe {
                GetExtendedTcpTable(buf.as_mut_ptr().cast(), &mut len, 0, family, OWNER_PID_CONNECTIONS, 0)
            };
            match rc {
                NO_ERROR => {
                    let mut bytes: Vec<u8> = buf.iter().flat_map(|w| w.to_ne_bytes()).collect();
                    bytes.truncate(len as usize);
                    return Some(bytes);
                }
                ERROR_INSUFFICIENT_BUFFER => size = len,
                _ => return None,
            }
        }
        None
    }

    pub(super) fn has_established_tcp(pid: u32) -> Option<bool> {
        let v4 = table(AF_INET);
        let v6 = table(AF_INET6);
        if v4.is_none() && v6.is_none() {
            return None;
        }
        let family = super::with_descendants(pid, &process_pairs());
        Some(family.iter().any(|&p| {
            v4.as_deref().is_some_and(|t| owns_established(t, p, &V4))
                || v6.as_deref().is_some_and(|t| owns_established(t, p, &V6))
        }))
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod imp {
    pub(super) fn has_established_tcp(_pid: u32) -> Option<bool> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Windows owner-pid table in memory: the row count, then each row
    /// with only its state and owning pid filled in.
    fn owner_pid_table(rows: &[(u32, u32)], layout: &owner_pid_table::RowLayout) -> Vec<u8> {
        let mut t = (rows.len() as u32).to_ne_bytes().to_vec();
        for &(state, pid) in rows {
            let mut row = vec![0u8; layout.size];
            row[layout.state_at..layout.state_at + 4].copy_from_slice(&state.to_ne_bytes());
            row[layout.pid_at..layout.pid_at + 4].copy_from_slice(&pid.to_ne_bytes());
            t.extend(row);
        }
        t
    }

    #[test]
    fn a_process_s_family_includes_what_it_started_and_nothing_else() {
        // shim 10 started plink 11, which started 12; 20 is unrelated, and
        // pid 0 is its own parent (the System Idle Process).
        let pairs = [(10, 1), (11, 10), (12, 11), (20, 1), (0, 0)];
        let family = with_descendants(10, &pairs);
        assert_eq!(family, std::collections::HashSet::from([10, 11, 12]));
        assert_eq!(with_descendants(0, &pairs), std::collections::HashSet::from([0]));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_connection_made_by_a_child_process_counts() {
        // The shim case: the process Plinky started is not the one that
        // connects -- its child is.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut parent = std::process::Command::new("bash")
            .args(["-c", &format!("(exec 3<>/dev/tcp/127.0.0.1/{port}; sleep 3); wait")])
            .spawn()
            .unwrap();
        let _accepted = listener.accept().unwrap();
        let mut seen = false;
        for _ in 0..100 {
            if has_established_tcp(parent.id()) == Some(true) {
                seen = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = parent.kill();
        let _ = parent.wait();
        assert!(seen, "the child's connection was not seen through the parent's pid");
    }

    #[test]
    fn finds_a_process_s_established_row_in_a_windows_table() {
        use owner_pid_table::{owns_established, V4, V6};
        for layout in [&V4, &V6] {
            // SYN_SENT (3) is a connect still in progress; ESTAB is 5.
            let connecting = owner_pid_table(&[(3, 4242)], layout);
            assert!(!owns_established(&connecting, 4242, layout));
            let connected = owner_pid_table(&[(3, 4242), (5, 1000), (5, 4242)], layout);
            assert!(owns_established(&connected, 4242, layout));
            assert!(!owns_established(&connected, 7, layout), "another process's connection");
        }
    }

    #[test]
    fn a_short_windows_table_is_read_only_as_far_as_it_goes() {
        use owner_pid_table::{owns_established, V4};
        let mut t = owner_pid_table(&[(5, 4242)], &V4);
        t[..4].copy_from_slice(&1000u32.to_ne_bytes()); // claims 1000 rows
        assert!(owns_established(&t, 4242, &V4));
        assert!(!owns_established(&t[..10], 4242, &V4));
        assert!(!owns_established(&[], 4242, &V4));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_the_established_sockets_out_of_a_kernel_table() {
        // /proc/net/tcp as the kernel writes it: one LISTEN (0A), one
        // ESTABLISHED (01), one SYN_SENT (02, a connect still in progress).
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:D2F0 0100007F:1392 01 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:D2F4 1E0A0A0A:13A2 02 00000001:00000000 01:00000064 00000000  1000        0 33333 2 0000000000000000 100 0 0 10 -1
";
        let est = imp::established_inodes(table);
        assert!(est.contains(&22222));
        assert!(!est.contains(&11111), "listening is not connected");
        assert!(!est.contains(&33333), "a connect in progress is not connected");
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn sees_a_connection_this_process_holds() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let _client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let _server = listener.accept().unwrap();
        assert_eq!(has_established_tcp(std::process::id()), Some(true));
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn a_process_without_connections_has_none() {
        #[cfg(windows)]
        let mut child = std::process::Command::new("ping").args(["-n", "3", "127.0.0.1"])
            .stdout(std::process::Stdio::null()).spawn().unwrap();
        #[cfg(not(windows))]
        let mut child = std::process::Command::new("sleep").arg("2").spawn().unwrap();
        assert_eq!(has_established_tcp(child.id()), Some(false));
        let _ = child.kill();
        let _ = child.wait();
        // Gone: Linux can tell nothing more; Windows just finds no rows.
        #[cfg(target_os = "linux")]
        assert_eq!(has_established_tcp(child.id()), None);
    }
}
