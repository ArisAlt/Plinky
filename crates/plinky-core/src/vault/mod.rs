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
    pub notes: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
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
            notes: None,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn with_username(mut self, username: impl Into<String>) -> Self {
        self.username = Some(username.into());
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
}
