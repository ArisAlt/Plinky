use std::collections::BTreeMap;
use std::fs;
use putty_compat::{
    escape_session_name, list_host_keys_from, list_sessions_in, looks_like_ppk, read_header,
    read_session_in, unescape_session_name, write_session_in, PuttySession,
};
use tempfile::tempdir;

#[test]
fn test_session_name_escaping() {
    let cases = [
        ("Default Settings", "Default%20Settings"),
        ("10.10.10.10 ", "10.10.10.10%20"),
        ("COM USB0", "COM%20USB0"),
        ("myserver/prod:22", "myserver%2Fprod%3A22"),
        ("normal-name_123.test", "normal-name_123.test"),
        // PuTTY for Unix keeps + and @ literal too.
        ("admin@router", "admin@router"),
        ("g++@build+1", "g++@build+1"),
        ("root@host:2222", "root@host%3A2222"),
        ("50%,a=b~c", "50%25%2Ca%3Db%7Ec"),
        ("café", "caf%C3%A9"),
    ];

    for (raw, escaped) in cases {
        assert_eq!(escape_session_name(raw), escaped);
        assert_eq!(unescape_session_name(escaped), raw);
    }

    // PuTTY saves an empty session name as Default Settings.
    assert_eq!(escape_session_name(""), "Default%20Settings");
}

fn write_raw_session(dir: &std::path::Path, filename: &str, host: &str) {
    fs::write(dir.join(filename), format!("HostName={host}\nPortNumber=22\n")).unwrap();
}

#[test]
fn test_session_saved_by_putty_with_at_sign() {
    let dir = tempdir().unwrap();
    // As PuTTY for Unix saves "admin@router".
    write_raw_session(dir.path(), "admin@router", "10.0.0.1");

    let list = list_sessions_in(dir.path()).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "admin@router");
    let loaded = read_session_in(dir.path(), "admin@router").unwrap();
    assert_eq!(loaded.host_name, "10.0.0.1");

    // Plinky's save goes to the same file, the one plink -load opens.
    write_session_in(dir.path(), &PuttySession { port_number: 2222, ..loaded }).unwrap();
    assert!(dir.path().join("admin@router").is_file());
    assert!(!dir.path().join("admin%40router").exists());
}

#[test]
fn test_legacy_session_filename_moves_to_putty_name_on_read() {
    let dir = tempdir().unwrap();
    // As Plinky saved "admin@router" before it matched PuTTY.
    write_raw_session(dir.path(), "admin%40router", "10.0.0.1");

    let list = list_sessions_in(dir.path()).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "admin@router");

    let loaded = read_session_in(dir.path(), "admin@router").unwrap();
    assert_eq!(loaded.name, "admin@router");
    assert_eq!(loaded.host_name, "10.0.0.1");
    assert!(dir.path().join("admin@router").is_file());
    assert!(!dir.path().join("admin%40router").exists());
}

#[test]
fn test_legacy_session_filename_replaced_on_save() {
    let dir = tempdir().unwrap();
    write_raw_session(dir.path(), "db%2Bcache%40prod", "10.0.0.2");

    let session = PuttySession {
        name: "db+cache@prod".to_string(),
        host_name: "10.0.0.3".to_string(),
        ..Default::default()
    };
    write_session_in(dir.path(), &session).unwrap();

    assert!(!dir.path().join("db%2Bcache%40prod").exists());
    let backup = fs::read_to_string(dir.path().join("db+cache@prod.bak")).unwrap();
    assert!(backup.contains("HostName=10.0.0.2"));
    let list = list_sessions_in(dir.path()).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].filename, "db+cache@prod");
    let loaded = read_session_in(dir.path(), "db+cache@prod").unwrap();
    assert_eq!(loaded.host_name, "10.0.0.3");
}

#[test]
fn test_session_listed_once_when_legacy_and_putty_files_both_exist() {
    let dir = tempdir().unwrap();
    write_raw_session(dir.path(), "admin%40router", "old.example");
    write_raw_session(dir.path(), "admin@router", "putty.example");
    write_raw_session(dir.path(), "zeta", "zeta.example");

    let list = list_sessions_in(dir.path()).unwrap();
    let names: Vec<_> = list.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["admin@router", "zeta"]);
    // PuTTY's file wins, in the listing and when read.
    assert_eq!(list[0].filename, "admin@router");
    let loaded = read_session_in(dir.path(), "admin@router").unwrap();
    assert_eq!(loaded.host_name, "putty.example");
}

#[test]
fn test_round_trip_session_with_unknown_fields_and_backup() {
    let dir = tempdir().unwrap();
    let session_dir = dir.path();

    let mut extra = BTreeMap::new();
    extra.insert("CustomPlinkyField".to_string(), "true".to_string());
    extra.insert("TCPKeepalives".to_string(), "1".to_string());
    extra.insert("Colour0".to_string(), "187,187,187".to_string());

    let session = PuttySession {
        name: "Production Cluster 01".to_string(),
        host_name: "prod01.internal".to_string(),
        port_number: 2222,
        user_name: "admin".to_string(),
        protocol: "ssh".to_string(),
        public_key_file: "/home/user/.ssh/id_ed25519.ppk".to_string(),
        log_file_name: String::new(),
        extra,
    };

    // 1. Initial write
    write_session_in(session_dir, &session).expect("write session failed");

    let escaped_name = escape_session_name(&session.name);
    let target_file = session_dir.join(&escaped_name);
    assert!(target_file.exists());

    // 2. Read back and verify exact fields (R3 invariant)
    let loaded = read_session_in(session_dir, &session.name).expect("read session failed");
    assert_eq!(loaded.name, session.name);
    assert_eq!(loaded.host_name, "prod01.internal");
    assert_eq!(loaded.port_number, 2222);
    assert_eq!(loaded.user_name, "admin");
    assert_eq!(loaded.protocol, "ssh");
    assert_eq!(loaded.public_key_file, "/home/user/.ssh/id_ed25519.ppk");
    assert_eq!(
        loaded.extra.get("CustomPlinkyField").map(|s| s.as_str()),
        Some("true")
    );
    assert_eq!(
        loaded.extra.get("Colour0").map(|s| s.as_str()),
        Some("187,187,187")
    );

    // 3. Second write triggers backup file creation (.bak)
    let mut updated = loaded.clone();
    updated.port_number = 2223;
    write_session_in(session_dir, &updated).expect("write session update failed");

    let bak_file = session_dir.join(format!("{}.bak", escaped_name));
    assert!(bak_file.exists(), ".bak backup file must be created on overwrite");

    let re_read = read_session_in(session_dir, &session.name).expect("re-read updated session failed");
    assert_eq!(re_read.port_number, 2223);
    assert_eq!(re_read.extra.get("CustomPlinkyField").map(|s| s.as_str()), Some("true"));
}

#[test]
fn test_list_sessions_in_directory() {
    let dir = tempdir().unwrap();
    let session_dir = dir.path();

    let s1 = PuttySession {
        name: "Alpha Server".to_string(),
        host_name: "alpha.test".to_string(),
        ..Default::default()
    };
    let s2 = PuttySession {
        name: "Beta Server".to_string(),
        host_name: "beta.test".to_string(),
        ..Default::default()
    };

    write_session_in(session_dir, &s1).unwrap();
    write_session_in(session_dir, &s2).unwrap();

    let list = list_sessions_in(session_dir).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].name, "Alpha Server");
    assert_eq!(list[1].name, "Beta Server");
}

#[test]
fn test_ppk_parsing_v3() {
    let dir = tempdir().unwrap();
    let ppk_path = dir.path().join("test_v3.ppk");

    let ppk_content = r#"PuTTY-User-Key-File-3: ssh-ed25519
Encryption: none
Comment: test-key-v3
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIM5DSoBxsvbmeC6cxkKMLM4cOwpBADUpEB/H4lp8
D5TU
Private-Lines: 1
AAAAIPywitCxHSJPME3jTxjRY7g6R6RpbPqNIO2l8BGM8sZv
Private-MAC: 422f3bd56cdb3f3f3bf88390e81de93dcfbcedd10081d9de47372e2f7b170023
"#;
    fs::write(&ppk_path, ppk_content).unwrap();

    assert!(looks_like_ppk(&ppk_path));

    let header = read_header(&ppk_path).expect("read_header failed on v3 ppk");
    assert_eq!(header.version, 3);
    assert_eq!(header.algo, "ssh-ed25519");
    assert_eq!(header.encrypted, false);
    assert_eq!(header.comment, "test-key-v3");
    assert_eq!(header.fingerprint, "SHA256:VFos9OhvOn2K42vozRhGbuDyq+COCsYFwRY2b7zaJqw");
}

#[test]
fn test_ppk_looks_like_ppk_rejection() {
    let dir = tempdir().unwrap();
    let openssh_path = dir.path().join("id_ed25519");
    fs::write(&openssh_path, "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA...\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();

    assert!(!looks_like_ppk(&openssh_path));
}

#[test]
fn test_hostkeys_parsing() {
    let dir = tempdir().unwrap();
    let hostkeys_file = dir.path().join("sshhostkeys");
    let content = r#"# Sample sshhostkeys
ssh-ed25519@22:10.10.10.10 0x28b56069f86246d18d5ff08c40029803e298d3f5d21cb1b615792024cf0c8711,0x7cadb38df766f23fda4f284a023dce62099329de4693c01852ff997703cbd588
ssh-rsa@2222:git.company.internal 0x10001,0x00c4f82a9...
"#;
    fs::write(&hostkeys_file, content).unwrap();

    let entries = list_host_keys_from(&hostkeys_file).expect("list_host_keys_from failed");
    assert_eq!(entries.len(), 2);

    assert_eq!(entries[0].key_type, "ssh-ed25519");
    assert_eq!(entries[0].port, 22);
    assert_eq!(entries[0].host, "10.10.10.10");

    assert_eq!(entries[1].key_type, "ssh-rsa");
    assert_eq!(entries[1].port, 2222);
    assert_eq!(entries[1].host, "git.company.internal");
}

#[test]
fn test_parse_real_system_hostkeys_if_available() {
    let path = std::path::Path::new("/home/citizenzero/.putty/sshhostkeys");
    if path.exists() {
        let entries = list_host_keys_from(path).unwrap();
        assert!(!entries.is_empty());
        assert_eq!(entries[0].host, "10.10.10.10");
        assert_eq!(entries[0].port, 22);
    }
}
