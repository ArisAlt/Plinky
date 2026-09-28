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

/// `Some(true)` once `pid` holds an ESTABLISHED TCP socket, `Some(false)`
/// while it doesn't, `None` where this can't be told: the tables can't be
/// read, the process is gone (Linux), or the platform has no way here.
pub fn has_established_tcp(pid: u32) -> Option<bool> {
    imp::has_established_tcp(pid)
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

    pub(super) fn has_established_tcp(pid: u32) -> Option<bool> {
        let mine = socket_inodes(pid)?;
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
        Some(
            v4.is_some_and(|t| owns_established(&t, pid, &V4))
                || v6.is_some_and(|t| owns_established(&t, pid, &V6)),
        )
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
