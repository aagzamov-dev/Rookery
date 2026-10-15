//! Encrypted vault (docs/04-DATA-SYNC-SECURITY.md §2).
//!
//! - Master password → Argon2id → KEK, which wraps a random 32-byte vault key (VK).
//! - Every secret is sealed with XChaCha20-Poly1305 under VK, `aad = secret id`.
//! - The PIN never encrypts the vault file. It wraps VK into an entry stored in the
//!   OS keychain, so a copied `vault.bin` is useless without the master password.
//! - VK lives only in memory and is zeroized on lock.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::model::VaultStatus;
use crate::{now_ms, Error, Result};

/// Wrong PINs before a cooldown, and before the PIN is disabled.
pub const PIN_COOLDOWN_AFTER: u32 = 5;
pub const PIN_DISABLE_AFTER: u32 = 10;
pub const PIN_COOLDOWN_MS: i64 = 30_000;

const MASTER_KDF: KdfParams = KdfParams { m_kib: 64 * 1024, t: 3, p: 1 };
const PIN_KDF: KdfParams = KdfParams { m_kib: 19 * 1024, t: 2, p: 1 };

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct KdfParams {
    m_kib: u32,
    t: u32,
    p: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Sealed {
    nonce: String,
    ct: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    vault_id: String,
    salt: String,
    kdf: KdfParams,
    wrapped_vk: Sealed,
    secrets: BTreeMap<String, Sealed>,
}

/// Stored in the OS keychain, never on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PinEntry {
    salt: String,
    kdf: KdfParams,
    wrapped_vk: Sealed,
    len: u8,
    failures: u32,
    last_fail_ms: i64,
}

/// Where the PIN entry lives. Real builds use the OS keychain; tests use memory.
pub trait PinStore: Send + Sync {
    fn get(&self, vault_id: &str) -> Result<Option<String>>;
    fn set(&self, vault_id: &str, value: &str) -> Result<()>;
    fn delete(&self, vault_id: &str) -> Result<()>;
}

pub struct KeyringPinStore;

impl KeyringPinStore {
    fn entry(vault_id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new("app.rook", &format!("pin:{vault_id}")).map_err(|e| Error::Keychain(e.to_string()))
    }
}

impl PinStore for KeyringPinStore {
    fn get(&self, vault_id: &str) -> Result<Option<String>> {
        match Self::entry(vault_id)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Keychain(e.to_string())),
        }
    }
    fn set(&self, vault_id: &str, value: &str) -> Result<()> {
        Self::entry(vault_id)?
            .set_password(value)
            .map_err(|e| Error::Keychain(e.to_string()))
    }
    fn delete(&self, vault_id: &str) -> Result<()> {
        match Self::entry(vault_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Keychain(e.to_string())),
        }
    }
}

pub struct Vault {
    path: PathBuf,
    file: Option<VaultFile>,
    vk: Option<Zeroizing<[u8; 32]>>,
    pins: Box<dyn PinStore>,
}

impl Vault {
    pub fn load_or_new(path: impl AsRef<Path>) -> Result<Self> {
        Self::with_pin_store(path, Box::new(KeyringPinStore))
    }

    pub fn with_pin_store(path: impl AsRef<Path>, pins: Box<dyn PinStore>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let file = if path.exists() {
            Some(serde_json::from_slice(&std::fs::read(&path)?)?)
        } else {
            None
        };
        Ok(Self { path, file, vk: None, pins })
    }

    pub fn is_initialised(&self) -> bool {
        self.file.is_some()
    }

    pub fn is_unlocked(&self) -> bool {
        self.vk.is_some()
    }

    pub fn status(&self) -> VaultStatus {
        let pin = self.pin_entry().ok().flatten();
        VaultStatus {
            initialised: self.is_initialised(),
            unlocked: self.is_unlocked(),
            pin_set: pin.is_some(),
            pin_disabled: pin.as_ref().map(|p| p.failures >= PIN_DISABLE_AFTER).unwrap_or(false),
            pin_length: pin.as_ref().map(|p| p.len),
            pin_attempts_left: pin.as_ref().map(|p| PIN_DISABLE_AFTER.saturating_sub(p.failures)),
        }
    }

    // ----------------------------------------------------------- master

    /// First-run: create the vault with a master password. Leaves it unlocked.
    pub fn create(&mut self, master: &str) -> Result<()> {
        if self.file.is_some() {
            return Err(Error::Other("vault already exists".into()));
        }
        if master.chars().count() < 8 {
            return Err(Error::Other("master password must be at least 8 characters".into()));
        }
        let salt = random::<16>();
        let kek = derive(master.as_bytes(), &salt, MASTER_KDF)?;
        let vk = Zeroizing::new(random::<32>());
        let file = VaultFile {
            version: 1,
            vault_id: crate::new_id(),
            salt: B64.encode(salt),
            kdf: MASTER_KDF,
            wrapped_vk: seal(&kek, vk.as_ref(), b"vk")?,
            secrets: BTreeMap::new(),
        };
        self.file = Some(file);
        self.vk = Some(vk);
        self.save()
    }

    pub fn unlock_master(&mut self, master: &str) -> Result<()> {
        let file = self.file.as_ref().ok_or(Error::VaultNotInitialised)?;
        let salt = B64.decode(&file.salt).map_err(|_| Error::Crypto)?;
        let kek = derive(master.as_bytes(), &salt, file.kdf)?;
        let vk = open(&kek, &file.wrapped_vk, b"vk").map_err(|_| Error::WrongPassword)?;
        self.vk = Some(to_key(&vk)?);
        Ok(())
    }

    pub fn lock(&mut self) {
        self.vk = None; // Zeroizing wipes on drop
    }

    // -------------------------------------------------------------- PIN

    pub fn set_pin(&mut self, pin: &str) -> Result<()> {
        validate_pin(pin)?;
        let vk = self.vk.as_ref().ok_or(Error::VaultLocked)?;
        let vault_id = self.vault_id()?.to_string();
        let salt = random::<16>();
        let pk = derive(pin.as_bytes(), &salt, PIN_KDF)?;
        let entry = PinEntry {
            salt: B64.encode(salt),
            kdf: PIN_KDF,
            wrapped_vk: seal(&pk, vk.as_ref(), vault_id.as_bytes())?,
            len: pin.len() as u8,
            failures: 0,
            last_fail_ms: 0,
        };
        self.pins.set(&vault_id, &serde_json::to_string(&entry)?)
    }

    pub fn clear_pin(&mut self) -> Result<()> {
        let id = self.vault_id()?.to_string();
        self.pins.delete(&id)
    }

    pub fn unlock_pin(&mut self, pin: &str) -> Result<()> {
        let vault_id = self.vault_id()?.to_string();
        let mut entry = self.pin_entry()?.ok_or(Error::PinNotSet)?;
        if entry.failures >= PIN_DISABLE_AFTER {
            return Err(Error::PinDisabled);
        }
        let now = now_ms();
        if entry.failures >= PIN_COOLDOWN_AFTER && now - entry.last_fail_ms < PIN_COOLDOWN_MS {
            let seconds = ((PIN_COOLDOWN_MS - (now - entry.last_fail_ms)) / 1000).max(1) as u32;
            return Err(Error::PinCooldown { seconds });
        }
        let salt = B64.decode(&entry.salt).map_err(|_| Error::Crypto)?;
        let pk = derive(pin.as_bytes(), &salt, entry.kdf)?;
        match open(&pk, &entry.wrapped_vk, vault_id.as_bytes()) {
            Ok(vk) => {
                self.vk = Some(to_key(&vk)?);
                if entry.failures != 0 {
                    entry.failures = 0;
                    entry.last_fail_ms = 0;
                    self.pins.set(&vault_id, &serde_json::to_string(&entry)?)?;
                }
                Ok(())
            }
            Err(_) => {
                entry.failures += 1;
                entry.last_fail_ms = now;
                self.pins.set(&vault_id, &serde_json::to_string(&entry)?)?;
                if entry.failures >= PIN_DISABLE_AFTER {
                    Err(Error::PinDisabled)
                } else {
                    Err(Error::WrongPin { attempts_left: PIN_DISABLE_AFTER - entry.failures })
                }
            }
        }
    }

    // ---------------------------------------------------------- secrets

    pub fn has(&self, id: &str) -> bool {
        self.file.as_ref().map(|f| f.secrets.contains_key(id)).unwrap_or(false)
    }

    pub fn get(&self, id: &str) -> Result<Option<Zeroizing<String>>> {
        let vk = self.vk.as_ref().ok_or(Error::VaultLocked)?;
        let file = self.file.as_ref().ok_or(Error::VaultNotInitialised)?;
        let Some(sealed) = file.secrets.get(id) else { return Ok(None) };
        let plain = open(vk, sealed, id.as_bytes())?;
        let s = String::from_utf8(plain.to_vec()).map_err(|_| Error::Crypto)?;
        Ok(Some(Zeroizing::new(s)))
    }

    pub fn set(&mut self, id: &str, value: &str) -> Result<()> {
        let vk = self.vk.as_ref().ok_or(Error::VaultLocked)?;
        let sealed = seal(vk, value.as_bytes(), id.as_bytes())?;
        let file = self.file.as_mut().ok_or(Error::VaultNotInitialised)?;
        file.secrets.insert(id.to_string(), sealed);
        self.save()
    }

    pub fn delete(&mut self, id: &str) -> Result<()> {
        if self.vk.is_none() {
            return Err(Error::VaultLocked);
        }
        let file = self.file.as_mut().ok_or(Error::VaultNotInitialised)?;
        if file.secrets.remove(id).is_some() {
            self.save()?;
        }
        Ok(())
    }

    /// Remove every secret whose id starts with `prefix` (e.g. `identity:<id>:`).
    pub fn delete_prefix(&mut self, prefix: &str) -> Result<()> {
        if self.vk.is_none() {
            return Err(Error::VaultLocked);
        }
        let file = self.file.as_mut().ok_or(Error::VaultNotInitialised)?;
        let before = file.secrets.len();
        file.secrets.retain(|k, _| !k.starts_with(prefix));
        if file.secrets.len() != before {
            self.save()?;
        }
        Ok(())
    }

    // ---------------------------------------------------------- internal

    fn vault_id(&self) -> Result<&str> {
        Ok(&self.file.as_ref().ok_or(Error::VaultNotInitialised)?.vault_id)
    }

    fn pin_entry(&self) -> Result<Option<PinEntry>> {
        let Ok(id) = self.vault_id() else { return Ok(None) };
        match self.pins.get(id)? {
            Some(s) => Ok(serde_json::from_str(&s).ok()),
            None => Ok(None),
        }
    }

    /// Atomic write: temp file + rename.
    fn save(&self) -> Result<()> {
        let file = self.file.as_ref().ok_or(Error::VaultNotInitialised)?;
        let tmp = self.path.with_extension("bin.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(file)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

fn validate_pin(pin: &str) -> Result<()> {
    if !(4..=6).contains(&pin.len()) || !pin.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::Other("PIN must be 4 to 6 digits".into()));
    }
    Ok(())
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

fn derive(secret: &[u8], salt: &[u8], p: KdfParams) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(p.m_kib, p.t, p.p, Some(32)).map_err(|_| Error::Crypto)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon.hash_password_into(secret, salt, out.as_mut()).map_err(|_| Error::Crypto)?;
    Ok(out)
}

fn to_key(bytes: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    let arr: [u8; 32] = bytes.try_into().map_err(|_| Error::Crypto)?;
    Ok(Zeroizing::new(arr))
}

fn seal(key: &[u8; 32], plain: &[u8], aad: &[u8]) -> Result<Sealed> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = random::<24>();
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| Error::Crypto)?;
    Ok(Sealed { nonce: B64.encode(nonce), ct: B64.encode(ct) })
}

fn open(key: &[u8; 32], s: &Sealed, aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = B64.decode(&s.nonce).map_err(|_| Error::Crypto)?;
    let ct = B64.decode(&s.ct).map_err(|_| Error::Crypto)?;
    if nonce.len() != 24 {
        return Err(Error::Crypto);
    }
    let pt = cipher
        .decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad })
        .map_err(|_| Error::Crypto)?;
    Ok(Zeroizing::new(pt))
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::collections::HashMap;
    use std::sync::Arc;

    #[derive(Default, Clone)]
    struct MemPins(Arc<Mutex<HashMap<String, String>>>);
    impl PinStore for MemPins {
        fn get(&self, id: &str) -> Result<Option<String>> {
            Ok(self.0.lock().get(id).cloned())
        }
        fn set(&self, id: &str, v: &str) -> Result<()> {
            self.0.lock().insert(id.into(), v.into());
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<()> {
            self.0.lock().remove(id);
            Ok(())
        }
    }

    fn new_vault(dir: &tempfile::TempDir, pins: MemPins) -> Vault {
        Vault::with_pin_store(dir.path().join("vault.bin"), Box::new(pins)).unwrap()
    }

    #[test]
    fn master_roundtrip_and_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let pins = MemPins::default();
        let mut v = new_vault(&dir, pins.clone());
        v.create("correct horse battery").unwrap();
        v.set("identity:a:password", "s3cret").unwrap();
        v.lock();
        assert!(matches!(v.get("identity:a:password"), Err(Error::VaultLocked)));

        // reload from disk
        let mut v = new_vault(&dir, pins);
        assert!(matches!(v.unlock_master("wrong password"), Err(Error::WrongPassword)));
        v.unlock_master("correct horse battery").unwrap();
        assert_eq!(v.get("identity:a:password").unwrap().unwrap().as_str(), "s3cret");
        assert!(v.has("identity:a:password"));
        assert!(!v.has("nope"));
    }

    #[test]
    fn file_on_disk_has_no_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = new_vault(&dir, MemPins::default());
        v.create("correct horse battery").unwrap();
        v.set("x", "PLAINTEXT-MARKER").unwrap();
        let raw = std::fs::read_to_string(dir.path().join("vault.bin")).unwrap();
        assert!(!raw.contains("PLAINTEXT-MARKER"));
    }

    #[test]
    fn pin_unlock_cooldown_and_disable() {
        let dir = tempfile::tempdir().unwrap();
        let pins = MemPins::default();
        let mut v = new_vault(&dir, pins.clone());
        v.create("correct horse battery").unwrap();
        v.set_pin("1234").unwrap();
        v.lock();

        v.unlock_pin("1234").unwrap();
        assert!(v.is_unlocked());
        v.lock();

        for i in 1..PIN_COOLDOWN_AFTER {
            match v.unlock_pin("0000") {
                Err(Error::WrongPin { attempts_left }) => assert_eq!(attempts_left, PIN_DISABLE_AFTER - i),
                other => panic!("unexpected {other:?}"),
            }
        }
        // 5th wrong → still WrongPin, then cooldown on the next try
        assert!(matches!(v.unlock_pin("0000"), Err(Error::WrongPin { .. })));
        assert!(matches!(v.unlock_pin("1234"), Err(Error::PinCooldown { .. })));

        // Simulate the cooldown passing and hit the disable limit.
        let id = v.vault_id().unwrap().to_string();
        let mut e: PinEntry = serde_json::from_str(&pins.get(&id).unwrap().unwrap()).unwrap();
        e.failures = PIN_DISABLE_AFTER - 1;
        e.last_fail_ms = 0;
        pins.set(&id, &serde_json::to_string(&e).unwrap()).unwrap();
        assert!(matches!(v.unlock_pin("0000"), Err(Error::PinDisabled)));
        assert!(matches!(v.unlock_pin("1234"), Err(Error::PinDisabled)));
        assert!(v.status().pin_disabled);

        // Master password still works; setting the PIN again re-enables it.
        v.unlock_master("correct horse battery").unwrap();
        v.set_pin("4321").unwrap();
        v.lock();
        v.unlock_pin("4321").unwrap();
    }

    #[test]
    fn pin_validation() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = new_vault(&dir, MemPins::default());
        v.create("correct horse battery").unwrap();
        assert!(v.set_pin("12").is_err());
        assert!(v.set_pin("12a4").is_err());
        assert!(v.set_pin("1234567").is_err());
        assert!(v.set_pin("123456").is_ok());
    }
}
