//! SFTP (docs/03-DESKTOP-FEATURES.md §4).
//!
//! One SFTP channel per host, opened the first time the Files view or panel needs it,
//! on the host's shared SSH session. Transfers stream in chunks with progress events.
//! "Edit locally" watches local saves and reports pending changes. Uploads are explicit
//! and preserve remote-version conflict checks.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use parking_lot::Mutex;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, Semaphore};
use tokio::task::JoinHandle;

use crate::model::{FileEntry, FileKind, Transfer, TransferState};
use crate::ssh::{exec, exec_stream, ConnectionManager, Lease, StreamChunk};
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
    handle: Arc<crate::ssh::SshHandle>,
}

struct EditWatch {
    task: JoinHandle<()>,
    base_mtime: Arc<Mutex<i64>>,
    local: PathBuf,
}

pub struct Sftp {
    conns: Arc<ConnectionManager>,
    db: Arc<crate::db::Db>,
    vault: Arc<Mutex<crate::vault::Vault>>,
    events: broadcast::Sender<CoreEvent>,
    cache_dir: PathBuf,
    sessions: tokio::sync::Mutex<HashMap<String, Arc<Conn>>>,
    transfers: Mutex<HashMap<String, JoinHandle<()>>>,
    edits: Mutex<HashMap<String, EditWatch>>,
    transfer_slots: Arc<Semaphore>,
    status: Mutex<HashMap<String, Transfer>>,
    /// Running ZIP / tar.gz jobs by the id the UI gave them, for Cancel.
    archives: Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
}

/// Archive kinds `archive.py` understands.
pub const ARCHIVE_MODES: [&str; 4] = ["zip", "unzip", "targz", "untargz"];
const ARCHIVE_MAX: Duration = Duration::from_secs(3 * 3600);

/// Size of a file or folder and the free space beside it, for "this is big, continue?".
/// `None` when it could not be measured in time (huge folder, slow disk, no permission).
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct PathUsage {
    #[ts(type = "number | null")]
    pub size: Option<u64>,
    #[ts(type = "number | null")]
    pub free: Option<u64>,
}

/// A single name for a new file or folder (no separators, not `.` / `..`). Names without
/// an extension (`Dockerfile`, `Makefile`) and dot files (`.env`) are fine.
pub fn check_new_name(name: &str) -> Result<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) || name.len() > 255 || name.trim() != name {
        return Err(Error::Other("Enter a name without slashes or spaces at the start or end.".into()));
    }
    Ok(())
}

fn check_new_path(path: &str) -> Result<&str> {
    let (parent, name) = path.rsplit_once('/').ok_or_else(|| Error::Other("Enter an absolute path.".into()))?;
    if !path.starts_with('/') || parent.contains('\0') {
        return Err(Error::Other("Enter an absolute path.".into()));
    }
    check_new_name(name)?;
    Ok(name)
}

struct ArchiveJob<'a>(&'a Mutex<HashMap<String, Arc<tokio::sync::Notify>>>, String);
impl Drop for ArchiveJob<'_> {
    fn drop(&mut self) {
        self.0.lock().remove(&self.1);
    }
}

impl Sftp {
    pub fn new(conns: Arc<ConnectionManager>, db: Arc<crate::db::Db>, vault: Arc<Mutex<crate::vault::Vault>>, events: broadcast::Sender<CoreEvent>, cache_dir: PathBuf) -> Self {
        Self {
            conns,
            db,
            vault,
            events,
            cache_dir,
            sessions: Default::default(),
            transfers: Default::default(),
            edits: Default::default(),
            transfer_slots: Arc::new(Semaphore::new(4)),
            status: Default::default(),
            archives: Default::default(),
        }
    }

    pub(crate) async fn conn(&self, host_id: &str) -> Result<Arc<Conn>> {
        let mut map = self.sessions.lock().await;
        if let Some(c) = map.get(host_id) {
            if c.lease.handle().await.is_ok_and(|handle| Arc::ptr_eq(&handle, &c.handle)) {
                return Ok(c.clone());
            }
        }
        map.remove(host_id);
        let c = tokio::time::timeout(Duration::from_secs(30), async {
            let lease = self.conns.acquire(host_id).await?;
            let handle = lease.handle().await?;
            let ch = handle.channel_open_session().await?;
            ch.request_subsystem(true, "sftp").await?;
            let s = SftpSession::new(ch.into_stream()).await.map_err(sftp_err)?;
            Ok::<_, Error>(Arc::new(Conn { lease, s, handle }))
        }).await.map_err(|_| Error::Ssh("SFTP connection timed out; retry after checking the network".into()))??;
        map.insert(host_id.to_string(), c.clone());
        Ok(c)
    }

    /// Drop a broken session so the next call reopens it (e.g. after a reconnect).
    pub(crate) async fn on_err<T>(&self, host_id: &str, r: std::result::Result<T, russh_sftp::client::error::Error>) -> Result<T> {
        match r {
            Ok(v) => Ok(v),
            Err(e) => {
                let msg = e.to_string();
                let broken = match &e {
                    russh_sftp::client::error::Error::Status(status) => matches!(status.status_code, StatusCode::NoConnection | StatusCode::ConnectionLost | StatusCode::BadMessage),
                    russh_sftp::client::error::Error::Limited(_) => false,
                    _ => true,
                };
                if broken { self.sessions.lock().await.remove(host_id); }
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
        check_new_path(path)?;
        let c = self.conn(host_id).await?;
        let r = c.s.create_dir(path).await;
        self.exists_err(host_id, &c, path, r).await
    }

    /// Create an empty file; never replaces an existing one (O_CREAT | O_EXCL on the server).
    pub async fn create_file(&self, host_id: &str, path: &str) -> Result<()> {
        check_new_path(path)?;
        let c = self.conn(host_id).await?;
        let r = c.s.open_with_flags_and_attributes(path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE, FileAttributes::empty()).await;
        let mut f = self.exists_err(host_id, &c, path, r).await?;
        f.shutdown().await?;
        Ok(())
    }

    /// Copy a regular file to `to` in the same folder (`cp -p`); never replaces anything.
    pub async fn duplicate(&self, host_id: &str, from: &str, to: &str) -> Result<()> {
        check_new_path(to)?;
        if !from.starts_with('/') || from.contains('\0') {
            return Err(Error::Other("Select a file.".into()));
        }
        let lease = self.conns.acquire(host_id).await?;
        let h = lease.handle().await?;
        let (src, dst) = (shell_quote(from), shell_quote(to));
        let command = format!(
            "if [ ! -f {src} ] || [ -L {src} ]; then echo 'Only regular files can be duplicated.'; exit 1; fi; \
             if [ -e {dst} ] || [ -L {dst} ]; then echo 'A file or folder with this name already exists; nothing was replaced.'; exit 1; fi; \
             cp -p -- {src} {dst} 2>&1"
        );
        let out = exec(&h, &command, Duration::from_secs(600)).await?;
        if out.exit != Some(0) {
            return Err(Error::Other(out.stdout.trim().to_string()));
        }
        Ok(())
    }

    /// Set permission bits (`0o7777` at most) of one file or folder; never recursive.
    pub async fn chmod(&self, host_id: &str, path: &str, mode: u32) -> Result<()> {
        if !path.starts_with('/') || path == "/" || path.contains('\0') || mode > 0o7777 {
            return Err(Error::Other("Select a file or folder and valid permissions.".into()));
        }
        let c = self.conn(host_id).await?;
        let mut a = FileAttributes::empty();
        a.permissions = Some(mode);
        let r = c.s.set_metadata(path, a).await;
        self.on_err(host_id, r).await
    }

    /// Owner and group names of `path` (`stat`), for the permissions dialog.
    pub async fn owner(&self, host_id: &str, path: &str) -> Result<(String, String)> {
        if !path.starts_with('/') || path.contains('\0') {
            return Err(Error::Other("Select a file or folder.".into()));
        }
        let lease = self.conns.acquire(host_id).await?;
        let h = lease.handle().await?;
        let out = exec(&h, &format!("LC_ALL=C stat -c '%U %G' -- {} 2>&1", shell_quote(path)), Duration::from_secs(10)).await?;
        let mut it = out.stdout.split_whitespace();
        match (out.exit, it.next(), it.next()) {
            (Some(0), Some(u), Some(g)) => Ok((u.to_string(), g.to_string())),
            _ => Err(Error::Other(out.stdout.trim().to_string())),
        }
    }

    /// SFTP v3 reports "already exists" as a generic failure: say what happened.
    async fn exists_err<T>(&self, host_id: &str, c: &Conn, path: &str, r: std::result::Result<T, russh_sftp::client::error::Error>) -> Result<T> {
        if r.is_err() && c.s.symlink_metadata(path).await.is_ok() {
            return Err(Error::Other("A file or folder with this name already exists; nothing was replaced.".into()));
        }
        self.on_err(host_id, r).await
    }

    /// Size of `path` (du, at most ~20 s) and free space in its folder (df).
    pub async fn usage(&self, host_id: &str, path: &str) -> Result<PathUsage> {
        if !path.starts_with('/') || path.contains('\0') {
            return Err(Error::Other("Enter an absolute path.".into()));
        }
        let parent = match path.trim_end_matches('/').rsplit_once('/') {
            Some(("", _)) | None => "/",
            Some((p, _)) => p,
        };
        let lease = self.conns.acquire(host_id).await?;
        let h = lease.handle().await?;
        let command = format!(
            "export LC_ALL=C; if command -v timeout >/dev/null 2>&1; then T='timeout 20'; else T=; fi; $T du -sk -- {} 2>/dev/null | tail -n 1 | cut -f1; echo @@; df -Pk -- {} 2>/dev/null | awk 'NR==2{{print $4}}'",
            shell_quote(path),
            shell_quote(parent)
        );
        let Ok(out) = exec(&h, &command, Duration::from_secs(30)).await else {
            return Ok(PathUsage { size: None, free: None });
        };
        let (size, free) = out.stdout.split_once("@@").unwrap_or((&out.stdout, ""));
        let kb = |s: &str| s.trim().parse::<u64>().ok().map(|k| k.saturating_mul(1024));
        Ok(PathUsage { size: kb(size), free: kb(free) })
    }

    pub async fn rename(&self, host_id: &str, from: &str, to: &str) -> Result<()> {
        check_new_path(to)?;
        let c = self.conn(host_id).await?;
        if c.s.symlink_metadata(to).await.is_ok() {
            return Err(Error::Other("A file or folder with this name already exists; nothing was replaced.".into()));
        }
        let r = c.s.rename(from, to).await;
        self.on_err(host_id, r).await
    }

    /// ZIP / tar.gz a file or folder, or extract one, beside it (`archive.py`). Runs on a pty,
    /// so [`Self::archive_cancel`] (closing the channel) stops it on the server, and the
    /// script removes its temporary output: the result appears complete or not at all.
    pub async fn archive(&self, host_id: &str, path: &str, name: &str, mode: &str, job: &str) -> Result<()> {
        if !path.starts_with('/') || path == "/" || path.contains('\0') || check_new_name(name).is_err() {
            return Err(Error::Other("select a file or folder and enter a valid destination name".into()));
        }
        if !ARCHIVE_MODES.contains(&mode) {
            return Err(Error::Other("unknown archive type".into()));
        }
        if job.is_empty() || job.len() > 64 {
            return Err(Error::Other("invalid job id".into()));
        }
        let cancel = Arc::new(tokio::sync::Notify::new());
        {
            let mut jobs = self.archives.lock();
            if jobs.contains_key(job) {
                return Err(Error::Other("this archive job is already running".into()));
            }
            jobs.insert(job.to_string(), cancel.clone());
        }
        let _job = ArchiveJob(&self.archives, job.to_string());
        let lease = self.conns.acquire(host_id).await?;
        let h = lease.handle().await?;
        let command = format!(
            "command -v python3 >/dev/null 2>&1 || {{ echo 'ZIP, tar.gz and extracting need Python 3 on this server.'; exit 1; }}; exec python3 -c {} {} {} {} 2>&1",
            shell_quote(include_str!("archive.py")), shell_quote(path), shell_quote(name), mode,
        );
        let mut rx = exec_stream(&h, &command, true).await?;
        let mut output = Vec::new();
        let mut exit = None;
        let deadline = tokio::time::sleep(ARCHIVE_MAX);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                chunk = rx.recv() => match chunk {
                    Some(StreamChunk::Data(b)) => if output.len() < 16 * 1024 { output.extend_from_slice(&b) },
                    Some(StreamChunk::Exit(code)) => exit = code,
                    None => break,
                },
                // Dropping the receiver closes the channel: the server sends SIGHUP and the
                // script deletes its temporary file or folder.
                _ = cancel.notified() => return Err(Error::Other("Cancelled; nothing was created.".into())),
                _ = &mut deadline => return Err(Error::Other("Stopped after 3 hours; nothing was created.".into())),
            }
        }
        if exit != Some(0) {
            let text = String::from_utf8_lossy(&output).replace('\r', "");
            let message = text.trim();
            return Err(Error::Other(if message.is_empty() { "The archive was not created (the connection closed).".into() } else { message.to_string() }));
        }
        Ok(())
    }

    /// Stop a running [`Self::archive`]; unknown or finished jobs are ignored.
    pub fn archive_cancel(&self, job: &str) {
        if let Some(n) = self.archives.lock().get(job) {
            n.notify_one();
        }
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

    pub fn transfer_status(&self) -> Vec<Transfer> {
        self.status.lock().values().cloned().collect()
    }

    fn emit(&self, t: &Transfer) {
        let mut status = self.status.lock();
        if status.len() >= 100 && !status.contains_key(&t.id) {
            if let Some(id) = status.iter().find(|(_, value)| value.state != TransferState::Running).map(|(id, _)| id.clone()) {
                status.remove(&id);
            }
        }
        status.insert(t.id.clone(), t.clone());
        drop(status);
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
        let me = self.clone();
        let host = host_id.to_string();
        let permit = self.transfer_slots.clone().try_acquire_owned()
            .map_err(|_| Error::Other("Four transfers are already running; wait for one to finish".into()))?;
        self.emit(&t);
        let (start, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _permit = permit;
            if ready.await.is_err() { return; }
            let mut recovery = None;
            let res: Result<()> = async {
                let c = me.conn(&host).await?;
                let mut src = tokio::fs::File::open(&local).await?;
                let (staging, original) = prepare_upload(&c, &remote).await?;
                recovery = Some(staging.clone());
                let mut dst = create_staging(&c, &staging).await?;
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
                finish_upload(&c, &staging, &remote, &original).await?;
                recovery = None;
                Ok(())
            }
            .await;
            match res {
                Ok(()) => t.state = TransferState::Done,
                Err(e) => {
                    t.state = TransferState::Failed;
                    me.sessions.lock().await.remove(&t.host_id);
                    t.error = Some(match &recovery {
                        Some(path) => format!("{e}. Partial recovery file: {path}"),
                        None => e.to_string(),
                    });
                }
            }
            me.emit(&t);
            me.transfers.lock().remove(&t.id);
        });
        self.transfers.lock().insert(id.clone(), task);
        let _ = start.send(());
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
        let me = self.clone();
        let host = host_id.to_string();
        let permit = self.transfer_slots.clone().try_acquire_owned()
            .map_err(|_| Error::Other("Four transfers are already running; wait for one to finish".into()))?;
        self.emit(&t);
        let (start, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _permit = permit;
            if ready.await.is_err() { return; }
            let mut recovery = None;
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
                    let remote = format!("{root}/{rel}");
                    let (staging, original) = prepare_upload(&c, &remote).await?;
                    recovery = Some(staging.clone());
                    let mut dst = create_staging(&c, &staging).await?;
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
                    finish_upload(&c, &staging, &remote, &original).await?;
                    recovery = None;
                }
                Ok(())
            }
            .await;
            match res {
                Ok(()) => t.state = TransferState::Done,
                Err(e) => {
                    t.state = TransferState::Failed;
                    me.sessions.lock().await.remove(&t.host_id);
                    t.error = Some(match &recovery {
                        Some(path) => format!("{e}. Partial recovery file: {path}"),
                        None => e.to_string(),
                    });
                }
            }
            me.emit(&t);
            me.transfers.lock().remove(&t.id);
        });
        self.transfers.lock().insert(id.clone(), task);
        let _ = start.send(());
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
        let me = self.clone();
        let remote = remote.to_string();
        let permit = self.transfer_slots.clone().try_acquire_owned()
            .map_err(|_| Error::Other("Four transfers are already running; wait for one to finish".into()))?;
        self.emit(&t);
        let (start, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _permit = permit;
            if ready.await.is_err() { return; }
            let mut recovery = None;
            let res: Result<()> = async {
                let mut src = c.s.open(&remote).await.map_err(sftp_err)?;
                let tmp = local.with_file_name(format!(".{}.{}.rookerypart", local.file_name().unwrap_or_default().to_string_lossy(), t.id));
                recovery = Some(tmp.to_string_lossy().into_owned());
                let mut dst = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).await?;
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
                recovery = None;
                Ok(())
            }
            .await;
            match res {
                Ok(()) => t.state = TransferState::Done,
                Err(e) => {
                    t.state = TransferState::Failed;
                    me.sessions.lock().await.remove(&t.host_id);
                    t.error = Some(match &recovery {
                        Some(path) => format!("{e}. Partial recovery file: {path}"),
                        None => e.to_string(),
                    });
                }
            }
            me.emit(&t);
            me.transfers.lock().remove(&t.id);
        });
        self.transfers.lock().insert(id.clone(), task);
        let _ = start.send(());
        Ok(id)
    }

    pub fn cancel(&self, transfer_id: &str) {
        if let Some(t) = self.transfers.lock().remove(transfer_id) {
            t.abort();
            let status = self.status.lock().get(transfer_id).cloned();
            if let Some(mut status) = status {
                status.state = TransferState::Cancelled;
                status.error = Some("Cancelled. Partial recovery files may remain beside the destination".into());
                self.emit(&status);
            }
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
        let (staging, original) = prepare_upload(&c, remote).await?;
        let mut f = create_staging(&c, &staging).await?;
        f.write_all(bytes).await?;
        f.shutdown().await?;
        finish_upload(&c, &staging, remote, &original).await?;
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
        let src = c.s.open(remote).await.map_err(sftp_err)?;
        let mut data = Vec::new();
        src.take(EDIT_MAX_BYTES + 1).read_to_end(&mut data).await?;
        if data.len() as u64 > EDIT_MAX_BYTES { return Err(Error::Other("file is larger than 20 MB — download it or use Database → Import".into())); }
        let local = self.local_copy_path(host_id, remote);
        if let Some(p) = local.parent() {
            tokio::fs::create_dir_all(p).await?;
        }
        tokio::fs::write(&local, &data).await?;

        self.edit_stop(host_id, remote);
        let base_mtime = Arc::new(Mutex::new(meta.mtime.unwrap_or(0) as i64));
        let me = self.clone();
        let (host, rem, path) = (host_id.to_string(), remote.to_string(), local.clone());
        let task = tokio::spawn(async move {
            let mut last_local = local_mtime(&path).await;
            loop {
                tokio::time::sleep(EDIT_POLL).await;
                let now = local_mtime(&path).await;
                if now.is_none() || now == last_local {
                    continue;
                }
                last_local = now;
                let _ = me.events.send(CoreEvent::EditSync { host_id: host.clone(), remote: rem.clone(), state: "pending".into(), message: Some("Local changes await upload. Review and upload from Files.".into()) });
            }
        });
        self.edits.lock().insert(Self::edit_key(host_id, remote), EditWatch { task, base_mtime, local: local.clone() });
        Ok(local)
    }

    async fn sync_edit(&self, host_id: &str, remote: &str, local: &Path, base: &Arc<Mutex<i64>>, force: bool, confirmed: bool) -> Result<()> {
        let emit = |state: &str, message: Option<String>| {
            let _ = self.events.send(CoreEvent::EditSync {
                host_id: host_id.to_string(),
                remote: remote.to_string(),
                state: state.to_string(),
                message,
            });
        };
        let res: Result<()> = async {
            if !self.vault.lock().is_unlocked() { return Err(Error::VaultLocked); }
            crate::git::require_confirmation(&self.db, host_id, confirmed)?;
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
    pub async fn edit_upload(&self, host_id: &str, remote: &str, force: bool, confirmed: bool) -> Result<()> {
        let (local, base) = {
            let edits = self.edits.lock();
            let w = edits
                .get(&Self::edit_key(host_id, remote))
                .ok_or_else(|| Error::NotFound("this file is not open for editing".into()))?;
            (w.local.clone(), w.base_mtime.clone())
        };
        self.sync_edit(host_id, remote, &local, &base, force, confirmed).await
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

pub(crate) async fn create_staging(c: &Conn, path: &str) -> Result<russh_sftp::client::fs::File> {
    let mut attributes = FileAttributes::empty();
    attributes.permissions = Some(0o600);
    c.s.open_with_flags_and_attributes(path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE, attributes).await.map_err(sftp_err)
}

pub(crate) async fn prepare_upload(c: &Conn, remote: &str) -> Result<(String, String)> {
    let target = shell_quote(remote);
    let command = format!("if [ -e {target} ] || [ -L {target} ]; then [ -f {target} ] && [ ! -L {target} ] && [ \"$(stat -c %u -- {target})\" = \"$(id -u)\" ] && [ \"$(stat -c %h -- {target})\" = 1 ] || {{ echo 'Cannot safely replace this file; use the built-in editor or another destination'; exit 1; }}; stat -c '%u:%g:%a:%h:%s:%Y:%i' -- {target}; else echo missing; fi");
    let result = exec(c.lease.handle().await?.as_ref(), &command, Duration::from_secs(10)).await?;
    if result.exit != Some(0) { return Err(Error::Other(result.stdout.trim().into())); }
    let parent = remote.rsplit_once('/').map(|(dir, _)| dir).unwrap_or(".");
    Ok((format!("{parent}/.rookery-{}.part", new_id()), result.stdout.trim().into()))
}

pub(crate) async fn finish_upload(c: &Conn, staging: &str, remote: &str, original: &str) -> Result<()> {
    let (temp, target) = (shell_quote(staging), shell_quote(remote));
    let check = if original == "missing" {
        format!("[ ! -e {target} ] && [ ! -L {target} ]")
    } else {
        format!("[ ! -L {target} ] && [ \"$(stat -c '%u:%g:%a:%h:%s:%Y:%i' -- {target})\" = {} ] && chmod --reference={target} -- {temp} && chgrp --reference={target} -- {temp}", shell_quote(original))
    };
    let install = if original == "missing" {
        format!("ln -- {temp} {target} && rm -- {temp}")
    } else {
        format!("mv -f -- {temp} {target}")
    };
    let command = format!("{check} && {install}");
    let result = exec(c.lease.handle().await?.as_ref(), &command, Duration::from_secs(10)).await?;
    if result.exit != Some(0) {
        return Err(Error::Other(format!("Upload was staged but could not safely replace the destination. Check {staging} before retrying")));
    }
    Ok(())
}

async fn local_mtime(p: &Path) -> Option<SystemTime> {
    tokio::fs::metadata(p).await.ok()?.modified().ok()
}

#[cfg(test)]
pub(crate) async fn exercise_staged_uploads(core: &crate::Core, host_id: &str) {
    let dir = format!("/tmp/rookery-test-{}", new_id());
    core.sftp.mkdir(host_id, &dir).await.unwrap();
    let remote = format!("{dir}/unicode-文件.txt");
    core.sftp.upload_bytes(host_id, &remote, b"original").await.unwrap();
    let c = core.sftp.conn(host_id).await.unwrap();
    assert_eq!(c.s.metadata(&remote).await.unwrap().permissions.unwrap() & 0o777, 0o600);
    let (staging, original) = prepare_upload(&c, &remote).await.unwrap();
    let mut file = create_staging(&c, &staging).await.unwrap();
    file.write_all(b"replacement").await.unwrap();
    file.shutdown().await.unwrap();
    assert_eq!(core.sftp.read_small(host_id, &remote, 100).await.unwrap(), b"original");
    assert!(create_staging(&c, &staging).await.is_err());
    finish_upload(&c, &staging, &remote, &original).await.unwrap();
    assert_eq!(core.sftp.read_small(host_id, &remote, 100).await.unwrap(), b"replacement");
    let (staging, original) = prepare_upload(&c, &remote).await.unwrap();
    let mut file = create_staging(&c, &staging).await.unwrap();
    file.write_all(b"stale").await.unwrap();
    file.shutdown().await.unwrap();
    core.sftp.upload_bytes(host_id, &remote, b"external change").await.unwrap();
    assert!(finish_upload(&c, &staging, &remote, &original).await.is_err());
    assert_eq!(core.sftp.read_small(host_id, &remote, 100).await.unwrap(), b"external change");
    let link = format!("{dir}/link");
    c.s.symlink(&remote, &link).await.unwrap();
    assert!(prepare_upload(&c, &link).await.is_err());
    core.connections.close(host_id).await;
    let renewed = core.sftp.conn(host_id).await.unwrap();
    assert!(!Arc::ptr_eq(&c, &renewed));
    assert_eq!(core.sftp.read_small(host_id, &remote, 100).await.unwrap(), b"external change");
    core.sftp.delete(host_id, &dir, true, true).await.unwrap();
    drop(c);
    drop(renewed);
    core.sftp.close(host_id).await;
}

#[cfg(test)]
mod guard_tests {
    use super::*;
    use crate::model::{EnvLabel, Host, RefreshSetting, StartView};

    #[test]
    fn new_names_allow_no_extension_and_dot_files_only() {
        for ok in ["Dockerfile", "Makefile", ".env", "a.b.c", "файл", "with space"] {
            assert!(check_new_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "a\0", " lead", "trail "] {
            assert!(check_new_name(bad).is_err(), "{bad:?}");
        }
        assert!(check_new_path("/srv/app/Dockerfile").is_ok());
        assert!(check_new_path("relative/x").is_err());
        assert!(check_new_path("/srv/app/").is_err());
    }

    #[tokio::test]
    async fn archive_rejects_bad_input_before_connecting() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::init(dir.path()).unwrap();
        for (path, name, mode) in [("/", "x.zip", "zip"), ("rel", "x.zip", "zip"), ("/a", "../x", "zip"), ("/a", "x", "rm -rf"), ("/a", "", "unzip")] {
            assert!(core.sftp.archive("h", path, name, mode, "job").await.is_err());
        }
        assert!(core.connections.all_info().is_empty());
        core.sftp.archive_cancel("unknown");
    }

    #[tokio::test]
    async fn external_upload_uses_saved_environment_and_lock_before_connecting() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::init(dir.path()).unwrap();
        let mut host = core.db.save_host(Host {
            id: String::new(), group_id: None, name: "server".into(), address: "unreachable.invalid".into(), port: 22,
            env_label: EnvLabel::Dev, tags: vec![], identity_id: None, jump_host_id: None, theme: None,
            start_view: StartView::Terminal, start_folder: None, auto_reconnect: false, keepalive_s: 30,
            log_session: false, refresh: RefreshSetting::default(), sort: 0, created_at: 0, updated_at: 0,
        }).unwrap();
        let local = dir.path().join("draft.txt");
        tokio::fs::write(&local, "local changes").await.unwrap();
        let base = Arc::new(Mutex::new(1));
        assert!(matches!(core.sftp.sync_edit(&host.id, "/remote", &local, &base, false, true).await, Err(Error::VaultLocked)));
        core.vault.lock().create("test master").unwrap();
        host.env_label = EnvLabel::Prod;
        core.db.save_host(host.clone()).unwrap();
        let error = core.sftp.sync_edit(&host.id, "/remote", &local, &base, false, false).await.unwrap_err();
        assert!(error.to_string().contains("production"));
        assert!(core.connections.all_info().is_empty());
        core.sftp.edits.lock().insert(Sftp::edit_key(&host.id, "/remote"), EditWatch { task: tokio::spawn(std::future::pending()), base_mtime: base, local: local.clone() });
        core.lock(false).await;
        assert!(core.sftp.edits.lock().contains_key(&Sftp::edit_key(&host.id, "/remote")));
        assert_eq!(tokio::fs::read_to_string(local).await.unwrap(), "local changes");
        assert!(core.connections.all_info().is_empty());
        core.sftp.edit_stop(&host.id, "/remote");
    }
}
