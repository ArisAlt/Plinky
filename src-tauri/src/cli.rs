//! Launch arguments that ask Plinky to open a console tab (T-020).
//!
//! GNS3's "Custom" console command runs Plinky once per device:
//!
//! ```text
//! plinky --telnet {host} {port} --title "{name}"
//! ```
//!
//! "Open all consoles" does that twenty times at once; the single-instance
//! plugin forwards every later launch to the running window, which turns
//! each request into a tab.
//!
//! Anything on the machine can start Plinky with arguments, so they are
//! treated as untrusted: a host or user starting with `-` is refused (plink
//! would read it as one of its own options), control characters are
//! stripped from titles, and anything unrecognised is ignored -- the
//! runtime may add arguments of its own.

use plinky_core::transport::plink::TargetProtocol;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub protocol: TargetProtocol,
    pub host: String,
    pub port: u16,
    pub title: Option<String>,
    pub user: Option<String>,
    /// The session already started for it (lib.rs start_console_session);
    /// the tab attaches to this id. None: the tab starts it itself.
    pub session_id: Option<String>,
}

impl OpenRequest {
    /// `telnet://127.0.0.1:5000`, `ssh://[2001:db8::1]:22`: the name the tab
    /// shows it under, the same as cliOpen.ts builds. Never the title, or a
    /// saved PuTTY session named like the device would be -loaded instead.
    pub fn session_name(&self) -> String {
        let scheme = match self.protocol {
            TargetProtocol::Ssh => "ssh",
            TargetProtocol::Telnet => "telnet",
            TargetProtocol::Raw => "raw",
        };
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        format!("{scheme}://{host}:{}", self.port)
    }
}

const MAX_TITLE: usize = 80;

/// A host plink can be given as its target argument.
fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && !h.starts_with('-')
        && !h.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn valid_user(u: &str) -> bool {
    !u.is_empty() && !u.starts_with('-') && !u.chars().any(|c| c.is_whitespace() || c.is_control() || c == '@')
}

/// `[::1]` → `::1`; anything else unchanged.
fn unbracket(h: &str) -> &str {
    h.strip_prefix('[').and_then(|x| x.strip_suffix(']')).unwrap_or(h)
}

fn parse_port(p: &str) -> Option<u16> {
    p.parse::<u16>().ok().filter(|&n| n > 0)
}

fn clean_title(t: &str) -> Option<String> {
    let cleaned: String = t.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.chars().take(MAX_TITLE).collect())
}

/// `[user@]host[:port]`, host possibly `[v6]` or bare IPv6.
fn parse_ssh_target(spec: &str) -> Option<(Option<String>, String, u16)> {
    let (user, rest) = match spec.rsplit_once('@') {
        Some((u, r)) => (Some(u), r),
        None => (None, spec),
    };
    if let Some(u) = user {
        if !valid_user(u) {
            return None;
        }
    }
    let (host, port) = if let Some(inner) = rest.strip_prefix('[') {
        // [v6] or [v6]:port
        let (h, after) = inner.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(p) => parse_port(p)?,
            None if after.is_empty() => 22,
            None => return None,
        };
        (h.to_string(), port)
    } else if rest.matches(':').count() == 1 {
        let (h, p) = rest.split_once(':')?;
        (h.to_string(), parse_port(p)?)
    } else {
        // No port, or a bare IPv6 address (several colons, no brackets).
        (rest.to_string(), 22)
    };
    valid_host(&host).then(|| (user.map(str::to_string), host, port))
}

/// Every open request in `args` (a whole argv, program name included).
pub fn parse_args(args: &[String]) -> Vec<OpenRequest> {
    let mut out: Vec<OpenRequest> = Vec::new();
    // A title given before any target applies to the next one.
    let mut pending_title: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        let protocol = match arg {
            "--telnet" => Some(TargetProtocol::Telnet),
            "--raw" => Some(TargetProtocol::Raw),
            _ => None,
        };
        if let Some(protocol) = protocol {
            let host = args.get(i + 1).map(|h| unbracket(h).to_string());
            let port = args.get(i + 2).and_then(|p| parse_port(p));
            match (host, port) {
                (Some(host), Some(port)) if valid_host(&host) => {
                    out.push(OpenRequest { protocol, host, port, title: pending_title.take(), user: None, session_id: None });
                    i += 3;
                }
                _ => i += 1, // incomplete: skip the flag, keep reading
            }
            continue;
        }
        match arg {
            "--ssh" => {
                if let Some((user, host, port)) = args.get(i + 1).and_then(|s| parse_ssh_target(s)) {
                    out.push(OpenRequest {
                        protocol: TargetProtocol::Ssh,
                        host,
                        port,
                        title: pending_title.take(),
                        user,
                        session_id: None,
                    });
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "--title" => {
                if let Some(title) = args.get(i + 1).and_then(|t| clean_title(t)) {
                    match out.last_mut() {
                        Some(last) if last.title.is_none() => last.title = Some(title),
                        _ => pending_title = Some(title),
                    }
                    i += 2;
                } else {
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    fn telnet(host: &str, port: u16, title: Option<&str>) -> OpenRequest {
        OpenRequest {
            protocol: TargetProtocol::Telnet,
            host: host.into(),
            port,
            title: title.map(str::to_string),
            user: None,
            session_id: None,
        }
    }

    #[test]
    fn a_console_is_named_by_its_address_the_way_the_page_names_it() {
        // cliOpen.ts builds the same string for the tab's sessionName.
        assert_eq!(telnet("127.0.0.1", 5000, Some("R1")).session_name(), "telnet://127.0.0.1:5000");
        let v6 = parse_args(&argv(&["plinky", "--ssh", "ops@[2001:db8::1]:2222"]));
        assert_eq!(v6[0].session_name(), "ssh://[2001:db8::1]:2222");
        let raw = parse_args(&argv(&["plinky", "--raw", "10.0.0.2", "2001"]));
        assert_eq!(raw[0].session_name(), "raw://10.0.0.2:2001");
    }

    #[test]
    fn reads_gns3s_console_command() {
        // GNS3 on Linux: plinky --telnet {host} {port} --title "{name}"
        let r = parse_args(&argv(&["/opt/Plinky.AppImage", "--telnet", "127.0.0.1", "5000", "--title", "R1 core"]));
        assert_eq!(r, vec![telnet("127.0.0.1", 5000, Some("R1 core"))]);
    }

    #[test]
    fn several_targets_each_keep_their_own_title() {
        let r = parse_args(&argv(&[
            "plinky", "--telnet", "127.0.0.1", "5000", "--title", "R1", "--raw", "10.0.0.2", "2001", "--title", "SW1",
        ]));
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title.as_deref(), Some("R1"));
        assert_eq!(r[1].protocol, TargetProtocol::Raw);
        assert_eq!(r[1].title.as_deref(), Some("SW1"));
    }

    #[test]
    fn a_title_before_the_target_still_applies() {
        let r = parse_args(&argv(&["plinky", "--title", "R2", "--telnet", "h", "5001"]));
        assert_eq!(r, vec![telnet("h", 5001, Some("R2"))]);
    }

    #[test]
    fn an_incomplete_target_opens_nothing() {
        assert!(parse_args(&argv(&["plinky", "--telnet", "127.0.0.1"])).is_empty());
        assert!(parse_args(&argv(&["plinky", "--telnet", "127.0.0.1", "--title", "R1"])).is_empty());
        assert!(parse_args(&argv(&["plinky", "--telnet", "127.0.0.1", "0"])).is_empty());
        assert!(parse_args(&argv(&["plinky", "--telnet", "127.0.0.1", "70000"])).is_empty());
    }

    #[test]
    fn ipv6_hosts_lose_their_brackets() {
        let r = parse_args(&argv(&["plinky", "--telnet", "[::1]", "5000"]));
        assert_eq!(r[0].host, "::1");
        let s = parse_args(&argv(&["plinky", "--ssh", "ops@[2001:db8::1]:2222"]));
        assert_eq!((s[0].user.as_deref(), s[0].host.as_str(), s[0].port), (Some("ops"), "2001:db8::1", 2222));
        let bare = parse_args(&argv(&["plinky", "--ssh", "2001:db8::1"]));
        assert_eq!((bare[0].host.as_str(), bare[0].port), ("2001:db8::1", 22));
    }

    #[test]
    fn ssh_targets_take_user_and_port() {
        let r = parse_args(&argv(&["plinky", "--ssh", "admin@core-sw1:2200", "--title", "core"]));
        assert_eq!(r[0].protocol, TargetProtocol::Ssh);
        assert_eq!((r[0].user.as_deref(), r[0].host.as_str(), r[0].port), (Some("admin"), "core-sw1", 2200));
        assert_eq!(parse_args(&argv(&["plinky", "--ssh", "core-sw1"]))[0].port, 22);
    }

    #[test]
    fn nothing_that_looks_like_a_plink_option_gets_through() {
        // Any program can launch Plinky with arguments; a host of "-proxycmd"
        // would reach plink as an option of its own.
        assert!(parse_args(&argv(&["plinky", "--telnet", "-proxycmd", "5000"])).is_empty());
        assert!(parse_args(&argv(&["plinky", "--ssh", "-oProxyCommand=x"])).is_empty());
        assert!(parse_args(&argv(&["plinky", "--ssh", "-l@host"])).is_empty());
        assert!(parse_args(&argv(&["plinky", "--telnet", "host name", "5000"])).is_empty());
    }

    #[test]
    fn titles_are_cleaned_and_capped() {
        let r = parse_args(&argv(&["plinky", "--telnet", "h", "1", "--title", "R1\u{1b}[31m\n evil"]));
        assert_eq!(r[0].title.as_deref(), Some("R1[31m evil"));
        let long = "x".repeat(200);
        let r = parse_args(&argv(&["plinky", "--telnet", "h", "1", "--title", &long]));
        assert_eq!(r[0].title.as_ref().map(|t| t.len()), Some(MAX_TITLE));
        let r = parse_args(&argv(&["plinky", "--telnet", "h", "1", "--title", "  \t "]));
        assert_eq!(r[0].title, None);
    }

    #[test]
    fn unknown_arguments_are_ignored() {
        let r = parse_args(&argv(&["plinky", "--no-sandbox", "--telnet", "h", "5000", "--whatever"]));
        assert_eq!(r, vec![telnet("h", 5000, None)]);
        assert!(parse_args(&argv(&["plinky"])).is_empty());
    }
}
