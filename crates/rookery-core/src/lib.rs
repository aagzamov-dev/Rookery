//! Rookery core library.
//!
//! Everything that is not UI lives here: vault, SQLite storage, SSH
//! connection management, terminals, collectors and subscriptions.
//! `rookery-tauri` (desktop) and the future mobile shell are thin glue on top.
//!
//! Lazy-load contract (see docs/01-ARCHITECTURE.md §1, §4, §5):
//! - a host in the database never causes a connection;
//! - a connection is opened only when something takes a [`ssh::Lease`];
//! - collectors run only while there is an active subscription for them.

pub mod actions;
pub mod backup;
pub mod collectors;
pub mod db;
pub mod error;
pub mod events;
pub mod importers;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod local;
pub mod model;
pub mod sessionlog;
pub mod sftp;
pub mod ssh;
pub mod subscriptions;
pub mod sync;
pub mod terminal;
pub mod vault;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::broadcast;

pub use error::{Error, Result};
pub use events::CoreEvent;

/// Grace period before an unleased SSH session is closed.
pub const SESSION_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

/// Root object owned by the app shell. Cheap to clone (all `Arc`s).
#[derive(Clone)]
pub struct Core {
    pub data_dir: PathBuf,
    pub db: Arc<db::Db>,
    pub vault: Arc<Mutex<vault::Vault>>,
    pub connections: Arc<ssh::ConnectionManager>,
    pub terminals: Arc<terminal::Terminals>,
    pub subscriptions: Arc<subscriptions::Subscriptions>,
    pub sftp: Arc<sftp::Sftp>,
    pub sync: Arc<sync::SyncEngine>,
    pub backup: Arc<backup::Backup>,
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub local: Arc<local::LocalTerminals>,
    pub events: broadcast::Sender<CoreEvent>,
}

impl Core {
    /// Open (or create) the data directory, database and vault file.
    /// Does **not** unlock the vault and does **not** open any connection.
    pub fn init(data_dir: impl AsRef<Path>) -> Result<Self> {
        let data_dir = data_dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&data_dir)?;
        std::fs::create_dir_all(data_dir.join("cache"))?;

        migrate_legacy_db(&data_dir);
        let db = Arc::new(db::Db::open(data_dir.join(DB_FILE))?);
        let vault = Arc::new(Mutex::new(vault::Vault::load_or_new(data_dir.join("vault.bin"))?));
        let (events, _) = broadcast::channel(1024);

        let connections = Arc::new(ssh::ConnectionManager::new(
            db.clone(),
            vault.clone(),
            events.clone(),
        ));
        let terminals = Arc::new(terminal::Terminals::new(connections.clone(), events.clone(), db.clone(), data_dir.join("logs")));
        let subscriptions = Arc::new(subscriptions::Subscriptions::new(
            connections.clone(),
            events.clone(),
        ));
        let sftp = Arc::new(sftp::Sftp::new(connections.clone(), events.clone(), data_dir.join("cache")));
        let sync = Arc::new(sync::SyncEngine::new(db.clone(), vault.clone(), connections.clone(), events.clone()));
        let backup = Arc::new(backup::Backup::new(db.clone(), vault.clone(), events.clone()));

        Ok(Self {
            data_dir,
            db,
            vault,
            connections,
            terminals,
            subscriptions,
            sftp,
            sync,
            backup,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            local: Arc::new(local::LocalTerminals::new(events.clone())),
            events,
        })
    }

    /// Default per-user data directory (`%APPDATA%/Rookery`, `~/Library/Application Support/Rookery`).
    /// Moves the folder of the old "Rook" builds the first time.
    pub fn default_data_dir() -> PathBuf {
        let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
        migrate_legacy_dir(&base.join(LEGACY_DIR), &base.join(DATA_DIR))
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<CoreEvent> {
        self.events.subscribe()
    }

    /// Lock the vault, stop every subscription and (optionally) close sessions.
    pub async fn lock(&self, close_sessions: bool) {
        self.sync.cancel_all();
        self.backup.lock();
        self.subscriptions.stop_all().await;
        if close_sessions {
            self.terminals.close_all().await;
            self.connections.close_all().await;
        }
        self.vault.lock().lock();
        let _ = self.events.send(CoreEvent::VaultLocked);
    }
}

pub const DATA_DIR: &str = "Rookery";
const DB_FILE: &str = "rookery.db";
/// The app was called "Rook" before it became Rookery.
const LEGACY_DIR: &str = "Rook";
const LEGACY_DB_FILE: &str = "rook.db";

/// Move the old data folder to the new name once. If that fails (another copy still has
/// files open), keep using the old folder rather than starting empty.
pub fn migrate_legacy_dir(old: &Path, new: &Path) -> PathBuf {
    if new.exists() || !old.exists() {
        return new.to_path_buf();
    }
    match std::fs::rename(old, new) {
        Ok(()) => {
            tracing::info!("moved data folder {} -> {}", old.display(), new.display());
            new.to_path_buf()
        }
        Err(e) => {
            tracing::warn!("could not move {} ({e}); using it as is", old.display());
            old.to_path_buf()
        }
    }
}

/// Rename `rook.db` (with its WAL / SHM files) to `rookery.db`, before it is opened.
fn migrate_legacy_db(dir: &Path) {
    if dir.join(DB_FILE).exists() || !dir.join(LEGACY_DB_FILE).exists() {
        return;
    }
    for suffix in ["", "-wal", "-shm"] {
        let old = dir.join(format!("{LEGACY_DB_FILE}{suffix}"));
        if old.exists() {
            if let Err(e) = std::fs::rename(&old, dir.join(format!("{DB_FILE}{suffix}"))) {
                tracing::warn!("could not rename {}: {e}", old.display());
            }
        }
    }
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_rook_data_moves_to_rookery() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join(LEGACY_DIR), tmp.path().join(DATA_DIR));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join(LEGACY_DB_FILE), b"db").unwrap();
        std::fs::write(old.join("rook.db-wal"), b"wal").unwrap();
        std::fs::write(old.join("vault.bin"), b"v").unwrap();

        let dir = migrate_legacy_dir(&old, &new);
        assert_eq!(dir, new);
        assert!(!old.exists());
        migrate_legacy_db(&dir);
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"db");
        assert_eq!(std::fs::read(dir.join("rookery.db-wal")).unwrap(), b"wal");
        assert!(dir.join("vault.bin").exists());

        // second start: nothing to do, new folder wins
        std::fs::create_dir_all(&old).unwrap();
        assert_eq!(migrate_legacy_dir(&old, &new), new);
    }
}
