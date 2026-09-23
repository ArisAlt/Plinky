use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::{thread_rng, RngCore};
use zeroize::Zeroizing;

use crate::errors::{PlinkyError, Result};

pub const MAGIC: &[u8; 4] = b"PLKV";
pub const CURRENT_VERSION: u32 = 1;
pub const HEADER_SIZE: usize = 36;
pub const NONCE_SIZE: usize = 12;
pub const TAG_SIZE: usize = 16;
pub const AAD_DOMAIN_PREFIX: &[u8] = b"PLKV_AAD_v1:";

// OWASP recommended defaults for interactive password storage
pub const DEFAULT_M_COST: u32 = 65536; // 64 MiB
pub const DEFAULT_T_COST: u32 = 3;     // 3 iterations
pub const DEFAULT_P_COST: u32 = 1;     // 1 thread

// Fast parameters for test runs
pub const TEST_M_COST: u32 = 19456;    // 19 MiB
pub const TEST_T_COST: u32 = 1;        // 1 iteration
pub const TEST_P_COST: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultHeader {
    pub version: u32,
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    pub salt: [u8; 16],
}

impl VaultHeader {
    pub fn new_default() -> Self {
        let mut salt = [0u8; 16];
        thread_rng().fill_bytes(&mut salt);
        Self {
            version: CURRENT_VERSION,
            m_cost: DEFAULT_M_COST,
            t_cost: DEFAULT_T_COST,
            p_cost: DEFAULT_P_COST,
            salt,
        }
    }

    pub fn new_fast() -> Self {
        let mut salt = [0u8; 16];
        thread_rng().fill_bytes(&mut salt);
        Self {
            version: CURRENT_VERSION,
            m_cost: TEST_M_COST,
            t_cost: TEST_T_COST,
            p_cost: TEST_P_COST,
            salt,
        }
    }

    pub fn to_bytes(&self) -> [u8; HEADER_SIZE] {
        let mut bytes = [0u8; HEADER_SIZE];
        bytes[0..4].copy_from_slice(MAGIC);
        bytes[4..8].copy_from_slice(&self.version.to_be_bytes());
        bytes[8..12].copy_from_slice(&self.m_cost.to_be_bytes());
        bytes[12..16].copy_from_slice(&self.t_cost.to_be_bytes());
        bytes[16..20].copy_from_slice(&self.p_cost.to_be_bytes());
        bytes[20..36].copy_from_slice(&self.salt);
        bytes
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < HEADER_SIZE {
            return Err(PlinkyError::VaultError(format!(
                "Invalid vault header length: expected {} bytes, got {}",
                HEADER_SIZE,
                bytes.len()
            )));
        }

        if &bytes[0..4] != MAGIC {
            return Err(PlinkyError::VaultError(
                "Invalid vault magic header. File is not a Plinky vault container.".to_string(),
            ));
        }

        let version = u32::from_be_bytes(bytes[4..8].try_into().unwrap());
        if version != CURRENT_VERSION {
            return Err(PlinkyError::VaultError(format!(
                "Unsupported vault version: {}. Expected version {}",
                version, CURRENT_VERSION
            )));
        }

        let m_cost = u32::from_be_bytes(bytes[8..12].try_into().unwrap());
        let t_cost = u32::from_be_bytes(bytes[12..16].try_into().unwrap());
        let p_cost = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
        let mut salt = [0u8; 16];
        salt.copy_from_slice(&bytes[20..36]);

        Ok(Self {
            version,
            m_cost,
            t_cost,
            p_cost,
            salt,
        })
    }

    pub fn aad(&self) -> Vec<u8> {
        let mut aad = Vec::with_capacity(AAD_DOMAIN_PREFIX.len() + HEADER_SIZE);
        aad.extend_from_slice(AAD_DOMAIN_PREFIX);
        aad.extend_from_slice(&self.to_bytes());
        aad
    }
}

/// Derive 256-bit AES master key from password and Argon2 parameters.
pub fn derive_key(
    password: &str,
    salt: &[u8; 16],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(m_cost, t_cost, p_cost, Some(32)).map_err(|e| {
        PlinkyError::VaultError(format!("Invalid Argon2 parameters: {}", e))
    })?;

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);

    argon2
        .hash_password_into(password.as_bytes(), salt, &mut *key)
        .map_err(|e| PlinkyError::VaultError(format!("Argon2 key derivation failed: {}", e)))?;

    Ok(key)
}

/// Encrypt plaintext using AES-256-GCM authenticated with AAD derived from the header.
pub fn encrypt_vault_payload(
    key: &[u8; 32],
    header: &VaultHeader,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));

    let mut nonce_bytes = [0u8; NONCE_SIZE];
    thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let aad = header.aad();
    let payload = Payload {
        msg: plaintext,
        aad: &aad,
    };

    let ciphertext = cipher.encrypt(nonce, payload).map_err(|e| {
        PlinkyError::VaultError(format!("AES-GCM encryption failed: {}", e))
    })?;

    let header_bytes = header.to_bytes();
    let mut container = Vec::with_capacity(HEADER_SIZE + NONCE_SIZE + ciphertext.len());
    container.extend_from_slice(&header_bytes);
    container.extend_from_slice(&nonce_bytes);
    container.extend_from_slice(&ciphertext);

    Ok(container)
}

/// Decrypt container data, verifying authentication tag and AAD.
/// Returns the parsed header, derived master key, and decrypted plaintext bytes.
pub fn decrypt_vault_payload(
    password: &str,
    container_data: &[u8],
) -> Result<(VaultHeader, Zeroizing<[u8; 32]>, Vec<u8>)> {
    let min_len = HEADER_SIZE + NONCE_SIZE + TAG_SIZE;
    if container_data.len() < min_len {
        return Err(PlinkyError::VaultError(format!(
            "Vault container too short ({} bytes, minimum is {} bytes)",
            container_data.len(),
            min_len
        )));
    }

    let header = VaultHeader::from_bytes(&container_data[0..HEADER_SIZE])?;
    let key = derive_key(
        password,
        &header.salt,
        header.m_cost,
        header.t_cost,
        header.p_cost,
    )?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&*key));

    let nonce_start = HEADER_SIZE;
    let nonce_end = nonce_start + NONCE_SIZE;
    let nonce = Nonce::from_slice(&container_data[nonce_start..nonce_end]);

    let ciphertext = &container_data[nonce_end..];
    let aad = header.aad();
    let payload = Payload {
        msg: ciphertext,
        aad: &aad,
    };

    let plaintext = cipher.decrypt(nonce, payload).map_err(|_| {
        PlinkyError::VaultError(
            "Authentication failed: incorrect master password or corrupted/tampered vault container."
                .to_string(),
        )
    })?;

    Ok((header, key, plaintext))
}

/// Atomically write data to disk by writing to a temporary file in the same directory
/// with restrictive permissions (0600 on Unix) and then renaming.
pub fn save_atomic(path: impl AsRef<Path>, data: &[u8]) -> Result<()> {
    let path = path.as_ref();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let tmp_path = parent.join(format!(
        ".{}.tmp.{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("vault"),
        thread_rng().next_u64()
    ));

    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = fs::Permissions::from_mode(0o600);
            let _ = fs::set_permissions(&tmp_path, perms);
        }

        file.write_all(data)?;
        file.sync_all()?;
    }

    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(PlinkyError::IoError(e));
    }

    Ok(())
}
