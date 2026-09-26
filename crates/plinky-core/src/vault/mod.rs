pub mod keepass_export;
pub mod storage;

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::errors::{PlinkyError, Result};
pub use storage::{VaultHeader, DEFAULT_M_COST, DEFAULT_P_COST, DEFAULT_T_COST};

/// Secure in-memory string that automatically zeros its memory when dropped,
/// and is redacted from `Debug` and `Display` output to prevent accidental credential leakage.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn expose_secret(&self) -> &str {
        &self.0
    }

    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl fmt::Display for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl Serialize for SecretString {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SecretString {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(SecretString::new(s))
    }
}

impl From<&str> for SecretString {
    fn from(s: &str) -> Self {
        Self::new(s)
    }
}

impl From<String> for SecretString {
    fn from(s: String) -> Self {
        Self::new(s)
    }
}

/// A stored credential entry in the vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultEntry {
    pub id: String,
    pub username: Option<String>,
    pub secret: SecretString,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_secret: Option<SecretString>,
    pub notes: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Metadata for a vault entry WITHOUT its secret -- for listing views.
///
/// The secret is deliberately not present on this type (not even redacted),
/// so it is structurally impossible for a listing call to leak plaintext:
/// callers must fetch a specific entry's full `VaultEntry` on demand
/// (e.g. when the user explicitly reveals or copies it) to see the secret.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultEntryMeta {
    pub id: String,
    pub username: Option<String>,
    pub has_enable_secret: bool,
    pub notes: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

impl From<&VaultEntry> for VaultEntryMeta {
    fn from(e: &VaultEntry) -> Self {
        Self {
            id: e.id.clone(),
            username: e.username.clone(),
            has_enable_secret: e.enable_secret.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
            notes: e.notes.clone(),
            created_at: e.created_at,
            updated_at: e.updated_at,
        }
    }
}

impl VaultEntry {
    pub fn new(id: impl Into<String>, secret: impl Into<String>) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Self {
            id: id.into(),
            username: None,
            secret: SecretString::new(secret),
            enable_secret: None,
            notes: None,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn with_username(mut self, username: impl Into<String>) -> Self {
        self.username = Some(username.into());
        self
    }

    pub fn with_enable_secret(mut self, enable_secret: impl Into<String>) -> Self {
        self.enable_secret = Some(SecretString::new(enable_secret));
        self
    }

    pub fn with_notes(mut self, notes: impl Into<String>) -> Self {
        self.notes = Some(notes.into());
        self
    }
}

/// In-memory decrypted Credential Vault managing secrets and atomic disk synchronization.
pub struct Vault {
    header: VaultHeader,
    master_key: Option<Zeroizing<[u8; 32]>>,
    entries: BTreeMap<String, VaultEntry>,
    file_path: Option<PathBuf>,
}

impl fmt::Debug for Vault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Vault")
            .field("locked", &self.is_locked())
            .field("entries_count", &self.entries.len())
            .field("file_path", &self.file_path)
            .finish()
    }
}

impl Vault {
    /// Create a new encrypted vault file at `path` using OWASP-recommended Argon2id parameters.
    pub fn create(path: impl AsRef<Path>, master_password: &str) -> Result<Self> {
        let header = VaultHeader::new_default();
        Self::init_at(path, master_password, header)
    }

    /// Create a new encrypted vault file at `path` using fast parameters (for tests).
    pub fn create_fast(path: impl AsRef<Path>, master_password: &str) -> Result<Self> {
        let header = VaultHeader::new_fast();
        Self::init_at(path, master_password, header)
    }

    fn init_at(path: impl AsRef<Path>, master_password: &str, header: VaultHeader) -> Result<Self> {
        if master_password.is_empty() {
            return Err(PlinkyError::VaultError(
                "Master password cannot be empty".to_string(),
            ));
        }

        let key = storage::derive_key(
            master_password,
            &header.salt,
            header.m_cost,
            header.t_cost,
            header.p_cost,
        )?;

        let path = path.as_ref().to_path_buf();
        let entries = BTreeMap::new();
        let json_bytes = serde_json::to_vec(&entries)
            .map_err(|e| PlinkyError::VaultError(format!("JSON serialization error: {}", e)))?;

        let container_data = storage::encrypt_vault_payload(&*key, &header, &json_bytes)?;
        storage::save_atomic(&path, &container_data)?;

        Ok(Self {
            header,
            master_key: Some(key),
            entries,
            file_path: Some(path),
        })
    }

    /// Unlock and load an existing vault file from `path` using `master_password`.
    pub fn load(path: impl AsRef<Path>, master_password: &str) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let data = fs::read(&path)?;

        let (header, key, plaintext) = storage::decrypt_vault_payload(master_password, &data)?;
        let entries: BTreeMap<String, VaultEntry> = serde_json::from_slice(&plaintext)
            .map_err(|e| PlinkyError::VaultError(format!("Corrupted vault data format: {}", e)))?;

        Ok(Self {
            header,
            master_key: Some(key),
            entries,
            file_path: Some(path),
        })
    }

    /// Save the current vault entries to disk atomically using the derived master key.
    pub fn save(&self) -> Result<()> {
        let path = self
            .file_path
            .as_ref()
            .ok_or_else(|| PlinkyError::VaultError("No file path associated with vault".to_string()))?;
        self.save_to(path)
    }

    /// Save the current vault entries to a specific path atomically.
    pub fn save_to(&self, path: impl AsRef<Path>) -> Result<()> {
        let key = self
            .master_key
            .as_ref()
            .ok_or_else(|| PlinkyError::VaultError("Vault is locked".to_string()))?;

        let json_bytes = serde_json::to_vec(&self.entries)
            .map_err(|e| PlinkyError::VaultError(format!("JSON serialization error: {}", e)))?;

        let container_data = storage::encrypt_vault_payload(&**key, &self.header, &json_bytes)?;
        storage::save_atomic(path, &container_data)?;
        Ok(())
    }

    /// Lock the vault, immediately scrubbing the master key and clearing all entries from memory.
    pub fn lock(&mut self) {
        self.master_key = None;
        self.entries.clear();
    }

    /// Check if the vault is currently locked.
    pub fn is_locked(&self) -> bool {
        self.master_key.is_none()
    }

    /// Retrieve secret plaintext for key `id`.
    pub fn get(&self, id: &str) -> Option<&str> {
        self.entries.get(id).map(|e| e.secret.expose_secret())
    }

    /// Retrieve entry for key `id`.
    pub fn get_entry(&self, id: &str) -> Option<&VaultEntry> {
        self.entries.get(id)
    }

    /// Every entry, in key order (for export).
    pub fn entries(&self) -> impl Iterator<Item = &VaultEntry> {
        self.entries.values()
    }

    /// Insert or update a secret with default metadata.
    pub fn set(&mut self, id: impl Into<String>, secret: impl Into<String>) {
        let id_str = id.into();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        if let Some(entry) = self.entries.get_mut(&id_str) {
            entry.secret = SecretString::new(secret);
            entry.updated_at = now;
        } else {
            let entry = VaultEntry {
                id: id_str.clone(),
                username: None,
                secret: SecretString::new(secret),
                enable_secret: None,
                notes: None,
                created_at: now,
                updated_at: now,
            };
            self.entries.insert(id_str, entry);
        }
    }

    /// Insert or replace a full `VaultEntry`.
    pub fn set_entry(&mut self, entry: VaultEntry) {
        self.entries.insert(entry.id.clone(), entry);
    }

    /// Remove a credential entry by `id`.
    pub fn remove(&mut self, id: &str) -> Option<VaultEntry> {
        self.entries.remove(id)
    }

    /// List all credential keys stored in the vault.
    pub fn list_keys(&self) -> Vec<String> {
        self.entries.keys().cloned().collect()
    }

    /// List entry metadata (id, username, notes, timestamps) for every stored
    /// credential, WITHOUT decrypted secrets. Use `get_entry`/`get` for the
    /// secret of one specific entry, on demand, not this for a bulk listing.
    pub fn list_entries_meta(&self) -> Vec<VaultEntryMeta> {
        self.entries.values().map(VaultEntryMeta::from).collect()
    }

    /// Return total number of stored credentials.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Check if vault contains zero credentials.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Get associated file path if any.
    pub fn file_path(&self) -> Option<&Path> {
        self.file_path.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_secret_string_redaction() {
        let secret = SecretString::new("super-secret-password-123");
        assert_eq!(secret.expose_secret(), "super-secret-password-123");
        assert_eq!(format!("{:?}", secret), "[REDACTED]");
        assert_eq!(format!("{}", secret), "[REDACTED]");
    }

    #[test]
    fn test_vault_create_save_load_roundtrip() {
        let dir = tempdir().unwrap();
        let vault_file = dir.path().join("vault.bin");
        let master_pwd = "Correct-Horse-Battery-Staple!";

        // 1. Create fast vault
        let mut vault = Vault::create_fast(&vault_file, master_pwd).unwrap();
        assert!(!vault.is_locked());
        assert_eq!(vault.len(), 0);

        // 2. Set credentials
        vault.set("session:server1", "srv1-secret-pass");
        vault.set_entry(
            VaultEntry::new("session:server2", "srv2-pass")
                .with_username("root")
                .with_notes("Production database gateway"),
        );
        assert_eq!(vault.len(), 2);
        assert_eq!(vault.get("session:server1"), Some("srv1-secret-pass"));

        // 3. Save to disk
        vault.save().unwrap();
        assert!(vault_file.exists());

        // 4. Reload from disk
        let loaded = Vault::load(&vault_file, master_pwd).unwrap();
        assert!(!loaded.is_locked());
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded.get("session:server1"), Some("srv1-secret-pass"));

        let e2 = loaded.get_entry("session:server2").unwrap();
        assert_eq!(e2.username.as_deref(), Some("root"));
        assert_eq!(e2.secret.expose_secret(), "srv2-pass");
        assert_eq!(e2.notes.as_deref(), Some("Production database gateway"));

        let keys = loaded.list_keys();
        assert_eq!(keys, vec!["session:server1", "session:server2"]);
    }

    #[test]
    fn test_vault_wrong_password_fails_closed() {
        let dir = tempdir().unwrap();
        let vault_file = dir.path().join("vault.bin");

        let mut vault = Vault::create_fast(&vault_file, "correct_password").unwrap();
        vault.set("key1", "val1");
        vault.save().unwrap();

        // Attempting load with wrong password must fail
        let res = Vault::load(&vault_file, "wrong_password");
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(format!("{}", err).contains("Authentication failed"));
    }

    #[test]
    fn test_vault_tampered_header_fails_auth() {
        let dir = tempdir().unwrap();
        let vault_file = dir.path().join("vault.bin");

        let mut vault = Vault::create_fast(&vault_file, "my_password").unwrap();
        vault.set("key1", "val1");
        vault.save().unwrap();

        let mut data = fs::read(&vault_file).unwrap();
        // Tamper with salt byte
        data[25] ^= 0xff;
        fs::write(&vault_file, &data).unwrap();

        let res = Vault::load(&vault_file, "my_password");
        assert!(res.is_err());
    }

    #[test]
    fn test_vault_tampered_ciphertext_fails_auth() {
        let dir = tempdir().unwrap();
        let vault_file = dir.path().join("vault.bin");

        let mut vault = Vault::create_fast(&vault_file, "my_password").unwrap();
        vault.set("key1", "val1");
        vault.save().unwrap();

        let mut data = fs::read(&vault_file).unwrap();
        // Tamper with ciphertext at the end
        let last_idx = data.len() - 1;
        data[last_idx] ^= 0x01;
        fs::write(&vault_file, &data).unwrap();

        let res = Vault::load(&vault_file, "my_password");
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(format!("{}", err).contains("Authentication failed"));
    }

    #[test]
    fn test_list_entries_meta_never_contains_secrets() {
        let dir = tempdir().unwrap();
        let vault_file = dir.path().join("vault.bin");

        let mut vault = Vault::create_fast(&vault_file, "meta_test_pw").unwrap();
        vault.set_entry(
            VaultEntry::new("session:server1", "top-secret-password")
                .with_username("root")
                .with_notes("prod db"),
        );

        let meta = vault.list_entries_meta();
        assert_eq!(meta.len(), 1);
        assert_eq!(meta[0].id, "session:server1");
        assert_eq!(meta[0].username.as_deref(), Some("root"));
        assert_eq!(meta[0].notes.as_deref(), Some("prod db"));

        // VaultEntryMeta has no `secret` field at all -- this is a compile-time
        // guarantee, not just a runtime check, but confirm the serialized form
        // never contains the plaintext either, in case that ever changes.
        let json = serde_json::to_string(&meta[0]).unwrap();
        assert!(!json.contains("top-secret-password"));
        assert!(!json.contains("\"secret\""));
    }

    #[test]
    fn test_vault_lock_clears_memory() {
        let dir = tempdir().unwrap();
        let vault_file = dir.path().join("vault.bin");

        let mut vault = Vault::create_fast(&vault_file, "lock_test").unwrap();
        vault.set("secret_key", "secret_value");
        assert!(!vault.is_locked());
        assert_eq!(vault.get("secret_key"), Some("secret_value"));

        vault.lock();
        assert!(vault.is_locked());
        assert_eq!(vault.len(), 0);
        assert_eq!(vault.get("secret_key"), None);

        // Saving a locked vault must fail
        assert!(vault.save().is_err());
    }

    #[test]
    fn test_vault_entry_enable_secret_roundtrip() {
        let dir = tempdir().unwrap();
        let vault_file = dir.path().join("vault.bin");
        let master_pwd = "network-admin-vault-pwd";

        let mut vault = Vault::create_fast(&vault_file, master_pwd).unwrap();
        let entry = VaultEntry::new("session:cisco-core-01", "cisco-login-pass")
            .with_username("admin")
            .with_enable_secret("cisco-enable-secret-15")
            .with_notes("Cisco Catalyst 9300 Core Switch");
        vault.set_entry(entry);
        vault.save().unwrap();

        let loaded = Vault::load(&vault_file, master_pwd).unwrap();
        let loaded_entry = loaded.get_entry("session:cisco-core-01").unwrap();
        assert_eq!(loaded_entry.username.as_deref(), Some("admin"));
        assert_eq!(loaded_entry.secret.expose_secret(), "cisco-login-pass");
        assert!(loaded_entry.enable_secret.is_some());
        let enable_sec = loaded_entry.enable_secret.as_ref().unwrap();
        assert_eq!(enable_sec.expose_secret(), "cisco-enable-secret-15");
        assert_eq!(format!("{:?}", enable_sec), "[REDACTED]");
        assert_eq!(format!("{}", enable_sec), "[REDACTED]");
    }

    #[test]
    fn test_vault_entry_meta_has_enable_secret() {
        let dir = tempdir().unwrap();
        let vault_file = dir.path().join("vault.bin");

        let mut vault = Vault::create_fast(&vault_file, "meta_enable_test").unwrap();
        // Entry 1: Standard server (no enable password)
        vault.set_entry(
            VaultEntry::new("session:linux-server", "user-password")
                .with_username("ubuntu"),
        );
        // Entry 2: Network switch (with enable password)
        vault.set_entry(
            VaultEntry::new("session:switch-01", "switch-login")
                .with_username("netops")
                .with_enable_secret("privileged-enable-secret"),
        );

        let metas = vault.list_entries_meta();
        assert_eq!(metas.len(), 2);

        let linux_meta = metas.iter().find(|m| m.id == "session:linux-server").unwrap();
        assert!(!linux_meta.has_enable_secret);

        let switch_meta = metas.iter().find(|m| m.id == "session:switch-01").unwrap();
        assert!(switch_meta.has_enable_secret);

        let json = serde_json::to_string(&switch_meta).unwrap();
        assert!(!json.contains("privileged-enable-secret"));
        assert!(!json.contains("switch-login"));
    }

    #[test]
    fn test_vault_backward_compatibility_without_enable_secret() {
        // Legacy JSON without enable_secret field
        let legacy_json = r#"{
            "id": "session:old-entry",
            "username": "admin",
            "secret": "legacy-pass",
            "notes": "created before enable_secret existed",
            "created_at": 1700000000,
            "updated_at": 1700000000
        }"#;

        let entry: VaultEntry = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(entry.id, "session:old-entry");
        assert_eq!(entry.secret.expose_secret(), "legacy-pass");
        assert!(entry.enable_secret.is_none());

        let meta = VaultEntryMeta::from(&entry);
        assert!(!meta.has_enable_secret);
    }
}
