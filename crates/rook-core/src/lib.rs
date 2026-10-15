//! Rook core library.
//!
//! Everything that is not UI lives here: vault, SQLite storage, SSH
//! connection management, terminals, collectors and subscriptions.
//! `rook-tauri` (desktop) and the future mobile shell are thin glue on top.
//!
//! Lazy-load contract (see docs/01-ARCHITECTURE.md §1, §4, §5):
//! - a host in the database never causes a connection;
//! - a connection is opened only when something takes a [`ssh::Lease`];
//! - collectors run only while there is an active subscription for them.

pub mod collectors;
pub mod db;
pub mod error;
pub mod events;
pub mod model;
pub mod ssh;
pub mod subscriptions;
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
    pub events: broadcast::Sender<CoreEvent>,
}

impl Core {
    /// Open (or create) the data directory, database and vault file.
    /// Does **not** unlock the vault and does **not** open any connection.
    pub fn init(data_dir: impl AsRef<Path>) -> Result<Self> {
        let data_dir = data_dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&data_dir)?;
        std::fs::create_dir_all(data_dir.join("cache"))?;

        let db = Arc::new(db::Db::open(data_dir.join("rook.db"))?);
        let vault = Arc::new(Mutex::new(vault::Vault::load_or_new(data_dir.join("vault.bin"))?));
        let (events, _) = broadcast::channel(1024);

        let connections = Arc::new(ssh::ConnectionManager::new(
            db.clone(),
            vault.clone(),
            events.clone(),
        ));
        let terminals = Arc::new(terminal::Terminals::new(connections.clone(), events.clone()));
        let subscriptions = Arc::new(subscriptions::Subscriptions::new(
            connections.clone(),
            events.clone(),
        ));

        Ok(Self {
            data_dir,
            db,
            vault,
            connections,
            terminals,
            subscriptions,
            events,
        })
    }

    /// Default per-user data directory (`%APPDATA%/Rook`, `~/Library/Application Support/Rook`).
    pub fn default_data_dir() -> PathBuf {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Rook")
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<CoreEvent> {
        self.events.subscribe()
    }

    /// Lock the vault, stop every subscription and (optionally) close sessions.
    pub async fn lock(&self, close_sessions: bool) {
        self.subscriptions.stop_all().await;
        if close_sessions {
            self.terminals.close_all().await;
            self.connections.close_all().await;
        }
        self.vault.lock().lock();
        let _ = self.events.send(CoreEvent::VaultLocked);
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
