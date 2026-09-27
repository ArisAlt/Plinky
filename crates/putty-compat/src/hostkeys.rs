use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

use crate::errors::{PuttyCompatError, Result};

/// One cached host key. Serialized for the page as camelCase with the host
/// as `hostname`: the page's type had always used those names, the backend
/// sent snake_case, and the Host Keys screen showed every row blank.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyEntry {
    pub key_type: String,
    #[serde(rename = "hostname")]
    pub host: String,
    pub port: u16,
    pub raw_key: String,
    /// `SHA256:...`, as `ssh-keygen -l` and PuTTY's own prompt print it.
    /// None for a key type this can't rebuild.
    #[serde(default)]
    pub fingerprint: Option<String>,
}

impl HostKeyEntry {
    pub fn new(key_type: String, host: String, port: u16, raw_key: String) -> Self {
        let fingerprint = fingerprint_sha256(&key_type, &raw_key);
        Self { key_type, host, port, raw_key, fingerprint }
    }
}

// ── fingerprints ─────────────────────────────────────────────────────────────
// PuTTY caches a key as its numbers in hex, not as the SSH key blob:
//   rsa2                 0x<e>,0x<n>
//   dss                  0x<p>,0x<q>,0x<g>,0x<y>
//   ssh-ed25519          0x<x>,0x<y>          (the curve point)
//   ecdsa-sha2-nistpNNN  nistpNNN,0x<x>,0x<y>
// The fingerprint is SHA-256 over the blob the server sent, so the blob is
// rebuilt from those numbers in RFC 4253 / 5656 / 8709 wire format.

fn hex_bytes(s: &str) -> Option<Vec<u8>> {
    let h = s.trim().trim_start_matches("0x");
    let h = if h.len() % 2 == 1 { format!("0{h}") } else { h.to_string() };
    (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).ok()).collect()
}

fn put_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn put_mpint(out: &mut Vec<u8>, be: &[u8]) {
    let first = be.iter().position(|&b| b != 0).unwrap_or(be.len());
    let mut v = be[first..].to_vec();
    if v.first().is_some_and(|b| b & 0x80 != 0) {
        v.insert(0, 0);
    }
    put_string(out, &v);
}

/// Big-endian `be`, left-padded (or trimmed of leading zeros) to `n` bytes.
fn fixed(be: &[u8], n: usize) -> Option<Vec<u8>> {
    let first = be.iter().position(|&b| b != 0).unwrap_or(be.len());
    let v = &be[first..];
    if v.len() > n {
        return None;
    }
    let mut out = vec![0u8; n - v.len()];
    out.extend_from_slice(v);
    Some(out)
}

pub fn fingerprint_sha256(key_type: &str, raw_key: &str) -> Option<String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};

    let parts: Vec<&str> = raw_key.split(',').map(str::trim).collect();
    let mut blob = Vec::new();
    match key_type {
        "rsa2" if parts.len() == 2 => {
            put_string(&mut blob, b"ssh-rsa");
            put_mpint(&mut blob, &hex_bytes(parts[0])?);
            put_mpint(&mut blob, &hex_bytes(parts[1])?);
        }
        "dss" if parts.len() == 4 => {
            put_string(&mut blob, b"ssh-dss");
            for p in &parts {
                put_mpint(&mut blob, &hex_bytes(p)?);
            }
        }
        "ssh-ed25519" if parts.len() == 2 => {
            // RFC 8032 encoding: y little-endian, x's low bit in the top bit.
            let x = hex_bytes(parts[0])?;
            let mut y = fixed(&hex_bytes(parts[1])?, 32)?;
            y.reverse();
            if x.last().is_some_and(|b| b & 1 == 1) {
                y[31] |= 0x80;
            }
            put_string(&mut blob, b"ssh-ed25519");
            put_string(&mut blob, &y);
        }
        t if t.starts_with("ecdsa-sha2-") && parts.len() == 3 => {
            let size = match parts[0] {
                "nistp256" => 32,
                "nistp384" => 48,
                "nistp521" => 66,
                _ => return None,
            };
            let mut point = vec![0x04];
            point.extend(fixed(&hex_bytes(parts[1])?, size)?);
            point.extend(fixed(&hex_bytes(parts[2])?, size)?);
            put_string(&mut blob, t.as_bytes());
            put_string(&mut blob, parts[0].as_bytes());
            put_string(&mut blob, &point);
        }
        _ => return None,
    }
    let digest = Sha256::digest(&blob);
    Some(format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)))
}

// ── removing ─────────────────────────────────────────────────────────────────
/// Forgets one cached key, as deleting its line (or registry value) by hand
/// would: the next connection asks again. Ok(false) if it wasn't there.
pub fn remove_host_key(key_type: &str, host: &str, port: u16) -> Result<bool> {
    #[cfg(windows)]
    return crate::registry::remove_host_key_in(crate::registry::HOST_KEYS_KEY, key_type, host, port);
    #[cfg(not(windows))]
    return remove_host_key_from(&hostkeys_path(), key_type, host, port);
}

pub fn remove_host_key_from(path: &Path, key_type: &str, host: &str, port: u16) -> Result<bool> {
    use std::io::Write;
    if !path.exists() {
        return Ok(false);
    }
    let io = |source| PuttyCompatError::Io { path: path.to_path_buf(), source };
    let text = std::fs::read_to_string(path).map_err(io)?;
    let target = format!("{key_type}@{port}:{host}");
    let mut removed = false;
    let mut kept = String::with_capacity(text.len());
    for line in text.lines() {
        if line.split_whitespace().next() == Some(target.as_str()) {
            removed = true;
        } else {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    if !removed {
        return Ok(false);
    }
    // Written beside the original and renamed over it, so a failure leaves
    // the cache as it was.
    let dir = path.parent().unwrap_or(Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(io)?;
    tmp.write_all(kept.as_bytes()).map_err(io)?;
    tmp.as_file().sync_all().map_err(io)?;
    tmp.persist(path).map_err(|e| io(e.error))?;
    Ok(true)
}

/// PuTTY for Unix's host key file. PuTTY for Windows keeps host keys in the
/// registry instead, which is where [`list_host_keys`] reads them there.
pub fn hostkeys_path() -> PathBuf {
    if let Ok(val) = std::env::var("PUTTYDIR") {
        let p = PathBuf::from(val);
        let s = p.join("sshhostkeys");
        if s.is_file() {
            return s;
        }
    }

    if let Ok(val) = std::env::var("XDG_CONFIG_HOME") {
        let s = PathBuf::from(val).join("putty").join("sshhostkeys");
        if s.is_file() {
            return s;
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".putty").join("sshhostkeys");
    }

    PathBuf::from(".putty/sshhostkeys")
}

pub fn list_host_keys() -> Result<Vec<HostKeyEntry>> {
    #[cfg(windows)]
    return crate::registry::list_host_keys_in(crate::registry::HOST_KEYS_KEY);
    #[cfg(not(windows))]
    return list_host_keys_from(&hostkeys_path());
}

pub fn list_host_keys_from(path: &Path) -> Result<Vec<HostKeyEntry>> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let file = File::open(path).map_err(|e| PuttyCompatError::Io {
        path: path.to_path_buf(),
        source: e,
    })?;

    let reader = BufReader::new(file);
    let mut entries = Vec::new();

    for line in reader.lines() {
        let line = line.map_err(|e| PuttyCompatError::Io {
            path: path.to_path_buf(),
            source: e,
        })?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some((target, raw_key)) = trimmed.split_once(char::is_whitespace) {
            if let Some((key_type, port, host)) = parse_host_key_target(target) {
                entries.push(HostKeyEntry::new(key_type, host.to_string(), port, raw_key.trim().to_string()));
            }
        }
    }

    Ok(entries)
}

/// Splits PuTTY's `<key_type>@<port>:<hostname>`, the start of a file line
/// and the whole of a registry value name (where the host is escaped).
pub(crate) fn parse_host_key_target(target: &str) -> Option<(String, u16, &str)> {
    let (key_type, rest) = target.split_once('@')?;
    let (port_str, host) = rest.split_once(':')?;
    let port = port_str.parse::<u16>().unwrap_or(22);
    Some((key_type.to_string(), port, host))
}

#[cfg(test)]
mod fingerprint_tests {
    use super::*;

    // Real plink 0.81 cache lines, each from a throwaway sshd host key; the
    // expected values are `ssh-keygen -lf <key>.pub -E sha256` on that key.
    const RSA: &str = "0x10001,0xe4d816e68f7101467fa93a974ba6391aab807806959926691e09cb6ce9ac58c470023699b100079b8e7f21a8bc71295b5e34449818eb6073bd6c7baa8d062db694b61de4f3487aa69d0c6de9fc72f3c1ac15156aac533f42309111cfa668a896ad244344cd837d5730996f413448839e1f686312427fdfb17799bc79bf17af800724a5f3eb075a18be9df6bf84a9e5e0e10f637f7c64dd5e20ec068507bfab6cc6eee582e7d787a36c52954a1836ebec776bcfb6ab20a4a67db5a497c7e2739f8e17b062d41d80a3c49051f1801f68a62c67832bbdee07452f97287b2870535223599d3022e912d1b3534e8c73eb4828b8d5f463e3a5ead6c4171dd32ae22dd7b062a54382c3475809f57ee3a2e7601c459f0879492c9d69bfbf633f1037bf0f8d352ca2636a37faddfa12a130dcd12c97349aab4d7ffbd093368ec30bdb9d39184302f6d7c869708177d4b1aa780350702be60dad3f9959ab4d380efe58938b20f0d8735e759c0df175beef4409de7a6ecf3d741a635adb2d13e425b4fd09bd";
    const ECDSA: &str = "nistp256,0x2d631a6bc6a665adc2ab6d85f33ee3a639c03a5c33792df2c597e2f0645a25c2,0xb4057eab691fbd2afff7776cf9cf4d64405bc33200d53cf99150030be1c90ef4";
    const ED25519: &str = "0x27a392bb0afcc7c9d3f5dca1adb6a40f478045dcd80367c82459d19abf680ae1,0x5a8d2cd24f2b64dc8d85c052ba77d4ea585fe3428d679c0d1921cfa6887aaa71";

    #[test]
    fn rsa_matches_ssh_keygen() {
        assert_eq!(fingerprint_sha256("rsa2", RSA).as_deref(), Some("SHA256:XWSqhoaBwTGtQ+7buCwph9ALAlZOShB5b5H4WGLAg00"));
    }

    #[test]
    fn ecdsa_matches_ssh_keygen() {
        assert_eq!(fingerprint_sha256("ecdsa-sha2-nistp256", ECDSA).as_deref(), Some("SHA256:H65GxaSUYbUQO9OY6CnfyHM+4BGMrmxNA8g1SRkWLKQ"));
    }

    #[test]
    fn ed25519_matches_ssh_keygen() {
        assert_eq!(fingerprint_sha256("ssh-ed25519", ED25519).as_deref(), Some("SHA256:xWrYeo4MQoxHOSFfDPvVva3O+xQJzTjKFw5wsutCjEQ"));
    }

    #[test]
    fn an_unknown_type_has_no_fingerprint_rather_than_a_wrong_one() {
        assert_eq!(fingerprint_sha256("ssh-ed448", "0x1,0x2"), None);
        assert_eq!(fingerprint_sha256("rsa2", "not hex"), None);
    }

    #[test]
    fn the_page_gets_the_names_its_type_uses() {
        // The Host Keys screen read hostname/keyType/fingerprint; the
        // backend sent host/key_type and no fingerprint, so every row was
        // blank.
        let e = HostKeyEntry::new("ssh-ed25519".into(), "10.0.0.1".into(), 22, ED25519.into());
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["hostname"], "10.0.0.1");
        assert_eq!(v["keyType"], "ssh-ed25519");
        assert_eq!(v["rawKey"], ED25519);
        assert_eq!(v["fingerprint"], "SHA256:xWrYeo4MQoxHOSFfDPvVva3O+xQJzTjKFw5wsutCjEQ");
    }

    #[test]
    fn removing_a_key_drops_only_that_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sshhostkeys");
        std::fs::write(&path, format!("ssh-ed25519@22:10.0.0.1 {ED25519}\nrsa2@22:10.0.0.1 {RSA}\nssh-ed25519@2222:10.0.0.1 {ED25519}\n")).unwrap();
        assert!(remove_host_key_from(&path, "ssh-ed25519", "10.0.0.1", 22).unwrap());
        let left = list_host_keys_from(&path).unwrap();
        assert_eq!(left.len(), 2);
        assert!(left.iter().all(|k| !(k.key_type == "ssh-ed25519" && k.port == 22)));
        assert!(!remove_host_key_from(&path, "ssh-ed25519", "10.0.0.1", 22).unwrap());
    }
}
