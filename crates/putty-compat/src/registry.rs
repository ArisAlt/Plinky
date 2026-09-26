//! PuTTY for Windows keeps saved sessions and SSH host keys in the registry,
//! not in files:
//!
//! ```text
//! HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\<escaped name>
//! HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\SshHostKeys
//! ```
//!
//! plink -load only ever looks there, so on Windows a session saved anywhere
//! else can't connect. PuTTY for Windows has no PUTTYDIR either, and Plinky
//! ignores it there too: a PUTTYDIR store on Windows would only hold sessions
//! plink can't load.
//!
//! Everything here follows PuTTY 0.85's windows/storage.c,
//! windows/utils/registry.c and windows/utils/escape_registry_key.c. The
//! escaping and value-type rules are plain functions so they're tested on
//! every platform; the registry I/O is Windows-only. The `*_in` functions
//! take the key path below HKEY_CURRENT_USER so tests can use a scratch key
//! instead of the user's real PuTTY settings.

#[cfg(windows)]
pub use io::*;

/// PuTTY's PUTTY_REG_POS, below HKEY_CURRENT_USER.
pub const PUTTY_KEY: &str = r"Software\SimonTatham\PuTTY";
pub const SESSIONS_KEY: &str = r"Software\SimonTatham\PuTTY\Sessions";
pub const HOST_KEYS_KEY: &str = r"Software\SimonTatham\PuTTY\SshHostKeys";

/// PuTTY's escape_registry_key: %XX for space, `\`, `*`, `?`, `%`, control
/// and non-ASCII bytes, and a leading `.`; everything else stays as is.
///
/// Not the file store's escaping ([`crate::escape_session_name`]), which
/// also escapes `/`, `:`, `@` and more. The same session has a different
/// name in each store, and a registry key named the file way is one plink
/// -load never finds ("myserver/prod" is `myserver/prod` here, not
/// `myserver%2Fprod`).
pub fn escape_registry_key(name: &str) -> String {
    let bytes = code_page::encode(name);
    let mut out = String::with_capacity(bytes.len() * 3);
    for (i, &b) in bytes.iter().enumerate() {
        let escape = matches!(b, b' ' | b'\\' | b'*' | b'?' | b'%')
            || !(b' '..=b'~').contains(&b)
            || (b == b'.' && i == 0);
        if escape {
            out.push_str(&format!("%{b:02X}"));
        } else {
            out.push(b as char);
        }
    }
    out
}

/// PuTTY's unescape_registry_key.
pub fn unescape_registry_key(key: &str) -> String {
    code_page::decode(&crate::sessions::percent_decode(key))
}

/// Settings PuTTY saves as REG_DWORD (write_setting_i, and write_setting_b as
/// 0/1); every other value is REG_SZ. The type matters: PuTTY reads a value
/// only if it has the type it expects (get_reg_dword / get_reg_sz check),
/// so `PortNumber` saved as the string "2222" is ignored and plink connects
/// to port 22.
///
/// From PuTTY 0.85: every INT, BOOL and font-size option in conf.h with a
/// SAVE_KEYWORD, the ones settings.c saves by hand (Present, PingInterval,
/// ...), and older keys it still reads as numbers (BugDHGEx2, ProxyType, ...).
#[rustfmt::skip]
const DWORD_SETTINGS: &[&str] = &[
    "ANSIColour", "AddressFamily", "AgentFwd", "AltF4", "AltOnly", "AltSpace", "AlwaysOnTop",
    "ApplicationCursorKeys", "ApplicationKeypad", "AuthGSSAPI", "AuthGSSAPIKEX", "AuthKI",
    "AuthTIS", "AutoWrapMode", "BCE", "BackspaceIsDelete", "Beep", "BeepInd", "BellOverload",
    "BellOverloadN", "BellOverloadS", "BellOverloadT", "BlinkCur", "BlinkText", "BoldAsColour",
    "BoldFontCharSet", "BoldFontHeight", "BoldFontIsBold", "BugChanReq", "BugDHGEx2",
    "BugDeriveKey2", "BugDropStart", "BugFilterKexinit", "BugHMAC2", "BugIgnore1",
    "BugIgnore2", "BugMaxPkt2", "BugOldGex2", "BugPKSessID2", "BugPlainPW1", "BugRSA1",
    "BugRSAPad2", "BugRSASHA2CertUserauth", "BugRekey2", "BugWinadj", "BuggyMAC",
    "CJKAmbigWide", "CRImpliesLF", "CapsLockCyr", "ChangeUsername", "CloseOnExit",
    "ComposeKey", "Compression", "ConnectionSharing", "ConnectionSharingDownstream",
    "ConnectionSharingUpstream", "CtrlAltKeys", "CurType", "DECOriginMode",
    "DisableArabicShaping", "DisableBidi", "DisableBracketedPaste", "EraseToScrollback",
    "FontCharSet", "FontHeight", "FontIsBold", "FontQuality", "FontVTMode",
    "FullScreenOnAltEnter", "GssapiFwd", "GssapiRekey", "HideMousePtr", "LFImpliesCR",
    "LinuxFunctionKeys", "LocalEcho", "LocalEdit", "LocalPortAcceptAll", "LockSize",
    "LogFileClash", "LogFlush", "LogHeader", "LogType", "LoginShell", "MouseAutocopy",
    "MouseIsXterm", "MouseOverride", "NetHackKeypad", "NoAltScreen", "NoApplicationCursors",
    "NoApplicationKeys", "NoDBackspace", "NoMouseReporting", "NoPTY", "NoRemoteCharset",
    "NoRemoteClearScroll", "NoRemoteQTitle", "NoRemoteResize", "NoRemoteWinTitle",
    "OSXCommandMeta", "OSXOptionMeta", "PassiveTelnet", "PasteControls", "PasteRTF",
    "PingInterval", "PingIntervalSecs", "PortNumber", "PreferKnownHostKeys", "Present",
    "ProxyDNS", "ProxyLocalhost", "ProxyLogToTerm", "ProxyMethod", "ProxyPort",
    "ProxySOCKSVersion", "ProxyType", "RFCEnviron", "RXVTHomeEnd", "RawCNP", "RectSelect",
    "RekeyTime", "RemotePortAcceptAll", "RemoteQTitleAction", "SSH2DES", "SSHLogOmitData",
    "SSHLogOmitPasswords", "SUPDUPCharset", "SUPDUPMoreProcessing", "SUPDUPScrolling",
    "ScrollBar", "ScrollBarFullScreen", "ScrollOnDisp", "ScrollOnKey", "ScrollbackLines",
    "ScrollbarOnLeft", "SerialDataBits", "SerialFlowControl", "SerialParity", "SerialSpeed",
    "SerialStopHalfbits", "ShadowBold", "ShadowBoldOffset", "ShiftedArrowKeys", "SshBanner",
    "SshNoAuth", "SshNoShell", "SshNoTrivialAuth", "SshProt", "StampUtmp", "SunkenEdge",
    "TCPKeepalives", "TCPNoDelay", "TelnetKey", "TelnetRet", "TermHeight", "TermWidth",
    "TrueColour", "TryAgent", "TryPalette", "UTF8Override", "UTF8linedraw", "UseSystemColours",
    "UserNameFromEnvironment", "WarnOnClose", "WideBoldFontCharSet", "WideBoldFontHeight",
    "WideBoldFontIsBold", "WideFontCharSet", "WideFontHeight", "WideFontIsBold",
    "WinNameAlways", "WindowBorder", "X11AuthType", "X11Forward", "Xterm256Colour",
];

/// Whether PuTTY saves `key` as REG_DWORD. Value names are case-insensitive
/// in the registry, so this is too.
pub fn stores_as_dword(key: &str) -> bool {
    DWORD_SETTINGS.iter().any(|k| k.eq_ignore_ascii_case(key))
}

/// The number PuTTY would store for `value`, if it is one. PuTTY writes an
/// int's bits into the DWORD, so negative numbers wrap the same way.
pub fn parse_dword(value: &str) -> Option<u32> {
    let value = value.trim();
    value
        .parse::<i32>()
        .map(|n| n as u32)
        .or_else(|_| value.parse::<u32>())
        .ok()
}

/// How PuTTY's non-Unicode build turns a session name into the bytes it
/// escapes: the ANSI code page on Windows. Elsewhere this is only reached by
/// tests, and UTF-8 stands in.
mod code_page {
    #[cfg(not(windows))]
    pub fn encode(s: &str) -> Vec<u8> {
        s.as_bytes().to_vec()
    }

    #[cfg(not(windows))]
    pub fn decode(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    #[cfg(windows)]
    pub use self::windows::{decode, encode};

    #[cfg(windows)]
    pub mod windows {
        use std::ptr;

        const CP_ACP: u32 = 0;
        const CP_UTF8: u32 = 65001;
        const WC_NO_BEST_FIT_CHARS: u32 = 0x400;

        #[link(name = "kernel32")]
        extern "system" {
            fn GetACP() -> u32;
            fn WideCharToMultiByte(
                code_page: u32,
                flags: u32,
                wide: *const u16,
                wide_len: i32,
                out: *mut u8,
                out_len: i32,
                default_char: *const u8,
                used_default_char: *mut i32,
            ) -> i32;
            fn MultiByteToWideChar(
                code_page: u32,
                flags: u32,
                bytes: *const u8,
                bytes_len: i32,
                out: *mut u16,
                out_len: i32,
            ) -> i32;
        }

        pub fn ansi_code_page() -> u32 {
            // SAFETY: no arguments, no preconditions.
            unsafe { GetACP() }
        }

        /// PuTTY's view of `s`: its ANSI-code-page bytes (the same bytes plink
        /// gets for a `-load` argument). A name with characters the code page
        /// can't hold, which PuTTY couldn't have saved, keeps its UTF-8 bytes
        /// so Plinky at least finds its own session again.
        pub fn encode(s: &str) -> Vec<u8> {
            if s.is_ascii() || ansi_code_page() == CP_UTF8 {
                return s.as_bytes().to_vec();
            }
            to_ansi(s).unwrap_or_else(|| s.as_bytes().to_vec())
        }

        pub fn decode(bytes: &[u8]) -> String {
            if bytes.is_ascii() || ansi_code_page() == CP_UTF8 {
                return String::from_utf8_lossy(bytes).into_owned();
            }
            from_ansi(bytes).unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
        }

        fn to_ansi(s: &str) -> Option<Vec<u8>> {
            let wide: Vec<u16> = s.encode_utf16().collect();
            let wide_len = i32::try_from(wide.len()).ok()?;
            let mut used_default = 0;
            // SAFETY: `wide` is valid for `wide_len` u16s; a null output with
            // length 0 only asks for the size.
            let len = unsafe {
                WideCharToMultiByte(
                    CP_ACP,
                    WC_NO_BEST_FIT_CHARS,
                    wide.as_ptr(),
                    wide_len,
                    ptr::null_mut(),
                    0,
                    ptr::null(),
                    &mut used_default,
                )
            };
            if len <= 0 || used_default != 0 {
                return None;
            }
            let mut out = vec![0u8; len as usize];
            // SAFETY: `out` has room for the `len` bytes just measured.
            let written = unsafe {
                WideCharToMultiByte(
                    CP_ACP,
                    WC_NO_BEST_FIT_CHARS,
                    wide.as_ptr(),
                    wide_len,
                    out.as_mut_ptr(),
                    len,
                    ptr::null(),
                    &mut used_default,
                )
            };
            (written == len && used_default == 0).then_some(out)
        }

        fn from_ansi(bytes: &[u8]) -> Option<String> {
            let bytes_len = i32::try_from(bytes.len()).ok()?;
            // SAFETY: `bytes` is valid for `bytes_len` bytes; a null output
            // with length 0 only asks for the size.
            let len = unsafe {
                MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), bytes_len, ptr::null_mut(), 0)
            };
            if len <= 0 {
                return None;
            }
            let mut wide = vec![0u16; len as usize];
            // SAFETY: `wide` has room for the `len` u16s just measured.
            let written = unsafe {
                MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), bytes_len, wide.as_mut_ptr(), len)
            };
            (written == len).then(|| String::from_utf16_lossy(&wide))
        }
    }
}

#[cfg(windows)]
mod io {
    use std::collections::BTreeMap;
    use std::io::ErrorKind;
    use std::path::PathBuf;

    use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ};
    use winreg::types::{FromRegValue, ToRegValue};
    use winreg::{RegKey, RegValue};

    use super::{escape_registry_key, parse_dword, stores_as_dword, unescape_registry_key};
    use crate::errors::{PuttyCompatError, Result};
    use crate::hostkeys::{parse_host_key_target, HostKeyEntry};
    use crate::sessions::{apply_setting, saved_settings, PuttySession, SessionRef};

    fn hkcu() -> RegKey {
        RegKey::predef(HKEY_CURRENT_USER)
    }

    fn reg_err(key: &str) -> impl Fn(std::io::Error) -> PuttyCompatError + '_ {
        move |source| PuttyCompatError::Registry {
            key: key.to_string(),
            source,
        }
    }

    /// PuTTY saves an unnamed session as "Default Settings"; an empty name
    /// here would otherwise write straight into the Sessions key itself.
    fn session_key_path(sessions_key: &str, name: &str) -> String {
        let name = if name.is_empty() {
            "Default Settings"
        } else {
            name
        };
        format!(r"{sessions_key}\{}", escape_registry_key(name))
    }

    /// Opens `path` for reading; `None` if it doesn't exist.
    fn open_existing(path: &str) -> Result<Option<RegKey>> {
        match hkcu().open_subkey_with_flags(path, KEY_READ) {
            Ok(key) => Ok(Some(key)),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(reg_err(path)(e)),
        }
    }

    /// The text of a value PuTTY would read: REG_SZ as is, REG_DWORD as the
    /// decimal int PuTTY's file store would have written. PuTTY ignores
    /// every other type in a session key, and so does Plinky.
    fn setting_text(value: &RegValue) -> std::io::Result<Option<String>> {
        match value.vtype {
            RegType::REG_SZ => String::from_reg_value(value).map(Some),
            RegType::REG_DWORD => u32::from_reg_value(value).map(|n| Some((n as i32).to_string())),
            _ => Ok(None),
        }
    }

    pub fn list_sessions_in(sessions_key: &str) -> Result<Vec<SessionRef>> {
        let Some(key) = open_existing(sessions_key)? else {
            return Ok(Vec::new());
        };
        let mut sessions = Vec::new();
        for escaped in key.enum_keys() {
            let escaped = escaped.map_err(reg_err(sessions_key))?;
            sessions.push(SessionRef {
                name: unescape_registry_key(&escaped),
                path: PathBuf::from(format!(r"HKEY_CURRENT_USER\{sessions_key}\{escaped}")),
                filename: escaped,
            });
        }
        sessions.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(sessions)
    }

    pub fn read_session_in(sessions_key: &str, name: &str) -> Result<PuttySession> {
        let path = session_key_path(sessions_key, name);
        let Some(key) = open_existing(&path)? else {
            return Err(PuttyCompatError::SessionNotFound(name.to_string()));
        };
        let mut session = PuttySession {
            name: name.to_string(),
            ..Default::default()
        };
        for item in key.enum_values() {
            let (value_name, value) = item.map_err(reg_err(&path))?;
            if let Some(text) = setting_text(&value).map_err(reg_err(&path))? {
                apply_setting(&mut session, value_name, text);
            }
        }
        Ok(session)
    }

    /// Replaces the session's settings, like the file store rewriting the
    /// whole file: a setting dropped from `extra` goes, anything PuTTY
    /// doesn't read (other value types, subkeys) is left alone.
    ///
    /// Numbers go in as REG_DWORD when PuTTY stores that setting as one
    /// ([`stores_as_dword`]) or when the value being replaced already was a
    /// DWORD (a setting from a newer PuTTY); everything else is REG_SZ. A
    /// DWORD setting that isn't a number is kept as the string it is: PuTTY
    /// falls back to its default for it either way, and refusing to save
    /// would lock the whole session over one field.
    pub fn write_session_in(sessions_key: &str, session: &PuttySession) -> Result<()> {
        let path = session_key_path(sessions_key, &session.name);
        let err = reg_err(&path);
        let (key, _) = hkcu().create_subkey(&path).map_err(&err)?;

        // Registry value names are case-insensitive, so match on lowercase.
        let mut previous: BTreeMap<String, (String, bool)> = BTreeMap::new();
        for item in key.enum_values() {
            let (value_name, value) = item.map_err(&err)?;
            let is_dword = match value.vtype {
                RegType::REG_DWORD => true,
                RegType::REG_SZ => false,
                _ => continue,
            };
            previous.insert(value_name.to_ascii_lowercase(), (value_name, is_dword));
        }

        for (value_name, text) in saved_settings(session) {
            let was_dword = previous
                .remove(&value_name.to_ascii_lowercase())
                .is_some_and(|(_, is_dword)| is_dword);
            let value = match parse_dword(&text) {
                Some(n) if was_dword || stores_as_dword(value_name) => n.to_reg_value(),
                _ => text.to_reg_value(),
            };
            key.set_raw_value(value_name, &value).map_err(&err)?;
        }

        for (value_name, _) in previous.into_values() {
            key.delete_value(&value_name).map_err(&err)?;
        }
        Ok(())
    }

    pub fn delete_session_in(sessions_key: &str, name: &str) -> Result<()> {
        let path = session_key_path(sessions_key, name);
        hkcu().delete_subkey_all(&path).map_err(|e| match e.kind() {
            ErrorKind::NotFound => PuttyCompatError::SessionNotFound(name.to_string()),
            _ => reg_err(&path)(e),
        })
    }

    /// PuTTY names each value `<key type>@<port>:<escaped host>` and stores
    /// the key as REG_SZ. Pre-0.52 RSA entries (named by bare host) and any
    /// non-string values are skipped, as the file parser skips lines it
    /// can't read.
    pub fn list_host_keys_in(host_keys_key: &str) -> Result<Vec<HostKeyEntry>> {
        let Some(key) = open_existing(host_keys_key)? else {
            return Ok(Vec::new());
        };
        let mut entries = Vec::new();
        for item in key.enum_values() {
            let (value_name, value) = item.map_err(reg_err(host_keys_key))?;
            if value.vtype != RegType::REG_SZ {
                continue;
            }
            let Some((key_type, port, host)) = parse_host_key_target(&value_name) else {
                continue;
            };
            entries.push(HostKeyEntry {
                key_type,
                host: unescape_registry_key(host),
                port,
                raw_key: String::from_reg_value(&value).map_err(reg_err(host_keys_key))?,
            });
        }
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_what_putty_for_windows_escapes() {
        let cases = [
            ("Default Settings", "Default%20Settings"),
            ("10.10.10.10 ", "10.10.10.10%20"),
            ("COM USB0", "COM%20USB0"),
            // Kept as is in the registry, escaped in the file store.
            ("myserver/prod:22", "myserver/prod:22"),
            ("admin@core-sw1+lab", "admin@core-sw1+lab"),
            ("a\\b*c?d%e", "a%5Cb%2Ac%3Fd%25e"),
            ("tab\there", "tab%09here"),
            ("del\u{7f}", "del%7F"),
            // Only a leading dot is escaped.
            (".hidden.box", "%2Ehidden.box"),
            ("normal-name_123.test", "normal-name_123.test"),
        ];
        for (name, key) in cases {
            assert_eq!(escape_registry_key(name), key, "escaping {name:?}");
            assert_eq!(unescape_registry_key(key), name, "unescaping {key:?}");
        }
    }

    #[test]
    fn escaped_names_never_nest_keys() {
        assert!(!escape_registry_key(r"core\sw1").contains('\\'));
    }

    #[test]
    fn dword_settings_match_putty() {
        for key in [
            "PortNumber",
            "TCPKeepalives",
            "SerialSpeed",
            "CloseOnExit",
            "FontHeight",
            "Present",
        ] {
            assert!(stores_as_dword(key), "{key} is a REG_DWORD in PuTTY");
        }
        assert!(
            stores_as_dword("portnumber"),
            "value names are case-insensitive"
        );
        for key in [
            "HostName",
            "UserName",
            "Protocol",
            "PublicKeyFile",
            "LogFileName",
            "SerialLine",
            "Colour0",
            "Font",
            "PlinkyTags",
        ] {
            assert!(!stores_as_dword(key), "{key} is a REG_SZ in PuTTY");
        }
    }

    #[test]
    fn dword_values_parse_like_putty_ints() {
        assert_eq!(parse_dword("2222"), Some(2222));
        assert_eq!(parse_dword(" 1 "), Some(1));
        assert_eq!(parse_dword("-1"), Some(u32::MAX));
        assert_eq!(parse_dword("4294967295"), Some(u32::MAX));
        assert_eq!(parse_dword("fast"), None);
        assert_eq!(parse_dword(""), None);
    }
}

/// Registry round trips against a scratch key under HKEY_CURRENT_USER, never
/// PuTTY's own: the user's real sessions are not test fixtures.
#[cfg(all(test, windows))]
mod windows_tests {
    use std::collections::BTreeMap;

    use winreg::enums::{RegType, HKEY_CURRENT_USER};
    use winreg::{RegKey, RegValue};

    use super::*;
    use crate::errors::PuttyCompatError;
    use crate::sessions::PuttySession;

    /// `Software\PlinkyTest-<pid>-<n>`, deleted with everything in it on drop.
    struct ScratchKey {
        root: String,
    }

    impl ScratchKey {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let root = format!(
                r"Software\PlinkyTest-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
            assert!(!root.starts_with(PUTTY_KEY));
            Self { root }
        }

        fn sessions(&self) -> String {
            format!(r"{}\Sessions", self.root)
        }

        fn host_keys(&self) -> String {
            format!(r"{}\SshHostKeys", self.root)
        }

        /// Read-write, to plant values the way PuTTY would have.
        fn open(&self, sub: &str) -> RegKey {
            RegKey::predef(HKEY_CURRENT_USER)
                .create_subkey(format!(r"{}\{sub}", self.root))
                .unwrap()
                .0
        }
    }

    impl Drop for ScratchKey {
        fn drop(&mut self) {
            let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.root);
        }
    }

    fn switch() -> PuttySession {
        let mut extra = BTreeMap::new();
        extra.insert("TCPKeepalives".to_string(), "1".to_string());
        extra.insert("SerialSpeed".to_string(), "9600".to_string());
        extra.insert("Colour0".to_string(), "187,187,187".to_string());
        extra.insert("PlinkyTags".to_string(), "core,lab".to_string());
        PuttySession {
            name: "core/sw1 lab".to_string(),
            host_name: "10.0.0.1".to_string(),
            port_number: 2222,
            user_name: "admin".to_string(),
            protocol: "telnet".to_string(),
            public_key_file: r"C:\keys\admin.ppk".to_string(),
            log_file_name: r"C:\logs\sw1.log".to_string(),
            extra,
        }
    }

    #[test]
    fn saved_session_lands_where_and_how_putty_reads_it() {
        let scratch = ScratchKey::new();
        write_session_in(&scratch.sessions(), &switch()).unwrap();

        let key = scratch.open(r"Sessions\core/sw1%20lab");
        let vtype = |name: &str| key.get_raw_value(name).unwrap().vtype;
        for name in ["PortNumber", "TCPKeepalives", "SerialSpeed"] {
            assert_eq!(vtype(name), RegType::REG_DWORD, "{name}");
        }
        for name in [
            "HostName",
            "UserName",
            "Protocol",
            "PublicKeyFile",
            "LogFileName",
            "Colour0",
            "PlinkyTags",
        ] {
            assert_eq!(vtype(name), RegType::REG_SZ, "{name}");
        }
        assert_eq!(key.get_value::<u32, _>("PortNumber").unwrap(), 2222);
        assert_eq!(key.get_value::<String, _>("HostName").unwrap(), "10.0.0.1");

        let read = read_session_in(&scratch.sessions(), "core/sw1 lab").unwrap();
        assert_eq!(read, switch());

        let listed = list_sessions_in(&scratch.sessions()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "core/sw1 lab");
        assert_eq!(listed[0].filename, "core/sw1%20lab");
    }

    #[test]
    fn rewrite_drops_removed_settings_and_keeps_putty_types() {
        let scratch = ScratchKey::new();
        write_session_in(&scratch.sessions(), &switch()).unwrap();

        // What PuTTY itself might have left there: a DWORD Plinky has no
        // table entry for, and a value type PuTTY never reads.
        let key = scratch.open(r"Sessions\core/sw1%20lab");
        key.set_value("SettingFromNewerPutty", &7u32).unwrap();
        let opaque = RegValue {
            bytes: vec![1, 2, 3],
            vtype: RegType::REG_BINARY,
        };
        key.set_raw_value("Opaque", &opaque).unwrap();

        let mut edited = read_session_in(&scratch.sessions(), "core/sw1 lab").unwrap();
        assert_eq!(
            edited
                .extra
                .get("SettingFromNewerPutty")
                .map(String::as_str),
            Some("7")
        );
        assert!(!edited.extra.contains_key("Opaque"));
        edited.extra.remove("PlinkyTags");
        edited.port_number = 23;
        write_session_in(&scratch.sessions(), &edited).unwrap();

        assert!(
            key.get_raw_value("PlinkyTags").is_err(),
            "a dropped setting must go"
        );
        assert_eq!(
            key.get_raw_value("SettingFromNewerPutty").unwrap().vtype,
            RegType::REG_DWORD
        );
        assert_eq!(
            key.get_raw_value("Opaque").unwrap().vtype,
            RegType::REG_BINARY
        );
        assert_eq!(key.get_value::<u32, _>("PortNumber").unwrap(), 23);
    }

    #[test]
    fn reads_a_session_putty_saved() {
        let scratch = ScratchKey::new();
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(format!(r"{}\Default%20Settings", scratch.sessions()))
            .unwrap();
        key.set_value("HostName", &"router.lab").unwrap();
        key.set_value("PortNumber", &22u32).unwrap();
        key.set_value("Protocol", &"ssh").unwrap();
        key.set_value("CloseOnExit", &1u32).unwrap();

        let session = read_session_in(&scratch.sessions(), "Default Settings").unwrap();
        assert_eq!(session.host_name, "router.lab");
        assert_eq!(session.port_number, 22);
        assert_eq!(
            session.extra.get("CloseOnExit").map(String::as_str),
            Some("1")
        );

        // PuTTY's name for the unnamed session.
        assert_eq!(
            read_session_in(&scratch.sessions(), "").unwrap().host_name,
            "router.lab"
        );
    }

    #[test]
    fn delete_removes_the_session_and_reports_a_missing_one() {
        let scratch = ScratchKey::new();
        write_session_in(&scratch.sessions(), &switch()).unwrap();
        delete_session_in(&scratch.sessions(), "core/sw1 lab").unwrap();

        assert!(list_sessions_in(&scratch.sessions()).unwrap().is_empty());
        assert!(matches!(
            read_session_in(&scratch.sessions(), "core/sw1 lab"),
            Err(PuttyCompatError::SessionNotFound(_))
        ));
        assert!(matches!(
            delete_session_in(&scratch.sessions(), "core/sw1 lab"),
            Err(PuttyCompatError::SessionNotFound(_))
        ));
    }

    #[test]
    fn missing_store_is_empty_not_an_error() {
        let scratch = ScratchKey::new();
        assert!(list_sessions_in(&scratch.sessions()).unwrap().is_empty());
        assert!(list_host_keys_in(&scratch.host_keys()).unwrap().is_empty());
    }

    #[test]
    fn lists_host_keys_putty_stored() {
        let scratch = ScratchKey::new();
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(scratch.host_keys())
            .unwrap();
        key.set_value("ssh-ed25519@22:10.10.10.10", &"0x28b5,0x7cad")
            .unwrap();
        key.set_value("rsa2@2222:git.company.internal", &"0x10001,0x00c4")
            .unwrap();
        key.set_value("old-rsa-host", &"0x23/0x1").unwrap();
        key.set_value("ssh-ed25519@22:not-a-string", &1u32).unwrap();

        let mut entries = list_host_keys_in(&scratch.host_keys()).unwrap();
        entries.sort_by(|a, b| a.port.cmp(&b.port));
        assert_eq!(entries.len(), 2);
        assert_eq!(
            (
                entries[0].key_type.as_str(),
                entries[0].port,
                entries[0].host.as_str()
            ),
            ("ssh-ed25519", 22, "10.10.10.10")
        );
        assert_eq!(entries[0].raw_key, "0x28b5,0x7cad");
        assert_eq!(
            (
                entries[1].key_type.as_str(),
                entries[1].port,
                entries[1].host.as_str()
            ),
            ("rsa2", 2222, "git.company.internal")
        );
    }

    #[test]
    fn non_ascii_names_use_the_ansi_code_page_like_putty() {
        let name = "Büro Switch";
        assert_eq!(unescape_registry_key(&escape_registry_key(name)), name);
        // The GitHub runners' code page. PuTTY there saves "Büro" as B%FCro.
        if code_page::windows::ansi_code_page() == 1252 {
            assert_eq!(escape_registry_key(name), "B%FCro%20Switch");
        }
    }
}
