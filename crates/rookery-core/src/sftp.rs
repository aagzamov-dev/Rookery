//! SFTP (docs/03-DESKTOP-FEATURES.md §4).
//!
//! One SFTP channel per host, opened the first time the Files view or panel needs it,
//! on the host's shared SSH session. Transfers stream in chunks with progress events.
//! "Edit locally" downloads to the cache, watches the local copy, and uploads every save
//! back — unless the remote file changed meanwhile (conflict).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use parking_lot::Mutex;
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::model::{FileEntry, FileKind, Transfer, TransferState};
use crate::ssh::{exec, ConnectionManager, Lease};
use crate::terminal::shell_quote;
use crate::{new_id, CoreEvent, Error, Result};

const CHUNK: usize = 64 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(150);
const EDIT_MAX_BYTES: u64 = 20 * 1024 * 1024;
const EDIT_POLL: Duration = Duration::from_millis(800);

fn sftp_err(e: impl std::fmt::Display) -> Error {
    Error::Ssh(format!("sftp: {e}"))
}

pub(crate) struct Conn {
    /// Keeps the SSH session open; also used by the editor for remote commands.
    pub(crate) lease: Lease,
    pub(crate) s: SftpSession,
}

struct EditWatch {
    task: JoinHandle<()>,
    base_mtime: Arc<Mutex<i64>>,
    local: PathBuf,
}

pub struct Sftp {
    conns: Arc<ConnectionManager>,
    events: broadcast::Sender<CoreEvent>,
    cache_dir: PathBuf,
    sessions: tokio::sync::Mutex<HashMap<String, Arc<Conn>>>,
    transfers: Mutex<HashMap<String, JoinHandle<()>>>,
    edits: Mutex<HashMap<String, EditWatch>>,
}

impl Sftp {
    pub fn new(conns: Arc<ConnectionManager>, events: broadcast::Sender<CoreEvent>, cache_dir: PathBuf) -> Self {
        Self {
            conns,
            events,
            cache_dir,
            sessions: Default::default(),
            transfers: Default::default(),
            edits: Default::default(),
        }
    }

    pub(crate) async fn conn(&self, host_id: &str) -> Result<Arc<Conn>> {
        let mut map = self.sessions.lock().await;
        if let Some(c) = map.get(host_id) {
            return Ok(c.clone());
        }
        let lease = self.conns.acquire(host_id).await?;
        let h = lease.handle().await?;
        let ch = h.channel_open_session().await?;
        ch.request_subsystem(true, "sftp").await?;
        let s = SftpSession::new(ch.into_stream()).await.map_err(sftp_err)?;
        let c = Arc::new(Conn { lease, s });
        map.insert(host_id.to_string(), c.clone());
        Ok(c)
    }

    /// Drop a broken session so the next call reopens it (e.g. after a reconnect).
    pub(crate) async fn on_err<T>(&self, host_id: &str, r: std::result::Result<T, russh_sftp::client::error::Error>) -> Result<T> {
        match r {
            Ok(v) => Ok(v),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("closed") || msg.contains("Timeout") || msg.contains("timeout") || msg.contains("EOF") {
                    self.sessions.lock().await.remove(host_id);
                }
                Err(sftp_err(msg))
            }
        }
    }

    pub async fn home(&self, host_id: &str) -> Result<String> {
        let c = self.conn(host_id).await?;
        let r = c.s.canonicalize(".").await;
        self.on_err(host_id, r).await
    }

    pub async fn list(&self, host_id: &str, path: &str) -> Result<Vec<FileEntry>> {
        let c = self.conn(host_id).await?;
        let r = c.s.read_dir(path).await;
        let dir = self.on_err(host_id, r).await?;
        let base = path.trim_end_matches('/');
        let mut out: Vec<FileEntry> = dir
            .filter(|e| e.file_name() != "." && e.file_name() != "..")
            .map(|e| {
                let name = e.file_name();
                let ft = e.file_type();
                let meta = e.metadata();
                let kind = if ft.is_symlink() {
                    FileKind::Link
                } else if ft.is_dir() {
                    FileKind::Dir
                } else {
                    FileKind::File
                };
                FileEntry {
                    path: if base.is_empty() { format!("/{name}") } else { format!("{base}/{name}") },
                    name,
                    kind,
                    size: meta.size.unwrap_or(0),
                    mtime: meta.mtime.unwrap_or(0) as i64,
                    mode: meta.permissions,
                }
            })
            .collect();
        out.sort_by(|a, b| {
            (a.kind != FileKind::Dir)
                .cmp(&(b.kind != FileKind::Dir))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    pub async fn mkdir(&self, host_id: &str, path: &str) -> Result<()> {
        let c = self.conn(host_id).await?;
        let r = c.s.create_dir(path).await;
        self.on_err(host_id, r).await
    }

    pub async fn rename(&self, host_id: &str, from: &str, to: &str) -> Result<()> {
        let c = self.conn(host_id).await?;
        let r = c.s.rename(from, to).await;
        self.on_err(host_id, r).await
    }

    /// Delete a file or empty folder; `recursive` uses `rm -rf` on the server.
    pub async fn delete(&self, host_id: &str, path: &str, is_dir: bool, recursive: bool) -> Result<()> {
        let p = path.trim();
        if p.is_empty() || p == "/" || p == "~" || p == "." || p == ".." {
            return Err(Error::Other("refusing to delete this path".into()));
        }
        if recursive {
            let lease = self.conns.acquire(host_id).await?;
            let h = lease.handle().await?;
            let out = exec(&h, &format!("rm -rf -- {} 2>&1", shell_quote(p)), Duration::from_secs(120)).await?;
            if out.exit.unwrap_or(0) != 0 {
                return Err(Error::Other(out.stdout.trim().to_string()));
            }
            return Ok(());
        }
        let c = self.conn(host_id).await?;
        let r = if is_dir { c.s.remove_dir(p).await } else { c.s.remove_file(p).await };
        self.on_err(host_id, r).await
    }

    // -------------------------------------------------------------- transfers

    fn emit(&self, t: &Transfer) {
        let _ = self.events.send(CoreEvent::Transfer { transfer: t.clone() });
    }

    pub async fn upload(self: &Arc<Self>, host_id: &str, local: PathBuf, remote_dir: &str) -> Result<String> {
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| Error::Other("not a file".into()))?;
        let total = tokio::fs::metadata(&local).await?.len();
        let remote = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
        let id = new_id();
        let mut t = Transfer {
            id: id.clone(),
            host_id: host_id.to_string(),
            name,
            upload: true,
            remote: remote.clone(),
            bytes: 0,
            total,
            state: TransferState::Running,
            error: None,
        };
        self.emit(&t);
        let me = self.clone();
        let host = host_id.to_string();
        let task = tokio::spawn(async move {
            let res: Result<()> = async {
                let c = me.conn(&host).await?;
                let mut src = tokio::fs::File::open(&local).await?;
                let mut dst = c.s.create(&remote).await.map_err(sftp_err)?;
                let mut buf = vec![0u8; CHUNK];
                let mut last = Instant::now();
                loop {
                    let n = src.read(&mut buf).await?;
                    if n == 0 {
                        break;
                    }
                    dst.write_all(&buf[..n]).await?;
                    t.bytes += n as u64;
                    if last.elapsed() >= PROGRESS_EVERY {
                        me.emit(&t);
                        last = Instant::now();
                    }
                }
                dst.shutdown().await?;
                Ok(())
            }
            .await;
            match res {
                Ok(()) => t.state = TransferState::Done,
                Err(e) => {
                    t.state = TransferState::Failed;
                    t.error = Some(e.to_string());
                }
            }
            me.emit(&t);
            me.transfers.lock().remove(&t.id);
        });
        self.transfers.lock().insert(id.clone(), task);
        Ok(id)
    }

    /// Upload a local folder (recursively) into `remote_dir` as one transfer.
    pub async fn upload_dir(self: &Arc<Self>, host_id: &str, local: PathBuf, remote_dir: &str) -> Result<String> {
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| Error::Other("not a folder".into()))?;
        // Walk first: folder list + files with sizes (so progress has a total).
        let mut dirs: Vec<String> = vec![String::new()];
        let mut files: Vec<(PathBuf, String, u64)> = Vec::new();
        let mut stack = vec![(local.clone(), String::new())];
        while let Some((dir, rel)) = stack.pop() {
            let mut rd = tokio::fs::read_dir(&dir).await?;
            while let Some(e) = rd.next_entry().await? {
                let ft = e.file_type().await?;
                let child_rel = if rel.is_empty() { e.file_name().to_string_lossy().into_owned() } else { format!("{rel}/{}", e.file_name().to_string_lossy()) };
                if ft.is_dir() {
                    dirs.push(child_rel.clone());
                    stack.push((e.path(), child_rel));
                } else if ft.is_file() {
                    files.push((e.path(), child_rel, e.metadata().await?.len()));
                }
            }
        }
        let root = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
        let id = new_id();
        let mut t = Transfer {
            id: id.clone(),
            host_id: host_id.to_string(),
            name: format!("{name}/ ({} files)", files.len()),
            upload: true,
            remote: root.clone(),
            bytes: 0,
            total: files.iter().map(|f| f.2).sum(),
            state: TransferState::Running,
            error: None,
        };
        self.emit(&t);
        let me = self.clone();
        let host = host_id.to_string();
        let task = tokio::spawn(async move {
            let res: Result<()> = async {
                let c = me.conn(&host).await?;
                for d in &dirs {
                    let p = if d.is_empty() { root.clone() } else { format!("{root}/{d}") };
                    if c.s.metadata(&p).await.is_err() {
                        c.s.create_dir(&p).await.map_err(sftp_err)?;
                    }
                }
                let mut buf = vec![0u8; CHUNK];
                let mut last = Instant::now();
                for (path, rel, _) in &files {
                    let mut src = tokio::fs::File::open(path).await?;
                    let mut dst = c.s.create(&format!("{root}/{rel}")).await.map_err(sftp_err)?;
                    loop {
                        let n = src.read(&mut buf).await?;
                        if n == 0 {
                            break;
                        }
                        dst.write_all(&buf[..n]).await?;
                        t.bytes += n as u64;
                        if last.elapsed() >= PROGRESS_EVERY {
                            me.emit(&t);
                            last = Instant::now();
                        }
                    }
                    dst.shutdown().await?;
                }
                Ok(())
            }
            .await;
            match res {
                Ok(()) => t.state = TransferState::Done,
                Err(e) => {
                    t.state = TransferState::Failed;
                    t.error = Some(e.to_string());
                }
            }
            me.emit(&t);
            me.transfers.lock().remove(&t.id);
        });
        self.transfers.lock().insert(id.clone(), task);
        Ok(id)
    }

    pub async fn download(self: &Arc<Self>, host_id: &str, remote: &str, local: PathBuf) -> Result<String> {
        let c = self.conn(host_id).await?;
        let r = c.s.metadata(remote).await;
        let meta = self.on_err(host_id, r).await?;
        let id = new_id();
        let mut t = Transfer {
            id: id.clone(),
            host_id: host_id.to_string(),
            name: remote.rsplit('/').next().unwrap_or(remote).to_string(),
            upload: false,
            remote: remote.to_string(),
            bytes: 0,
            total: meta.size.unwrap_or(0),
            state: TransferState::Running,
            error: None,
        };
        self.emit(&t);
        let me = self.clone();
        let remote = remote.to_string();
        let task = tokio::spawn(async move {
            let res: Result<()> = async {
                let mut src = c.s.open(&remote).await.map_err(sftp_err)?;
                let tmp = local.with_extension("rookerypart");
                let mut dst = tokio::fs::File::create(&tmp).await?;
                let mut buf = vec![0u8; CHUNK];
                let mut last = Instant::now();
                loop {
                    let n = src.read(&mut buf).await?;
                    if n == 0 {
                        break;
                    }
                    dst.write_all(&buf[..n]).await?;
                    t.bytes += n as u64;
                    if last.elapsed() >= PROGRESS_EVERY {
                        me.emit(&t);
                        last = Instant::now();
                    }
                }
                dst.flush().await?;
                drop(dst);
                tokio::fs::rename(&tmp, &local).await?;
                Ok(())
            }
            .await;
            match res {
                Ok(()) => t.state = TransferState::Done,
                Err(e) => {
                    t.state = TransferState::Failed;
                    t.error = Some(e.to_string());
                }
            }
            me.emit(&t);
            me.transfers.lock().remove(&t.id);
        });
        self.transfers.lock().insert(id.clone(), task);
        Ok(id)
    }

    pub fn cancel(&self, transfer_id: &str) {
        if let Some(t) = self.transfers.lock().remove(transfer_id) {
            t.abort();
        }
    }

    // --------------------------------------------------------- edit locally

    fn edit_key(host_id: &str, remote: &str) -> String {
        format!("{host_id}|{remote}")
    }

    fn local_copy_path(&self, host_id: &str, remote: &str) -> PathBuf {
        let (dir, name) = remote.rsplit_once('/').unwrap_or(("", remote));
        let safe_dir: String = dir.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect();
        self.cache_dir.join("edit").join(host_id).join(safe_dir).join(name)
    }

    async fn remote_mtime(&self, host_id: &str, remote: &str) -> Result<i64> {
        let c = self.conn(host_id).await?;
        let r = c.s.metadata(remote).await;
        Ok(self.on_err(host_id, r).await?.mtime.unwrap_or(0) as i64)
    }

    async fn upload_bytes(&self, host_id: &str, remote: &str, bytes: &[u8]) -> Result<()> {
        let c = self.conn(host_id).await?;
        let mut f = c.s.create(remote).await.map_err(sftp_err)?;
        f.write_all(bytes).await?;
        f.shutdown().await?;
        Ok(())
    }

    /// Read a small file into memory (e.g. a Laravel `.env`). `~/x` is relative to the home folder.
    pub async fn read_small(&self, host_id: &str, remote: &str, max: u64) -> Result<Vec<u8>> {
        let remote = remote.strip_prefix("~/").unwrap_or(remote);
        let c = self.conn(host_id).await?;
        let r = c.s.metadata(remote).await;
        let meta = self.on_err(host_id, r).await?;
        if meta.size.unwrap_or(0) > max {
            return Err(Error::Other(format!("{remote} is larger than {} KB", max / 1024)));
        }
        let mut f = c.s.open(remote).await.map_err(sftp_err)?;
        let mut data = Vec::new();
        f.read_to_end(&mut data).await?;
        Ok(data)
    }

    /// Download `remote` to the edit cache, start watching it, return the local path to open.
    pub async fn edit_open(self: &Arc<Self>, host_id: &str, remote: &str) -> Result<PathBuf> {
        let c = self.conn(host_id).await?;
        let r = c.s.metadata(remote).await;
        let meta = self.on_err(host_id, r).await?;
        if meta.size.unwrap_or(0) > EDIT_MAX_BYTES {
            return Err(Error::Other("file is larger than 20 MB — download it instead".into()));
        }
        let mut src = c.s.open(remote).await.map_err(sftp_err)?;
        let mut data = Vec::new();
        src.read_to_end(&mut data).await?;
        let local = self.local_copy_path(host_id, remote);
        if let Some(p) = local.parent() {
            tokio::fs::create_dir_all(p).await?;
        }
        tokio::fs::write(&local, &data).await?;

        self.edit_stop(host_id, remote);
        let base_mtime = Arc::new(Mutex::new(meta.mtime.unwrap_or(0) as i64));
        let me = self.clone();
        let (host, rem, path, base) = (host_id.to_string(), remote.to_string(), local.clone(), base_mtime.clone());
        let task = tokio::spawn(async move {
            let mut last_local = local_mtime(&path).await;
            loop {
                tokio::time::sleep(EDIT_POLL).await;
                let now = local_mtime(&path).await;
                if now.is_none() || now == last_local {
                    continue;
                }
                last_local = now;
                let _ = me.sync_edit(&host, &rem, &path, &base, false).await;
            }
        });
        self.edits.lock().insert(Self::edit_key(host_id, remote), EditWatch { task, base_mtime, local: local.clone() });
        Ok(local)
    }

    async fn sync_edit(&self, host_id: &str, remote: &str, local: &Path, base: &Arc<Mutex<i64>>, force: bool) -> Result<()> {
        let emit = |state: &str, message: Option<String>| {
            let _ = self.events.send(CoreEvent::EditSync {
                host_id: host_id.to_string(),
                remote: remote.to_string(),
                state: state.to_string(),
                message,
            });
        };
        let res: Result<()> = async {
            let current = self.remote_mtime(host_id, remote).await?;
            if !force && current != *base.lock() {
                emit("conflict", Some("The file changed on the server since you opened it.".into()));
                return Ok(());
            }
            let bytes = tokio::fs::read(local).await?;
            self.upload_bytes(host_id, remote, &bytes).await?;
            *base.lock() = self.remote_mtime(host_id, remote).await?;
            emit("uploaded", None);
            Ok(())
        }
        .await;
        if let Err(e) = &res {
            emit("error", Some(e.to_string()));
        }
        res
    }

    /// Upload the local copy now. `force` overwrites a file that changed on the server.
    pub async fn edit_upload(&self, host_id: &str, remote: &str, force: bool) -> Result<()> {
        let (local, base) = {
            let edits = self.edits.lock();
            let w = edits
                .get(&Self::edit_key(host_id, remote))
                .ok_or_else(|| Error::NotFound("this file is not open for editing".into()))?;
            (w.local.clone(), w.base_mtime.clone())
        };
        self.sync_edit(host_id, remote, &local, &base, force).await
    }

    pub fn edit_stop(&self, host_id: &str, remote: &str) {
        if let Some(w) = self.edits.lock().remove(&Self::edit_key(host_id, remote)) {
            w.task.abort();
        }
    }

    /// Server tab closed: stop edit watchers and drop the SFTP channel.
    pub async fn close(&self, host_id: &str) {
        let prefix = format!("{host_id}|");
        self.edits.lock().retain(|k, w| {
            let keep = !k.starts_with(&prefix);
            if !keep {
                w.task.abort();
            }
            keep
        });
        self.sessions.lock().await.remove(host_id);
    }
}

async fn local_mtime(p: &Path) -> Option<SystemTime> {
    tokio::fs::metadata(p).await.ok()?.modified().ok()
}
