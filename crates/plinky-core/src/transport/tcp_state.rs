//! Whether a process has an established TCP connection, from the kernel's
//! own tables.
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
/// while it doesn't, `None` where this can't be told: the process is gone,
/// or the platform has no way here (only Linux, for now).
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

#[cfg(not(target_os = "linux"))]
mod imp {
    pub(super) fn has_established_tcp(_pid: u32) -> Option<bool> {
        None
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

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

    #[test]
    fn sees_a_connection_this_process_holds() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let _client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let _server = listener.accept().unwrap();
        assert_eq!(has_established_tcp(std::process::id()), Some(true));
    }

    #[test]
    fn a_process_without_connections_has_none() {
        let mut child = std::process::Command::new("sleep").arg("2").spawn().unwrap();
        assert_eq!(has_established_tcp(child.id()), Some(false));
        let _ = child.kill();
        let _ = child.wait();
        // Gone: nothing can be told.
        assert_eq!(has_established_tcp(child.id()), None);
    }
}
