//! Backup files and device sync (docs/04 §5).
//!
//! One file format for both:
//! - **Backup file**: "Save as…", send it anywhere (Telegram, USB…), import on another device.
//! - **Sync folder**: each device writes its own file into a folder that Google Drive /
//!   OneDrive / Dropbox keeps in sync, and merges the other devices' files. One file per
//!   device means the cloud never sees two devices writing the same file.
//!
//! File: `RKRYBK1\n` + header JSON + `\n` + XChaCha20-Poly1305 ciphertext of the payload JSON.
//! The header (device name, time, salt, nonce) is readable without the password and is
//! authenticated as AAD. Key = Argon2id(sync password, salt), cached in memory per salt, so
//! only the first sync after unlocking pays for the key derivation.
//!
//! Merge: per item, newest version wins; deletions travel as tombstones.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::aead::{Aead, KeyInit, Payload as AeadPayload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use parking_lot::Mutex;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use zeroize::Zeroizing;

use crate::db::Db;
use crate::model::*;
use crate::vault::Vault;
use crate::{new_id, now_ms, CoreEvent, Error, Result};

const MAGIC: &[u8] = b"RKRYBK1\n";
pub const EXTENSION: &str = "rookerybackup";
const FORMAT: &str = "rookery-data";
const PASSWORD_SECRET: &str = "backup:password";
const CONFIG_KEY: &str = "backup.config";
const SALT_KEY: &str = "backup.salt";
const KDF: Kdf = Kdf { m_kib: 64 * 1024, t: 3, p: 1 };
const TICK: Duration = Duration::from_secs(10);
const MAX_FILE: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Kdf {
    m_kib: u32,
    t: u32,
    p: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Header {
    v: u32,
    kdf: Kdf,
    salt: String,
    nonce: String,
    device_id: String,
    device_name: String,
    created_at: i64,
}

// ------------------------------------------------------------------ payload

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityRecord {
    #[serde(flatten)]
    pub identity: Identity,
    /// kind (password | key | passphrase | sudo) → value.
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Payload {
    pub format: String,
    pub version: u32,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub hosts: Vec<Host>,
    #[serde(default)]
    pub identities: Vec<IdentityRecord>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub known_hosts: Vec<KnownHost>,
    #[serde(default)]
    pub settings: Vec<SettingRecord>,
    #[serde(default)]
    pub tombstones: Vec<Tombstone>,
}

/// Everything that syncs, secrets included (they only ever leave the process encrypted).
pub fn collect(db: &Db, vault: &Vault) -> Result<Payload> {
    let mut secrets: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    for (id, value) in vault.secrets_with_prefix("identity:")? {
        // identity:<uuid>:<kind>
        let mut it = id.splitn(3, ':').skip(1);
        if let (Some(ident), Some(kind)) = (it.next(), it.next()) {
            secrets.entry(ident.to_string()).or_default().insert(kind.to_string(), value.to_string());
        }
    }
    Ok(Payload {
        format: FORMAT.into(),
        version: 1,
        groups: db.list_groups()?,
        hosts: db.list_hosts()?,
        identities: db
            .list_identities()?
            .into_iter()
            .map(|identity| {
                let secrets = secrets.remove(&identity.id).unwrap_or_default();
                IdentityRecord { identity, secrets }
            })
            .collect(),
        snippets: db.list_snippets()?,
        known_hosts: db.list_known_hosts()?,
        settings: db.list_synced_settings()?,
        tombstones: db.list_tombstones()?,
    })
}

/// What to do with an identity's vault secrets after a merge.
pub enum SecretOp {
    Replace { identity_id: String, secrets: BTreeMap<String, String> },
    Delete { identity_id: String },
}

/// Merge `remote` into the database: newest version wins per item, tombstones delete.
/// Vault changes are returned so the caller applies them under the vault lock.
pub fn merge(db: &Db, remote: &Payload) -> Result<(MergeSummary, Vec<SecretOp>)> {
    if remote.format != FORMAT {
        return Err(Error::Other("not a Rookery data file".into()));
    }
    let mut sum = MergeSummary::default();
    let mut ops = Vec::new();
    let local_tomb: HashMap<(String, String), i64> =
        db.list_tombstones()?.into_iter().map(|t| ((t.kind, t.id), t.deleted_at)).collect();
    let remote_tomb: HashMap<(&str, &str), i64> =
        remote.tombstones.iter().map(|t| ((t.kind.as_str(), t.id.as_str()), t.deleted_at)).collect();
    // Should a remote record (kind, id, version) be written here? None = no; Some(true) = new.
    let decide = |kind: &str, id: &str, ver: i64, local_ver: Option<i64>| -> Option<bool> {
        if remote_tomb.get(&(kind, id)).is_some_and(|d| *d >= ver) {
            return None;
        }
        match local_ver {
            Some(l) => (ver > l).then_some(false),
            None => {
                let deleted_here = local_tomb.get(&(kind.to_string(), id.to_string())).is_some_and(|d| *d >= ver);
                (!deleted_here).then_some(true)
            }
        }
    };
    let count = |sum: &mut MergeSummary, new: bool| if new { sum.added += 1 } else { sum.updated += 1 };

    // Groups, parents first (a child cannot point at a parent that does not exist yet).
    let local_groups: HashMap<String, Group> = db.list_groups()?.into_iter().map(|g| (g.id.clone(), g)).collect();
    let mut known_groups: HashSet<String> = local_groups.keys().cloned().collect();
    let mut pending: Vec<&Group> = remote.groups.iter().collect();
    let mut accepted: Vec<(Group, bool)> = Vec::new();
    while !pending.is_empty() {
        let before = pending.len();
        pending.retain(|g| {
            let parent_ready = g.parent_id.as_ref().map(|p| known_groups.contains(p)).unwrap_or(true)
                || !remote.groups.iter().any(|x| Some(&x.id) == g.parent_id.as_ref());
            if !parent_ready {
                return true;
            }
            let local = local_groups.get(&g.id);
            if let Some(new) = decide("group", &g.id, g.updated_at, local.map(|l| l.updated_at)) {
                let mut g = (*g).clone();
                // The Dashboard auto-sync switch belongs to each device.
                g.auto_sync_enabled = local.map(|l| l.auto_sync_enabled).unwrap_or(false);
                accepted.push((g, new));
            }
            known_groups.insert(g.id.clone());
            false
        });
        if pending.len() == before {
            break; // cycle: write the rest without parents
        }
    }
    for g in pending {
        if let Some(new) = decide("group", &g.id, g.updated_at, local_groups.get(&g.id).map(|l| l.updated_at)) {
            let mut g = g.clone();
            g.parent_id = None;
            g.auto_sync_enabled = local_groups.get(&g.id).map(|l| l.auto_sync_enabled).unwrap_or(false);
            accepted.push((g, new));
        }
    }
    let existing_groups: HashSet<String> = local_groups.keys().cloned().chain(accepted.iter().map(|(g, _)| g.id.clone())).collect();
    for (mut g, new) in accepted {
        if g.parent_id.as_ref().is_some_and(|p| !existing_groups.contains(p)) {
            g.parent_id = None;
        }
        db.put_group(&g)?;
        db.clear_tombstone("group", &g.id)?;
        count(&mut sum, new);
    }

    // Identities (+ their secrets).
    let local_ids: HashMap<String, i64> = db.list_identities()?.into_iter().map(|i| (i.id, i.updated_at)).collect();
    for r in &remote.identities {
        let i = &r.identity;
        if let Some(new) = decide("identity", &i.id, i.updated_at, local_ids.get(&i.id).copied()) {
            db.put_identity(i)?;
            db.clear_tombstone("identity", &i.id)?;
            ops.push(SecretOp::Replace { identity_id: i.id.clone(), secrets: r.secrets.clone() });
            count(&mut sum, new);
        }
    }

    // Hosts.
    let all_groups: HashSet<String> = db.list_groups()?.into_iter().map(|g| g.id).collect();
    let local_hosts: HashMap<String, i64> = db.list_hosts()?.into_iter().map(|h| (h.id, h.updated_at)).collect();
    for h in &remote.hosts {
        if let Some(new) = decide("host", &h.id, h.updated_at, local_hosts.get(&h.id).copied()) {
            let mut h = h.clone();
            if h.group_id.as_ref().is_some_and(|g| !all_groups.contains(g)) {
                h.group_id = None;
            }
            db.put_host(&h)?;
            db.clear_tombstone("host", &h.id)?;
            count(&mut sum, new);
        }
    }

    // Snippets (an alias can exist only once).
    let local_snips: HashMap<String, i64> = db.list_snippets()?.into_iter().map(|s| (s.id, s.updated_at)).collect();
    for s in &remote.snippets {
        if let Some(new) = decide("snippet", &s.id, s.updated_at, local_snips.get(&s.id).copied()) {
            if db.put_snippet(s).is_err() {
                let mut s2 = s.clone();
                if let Some(a) = s2.alias.take() {
                    sum.notes.push(format!("Snippet \"{}\": alias \"{a}\" is already used here, saved without it", s.name));
                }
                db.put_snippet(&s2)?;
            }
            db.clear_tombstone("snippet", &s.id)?;
            count(&mut sum, new);
        }
    }

    // Trusted host keys (version = when it was trusted).
    let local_known: HashMap<String, i64> = db.list_known_hosts()?.into_iter().map(|k| (k.host_id, k.first_seen)).collect();
    for k in &remote.known_hosts {
        if decide("known_host", &k.host_id, k.first_seen, local_known.get(&k.host_id).copied()).is_some() {
            db.put_known_host(k)?;
            db.clear_tombstone("known_host", &k.host_id)?;
        }
    }

    // Settings (shortcuts, themes, terminal prefs, dashboard defaults…).
    let local_settings: HashMap<String, i64> = db.list_synced_settings()?.into_iter().map(|s| (s.key, s.updated_at)).collect();
    for s in &remote.settings {
        if local_settings.get(&s.key).map(|l| s.updated_at > *l).unwrap_or(true) {
            db.put_setting(s)?;
            sum.updated += 1;
        }
    }

    // Deletions.
    let versions: HashMap<(&str, String), i64> = db
        .list_groups()?
        .into_iter()
        .map(|g| (("group", g.id), g.updated_at))
        .chain(db.list_hosts()?.into_iter().map(|h| (("host", h.id), h.updated_at)))
        .chain(db.list_identities()?.into_iter().map(|i| (("identity", i.id), i.updated_at)))
        .chain(db.list_snippets()?.into_iter().map(|s| (("snippet", s.id), s.updated_at)))
        .chain(db.list_known_hosts()?.into_iter().map(|k| (("known_host", k.host_id), k.first_seen)))
        .collect();
    for t in &remote.tombstones {
        let kind: &str = match t.kind.as_str() {
            "group" => "group",
            "host" => "host",
            "identity" => "identity",
            "snippet" => "snippet",
            "known_host" => "known_host",
            _ => continue,
        };
        match versions.get(&(kind, t.id.clone())) {
            Some(v) if *v > t.deleted_at => {} // edited here after it was deleted there: keep
            Some(_) => {
                db.apply_delete(t)?;
                if kind == "identity" {
                    ops.push(SecretOp::Delete { identity_id: t.id.clone() });
                }
                if kind != "known_host" {
                    sum.deleted += 1;
                }
            }
            None => db.apply_delete(t)?, // just remember it
        }
    }

    Ok((sum, ops))
}

pub fn apply_secret_ops(vault: &mut Vault, ops: Vec<SecretOp>) -> Result<()> {
    for op in ops {
        match op {
            SecretOp::Replace { identity_id, secrets } => {
                let prefix = format!("identity:{identity_id}:");
                let entries: Vec<(String, Zeroizing<String>)> =
                    secrets.into_iter().map(|(k, v)| (format!("{prefix}{k}"), Zeroizing::new(v))).collect();
                vault.replace_prefix(&prefix, &entries)?;
            }
            SecretOp::Delete { identity_id } => vault.delete_prefix(&format!("identity:{identity_id}:"))?,
        }
    }
    Ok(())
}

// --------------------------------------------------------------- file crypto

fn derive(password: &str, salt: &[u8], k: Kdf) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(k.m_kib, k.t, k.p, Some(32)).map_err(|_| Error::Crypto)?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|_| Error::Crypto)?;
    Ok(out)
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

fn seal_file(plain: &[u8], key: &[u8; 32], salt: &str, device_id: &str, device_name: &str) -> Result<Vec<u8>> {
    let nonce = random::<24>();
    let header = Header {
        v: 1,
        kdf: KDF,
        salt: salt.to_string(),
        nonce: B64.encode(nonce),
        device_id: device_id.to_string(),
        device_name: device_name.to_string(),
        created_at: now_ms(),
    };
    let header_bytes = serde_json::to_vec(&header)?;
    let ct = XChaCha20Poly1305::new(Key::from_slice(key))
        .encrypt(XNonce::from_slice(&nonce), AeadPayload { msg: plain, aad: &header_bytes })
        .map_err(|_| Error::Crypto)?;
    let mut out = Vec::with_capacity(MAGIC.len() + header_bytes.len() + 1 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&header_bytes);
    out.push(b'\n');
    out.extend_from_slice(&ct);
    Ok(out)
}

fn split_file(bytes: &[u8]) -> Result<(Header, &[u8], &[u8])> {
    let rest = bytes.strip_prefix(MAGIC).ok_or_else(|| Error::Other("not a Rookery backup file".into()))?;
    let nl = rest.iter().position(|b| *b == b'\n').ok_or_else(|| Error::Other("damaged backup file".into()))?;
    let (header_bytes, ct) = (&rest[..nl], &rest[nl + 1..]);
    let header: Header = serde_json::from_slice(header_bytes).map_err(|_| Error::Other("damaged backup file".into()))?;
    if header.v != 1 {
        return Err(Error::Other("this backup was made by a newer Rookery; update first".into()));
    }
    Ok((header, header_bytes, ct))
}

fn open_file(header: &Header, header_bytes: &[u8], ct: &[u8], key: &[u8; 32]) -> Result<Payload> {
    let nonce = B64.decode(&header.nonce).map_err(|_| Error::Crypto)?;
    if nonce.len() != 24 {
        return Err(Error::Crypto);
    }
    let plain = Zeroizing::new(
        XChaCha20Poly1305::new(Key::from_slice(key))
            .decrypt(XNonce::from_slice(&nonce), AeadPayload { msg: ct, aad: header_bytes })
            .map_err(|_| Error::WrongPassword)?,
    );
    Ok(serde_json::from_slice(&plain)?)
}

fn read_limited(path: &Path) -> Result<Vec<u8>> {
    if std::fs::metadata(path)?.len() > MAX_FILE {
        return Err(Error::Other("file is too large to be a Rookery backup".into()));
    }
    Ok(std::fs::read(path)?)
}

/// Atomic write next to the target (cloud clients never upload a half-written file).
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("rookery-tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn slug(s: &str) -> String {
    let out: String = s.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let out = out.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if out.is_empty() { "device".into() } else { out.chars().take(32).collect() }
}

fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "This device".into())
}

fn mtime(path: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(path).ok()?;
    let t = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some((t, m.len()))
}

// ------------------------------------------------------------------- engine

#[derive(Default)]
struct State {
    last_sync_at: Option<i64>,
    last_error: Option<String>,
    last_summary: Option<MergeSummary>,
    peers: Vec<SyncPeer>,
    /// Peer files already merged, by (mtime, size).
    seen: HashMap<PathBuf, (u64, u64)>,
    /// Data revision written to our own file.
    pushed: Option<String>,
}

pub struct Backup {
    db: Arc<Db>,
    vault: Arc<Mutex<Vault>>,
    events: broadcast::Sender<CoreEvent>,
    state: Mutex<State>,
    keys: Mutex<HashMap<String, Zeroizing<[u8; 32]>>>,
    busy: tokio::sync::Mutex<()>,
    syncing: AtomicBool,
}

impl Backup {
    pub fn new(db: Arc<Db>, vault: Arc<Mutex<Vault>>, events: broadcast::Sender<CoreEvent>) -> Self {
        Self {
            db,
            vault,
            events,
            state: Mutex::new(State::default()),
            keys: Mutex::new(HashMap::new()),
            busy: tokio::sync::Mutex::new(()),
            syncing: AtomicBool::new(false),
        }
    }

    pub fn config(&self) -> Result<BackupConfig> {
        if let Some(c) = self.db.get_setting::<BackupConfig>(CONFIG_KEY)? {
            return Ok(c);
        }
        let c = BackupConfig { device_id: new_id(), device_name: default_device_name(), folder: None, auto: true };
        self.db.set_setting(CONFIG_KEY, &c)?;
        Ok(c)
    }

    pub fn set_config(&self, folder: Option<String>, auto: bool, device_name: String) -> Result<BackupStatus> {
        let mut c = self.config()?;
        let name = device_name.trim();
        c.device_name = if name.is_empty() { default_device_name() } else { name.chars().take(48).collect() };
        c.folder = folder.map(|f| f.trim().to_string()).filter(|f| !f.is_empty());
        c.auto = auto;
        if let Some(f) = &c.folder {
            if !Path::new(f).is_dir() {
                return Err(Error::Other("that folder does not exist".into()));
            }
        }
        self.db.set_setting(CONFIG_KEY, &c)?;
        {
            let mut st = self.state.lock();
            st.seen.clear();
            st.pushed = None;
            st.peers.clear();
        }
        self.emit_status();
        self.status()
    }

    pub fn status(&self) -> Result<BackupStatus> {
        let config = self.config()?;
        let has_password = self.vault.lock().has(PASSWORD_SECRET);
        let st = self.state.lock();
        Ok(BackupStatus {
            config,
            has_password,
            syncing: self.syncing.load(Ordering::SeqCst),
            last_sync_at: st.last_sync_at,
            last_error: st.last_error.clone(),
            last_summary: st.last_summary.clone(),
            peers: st.peers.clone(),
        })
    }

    fn emit_status(&self) {
        if let Ok(status) = self.status() {
            let _ = self.events.send(CoreEvent::BackupStatus { status });
        }
    }

    /// Set the sync password (same on every device). Stored in this device's vault.
    pub fn set_password(&self, password: &str) -> Result<()> {
        if password.chars().count() < 8 {
            return Err(Error::Other("use at least 8 characters".into()));
        }
        self.vault.lock().set(PASSWORD_SECRET, password)?;
        self.db.set_setting(SALT_KEY, &B64.encode(random::<16>()))?;
        self.keys.lock().clear();
        {
            let mut st = self.state.lock();
            st.seen.clear();
            st.pushed = None;
        }
        self.emit_status();
        Ok(())
    }

    /// Forget derived keys (app locked).
    pub fn lock(&self) {
        self.keys.lock().clear();
    }

    fn saved_password(&self) -> Result<Zeroizing<String>> {
        self.vault
            .lock()
            .get(PASSWORD_SECRET)?
            .ok_or_else(|| Error::Other("set a sync password first".into()))
    }

    /// Derived key for a salt, cached (only the first use pays for Argon2id).
    fn key_for(&self, password: Option<&str>, salt_b64: &str, kdf: Kdf) -> Result<Zeroizing<[u8; 32]>> {
        if password.is_none() {
            if let Some(k) = self.keys.lock().get(salt_b64) {
                return Ok(k.clone());
            }
        }
        let salt = B64.decode(salt_b64).map_err(|_| Error::Crypto)?;
        let pw = match password {
            Some(p) => Zeroizing::new(p.to_string()),
            None => self.saved_password()?,
        };
        if kdf.m_kib > 1024 * 1024 || kdf.t > 20 {
            return Err(Error::Other("backup file asks for unreasonable key settings".into()));
        }
        let key = derive(&pw, &salt, kdf)?;
        if password.is_none() {
            self.keys.lock().insert(salt_b64.to_string(), key.clone());
        }
        Ok(key)
    }

    fn own_salt(&self) -> Result<String> {
        if let Some(s) = self.db.get_setting::<String>(SALT_KEY)? {
            return Ok(s);
        }
        let s = B64.encode(random::<16>());
        self.db.set_setting(SALT_KEY, &s)?;
        Ok(s)
    }

    fn encrypt_payload(&self, password: Option<&str>) -> Result<Vec<u8>> {
        let payload = {
            let v = self.vault.lock();
            if !v.is_unlocked() {
                return Err(Error::VaultLocked);
            }
            collect(&self.db, &v)?
        };
        let plain = Zeroizing::new(serde_json::to_vec(&payload)?);
        let cfg = self.config()?;
        let salt = match password {
            Some(_) => B64.encode(random::<16>()),
            None => self.own_salt()?,
        };
        let key = self.key_for(password, &salt, KDF)?;
        seal_file(&plain, &key, &salt, &cfg.device_id, &cfg.device_name)
    }

    fn decrypt(&self, bytes: &[u8], password: Option<&str>) -> Result<(Header, Payload)> {
        let (header, header_bytes, ct) = split_file(bytes)?;
        let key = self.key_for(password, &header.salt, header.kdf)?;
        let payload = open_file(&header, header_bytes, ct, &key)?;
        Ok((header, payload))
    }

    fn apply(&self, payload: &Payload) -> Result<MergeSummary> {
        let (sum, ops) = merge(&self.db, payload)?;
        apply_secret_ops(&mut self.vault.lock(), ops)?;
        if sum.changed() || !sum.notes.is_empty() {
            let _ = self.events.send(CoreEvent::DataChanged { summary: sum.clone() });
        }
        Ok(sum)
    }

    // ----------------------------------------------------------- backup files

    /// Write a full backup. `password` None = the saved sync password.
    pub fn export_file(&self, path: &Path, password: Option<&str>) -> Result<()> {
        let bytes = self.encrypt_payload(password)?;
        write_atomic(path, &bytes)
    }

    /// Peek into a backup before importing. Fails with `WrongPassword` when the password does not fit.
    pub fn inspect_file(&self, path: &Path, password: Option<&str>) -> Result<BackupInfo> {
        let (h, p) = self.decrypt(&read_limited(path)?, password)?;
        Ok(BackupInfo {
            device_name: h.device_name.clone(),
            created_at: h.created_at,
            hosts: p.hosts.len() as u32,
            groups: p.groups.len() as u32,
            identities: p.identities.len() as u32,
            snippets: p.snippets.len() as u32,
        })
    }

    pub fn import_file(&self, path: &Path, password: Option<&str>, mode: ImportMode) -> Result<MergeSummary> {
        let (_, payload) = self.decrypt(&read_limited(path)?, password)?;
        if payload.format != FORMAT {
            return Err(Error::Other("not a Rookery data file".into()));
        }
        if mode == ImportMode::Replace {
            self.db.wipe_synced()?;
            self.vault.lock().delete_prefix("identity:")?;
        }
        let sum = self.apply(&payload)?;
        self.state.lock().pushed = None; // our sync file should reflect the import
        Ok(sum)
    }

    // ------------------------------------------------------------- sync folder

    /// Merge the other devices' files, then write ours if anything changed.
    pub async fn sync_now(&self, force_push: bool) -> Result<BackupStatus> {
        let _guard = self.busy.lock().await;
        let cfg = self.config()?;
        let Some(folder) = cfg.folder.clone() else { return Err(Error::Other("choose a sync folder first".into())) };
        self.syncing.store(true, Ordering::SeqCst);
        self.emit_status();
        // Key derivation and file IO are blocking: keep them off the async workers.
        let result = tokio::task::block_in_place(|| self.sync_inner(Path::new(&folder), &cfg, force_push));
        self.syncing.store(false, Ordering::SeqCst);
        {
            let mut st = self.state.lock();
            match &result {
                Ok(sum) => {
                    st.last_sync_at = Some(now_ms());
                    st.last_error = None;
                    if let Some(s) = sum {
                        st.last_summary = Some(s.clone());
                    }
                }
                Err(e) => st.last_error = Some(e.to_string()),
            }
        }
        self.emit_status();
        result.map(|_| ())?;
        self.status()
    }

    fn sync_inner(&self, folder: &Path, cfg: &BackupConfig, force_push: bool) -> Result<Option<MergeSummary>> {
        if !self.vault.lock().is_unlocked() {
            return Err(Error::VaultLocked);
        }
        self.saved_password()?;
        let own_name = format!("rookery-{}-{}.{EXTENSION}", slug(&cfg.device_name), &cfg.device_id[..8.min(cfg.device_id.len())]);
        let own_path = folder.join(&own_name);

        // Pull: every device file but ours. Only decrypt files that changed since last time.
        let mut total = MergeSummary::default();
        let mut merged_any = false;
        let mut peers = Vec::new();
        let mut stale_own = Vec::new();
        for entry in std::fs::read_dir(folder)? {
            let path = entry?.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            if !(name.starts_with("rookery-") && name.ends_with(&format!(".{EXTENSION}"))) || path == own_path {
                continue;
            }
            let Ok(bytes) = read_limited(&path) else { continue };
            let Ok((header, _, _)) = split_file(&bytes) else { continue };
            if header.device_id == cfg.device_id {
                stale_own.push(path); // written under an old device name
                continue;
            }
            let stamp = mtime(&path);
            let unchanged = stamp.is_some() && self.state.lock().seen.get(&path) == stamp.as_ref();
            let mut peer = SyncPeer {
                device_id: header.device_id.clone(),
                device_name: header.device_name.clone(),
                written_at: header.created_at,
                error: None,
            };
            if !unchanged {
                match self.decrypt(&bytes, None) {
                    Ok((_, payload)) => match self.apply(&payload) {
                        Ok(sum) => {
                            merged_any = true;
                            total.added += sum.added;
                            total.updated += sum.updated;
                            total.deleted += sum.deleted;
                            total.notes.extend(sum.notes);
                            if let Some(s) = stamp {
                                self.state.lock().seen.insert(path.clone(), s);
                            }
                        }
                        Err(e) => peer.error = Some(e.to_string()),
                    },
                    Err(Error::WrongPassword) => peer.error = Some("uses a different sync password".into()),
                    Err(e) => peer.error = Some(e.to_string()),
                }
            } else if let Some(prev) = self.state.lock().peers.iter().find(|p| p.device_id == header.device_id) {
                peer.error = prev.error.clone();
            }
            peers.push(peer);
        }
        peers.sort_by(|a, b| a.device_name.cmp(&b.device_name));
        self.state.lock().peers = peers;
        for p in stale_own {
            let _ = std::fs::remove_file(p);
        }

        // Push: our file, when our data changed (or it is missing).
        let rev = self.db.data_revision()?;
        let need = force_push || !own_path.exists() || self.state.lock().pushed.as_deref() != Some(rev.as_str());
        if need {
            let bytes = self.encrypt_payload(None)?;
            write_atomic(&own_path, &bytes)?;
            self.state.lock().pushed = Some(rev);
        }
        Ok(merged_any.then_some(total))
    }

    /// Auto-sync: every few seconds, cheap checks (file times, one revision query).
    pub async fn run_scheduler(self: Arc<Self>) {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let ready = (|| -> Result<bool> {
                let cfg = self.config()?;
                let v = self.vault.lock();
                Ok(cfg.auto && cfg.folder.is_some() && v.is_unlocked() && v.has(PASSWORD_SECRET))
            })()
            .unwrap_or(false);
            if !ready || self.syncing.load(Ordering::SeqCst) {
                continue;
            }
            if let Err(e) = self.sync_now(false).await {
                tracing::debug!("auto sync: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(id: &str, name: &str, updated_at: i64) -> Host {
        Host {
            id: id.into(),
            group_id: None,
            name: name.into(),
            address: "10.0.0.1".into(),
            port: 22,
            env_label: EnvLabel::default(),
            tags: vec![],
            identity_id: None,
            jump_host_id: None,
            theme: None,
            start_view: StartView::default(),
            start_folder: None,
            auto_reconnect: true,
            keepalive_s: 30,
            log_session: false,
            refresh: RefreshSetting::default(),
            sort: 0,
            created_at: 1,
            updated_at,
        }
    }

    fn payload(db: &Db) -> Payload {
        Payload {
            format: FORMAT.into(),
            version: 1,
            groups: db.list_groups().unwrap(),
            hosts: db.list_hosts().unwrap(),
            identities: vec![],
            snippets: db.list_snippets().unwrap(),
            known_hosts: db.list_known_hosts().unwrap(),
            settings: db.list_synced_settings().unwrap(),
            tombstones: db.list_tombstones().unwrap(),
        }
    }

    #[test]
    fn two_devices_converge_newest_wins_and_deletes_travel() {
        let pc = Db::open_in_memory().unwrap();
        let laptop = Db::open_in_memory().unwrap();
        pc.put_host(&host("a", "web", 100)).unwrap();
        pc.put_host(&host("b", "db", 100)).unwrap();
        laptop.put_host(&host("a", "web-renamed", 200)).unwrap(); // newer edit
        laptop.put_host(&host("c", "cache", 150)).unwrap();

        // laptop → pc
        let (sum, _) = merge(&pc, &payload(&laptop)).unwrap();
        assert_eq!((sum.added, sum.updated), (1, 1));
        assert_eq!(pc.get_host("a").unwrap().name, "web-renamed");

        // pc deletes "b"; pc → laptop brings "b"'s deletion and keeps the rest
        let (sum, _) = merge(&laptop, &payload(&pc)).unwrap();
        assert_eq!(sum.added, 1); // b
        pc.delete_host("b").unwrap();
        let (sum, _) = merge(&laptop, &payload(&pc)).unwrap();
        assert_eq!(sum.deleted, 1);
        assert!(laptop.get_host("b").is_err());

        // the old laptop file (still has "b") must not bring it back on the pc
        let old = Payload { hosts: vec![host("b", "db", 100)], ..payload(&laptop) };
        let (sum, _) = merge(&pc, &old).unwrap();
        assert_eq!(sum.added, 0);
        assert!(pc.get_host("b").is_err());

        let names = |db: &Db| {
            let mut v: Vec<String> = db.list_hosts().unwrap().into_iter().map(|h| h.name).collect();
            v.sort();
            v
        };
        assert_eq!(names(&pc), names(&laptop));
    }

    #[test]
    fn edit_after_delete_wins() {
        let pc = Db::open_in_memory().unwrap();
        let laptop = Db::open_in_memory().unwrap();
        pc.put_host(&host("a", "web", 100)).unwrap();
        pc.delete_host("a").unwrap(); // deleted "now"
        laptop.put_host(&host("a", "web", now_ms() + 60_000)).unwrap(); // edited later
        let (sum, _) = merge(&laptop, &payload(&pc)).unwrap();
        assert_eq!(sum.deleted, 0);
        assert!(laptop.get_host("a").is_ok());
    }

    #[test]
    fn child_groups_arrive_after_parents_and_switch_stays_local() {
        let pc = Db::open_in_memory().unwrap();
        let laptop = Db::open_in_memory().unwrap();
        let g = |id: &str, parent: Option<&str>| Group {
            id: id.into(),
            parent_id: parent.map(String::from),
            name: id.into(),
            color: "#8AB4FF".into(),
            sort: 0,
            identity_id: None,
            jump_host_id: None,
            theme: None,
            start_folder: None,
            refresh: RefreshSetting::default(),
            auto_sync_enabled: true,
            updated_at: 10,
        };
        // child listed first on purpose
        let p = Payload { groups: vec![g("child", Some("parent")), g("parent", None)], ..payload(&pc) };
        let (sum, _) = merge(&laptop, &p).unwrap();
        assert_eq!(sum.added, 2);
        let child = laptop.get_group("child").unwrap().unwrap();
        assert_eq!(child.parent_id.as_deref(), Some("parent"));
        assert!(!child.auto_sync_enabled, "dashboard switch is per device");
    }

    #[test]
    fn file_roundtrip_wrong_password_and_tamper() {
        let payload = Payload { format: FORMAT.into(), version: 1, hosts: vec![host("a", "web", 1)], ..Default::default() };
        let plain = serde_json::to_vec(&payload).unwrap();
        let salt = B64.encode(random::<16>());
        let fast = Kdf { m_kib: 8, t: 1, p: 1 };
        let key = derive("correct horse", &B64.decode(&salt).unwrap(), fast).unwrap();
        // seal with test params by patching the header kdf
        let mut bytes = seal_file(&plain, &key, &salt, "dev1", "PC").unwrap();
        let (h, hb, ct) = split_file(&bytes).unwrap();
        assert_eq!(h.device_name, "PC");
        let back = open_file(&h, hb, ct, &key).unwrap();
        assert_eq!(back.hosts[0].name, "web");
        let wrong = derive("wrong", &B64.decode(&salt).unwrap(), fast).unwrap();
        assert!(matches!(open_file(&h, hb, ct, &wrong), Err(Error::WrongPassword)));
        // flip one ciphertext byte
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        let (h, hb, ct) = split_file(&bytes).unwrap();
        assert!(open_file(&h, hb, ct, &key).is_err());
    }

    /// Two app instances ("PC" and "Laptop") sharing one sync folder, like Google Drive would.
    #[tokio::test(flavor = "multi_thread")]
    async fn pc_and_laptop_sync_through_a_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let shared = tmp.path().join("Google Drive").join("Rookery");
        std::fs::create_dir_all(&shared).unwrap();
        let device = |name: &str| {
            let core = crate::Core::init(tmp.path().join(name)).unwrap();
            core.vault.lock().create("master password").unwrap();
            core.backup.set_password("same sync password").unwrap();
            core.backup.set_config(Some(shared.to_string_lossy().into()), true, name.into()).unwrap();
            core
        };
        let pc = device("PC");
        let laptop = device("Laptop");

        // PC has 2 servers and a login with a password; laptop adds its own server.
        let ident = pc
            .db
            .save_identity(Identity {
                id: String::new(),
                name: "root".into(),
                username: "root".into(),
                auth: AuthKind::Password,
                key_path: None,
                has_password: false,
                has_key: false,
                has_passphrase: false,
                has_sudo: false,
                updated_at: 0,
            })
            .unwrap();
        pc.vault.lock().set(&ident.secret_id("password"), "hunter2").unwrap();
        pc.db.save_host(host("", "web", 0)).unwrap();
        let db_host = pc.db.save_host(host("", "db", 0)).unwrap();
        laptop.db.save_host(host("", "laptop-only", 0)).unwrap();

        pc.backup.sync_now(false).await.unwrap();
        let st = laptop.backup.sync_now(false).await.unwrap();
        assert_eq!(st.peers.len(), 1);
        assert_eq!(st.peers[0].device_name, "PC");
        assert_eq!(laptop.db.list_hosts().unwrap().len(), 3);
        // the password came along, encrypted in transit, into the laptop's own vault
        assert_eq!(laptop.vault.lock().get(&ident.secret_id("password")).unwrap().unwrap().as_str(), "hunter2");

        // PC picks up the laptop's server
        pc.backup.sync_now(false).await.unwrap();
        assert_eq!(pc.db.list_hosts().unwrap().len(), 3);

        // delete on the laptop → gone on the PC too
        laptop.db.delete_host(&db_host.id).unwrap();
        laptop.backup.sync_now(false).await.unwrap();
        pc.backup.sync_now(false).await.unwrap();
        let names: Vec<String> = pc.db.list_hosts().unwrap().into_iter().map(|h| h.name).collect();
        assert!(!names.contains(&"db".to_string()), "{names:?}");

        // one file per device, nothing else left behind
        let mut files: Vec<String> = std::fs::read_dir(&shared)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        files.sort();
        assert_eq!(files.len(), 2, "{files:?}");
        assert!(files.iter().all(|f| f.ends_with(".rookerybackup")));

        // a device with another password sees the file but cannot read it
        let other = crate::Core::init(tmp.path().join("Other")).unwrap();
        other.vault.lock().create("other master password").unwrap();
        other.backup.set_password("a different password").unwrap();
        other.backup.set_config(Some(shared.to_string_lossy().into()), true, "Other".into()).unwrap();
        let st = other.backup.sync_now(false).await.unwrap();
        assert!(st.peers.iter().all(|p| p.error.as_deref() == Some("uses a different sync password")));
        assert!(other.db.list_hosts().unwrap().is_empty());
    }

    #[test]
    fn device_file_names_are_safe() {
        assert_eq!(slug("Abdurashid's Laptop (2)"), "abdurashid-s-laptop-2");
        assert_eq!(slug("..."), "device");
    }
}
