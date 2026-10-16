//! SSH connection management (docs/01-ARCHITECTURE.md §4.1).
//!
//! - One SSH session per host; terminals, SFTP and collectors are channels on it.
//! - Consumers hold a [`Lease`]. No lease, no connection.
//! - When the last lease drops, the session closes after [`crate::SESSION_GRACE`].
//! - While leased, a watcher reconnects with exponential backoff if the link drops.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use russh::client::{self, Handle};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, Disconnect};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::db::Db;
use crate::model::{AuthKind, SessionInfo, SessionState};
use crate::vault::Vault;
use crate::{CoreEvent, Error, Result, SESSION_GRACE};

pub type SshHandle = Handle<ClientHandler>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const WATCH_EVERY: Duration = Duration::from_secs(2);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// russh client handler: host-key verification
// ---------------------------------------------------------------------------

pub struct ClientHandler {
    expected: Option<String>,
    observed: Arc<Mutex<Option<(String, String)>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> std::result::Result<bool, Self::Error> {
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        let kt = key.algorithm().to_string();
        *self.observed.lock() = Some((kt, fp.clone()));
        Ok(self.expected.as_deref() == Some(fp.as_str()))
    }
}

// ---------------------------------------------------------------------------
// Connector: everything needed to open a fresh session for a host
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Connector {
    db: Arc<Db>,
    vault: Arc<Mutex<Vault>>,
    /// Host keys seen on a failed connect, waiting for the user to trust them.
    pending_keys: Arc<Mutex<HashMap<String, (String, String)>>>,
}

impl Connector {
    async fn connect(&self, host_id: &str) -> Result<(Arc<SshHandle>, u32)> {
        let host = self.db.get_host(host_id)?;
        if host.jump_host_id.is_some() {
            tracing::warn!(host = %host.name, "jump hosts arrive in v0.5; connecting directly");
        }
        let identity_id = self
            .db
            .resolve_identity_id(&host)?
            .ok_or_else(|| Error::SecretRequired("no login identity set for this host or its group".into()))?;
        let ident = self.db.get_identity(&identity_id)?;

        // Copy secrets out of the vault before any `.await` (never hold the lock across awaits).
        let (password, key_text, passphrase) = {
            let v = self.vault.lock();
            if !v.is_unlocked() {
                return Err(Error::VaultLocked);
            }
            (
                v.get(&ident.secret_id("password"))?,
                v.get(&ident.secret_id("key"))?,
                v.get(&ident.secret_id("passphrase"))?,
            )
        };

        let known = self.db.get_known_host(&host.id)?;
        let observed = Arc::new(Mutex::new(None));
        let handler = ClientHandler { expected: known.as_ref().map(|k| k.fingerprint.clone()), observed: observed.clone() };
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(host.keepalive_s.max(5) as u64)),
            keepalive_max: 3,
            inactivity_timeout: None,
            ..Default::default()
        });

        let started = Instant::now();
        let connected =
            tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, (host.address.as_str(), host.port), handler))
                .await;

        let mut handle = match connected {
            Err(_) => return Err(Error::Ssh(format!("connection to {} timed out", host.address))),
            Ok(Ok(h)) => h,
            Ok(Err(e)) => {
                if let Some((kt, fp)) = observed.lock().clone() {
                    match &known {
                        None => {
                            self.pending_keys.lock().insert(host.id.clone(), (kt, fp.clone()));
                            return Err(Error::UnknownHostKey { host: host.name.clone(), fingerprint: fp });
                        }
                        Some(k) if k.fingerprint != fp => {
                            self.pending_keys.lock().insert(host.id.clone(), (kt, fp.clone()));
                            return Err(Error::HostKeyChanged {
                                host: host.name.clone(),
                                expected: k.fingerprint.clone(),
                                actual: fp,
                            });
                        }
                        _ => {}
                    }
                }
                return Err(e.into());
            }
        };
        let latency = started.elapsed().as_millis().min(u32::MAX as u128) as u32;

        let user = ident.username.as_str();
        let ok = match ident.auth {
            AuthKind::Password => {
                let pw = password.ok_or_else(|| Error::SecretRequired(format!("password for {}", ident.name)))?;
                handle.authenticate_password(user, pw.as_str()).await?.success()
            }
            AuthKind::KeyFile | AuthKind::KeyInVault => {
                let pass = passphrase.as_ref().map(|p| p.as_str());
                let key = if ident.auth == AuthKind::KeyFile {
                    let path = ident
                        .key_path
                        .as_deref()
                        .ok_or_else(|| Error::SecretRequired(format!("key file path for {}", ident.name)))?;
                    russh::keys::load_secret_key(expand_home(path), pass)
                } else {
                    let text = key_text.ok_or_else(|| Error::SecretRequired(format!("private key for {}", ident.name)))?;
                    russh::keys::decode_secret_key(text.as_str(), pass)
                }
                .map_err(|e| match e {
                    russh::keys::Error::KeyIsEncrypted => Error::SecretRequired(format!("key passphrase for {}", ident.name)),
                    other => Error::Ssh(other.to_string()),
                })?;
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                handle
                    .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                    .await?
                    .success()
            }
            AuthKind::Agent => {
                return Err(Error::Other("SSH agent login arrives in a later version; use a key file or password".into()))
            }
        };
        if !ok {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
            return Err(Error::AuthFailed);
        }
        let _ = self.db.touch_known_host(&host.id);
        // `handle` is only borrowed mutably during auth; from here on it is shared.
        Ok((Arc::new(handle), latency))
    }
}

fn expand_home(p: &str) -> std::path::PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    std::path::PathBuf::from(p)
}

// ---------------------------------------------------------------------------
// Per-host entry
// ---------------------------------------------------------------------------

struct Entry {
    host_id: String,
    connector: Connector,
    events: broadcast::Sender<CoreEvent>,
    handle: tokio::sync::Mutex<Option<Arc<SshHandle>>>,
    leases: AtomicU32,
    generation: AtomicU64,
    info: Mutex<SessionInfo>,
    watcher: Mutex<Option<JoinHandle<()>>>,
}

impl Entry {
    fn set_state(&self, state: SessionState, latency: Option<u32>, error: Option<String>) {
        let info = {
            let mut i = self.info.lock();
            i.state = state;
            if latency.is_some() {
                i.latency_ms = latency;
            }
            i.error = error;
            i.leases = self.leases.load(Ordering::SeqCst);
            i.clone()
        };
        let _ = self.events.send(CoreEvent::Session { info });
    }

    async fn ensure_connected(self: &Arc<Self>) -> Result<Arc<SshHandle>> {
        let mut guard = self.handle.lock().await;
        if let Some(h) = guard.as_ref() {
            if !h.is_closed() {
                return Ok(h.clone());
            }
        }
        self.set_state(SessionState::Connecting, None, None);
        match self.connector.connect(&self.host_id).await {
            Ok((h, latency)) => {
                *guard = Some(h.clone());
                drop(guard);
                self.set_state(SessionState::Connected, Some(latency), None);
                self.start_watcher();
                Ok(h)
            }
            Err(e) => {
                drop(guard);
                self.set_state(SessionState::Error, None, Some(e.to_string()));
                Err(e)
            }
        }
    }

    /// Reconnect with backoff while there are leases and the host allows it.
    fn start_watcher(self: &Arc<Self>) {
        let mut slot = self.watcher.lock();
        if slot.as_ref().map(|h| !h.is_finished()).unwrap_or(false) {
            return;
        }
        let entry = self.clone();
        *slot = Some(tokio::spawn(async move {
            let mut backoff = Duration::from_secs(1);
            loop {
                tokio::time::sleep(WATCH_EVERY).await;
                if entry.leases.load(Ordering::SeqCst) == 0 {
                    return;
                }
                let closed = entry.handle.lock().await.as_ref().map(|h| h.is_closed()).unwrap_or(true);
                if !closed {
                    backoff = Duration::from_secs(1);
                    continue;
                }
                let auto = entry.connector.db.get_host(&entry.host_id).map(|h| h.auto_reconnect).unwrap_or(false);
                if !auto {
                    *entry.handle.lock().await = None;
                    entry.set_state(SessionState::Error, None, Some("connection lost".into()));
                    return;
                }
                entry.set_state(SessionState::Reconnecting, None, Some("connection lost".into()));
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(BACKOFF_MAX);
                let mut guard = entry.handle.lock().await;
                match entry.connector.connect(&entry.host_id).await {
                    Ok((h, latency)) => {
                        *guard = Some(h);
                        drop(guard);
                        entry.set_state(SessionState::Connected, Some(latency), None);
                        backoff = Duration::from_secs(1);
                    }
                    Err(e @ (Error::VaultLocked | Error::AuthFailed | Error::HostKeyChanged { .. })) => {
                        *guard = None;
                        drop(guard);
                        entry.set_state(SessionState::Error, None, Some(e.to_string()));
                        return;
                    }
                    Err(e) => {
                        drop(guard);
                        entry.set_state(SessionState::Reconnecting, None, Some(e.to_string()));
                    }
                }
            }
        }));
    }

    async fn close(&self) {
        if let Some(w) = self.watcher.lock().take() {
            w.abort();
        }
        if let Some(h) = self.handle.lock().await.take() {
            let _ = h.disconnect(Disconnect::ByApplication, "", "en").await;
        }
        self.set_state(SessionState::Idle, None, None);
    }
}

// ---------------------------------------------------------------------------
// Lease
// ---------------------------------------------------------------------------

/// Keeps a host's session alive. Dropping the last lease starts the grace timer.
pub struct Lease {
    entry: Arc<Entry>,
}

impl Lease {
    pub fn host_id(&self) -> &str {
        &self.entry.host_id
    }

    /// Current handle (may change after a reconnect — always fetch it per use).
    pub async fn handle(&self) -> Result<Arc<SshHandle>> {
        self.entry
            .handle
            .lock()
            .await
            .clone()
            .filter(|h| !h.is_closed())
            .ok_or_else(|| Error::Ssh("not connected".into()))
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let prev = self.entry.leases.fetch_sub(1, Ordering::SeqCst);
        if prev != 1 {
            return;
        }
        let gen = self.entry.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let entry = self.entry.clone();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                tokio::time::sleep(SESSION_GRACE).await;
                if entry.leases.load(Ordering::SeqCst) == 0 && entry.generation.load(Ordering::SeqCst) == gen {
                    entry.close().await;
                }
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

pub struct ConnectionManager {
    connector: Connector,
    events: broadcast::Sender<CoreEvent>,
    entries: Mutex<HashMap<String, Arc<Entry>>>,
}

impl ConnectionManager {
    pub fn new(db: Arc<Db>, vault: Arc<Mutex<Vault>>, events: broadcast::Sender<CoreEvent>) -> Self {
        Self {
            connector: Connector { db, vault, pending_keys: Default::default() },
            events,
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn entry(&self, host_id: &str) -> Arc<Entry> {
        self.entries
            .lock()
            .entry(host_id.to_string())
            .or_insert_with(|| {
                Arc::new(Entry {
                    host_id: host_id.to_string(),
                    connector: self.connector.clone(),
                    events: self.events.clone(),
                    handle: tokio::sync::Mutex::new(None),
                    leases: AtomicU32::new(0),
                    generation: AtomicU64::new(0),
                    info: Mutex::new(SessionInfo {
                        host_id: host_id.to_string(),
                        state: SessionState::Idle,
                        latency_ms: None,
                        error: None,
                        leases: 0,
                    }),
                    watcher: Mutex::new(None),
                })
            })
            .clone()
    }

    /// Take a lease, connecting if needed. This is the ONLY way a connection opens.
    pub async fn acquire(&self, host_id: &str) -> Result<Lease> {
        let entry = self.entry(host_id);
        entry.leases.fetch_add(1, Ordering::SeqCst);
        entry.generation.fetch_add(1, Ordering::SeqCst); // cancels a pending grace close
        let lease = Lease { entry: entry.clone() };
        entry.ensure_connected().await?; // on error `lease` drops and the count is restored
        // Always report the state: reusing an already-open session emits no transition,
        // and a UI that (re)loaded meanwhile would otherwise never learn it is connected.
        let _ = self.events.send(CoreEvent::Session { info: self.info(host_id) });
        Ok(lease)
    }

    pub fn info(&self, host_id: &str) -> SessionInfo {
        let e = self.entry(host_id);
        let mut i = e.info.lock().clone();
        i.leases = e.leases.load(Ordering::SeqCst);
        i
    }

    pub fn all_info(&self) -> Vec<SessionInfo> {
        let entries: Vec<_> = self.entries.lock().values().cloned().collect();
        entries.iter().map(|e| self.info(&e.host_id)).collect()
    }

    /// Store the host key seen on the last failed connect, if it matches what the user approved.
    pub fn trust_pending_key(&self, host_id: &str, fingerprint: &str) -> Result<()> {
        let pending = self.connector.pending_keys.lock().get(host_id).cloned();
        match pending {
            Some((kt, fp)) if fp == fingerprint => {
                self.connector.db.trust_host_key(host_id, &kt, &fp)?;
                self.connector.pending_keys.lock().remove(host_id);
                Ok(())
            }
            _ => Err(Error::Other("no matching host key waiting for approval; connect again".into())),
        }
    }

    /// A session is open right now (a server tab or another user of it holds a lease).
    pub fn is_connected(&self, host_id: &str) -> bool {
        self.entries.lock().get(host_id).map(|e| e.info.lock().state == SessionState::Connected).unwrap_or(false)
    }

    /// Close a temporary session right away (Dashboard sync) instead of after the grace period,
    /// unless something else took a lease meanwhile.
    pub async fn close_if_unused(&self, host_id: &str) {
        let e = self.entries.lock().get(host_id).cloned();
        if let Some(e) = e {
            if e.leases.load(Ordering::SeqCst) == 0 {
                e.close().await;
            }
        }
    }

    pub async fn close(&self, host_id: &str) {
        let e = self.entries.lock().get(host_id).cloned();
        if let Some(e) = e {
            e.close().await;
        }
    }

    pub async fn close_all(&self) {
        let all: Vec<_> = self.entries.lock().values().cloned().collect();
        for e in all {
            e.close().await;
        }
    }
}

// ---------------------------------------------------------------------------
// Streaming exec (docker events / stats / logs, tail -F)
// ---------------------------------------------------------------------------

pub enum StreamChunk {
    Data(Vec<u8>),
    Exit(Option<u32>),
}

/// Run a long-lived command. Dropping the receiver closes the channel; with
/// `pty = true` the remote process gets SIGHUP, so nothing keeps running on the server.
pub async fn exec_stream(handle: &SshHandle, cmd: &str, pty: bool) -> Result<tokio::sync::mpsc::Receiver<StreamChunk>> {
    let mut ch = handle.channel_open_session().await?;
    if pty {
        // Wide, colourless terminal so lines don't wrap and tools don't add colours.
        ch.request_pty(false, "dumb", 1000, 50, 0, 0, &[]).await?;
    }
    ch.exec(true, cmd).await?;
    let (tx, rx) = tokio::sync::mpsc::channel(256);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tx.closed() => {
                    let _ = ch.close().await;
                    break;
                }
                msg = ch.wait() => match msg {
                    Some(ChannelMsg::Data { ref data }) | Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        if tx.send(StreamChunk::Data(data.to_vec())).await.is_err() {
                            let _ = ch.close().await;
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        let _ = tx.send(StreamChunk::Exit(Some(exit_status))).await;
                    }
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
            }
        }
    });
    Ok(rx)
}

/// Splits a byte stream into lines, dropping `\r` and ANSI escape sequences.
#[derive(Default)]
pub struct LineSplitter {
    buf: Vec<u8>,
}

impl LineSplitter {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            out.push(clean_line(&line[..line.len() - 1]));
        }
        // Guard against a producer that never sends a newline.
        if self.buf.len() > 256 * 1024 {
            let line: Vec<u8> = std::mem::take(&mut self.buf);
            out.push(clean_line(&line));
        }
        out
    }
}

pub fn clean_line(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {}
            '\x1b' => {
                // CSI: ESC [ params final-byte ; OSC: ESC ] ... BEL/ST ; other: ESC + one char
                match chars.peek() {
                    Some('[') => {
                        chars.next();
                        for n in chars.by_ref() {
                            if ('@'..='~').contains(&n) {
                                break;
                            }
                        }
                    }
                    Some(']') => {
                        chars.next();
                        while let Some(n) = chars.next() {
                            if n == '\x07' {
                                break;
                            }
                            if n == '\x1b' {
                                chars.next();
                                break;
                            }
                        }
                    }
                    _ => {
                        chars.next();
                    }
                }
            }
            c => out.push(c),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// One-shot exec helper used by collectors
// ---------------------------------------------------------------------------

pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit: Option<u32>,
}

pub async fn exec(handle: &SshHandle, cmd: &str, timeout: Duration) -> Result<ExecOutput> {
    let run = async {
        let mut ch = handle.channel_open_session().await?;
        ch.exec(true, cmd).await?;
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut exit = None;
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => out.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, .. } => err.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok::<_, Error>(ExecOutput {
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            exit,
        })
    };
    tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| Error::Ssh("command timed out".into()))?
}

/// Like [`exec`], with `input` sent on stdin (then EOF). Used for a sudo password only:
/// file content never travels on the same stdin as a password.
pub async fn exec_with_input(handle: &SshHandle, cmd: &str, input: &[u8], timeout: Duration) -> Result<ExecOutput> {
    let run = async {
        let mut ch = handle.channel_open_session().await?;
        ch.exec(true, cmd).await?;
        ch.data(input).await?;
        ch.eof().await?;
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut exit = None;
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => out.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, .. } => err.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok::<_, Error>(ExecOutput {
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            exit,
        })
    };
    tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| Error::Ssh("command timed out".into()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_and_strips_escapes() {
        let mut s = LineSplitter::default();
        assert!(s.push(b"par").is_empty());
        let lines = s.push(b"tial\r\n\x1b[2J\x1b[H{\"a\":1}\r\nnext");
        assert_eq!(lines, vec!["partial".to_string(), "{\"a\":1}".to_string()]);
        assert_eq!(s.push(b"\n"), vec!["next".to_string()]);
        assert_eq!(clean_line(b"\x1b]7;file://h/var\x07ok\x1b[31m!\x1b[0m"), "ok!");
    }
}
