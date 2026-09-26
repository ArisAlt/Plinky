//! Export the vault to a KeePass database (KDBX 4), readable by KeePassXC,
//! KeePass 2 and the other KDBX clients.

use std::path::Path;

use keepass::config::{DatabaseConfig, KdfConfig};
use keepass::{Database, DatabaseKey};

use super::Vault;
use crate::errors::{PlinkyError, Result};

/// The KeePass field that carries a network device's enable password.
/// KeePass has no standard field for it; a protected custom field keeps it
/// hidden like the password.
pub const ENABLE_PASSWORD_FIELD: &str = "Enable password";

/// KeePassXC's own default for new databases (Argon2, 64 MiB). The crate's
/// default is 1 MiB, which makes a stolen export far cheaper to brute-force
/// than a file KeePassXC itself would write.
const KDF_MEMORY_BYTES: u64 = 64 * 1024 * 1024;
const KDF_ITERATIONS: u64 = 10;
const KDF_PARALLELISM: u32 = 2;

fn export_err(what: &str, e: impl std::fmt::Display) -> PlinkyError {
    PlinkyError::ProcessError(format!("KeePass export failed ({what}): {e}"))
}

/// Writes every vault entry to `dest` as a KDBX 4 database protected by
/// `password`, and returns how many entries were written.
///
/// Each entry becomes a KeePass entry titled with its vault key; username,
/// password, notes and (as a protected custom field) the enable password
/// carry over. `url_for` may give an entry a URL, e.g. the saved session it
/// belongs to. The file is written beside `dest` and renamed into place, so
/// a failure never leaves a half-written database under the chosen name.
pub fn export_kdbx(
    vault: &Vault,
    dest: &Path,
    password: &str,
    url_for: impl Fn(&str) -> Option<String>,
) -> Result<usize> {
    if password.is_empty() {
        return Err(PlinkyError::ProcessError("KeePass export needs a password".into()));
    }
    let mut config = DatabaseConfig::default();
    if let KdfConfig::Argon2 { version, .. } | KdfConfig::Argon2id { version, .. } = config.kdf_config {
        config.kdf_config = KdfConfig::Argon2id {
            iterations: KDF_ITERATIONS,
            memory: KDF_MEMORY_BYTES,
            parallelism: KDF_PARALLELISM,
            version,
        };
    }
    let mut db = Database::with_config(config);
    db.meta.database_name = Some("Plinky vault".into());

    let mut count = 0;
    {
        let mut root = db.root_mut();
        root.name = "Plinky vault".into();
        for e in vault.entries() {
            let mut entry = root.add_entry();
            entry.set_unprotected("Title", e.id.clone());
            if let Some(user) = e.username.as_deref().filter(|u| !u.is_empty()) {
                entry.set_unprotected("UserName", user);
            }
            entry.set_protected("Password", e.secret.expose_secret());
            if let Some(enable) = e.enable_secret.as_ref().filter(|s| !s.is_empty()) {
                entry.set_protected(ENABLE_PASSWORD_FIELD, enable.expose_secret());
            }
            if let Some(notes) = e.notes.as_deref().filter(|n| !n.is_empty()) {
                entry.set_unprotected("Notes", notes);
            }
            if let Some(url) = url_for(&e.id) {
                entry.set_unprotected("URL", url);
            }
            count += 1;
        }
    }

    let dir = dest.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    // tempfile creates the file 0600 on Unix: only this user can read it.
    let mut tmp = tempfile::Builder::new()
        .prefix(".plinky-export-")
        .tempfile_in(dir)
        .map_err(|e| export_err("creating the file", e))?;
    db.save(&mut tmp, DatabaseKey::new().with_password(password))
        .map_err(|e| export_err("writing the database", e))?;
    tmp.as_file().sync_all().map_err(|e| export_err("writing the database", e))?;
    tmp.persist(dest).map_err(|e| export_err("saving the file", e.error))?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::VaultEntry;

    fn open(path: &Path, password: &str) -> std::result::Result<Database, keepass::db::DatabaseOpenError> {
        Database::open(&mut std::fs::File::open(path).unwrap(), DatabaseKey::new().with_password(password))
    }

    #[test]
    fn every_field_survives_the_round_trip_and_secrets_stay_protected() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::create_fast(dir.path().join("vault.bin"), "master").unwrap();
        vault.set_entry(
            VaultEntry::new("session:Core-SW", "login-pw")
                .with_username("netops")
                .with_enable_secret("enable-pw")
                .with_notes("core switch"),
        );
        vault.set_entry(VaultEntry::new("10.10.10.10", "server-pw"));

        let dest = dir.path().join("export.kdbx");
        let n = export_kdbx(&vault, &dest, "master", |id| {
            (id == "session:Core-SW").then(|| "ssh://netops@192.0.2.2:22".to_string())
        })
        .unwrap();
        assert_eq!(n, 2);

        let db = open(&dest, "master").expect("opens with the export password");
        let root = db.root();
        let sw = root.entry_by_name("session:Core-SW").expect("titled with the vault key");
        assert_eq!(sw.get_username(), Some("netops"));
        assert_eq!(sw.get_password(), Some("login-pw"));
        assert_eq!(sw.get(ENABLE_PASSWORD_FIELD), Some("enable-pw"));
        assert_eq!(sw.get("Notes"), Some("core switch"));
        assert_eq!(sw.get_url(), Some("ssh://netops@192.0.2.2:22"));
        assert!(sw.fields["Password"].is_protected());
        assert!(sw.fields[ENABLE_PASSWORD_FIELD].is_protected());

        let host = root.entry_by_name("10.10.10.10").unwrap();
        assert_eq!(host.get_password(), Some("server-pw"));
        assert!(host.get(ENABLE_PASSWORD_FIELD).is_none());
    }

    #[test]
    fn the_file_is_useless_without_the_password() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::create_fast(dir.path().join("vault.bin"), "master").unwrap();
        vault.set_entry(VaultEntry::new("k", "top-secret-password"));
        let dest = dir.path().join("export.kdbx");
        export_kdbx(&vault, &dest, "master", |_| None).unwrap();

        assert!(open(&dest, "wrong").is_err());
        let raw = std::fs::read(&dest).unwrap();
        assert!(!raw.windows(19).any(|w| w == b"top-secret-password"), "no plaintext in the file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "only the owner may read the export");
        }
    }

    #[test]
    fn an_empty_password_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::create_fast(dir.path().join("vault.bin"), "master").unwrap();
        assert!(export_kdbx(&vault, &dir.path().join("x.kdbx"), "", |_| None).is_err());
        assert!(!dir.path().join("x.kdbx").exists());
    }
}
