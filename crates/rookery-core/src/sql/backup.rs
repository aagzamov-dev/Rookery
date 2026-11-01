//! User-started native database file jobs. Dump contents never cross IPC or enter an editor.
use std::{collections::HashSet, path::{Path, PathBuf}, process::Stdio, sync::Arc, time::{Duration, Instant}};
use parking_lot::Mutex;
use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt}, process::Command, sync::{broadcast, watch, OwnedMutexGuard, Semaphore}};
use ts_rs::TS;
use super::{ConnParams, SqlManager};
use crate::{db::Db, forward::Forwarder, model::{DbEngine, SslMode}, new_id, now_ms, sftp::Sftp, ssh::ConnectionManager, CoreEvent, Error, Result};

const CHUNK: usize = 64 * 1024;
const INDEX: &str = "backup.database.artifacts";

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum TableMode { Data, Structure, Exclude }
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct BackupTable {
    pub schema: String, pub name: String, pub kind: String,
    #[ts(type = "number")]
    pub data_bytes: u64,
    #[ts(type = "number")]
    pub index_bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct TableSelection { pub schema: String, pub name: String, pub mode: TableMode }
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(tag = "location", rename_all = "snake_case")]
pub enum DatabaseFile { Local { path: String }, Server { path: String } }
impl DatabaseFile { fn path(&self) -> &str { match self { Self::Local { path } | Self::Server { path } => path } } }
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum DumpFormat { PostgresArchive, Sql, SqlGzip }
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseOperation {
    Export { file: DatabaseFile, tables: Vec<TableSelection>, #[serde(default)] #[ts(optional)] format: Option<DumpFormat> },
    Import { file: DatabaseFile, format: DumpFormat },
    Restore { backup_id: String },
    Download { backup_id: String, path: String },
    Delete { backup_id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct DatabaseBackup {
    pub id: String, pub conn_key: String, pub database: String, pub engine: DbEngine,
    pub host_id: Option<String>, pub file: DatabaseFile, pub format: DumpFormat,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub bytes: u64,
    pub sha256: String, pub tool_version: String, pub tables: Vec<TableSelection>,
    pub verification: String,
}
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct DatabaseJob {
    pub id: String, pub session_id: String, pub state: String, pub stage: String,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number")]
    pub bytes: u64,
    #[ts(type = "number | null")]
    pub total: Option<u64>,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    pub error: Option<String>,
    pub log: Vec<String>,
}
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct DatabaseFileInfo { pub target: String, pub database: String, pub engine: DbEngine, pub production: bool, pub server_files: bool, pub tables: Vec<BackupTable> }

pub(crate) struct NativeContext {
    pub params: ConnParams, pub host_id: Option<String>, pub production: bool, pub conn_key: String,
    pub stop: watch::Receiver<bool>, pub _guard: OwnedMutexGuard<()>,
}

pub fn tables_from_rows(rows: Vec<super::schema::TextRow>) -> Vec<BackupTable> {
    rows.into_iter().map(|r| {
        let text = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
        BackupTable { schema: text(0), name: text(1), kind: text(2), data_bytes: text(3).parse().unwrap_or(0), index_bytes: text(4).parse().unwrap_or(0) }
    }).collect()
}

pub struct DatabaseFiles {
    sql: Arc<SqlManager>, db: Arc<Db>, sftp: Arc<Sftp>, connections: Arc<ConnectionManager>,
    events: broadcast::Sender<CoreEvent>, directory: PathBuf, slot: Arc<Semaphore>,
    jobs: Mutex<Vec<DatabaseJob>>, cancel: Mutex<Option<(String, watch::Sender<bool>)>>,
}
impl DatabaseFiles {
    pub fn new(sql: Arc<SqlManager>, db: Arc<Db>, sftp: Arc<Sftp>, connections: Arc<ConnectionManager>, events: broadcast::Sender<CoreEvent>, directory: PathBuf) -> Self {
        Self { sql, db, sftp, connections, events, directory, slot: Arc::new(Semaphore::new(1)), jobs: Mutex::new(vec![]), cancel: Mutex::new(None) }
    }
    pub async fn info(&self, session: &str, include_tables: bool) -> Result<DatabaseFileInfo> {
        let ctx = self.sql.native_context(session, false, false).await?;
        let database = ctx.params.database.clone().unwrap_or_default();
        let engine = ctx.params.engine;
        let production = ctx.production;
        let server_files = ctx.host_id.is_some();
        let target = format!("{}@{}:{}/{}{}", ctx.params.user, ctx.params.host, ctx.params.port, database, ctx.host_id.as_ref().and_then(|id| self.db.get_host(id).ok()).map(|h| format!(" via SSH {}", h.name)).unwrap_or_default());
        let tables = if include_tables { self.sql.native_tables(session).await? } else { vec![] };
        drop(ctx);
        Ok(DatabaseFileInfo { target, database, engine, production, server_files, tables })
    }
    pub async fn list(&self, session: &str) -> Result<Vec<DatabaseBackup>> {
        let ctx = self.sql.native_context(session, false, false).await?;
        Ok(self.records()?.into_iter().filter(|b| b.conn_key == ctx.conn_key && Some(&b.database) == ctx.params.database.as_ref() && b.engine == ctx.params.engine && b.host_id == ctx.host_id).collect())
    }
    fn records(&self) -> Result<Vec<DatabaseBackup>> { Ok(self.db.get_setting(INDEX)?.unwrap_or_default()) }
    pub fn status(&self) -> Vec<DatabaseJob> { self.jobs.lock().clone() }
    pub fn cancel(&self, id: &str) { if let Some((job, tx)) = self.cancel.lock().as_ref() { if id == job { let _ = tx.send(true); } } }
    pub fn cancel_all(&self) { if let Some((_, tx)) = self.cancel.lock().as_ref() { let _ = tx.send(true); } }
    fn emit(&self, job: &mut DatabaseJob) {
        let mut jobs = self.jobs.lock();
        let previous = jobs.iter().find(|j| j.id == job.id);
        if previous.is_none_or(|old| old.stage != job.stage || old.state != job.state) {
            job.log.push(format!("[{:.1}s] {} · {}", job.elapsed_ms as f64 / 1000.0, job.state, job.stage));
        }
        bound_log(&mut job.log);
        if let Some(old) = jobs.iter_mut().find(|j| j.id == job.id) { *old = job.clone(); } else { jobs.push(job.clone()); }
        if jobs.len() > 20 { jobs.remove(0); }
        let _ = self.events.send(CoreEvent::DatabaseJob { job: job.clone() });
    }
    pub async fn start(self: &Arc<Self>, session: String, operation: DatabaseOperation, confirmed: bool) -> Result<String> {
        let permit = self.slot.clone().try_acquire_owned().map_err(|_| Error::Other("A database file job is already running; wait or cancel it".into()))?;
        let writes_db = matches!(&operation, DatabaseOperation::Import { .. } | DatabaseOperation::Restore { .. });
        let mut ctx = self.sql.native_context(&session, writes_db, confirmed).await?;
        let record = match &operation {
            DatabaseOperation::Restore { backup_id } | DatabaseOperation::Download { backup_id, .. } | DatabaseOperation::Delete { backup_id } => Some(self.records()?.into_iter().find(|b| &b.id == backup_id && b.conn_key == ctx.conn_key && Some(&b.database) == ctx.params.database.as_ref() && b.engine == ctx.params.engine && b.host_id == ctx.host_id).ok_or_else(|| Error::NotFound("Rookery database backup for this connection and database".into()))?),
            _ => None,
        };
        let remote_write = (ctx.host_id.is_some() && matches!(&operation, DatabaseOperation::Export { .. })) || matches!((&operation, &record), (DatabaseOperation::Delete { .. }, Some(DatabaseBackup { file: DatabaseFile::Server { .. }, .. })));
        if remote_write && ctx.production && !confirmed { return Err(Error::Other("Confirm this PROD server backup write first".into())); }
        if remote_write {
            let host = ctx.host_id.as_ref().ok_or_else(|| Error::Other("Server files require an SSH database connection".into()))?;
            crate::git::require_confirmation(&self.db, host, confirmed)?;
        }
        if ctx.production && matches!(&operation, DatabaseOperation::Delete { .. }) && !confirmed { return Err(Error::Other("Confirm deletion of this PROD backup first".into())); }
        match &operation {
            DatabaseOperation::Export { file, tables, format } => {
                let export_format = validate_export_format(ctx.params.engine, format.as_ref())?;
                validate_export_path(file.path(), &export_format)?;
                validate_file(file, ctx.host_id.is_some())?; validate_selection(tables, ctx.params.engine, ctx.params.database.as_deref().unwrap_or_default())?;
                let catalog = self.sql.native_tables(&session).await?;
                let actual: HashSet<_> = catalog.iter().map(|t| (&t.schema, &t.name)).collect();
                let selected: HashSet<_> = tables.iter().map(|t| (&t.schema, &t.name)).collect();
                if actual != selected { return Err(Error::Other("Tables changed since the modal opened; reopen Export and review the selection".into())); }
            }
            DatabaseOperation::Import { file, format } => { validate_file(file, ctx.host_id.is_some())?; if ctx.params.engine == DbEngine::Mysql && matches!(format, DumpFormat::PostgresArchive) { return Err(Error::Other("PostgreSQL archives cannot be imported into MySQL".into())); } }
            _ => {}
        }
        let id = new_id();
        let mut job = DatabaseJob { id: id.clone(), session_id: session, state: "running".into(), stage: "Creating private staging".into(), started_at: now_ms(), bytes: 0, total: None, elapsed_ms: 0, error: None, log: vec![] };
        let (cancel, mut cancelled) = watch::channel(false);
        *self.cancel.lock() = Some((id.clone(), cancel));
        self.emit(&mut job);
        let me = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let started = Instant::now();
            let mut job = job;
            let result = async {
                let work = WorkDir::new(&me.directory, &job.id).await?;
                let mut stop = ctx.stop.clone();
                tokio::select! {
                    biased;
                    _ = cancelled.changed() => Err(Error::Other("Cancelled. A created file or partial import may remain; verify before retrying.".into())),
                    _ = stop.changed() => Err(Error::Other("Database session closed. An import outcome may be partial; verify the target.".into())),
                    r = me.perform(&mut ctx, operation, record, &work, &mut job, started) => r,
                }
            }.await;
            job.elapsed_ms = started.elapsed().as_millis() as u64;
            job.state = if *cancelled.borrow() { "cancelled" } else if result.is_ok() { "done" } else { "failed" }.into();
            job.error = result.err().map(|e| e.to_string());
            me.emit(&mut job);
            *me.cancel.lock() = None;
        });
        Ok(id)
    }
    async fn perform(&self, ctx: &mut NativeContext, operation: DatabaseOperation, record: Option<DatabaseBackup>, work: &WorkDir, job: &mut DatabaseJob, started: Instant) -> Result<()> {
        let backup = record.as_ref();
        match operation {
            DatabaseOperation::Export { file, tables, format } => {
                let mut p = ctx.params.clone();
                let format = validate_export_format(p.engine, format.as_ref())?;
                let gzip = matches!(format, DumpFormat::SqlGzip);
                let (bytes, sha256, version) = if ctx.host_id.is_some() {
                    self.export_server(ctx, &file, &tables, gzip, work, job, started).await?
                } else {
                let _forward = self.forward(&mut p, ctx.host_id.as_deref()).await?;
                let (tool, version) = dump_tool(p.engine).await?;
                let auth = AuthFile::new(work, &p).await?;
                let path = work.0.join("dump");
                let mut dst = private_file(&path).await?;
                let commands = dump_arguments(&p, &tables, &tool)?;
                let mut compressor = gzip.then(|| Compress::new_gzip(Compression::fast(), 15));
                for args in commands {
                    let command = native_command(&tool, &args, &p, &auth);
                    self.process_stream(command, None, Some(&mut dst), compressor.as_mut(), false, job, started, "Exporting with native client", p.password.as_deref().map(|s| s.as_str())).await?;
                }
                if let Some(compressor) = compressor.as_mut() { finish_gzip(compressor, &mut dst).await?; }
                dst.flush().await?;
                drop(dst);
                let (bytes, sha256) = self.hash(&path, job, started).await?;
                self.publish(ctx, &path, &file, work, job, started).await?;
                (bytes, sha256, version)
                };
                let mut records = self.records()?;
                records.push(DatabaseBackup { id: job.id.clone(), conn_key: ctx.conn_key.clone(), database: p.database.clone().unwrap_or_default(), engine: p.engine, host_id: ctx.host_id.clone(), file, format, created_at: now_ms(), bytes, sha256, tool_version: version, tables, verification: "Native export completed; SHA-256 recorded. Restore has not been tested.".into() });
                self.db.set_setting(INDEX, &records)?;
                job.stage = "Export completed · restore not tested".into();
            }
            DatabaseOperation::Import { file, format } => {
                let path = self.materialize(ctx, &file, work, job, started).await?;
                self.restore(ctx, &path, format, work, job, started).await?;
            }
            DatabaseOperation::Restore { .. } => {
                let b = backup.unwrap();
                let path = self.materialize(ctx, &b.file, work, job, started).await?;
                let (size, hash) = self.hash(&path, job, started).await?;
                if size != b.bytes || hash != b.sha256 { return Err(Error::Other("Backup bytes differ from the recorded SHA-256; restore refused".into())); }
                self.restore(ctx, &path, b.format.clone(), work, job, started).await?;
            }
            DatabaseOperation::Download { path, .. } => {
                let b = backup.unwrap();
                let local = self.materialize(ctx, &b.file, work, job, started).await?;
                let (size, hash) = self.hash(&local, job, started).await?;
                if size != b.bytes || hash != b.sha256 { return Err(Error::Other("Backup bytes differ from the recorded SHA-256; download refused".into())); }
                self.publish(ctx, &local, &DatabaseFile::Local { path }, work, job, started).await?;
                job.stage = "Download completed · SHA-256 matched".into();
            }
            DatabaseOperation::Delete { .. } => {
                let b = backup.unwrap();
                let path = self.materialize(ctx, &b.file, work, job, started).await?;
                let (size, hash) = self.hash(&path, job, started).await?;
                if size != b.bytes || hash != b.sha256 { return Err(Error::Other("Backup bytes have changed; deletion refused. Manage this file in Files instead.".into())); }
                match &b.file {
                    DatabaseFile::Local { path } => { tokio::fs::remove_file(path).await?; }
                    DatabaseFile::Server { path } => { self.sftp.conn(ctx.host_id.as_deref().unwrap()).await?.s.remove_file(path).await.map_err(remote_error)?; }
                }
                let mut records = self.records()?;
                records.retain(|r| r.id != b.id);
                self.db.set_setting(INDEX, &records)?;
                job.stage = "Backup deleted".into();
            }
        }
        Ok(())
    }
    async fn export_server(&self, ctx: &NativeContext, file: &DatabaseFile, tables: &[TableSelection], gzip: bool, work: &WorkDir, job: &mut DatabaseJob, started: Instant) -> Result<(u64, String, String)> {
        job.stage = "Connecting to SSH server".into(); job.elapsed_ms = started.elapsed().as_millis() as u64; self.emit(job);
        let host = ctx.host_id.as_deref().unwrap();
        let lease = self.connections.acquire(host).await?;
        let handle = lease.handle().await?;
        let p = &ctx.params;
        if p.ca_path.is_some() { return Err(Error::Other("SSH export with a custom CA certificate is not supported yet. Use a direct database connection with the CA configured for local native export.".into())); }
        let candidates = if p.engine == DbEngine::Postgres { vec!["pg_dump"] } else { vec!["mariadb-dump", "mysqldump"] };
        let probe = candidates.iter().map(|tool| format!("if PATH=/usr/local/bin:/usr/bin:/bin command -v {tool} >/dev/null 2>&1; then printf '%s\\n' {tool}; {tool} --version 2>/dev/null | head -c 512; exit; fi")).collect::<Vec<_>>().join("; ");
        job.stage = "Checking server native client and coreutils".into(); job.elapsed_ms = started.elapsed().as_millis() as u64; self.emit(job);
        let found = crate::ssh::exec(&handle, &format!("PATH=/usr/local/bin:/usr/bin:/bin; export PATH; command -v sha256sum >/dev/null && ln --version >/dev/null 2>&1 || {{ echo 'SSH export requires GNU coreutils (sha256sum and ln -T) on the server' >&2; exit 126; }}; {probe}; exit 127"), Duration::from_secs(10)).await?;
        if found.exit != Some(0) {
            return Err(Error::Other(format!("Native dump client or GNU coreutils missing on the SSH server. Install {} there using its system package manager (PostgreSQL client / mysql-client / mariadb-client), or ask the server administrator. Docker-only databases need a host-accessible native client and endpoint; automatic container discovery and installation are not supported.", candidates.join(" or "))));
        }
        let (tool, version) = found.stdout.split_once('\n').ok_or_else(|| Error::Other("Invalid server native client version response".into()))?;
        if !candidates.contains(&tool) { return Err(Error::Other("Unexpected server native client".into())); }
        let parent = match file { DatabaseFile::Server { path } => path.rsplit_once('/').map(|(parent, _)| if parent.is_empty() { "/" } else { parent }).unwrap_or("/"), _ => "/tmp" };
        let remote = format!("{parent}/.rookery-database-{}", job.id);
        let made = crate::ssh::exec(&handle, &format!("umask 077; mkdir -- {}", crate::terminal::shell_quote(&remote)), Duration::from_secs(10)).await?;
        if made.exit != Some(0) { return Err(Error::Other("Cannot create private staging directory on the SSH server; check destination parent permissions and free space".into())); }
        let cleanup = RemoteWork { handle: handle.clone(), path: remote.clone(), _lease: Some(lease) };
        let auth = AuthFile::new(work, p).await?;
        let secret = zeroize::Zeroizing::new(tokio::fs::read(&auth.0).await?);
        let command = server_dump_script_compression(p, tables, tool, &remote, file, gzip)?;
        job.stage = "Exporting on SSH server · total unknown".into(); job.bytes = 0; job.total = None; self.emit(job);
        let (sender, mut receiver) = tokio::sync::mpsc::channel(16);
        let execution = crate::ssh::exec_with_input_progress(&handle, &command, &secret, Duration::from_secs(24 * 60 * 60), sender);
        tokio::pin!(execution);
        let mut lines = DiagnosticLines::default();
        let mut last_output = Instant::now() - Duration::from_millis(150);
        let mut pending_output = false;
        let password = p.password.as_deref().map(|p| p.as_str());
        let result = loop {
            tokio::select! {
                result = &mut execution => {
                    while let Ok(chunk) = receiver.try_recv() { self.server_output(job, started, lines.push(&chunk), password, &mut last_output, &mut pending_output); }
                    self.server_output(job, started, lines.finish(), password, &mut last_output, &mut pending_output);
                    self.emit(job);
                    break result?;
                }
                Some(chunk) = receiver.recv() => self.server_output(job, started, lines.push(&chunk), password, &mut last_output, &mut pending_output),
                _ = tokio::time::sleep_until((last_output + Duration::from_millis(150)).into()), if pending_output => { self.emit(job); last_output = Instant::now(); pending_output = false; },
            }
        };
        if result.exit != Some(0) { return Err(Error::Other(format!("SSH server dump failed (exit {}). {}", result.exit.map(|code| code.to_string()).unwrap_or_else(|| "unknown".into()), safe_diagnostic(result.stderr.as_bytes(), password)))); }
        let mut fields = result.stdout.split_whitespace();
        let bytes = fields.next().and_then(|v| v.parse::<u64>().ok()).ok_or_else(|| Error::Other("Invalid server dump size".into()))?;
        let sha256 = fields.next().filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(|| Error::Other("Invalid server dump SHA-256".into()))?.to_string();
        if let DatabaseFile::Local { .. } = file {
            let local = self.materialize(ctx, &DatabaseFile::Server { path: format!("{remote}/dump") }, work, job, started).await?;
            let actual = self.hash(&local, job, started).await?;
            if actual != (bytes, sha256.clone()) { return Err(Error::Other("Server dump changed during download; SHA-256 mismatch".into())); }
            self.publish(ctx, &local, file, work, job, started).await?;
        }
        drop(cleanup);
        Ok((bytes, sha256, version.trim().into()))
    }
    async fn forward(&self, params: &mut ConnParams, host: Option<&str>) -> Result<Option<Forwarder>> {
        let Some(host) = host else { return Ok(None) };
        let f = Forwarder::ssh(self.connections.acquire(host).await?, params.host.clone(), params.port).await?;
        params.host = "127.0.0.1".into(); params.port = f.local_port;
        Ok(Some(f))
    }
    fn server_output(&self, job: &mut DatabaseJob, started: Instant, lines: Vec<Vec<u8>>, password: Option<&str>, last: &mut Instant, pending: &mut bool) {
        for line in lines {
            let text = safe_diagnostic(&line, password);
            let stage = match text.trim() {
                "ROOKERY_STAGE:Verifying server dump checksum" => Some("Verifying server dump checksum".to_string()),
                "ROOKERY_STAGE:Publishing server backup" => Some("Publishing server backup".to_string()),
                "ROOKERY_PASS:1" => Some("Running native dump · pass 1 · size unknown".to_string()),
                "ROOKERY_PASS:2" => Some("Running native dump · pass 2 · size unknown".to_string()),
                "ROOKERY_PASS:3" => Some("Running native dump · pass 3 · size unknown".to_string()),
                _ => None,
            };
            job.elapsed_ms = started.elapsed().as_millis() as u64;
            if let Some(stage) = stage {
                if job.stage != stage { job.stage = stage; self.emit(job); }
                continue;
            }
            else if !text.trim().is_empty() {
                let message = text.trim();
                let entry = format!("[{:.1}s] stderr: {message}", job.elapsed_ms as f64 / 1000.0);
                if job.log.iter().any(|last| last.ends_with(&format!("stderr: {message}"))) { continue; }
                job.log.push(entry);
                bound_log(&mut job.log);
            } else { continue; }
            *pending = true;
            if last.elapsed() >= Duration::from_millis(150) { self.emit(job); *last = Instant::now(); *pending = false; }
        }
    }

    async fn materialize(&self, ctx: &NativeContext, file: &DatabaseFile, work: &WorkDir, job: &mut DatabaseJob, started: Instant) -> Result<PathBuf> {
        match file {
            DatabaseFile::Local { path } => {
                let meta = tokio::fs::symlink_metadata(path).await?;
                if !meta.is_file() { return Err(Error::Other("Select a regular dump file, not a symlink or directory".into())); }
                let mut src = tokio::fs::File::open(path).await?;
                let local = work.0.join("source");
                let mut dst = private_file(&local).await?;
                self.copy(&mut src, &mut dst, job, started, "Copying source to private local staging", Some(meta.len())).await?;
                dst.flush().await?;
                Ok(local)
            }
            DatabaseFile::Server { path } => {
                let c = self.sftp.conn(ctx.host_id.as_deref().ok_or_else(|| Error::Other("Server files require SSH".into()))?).await?;
                let meta = c.s.symlink_metadata(path).await.map_err(remote_error)?;
                if !meta.is_regular() { return Err(Error::Other("Select a regular server dump file".into())); }
                let mut src = c.s.open(path).await.map_err(remote_error)?;
                let local = work.0.join("source");
                let mut dst = private_file(&local).await?;
                self.copy(&mut src, &mut dst, job, started, "Downloading server file to private local staging", meta.size).await?;
                dst.flush().await?;
                Ok(local)
            }
        }
    }
    async fn publish(&self, ctx: &NativeContext, source: &Path, file: &DatabaseFile, work: &WorkDir, job: &mut DatabaseJob, started: Instant) -> Result<()> {
        match file {
            DatabaseFile::Local { path } => {
                let dest = Path::new(path);
                let tmp = dest.with_file_name(format!(".rookery-{}.part", job.id));
                let cleanup = LocalFile(tmp.clone());
                let mut dst = private_file(&tmp).await?;
                let mut src = tokio::fs::File::open(source).await?;
                self.copy(&mut src, &mut dst, job, started, "Saving local file", Some(tokio::fs::metadata(source).await?.len())).await?;
                dst.sync_all().await?; drop(dst);
                tokio::fs::hard_link(&tmp, dest).await.map_err(|e| Error::Other(format!("Cannot create destination (existing files are never replaced): {e}")))?;
                drop(cleanup);
            }
            DatabaseFile::Server { path } => {
                let host = ctx.host_id.as_deref().ok_or_else(|| Error::Other("Server files require SSH".into()))?;
                let c = self.sftp.conn(host).await?;
                let (tmp, original) = crate::sftp::prepare_upload(&c, path).await?;
                if original != "missing" { return Err(Error::Other("Destination exists; choose a new server filename".into())); }
                // On cancellation the private .part is retained as an explicitly named recovery file.
                job.stage = format!("Uploading server file · partial recovery: {tmp}"); self.emit(job);
                let mut dst = crate::sftp::create_staging(&c, &tmp).await?;
                let mut src = tokio::fs::File::open(source).await?;
                self.copy(&mut src, &mut dst, job, started, &format!("Uploading server file · partial recovery: {tmp}"), Some(tokio::fs::metadata(source).await?.len())).await?;
                dst.shutdown().await?;
                crate::sftp::finish_upload(&c, &tmp, path, &original).await?;
            }
        }
        let _ = work;
        Ok(())
    }
    async fn hash(&self, path: &Path, job: &mut DatabaseJob, started: Instant) -> Result<(u64, String)> {
        let mut file = tokio::fs::File::open(path).await?;
        let mut digest = Sha256::new(); let mut buf = vec![0; CHUNK]; let mut bytes = 0;
        job.stage = "Checking file SHA-256".into(); job.bytes = 0; job.total = Some(file.metadata().await?.len()); self.emit(job);
        let mut last = Instant::now();
        loop { let n = file.read(&mut buf).await?; if n == 0 { break; } digest.update(&buf[..n]); bytes += n as u64; job.bytes = bytes; self.progress(job, started, &mut last); }
        Ok((bytes, format!("{:x}", digest.finalize())))
    }
    async fn restore(&self, ctx: &NativeContext, source: &Path, format: DumpFormat, work: &WorkDir, job: &mut DatabaseJob, started: Instant) -> Result<()> {
        let mut magic_file = tokio::fs::File::open(source).await?;
        let mut magic = [0; 4]; let n = magic_file.read(&mut magic).await?;
        if n >= 2 && &magic[..2] == b"PK" { return Err(Error::Other("ZIP archives are unsupported. Extract the SQL file first, or choose a gzip SQL (.sql.gz) file.".into())); }
        let gzip_magic = n >= 2 && magic[..2] == [0x1f, 0x8b];
        if gzip_magic != matches!(format, DumpFormat::SqlGzip) {
            return Err(Error::Other(if gzip_magic { "This file contains gzip SQL. Select Compressed SQL (.sql.gz) before importing." } else { "This file is not gzip SQL. Select the matching dump format before importing." }.into()));
        }
        let mut p = ctx.params.clone();
        if matches!(format, DumpFormat::SqlGzip) {
            let mut src = tokio::fs::File::open(source).await?;
            self.gunzip(&mut src, &mut tokio::io::sink(), job, started, "Validating gzip SQL before import").await?;
        }
        let _forward = self.forward(&mut p, ctx.host_id.as_deref()).await?;
        let tool = match (p.engine, &format) { (DbEngine::Postgres, DumpFormat::PostgresArchive) => "pg_restore", (DbEngine::Postgres, DumpFormat::Sql | DumpFormat::SqlGzip) => "psql", (DbEngine::Mysql, _) => if tool_version("mariadb").await.is_ok() { "mariadb" } else { "mysql" } };
        tool_version(tool).await?;
        let auth = AuthFile::new(work, &p).await?;
        let args = restore_arguments(&p, &format, tool);
        let command = native_command(tool, &args, &p, &auth);
        let mut src = tokio::fs::File::open(source).await?;
        job.total = Some(src.metadata().await?.len());
        self.process_stream(command, Some(&mut src), None, None, matches!(format, DumpFormat::SqlGzip), job, started, "Importing with native client · changes may be applied immediately", p.password.as_deref().map(|s| s.as_str())).await?;
        job.stage = "Native import completed · verify target data; no restore test recorded".into();
        Ok(())
    }
    async fn gzip<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(&self, src: &mut R, dst: &mut W, compressor: &mut Compress, job: &mut DatabaseJob, started: Instant, stage: &str) -> Result<()> {
        job.stage = stage.into(); job.bytes = 0; job.total = None; self.emit(job);
        let mut input = vec![0; CHUNK]; let mut output = vec![0; CHUNK]; let mut last = Instant::now();
        loop {
            let n = src.read(&mut input).await?; if n == 0 { break; }
            let mut offset = 0;
            while offset < n {
                let before_in = compressor.total_in(); let before_out = compressor.total_out();
                compressor.compress(&input[offset..n], &mut output, FlushCompress::None).map_err(gzip_error)?;
                let consumed = (compressor.total_in() - before_in) as usize;
                let produced = (compressor.total_out() - before_out) as usize;
                if consumed == 0 && produced == 0 { return Err(gzip_error("compression made no progress")); }
                offset += consumed; dst.write_all(&output[..produced]).await?;
                job.bytes += consumed as u64; self.progress(job, started, &mut last);
            }
        }
        Ok(())
    }
    async fn gunzip<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(&self, src: &mut R, dst: &mut W, job: &mut DatabaseJob, started: Instant, stage: &str) -> Result<()> {
        job.stage = stage.into(); job.bytes = 0; job.total = None; self.emit(job);
        let mut input = vec![0; CHUNK]; let mut output = vec![0; CHUNK]; let mut last = Instant::now();
        let mut decoder = Decompress::new_gzip(15); let mut complete = false;
        loop {
            let n = src.read(&mut input).await?;
            if n == 0 { if complete { return Ok(()); } return Err(gzip_error("empty or truncated gzip stream")); }
            let mut offset = 0;
            loop {
                if complete {
                    if offset == n { break; }
                    decoder = Decompress::new_gzip(15);
                }
                let before_in = decoder.total_in(); let before_out = decoder.total_out();
                let status = decoder.decompress(&input[offset..n], &mut output, FlushDecompress::None).map_err(gzip_error)?;
                let consumed = (decoder.total_in() - before_in) as usize;
                let produced = (decoder.total_out() - before_out) as usize;
                offset += consumed; dst.write_all(&output[..produced]).await?;
                job.bytes += consumed as u64; self.progress(job, started, &mut last);
                complete = status == Status::StreamEnd;
                if complete { continue; }
                if consumed == 0 && produced == 0 {
                    if offset == n { break; }
                    return Err(gzip_error("decompression made no progress"));
                }
                if offset == n && produced < output.len() { break; }
                tokio::task::yield_now().await;
            }
        }
    }
    async fn copy<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(&self, src: &mut R, dst: &mut W, job: &mut DatabaseJob, started: Instant, stage: &str, total: Option<u64>) -> Result<()> {
        job.stage = stage.into(); job.bytes = 0; job.total = total; self.emit(job);
        let mut buf = vec![0; CHUNK]; let mut last = Instant::now();
        loop { let n = src.read(&mut buf).await?; if n == 0 { break; } dst.write_all(&buf[..n]).await?; job.bytes += n as u64; self.progress(job, started, &mut last); }
        Ok(())
    }
    fn progress(&self, job: &mut DatabaseJob, started: Instant, last: &mut Instant) { if last.elapsed() >= Duration::from_millis(150) { job.elapsed_ms = started.elapsed().as_millis() as u64; self.emit(job); *last = Instant::now(); } }
    #[cfg(test)]
    async fn process(&self, command: Command, input: Option<&mut tokio::fs::File>, output: Option<&mut tokio::fs::File>, job: &mut DatabaseJob, started: Instant, stage: &str, password: Option<&str>) -> Result<()> {
        self.process_stream(command, input, output, None, false, job, started, stage, password).await
    }
    async fn process_stream(&self, mut command: Command, input: Option<&mut tokio::fs::File>, output: Option<&mut tokio::fs::File>, compressor: Option<&mut Compress>, gzip_input: bool, job: &mut DatabaseJob, started: Instant, stage: &str, password: Option<&str>) -> Result<()> {
        command.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let child = command.spawn().map_err(|e| Error::Other(format!("Native database client could not start: {e}. Install the matching client manually and make it available on PATH.")))?;
        let mut reaper = ReapChild(Some(child));
        let child = reaper.0.as_mut().unwrap();
        let mut stdout = child.stdout.take().unwrap(); let stderr = child.stderr.take().unwrap(); let stdin = child.stdin.take();
        let importing = input.is_some();
        let total = if importing { job.total } else { None };
        let transfer = async {
            match (input, output, stdin) {
                (Some(src), _, Some(mut dst)) => {
                    let mut sink = tokio::io::sink();
                    let drain = tokio::io::copy(&mut stdout, &mut sink);
                    let send = async { if gzip_input { self.gunzip(src, &mut dst, job, started, stage).await?; } else { self.copy(src, &mut dst, job, started, stage, total).await?; } dst.shutdown().await?; drop(dst); Ok::<_, Error>(()) };
                    tokio::try_join!(send, async { drain.await.map_err(Error::from) })?;
                }
                (_, Some(dst), _) => {
                    if let Some(compressor) = compressor { self.gzip(&mut stdout, dst, compressor, job, started, stage).await?; }
                    else { self.copy(&mut stdout, dst, job, started, stage, None).await?; }
                },
                _ => { tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await?; }
            }
            Ok::<_, Error>(())
        };
        let diagnostic = match tokio::try_join!(transfer, bounded_output(stderr, 8192)) {
            Ok((_, diagnostic)) => diagnostic,
            Err(error) => { let _ = child.kill().await; let _ = child.wait().await; return Err(error); }
        };
        let status = child.wait().await?;
        if !status.success() {
            let diagnostic = safe_diagnostic(&diagnostic, password);
            let diagnostic = if importing { import_diagnostic(&diagnostic) } else { diagnostic };
            return Err(Error::Other(format!("Native client failed ({status}). {diagnostic}")));
        }
        reaper.0.take();
        Ok(())
    }
}

struct RemoteWork { handle: Arc<crate::ssh::SshHandle>, path: String, _lease: Option<crate::ssh::Lease> }
impl Drop for RemoteWork {
    fn drop(&mut self) {
        let handle = self.handle.clone(); let path = crate::terminal::shell_quote(&self.path);
        let lease = self._lease.take();
        tokio::spawn(async move {
            let _lease = lease;
            let command = format!("if [ -f {path}/pid ]; then read pid < {path}/pid; case $pid in ''|*[!0-9]*) ;; *) kill -TERM \"$pid\" 2>/dev/null || : ;; esac; fi; rm -rf -- {path}");
            let _ = crate::ssh::exec(&handle, &command, Duration::from_secs(10)).await;
        });
    }
}
#[cfg(test)]
fn server_dump_script(p: &ConnParams, tables: &[TableSelection], tool: &str, remote: &str, file: &DatabaseFile) -> Result<String> {
    server_dump_script_compression(p, tables, tool, remote, file, false)
}
fn server_dump_script_compression(p: &ConnParams, tables: &[TableSelection], tool: &str, remote: &str, file: &DatabaseFile, gzip: bool) -> Result<String> {
    use crate::terminal::shell_quote as q;
    let auth = AuthFile(PathBuf::from(format!("{remote}/auth")));
    let command = native_command(tool, &[], p, &auth);
    let mut prefix = vec!["env".to_string()];
    // Explicit environment prevents inherited server client settings from changing the target.
    prefix.extend(["-i".into(), "PATH=/usr/local/bin:/usr/bin:/bin".into(), "HOME=/nonexistent".into()]);
    for (key, value) in command.as_std().get_envs() { if let Some(value) = value { prefix.push(format!("{}={}", key.to_string_lossy(), value.to_string_lossy())); } }
    prefix.push(tool.into());
    prefix.extend(command.as_std().get_args().map(|s| s.to_string_lossy().into_owned()));
    let passes = dump_arguments(p, tables, tool)?.into_iter().map(|args| prefix.iter().chain(args.iter()).map(|s| q(s)).collect::<Vec<_>>().join(" ")).enumerate().map(|(index, cmd)| format!("printf 'ROOKERY_PASS:%s\\n' {} >&2; {cmd} & native=$!; wait \"$native\" || exit $?;", index + 1)).collect::<Vec<_>>().join(" ");
    let dir = q(remote);
    let publish = match file { DatabaseFile::Server { path } => format!("printf '%s\\n' 'ROOKERY_STAGE:Publishing server backup' >&2; ln -T -- {dir}/dump {} || {{ echo 'Cannot create server destination: existing paths are never replaced; check parent permissions and free space.' >&2; exit 1; }};", q(path)), _ => String::new() };
    let producer = format!("( trap 'kill \"$native\" 2>/dev/null || :; wait \"$native\" 2>/dev/null || :; exit 143' HUP INT TERM; {passes} )");
    let export = if gzip {
        format!("command -v gzip >/dev/null 2>&1 || {{ echo 'SSH compressed exports require gzip on the server' >&2; exit 126; }}; mkfifo -- {dir}/stream || exit; gzip -1 -c < {dir}/stream > {dir}/dump & compressor=$!; {producer} > {dir}/stream & child=$!; wait \"$compressor\"; compression_status=$?; compressor=; if [ \"$compression_status\" != 0 ]; then kill \"$child\" 2>/dev/null || :; wait \"$child\" 2>/dev/null || :; exit 1; fi; wait \"$child\"; status=$?; child=; rm -f -- {dir}/stream; if [ \"$status\" != 0 ]; then exit 1; fi;")
    } else {
        format!("{producer} > {dir}/dump & child=$!; wait \"$child\"; status=$?; child=; if [ \"$status\" != 0 ]; then exit 1; fi;")
    };
    Ok(format!("umask 077; dir={dir}; echo $$ > {dir}/pid; child=; compressor=; trap 'rm -f -- \"$dir/auth\" \"$dir/pid\" \"$dir/stream\"' EXIT; trap 'kill \"$child\" \"$compressor\" 2>/dev/null || :; wait \"$child\" 2>/dev/null || :; wait \"$compressor\" 2>/dev/null || :; exit 143' HUP INT TERM; cat > {dir}/auth || exit; {export} rm -f -- {dir}/auth; printf '%s\\n' 'ROOKERY_STAGE:Verifying server dump checksum' >&2; bytes=$(wc -c < {dir}/dump) || exit; sha256sum < {dir}/dump > {dir}/hash & child=$!; wait \"$child\" || exit; child=; read hash rest < {dir}/hash; {publish} printf '%s %s\\n' \"$bytes\" \"$hash\""))
}

struct ReapChild(Option<tokio::process::Child>);
impl Drop for ReapChild {
    fn drop(&mut self) { if let Some(mut child) = self.0.take() { let _ = child.start_kill(); tokio::spawn(async move { let _ = child.wait().await; }); } }
}

fn gzip_error(error: impl std::fmt::Display) -> Error { Error::Other(format!("Invalid gzip SQL stream: {error}")) }
async fn finish_gzip<W: AsyncWrite + Unpin>(compressor: &mut Compress, dst: &mut W) -> Result<()> {
    let mut output = vec![0; CHUNK];
    loop {
        let before = compressor.total_out();
        let status = compressor.compress(&[], &mut output, FlushCompress::Finish).map_err(gzip_error)?;
        let n = (compressor.total_out() - before) as usize;
        dst.write_all(&output[..n]).await?;
        if status == Status::StreamEnd { return Ok(()); }
        if n == 0 { return Err(gzip_error("cannot finish compression")); }
    }
}
fn validate_export_path(path: &str, format: &DumpFormat) -> Result<()> {
    let lower = path.to_ascii_lowercase();
    if matches!(format, DumpFormat::SqlGzip) && lower.ends_with(".sql") || matches!(format, DumpFormat::Sql) && lower.ends_with(".gz") {
        return Err(Error::Other("Use a .sql.gz filename for compressed SQL, or .sql for plain SQL. Update the filename or export format.".into()));
    }
    Ok(())
}
fn validate_export_format(engine: DbEngine, format: Option<&DumpFormat>) -> Result<DumpFormat> {
    match (engine, format) {
        (DbEngine::Postgres, None | Some(DumpFormat::PostgresArchive)) => Ok(DumpFormat::PostgresArchive),
        (DbEngine::Mysql, None | Some(DumpFormat::Sql)) => Ok(DumpFormat::Sql),
        (DbEngine::Mysql, Some(DumpFormat::SqlGzip)) => Ok(DumpFormat::SqlGzip),
        _ => Err(Error::Other("Choose PostgreSQL custom archive for PostgreSQL exports, or SQL / gzip SQL for MySQL exports".into())),
    }
}
fn remote_error(e: impl std::fmt::Display) -> Error { Error::Other(format!("SFTP: {e}")) }
fn validate_file(file: &DatabaseFile, server: bool) -> Result<()> {
    if file.path().to_ascii_lowercase().ends_with(".zip") { return Err(Error::Other("ZIP archives are unsupported. Extract the SQL file first, or choose a gzip SQL (.sql.gz) file.".into())); }
    let path = file.path();
    if path.trim().is_empty() || path.contains('\0') || path.contains('\n') || path.contains('\r') { return Err(Error::Other("Choose a valid file path".into())); }
    if matches!(file, DatabaseFile::Server { .. }) && (!server || !path.starts_with('/')) { return Err(Error::Other("Server files require an SSH connection and an absolute path".into())); }
    Ok(())
}
fn validate_selection(tables: &[TableSelection], engine: DbEngine, database: &str) -> Result<()> {
    if tables.is_empty() || tables.iter().all(|t| t.mode == TableMode::Exclude) { return Err(Error::Other("Select at least one table".into())); }
    let mut unique = HashSet::new();
    for t in tables { if t.name.is_empty() || t.name.contains('\0') || t.schema.contains('\0') || !unique.insert((&t.schema, &t.name)) { return Err(Error::Other("Invalid or repeated table selection".into())); } if engine == DbEngine::Mysql && t.schema != database { return Err(Error::Other("MySQL table selection must belong to the current database".into())); } }
    Ok(())
}
fn pg_pattern(schema: &str, table: &str) -> String { format!("\"{}\".\"{}\"", schema.replace('"', "\"\""), table.replace('"', "\"\"")) }
fn connection_args(p: &ConnParams) -> Vec<String> { vec!["--host".into(), p.host.clone(), "--port".into(), p.port.to_string(), "--username".into(), p.user.clone()] }
fn dump_arguments(p: &ConnParams, tables: &[TableSelection], tool: &str) -> Result<Vec<Vec<String>>> {
    validate_selection(tables, p.engine, p.database.as_deref().unwrap_or_default())?;
    if p.engine == DbEngine::Postgres {
        let mut args = connection_args(p); args.extend(["--verbose".into(), "--no-password".into(), "--format=custom".into(), "--no-owner".into(), "--no-privileges".into(), "--dbname".into(), pg_database(p)]);
        // Whole-database exports retain non-table dependencies. Subsets intentionally use exact patterns.
        if tables.iter().any(|t| t.mode == TableMode::Exclude) { for t in tables.iter().filter(|t| t.mode != TableMode::Exclude) { args.extend(["--table".into(), pg_pattern(&t.schema, &t.name)]); } }
        if tables.iter().filter(|t| t.mode != TableMode::Exclude).all(|t| t.mode == TableMode::Structure) { args.push("--schema-only".into()); }
        for t in tables.iter().filter(|t| t.mode == TableMode::Structure) { args.extend(["--exclude-table-data".into(), pg_pattern(&t.schema, &t.name)]); }
        return Ok(vec![args]);
    }
    let mut base = vec!["--verbose".into(), "--host".into(), p.host.clone(), "--port".into(), p.port.to_string(), "--user".into(), p.user.clone(), "--protocol=TCP".into(), "--single-transaction".into(), "--quick".into(), "--skip-lock-tables".into(), "--skip-add-locks".into(), "--hex-blob".into()];
    if tool == "mysqldump" { base.push("--set-gtid-purged=OFF".into()); }
    let selected: Vec<_> = tables.iter().filter(|t| t.mode != TableMode::Exclude).collect();
    let with_tables = |mut args: Vec<String>, selected: &[&TableSelection]| {
        args.extend(["--".into(), p.database.clone().unwrap()]); args.extend(selected.iter().map(|t| t.name.clone())); args
    };
    if selected.iter().all(|t| t.mode == TableMode::Data) { return Ok(vec![with_tables(base, &selected)]); }
    let data: Vec<_> = selected.iter().copied().filter(|t| t.mode == TableMode::Data).collect();
    let mut structure = base.clone(); structure.push("--no-data".into());
    if data.is_empty() { return Ok(vec![with_tables(structure, &selected)]); }
    structure.push("--skip-triggers".into());
    let mut rows = base.clone(); rows.extend(["--no-create-info".into(), "--skip-triggers".into()]);
    let mut triggers = base; triggers.extend(["--no-create-info".into(), "--no-data".into()]);
    Ok(vec![with_tables(structure, &selected), with_tables(rows, &data), with_tables(triggers, &selected)])
}

fn pg_database(p: &ConnParams) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let host = if p.host.contains(':') { format!("[{}]", p.host) } else { p.host.clone() };
    format!("postgresql://{}@{}:{}/{}", utf8_percent_encode(&p.user, NON_ALPHANUMERIC), host, p.port, utf8_percent_encode(p.database.as_deref().unwrap_or_default(), NON_ALPHANUMERIC))
}
fn restore_arguments(p: &ConnParams, format: &DumpFormat, _tool: &str) -> Vec<String> {
    if p.engine == DbEngine::Mysql { return vec!["--host".into(), p.host.clone(), "--port".into(), p.port.to_string(), "--user".into(), p.user.clone(), "--protocol=TCP".into(), "--binary-mode".into(), "--".into(), p.database.clone().unwrap()]; }
    let mut args = connection_args(p); args.extend(["--no-password".into(), "--dbname".into(), pg_database(p)]);
    match format { DumpFormat::PostgresArchive => args.extend(["--exit-on-error".into(), "--no-owner".into(), "--no-privileges".into()]), DumpFormat::Sql | DumpFormat::SqlGzip => args.extend(["--no-psqlrc".into(), "--set=ON_ERROR_STOP=1".into()]) }
    args
}
async fn dump_tool(engine: DbEngine) -> Result<(String, String)> {
    let candidates: &[&str] = if engine == DbEngine::Postgres { &["pg_dump"] } else { &["mariadb-dump", "mysqldump"] };
    for tool in candidates { if let Ok(version) = tool_version(tool).await { return Ok((tool.to_string(), version)); } }
    Err(Error::Other(format!("Native client missing. Install {} manually on this computer and make it available on PATH. Rookery does not install tools.", candidates.join(" or "))))
}
async fn tool_version(tool: &str) -> Result<String> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let child = Command::new(tool).arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn()?;
        let mut reaper = ReapChild(Some(child));
        let child = reaper.0.as_mut().unwrap();
        let version = bounded_output(child.stdout.take().unwrap(), 512).await?;
        if !child.wait().await?.success() { return Err(Error::Other(format!("{tool} --version failed"))); }
        reaper.0.take();
        Ok(String::from_utf8_lossy(&version).trim().to_string())
    }).await.map_err(|_| Error::Other(format!("{tool} version check timed out")))?
}
async fn bounded_output<R: AsyncRead + Unpin>(mut stream: R, cap: usize) -> Result<Vec<u8>> {
    let mut output = Vec::new(); let mut buf = [0; 4096];
    loop { let n = stream.read(&mut buf).await?; if n == 0 { break; } let keep = (cap - output.len()).min(n); output.extend_from_slice(&buf[..keep]); }
    Ok(output)
}
#[derive(Default)]
struct DiagnosticLines { pending: Vec<u8>, oversized: bool, sql_continuation: bool }
impl DiagnosticLines {
    fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        let mut lines = Vec::new();
        for &byte in chunk {
            if byte == b'\n' {
                if !self.oversized {
                    let line = std::mem::take(&mut self.pending);
                    if self.accept(&line) { lines.push(line); }
                }
                self.pending.clear(); self.oversized = false;
            } else if self.pending.len() < 8192 && !self.oversized { self.pending.push(byte); }
            else { self.pending.clear(); self.oversized = true; }
        }
        lines
    }
    fn accept(&mut self, line: &[u8]) -> bool {
        let lower = String::from_utf8_lossy(line).trim_start().to_ascii_lowercase();
        if lower.starts_with("rookery_") || lower.starts_with("pg_dump:") || lower.starts_with("mysqldump:") || lower.starts_with("mariadb-dump:") || lower.starts_with("error") { self.sql_continuation = false; }
        if self.sql_continuation { return false; }
        if lower.contains("command was:") || lower.starts_with("query:") || lower.starts_with("statement:") { self.sql_continuation = true; }
        true
    }
    fn finish(&mut self) -> Vec<Vec<u8>> {
        if self.oversized || self.pending.is_empty() { self.pending.clear(); vec![] }
        else { let line = std::mem::take(&mut self.pending); if self.accept(&line) { vec![line] } else { vec![] } }
    }
}
fn import_diagnostic(text: &str) -> String {
    let mut output = String::new(); let mut quote = None; let mut escaped = false;
    for character in text.chars() {
        if let Some(delimiter) = quote {
            if escaped { escaped = false; }
            else if character == '\\' { escaped = true; }
            else if character == delimiter { output.push(character); quote = None; }
        } else if matches!(character, '\'' | '"' | '`') {
            output.push(character); output.push_str("[redacted]"); quote = Some(character);
        } else { output.push(character); }
    }
    output
}
fn bound_log(log: &mut Vec<String>) {
    let mut bytes: usize = log.iter().map(String::len).sum();
    while log.len() > 100 || bytes > 32 * 1024 {
        bytes -= log.remove(0).len();
    }
}
fn safe_diagnostic(bytes: &[u8], password: Option<&str>) -> String {
    let bytes = if bytes.len() >= 8192 && !bytes.ends_with(b"\n") { &bytes[..bytes.iter().rposition(|byte| *byte == b'\n').map(|i| i + 1).unwrap_or(0)] } else { bytes };
    let text = String::from_utf8_lossy(bytes).replace(|c: char| c.is_control() && c != '\n' && c != '\t', "");
    let text = match password.filter(|p| !p.is_empty()) { Some(pw) => text.replace(pw, "[redacted]"), None => text };
    let mut output = Vec::new();
    let mut sql_continuation = false;
    for line in text.lines() {
        let mut line = line.to_string();
        let lower = line.to_ascii_lowercase();
        if sql_continuation { continue; }
        if lower.contains("command was:") || lower.trim_start().starts_with("query:") || lower.trim_start().starts_with("statement:") { sql_continuation = true; }
        if ["detail:", "context:", "query:", "statement:", "line "].iter().any(|prefix| lower.trim_start().starts_with(prefix)) {
            line = "[SQL/data diagnostic omitted]".into();
        } else {
            let sensitive = ["password=", "password:", "password =", "--password ", "password '", "password \"", "passwd=", "pwd=", "postgresql://", "postgres://", "mysql://", "mariadb://", "select ", "insert ", "update ", "delete ", "copy ", "values ", "key (", "failing row contains", "near '", "near \"", "command was:", "create ", "alter ", "drop ", "truncate ", "grant ", "revoke "];
            let value_start = if lower.contains("duplicate entry") || lower.contains("invalid input syntax for type") {
                line.char_indices().find(|(_, c)| *c == '\'' || *c == '"').map(|(i, _)| i)
            } else { None };
            if let Some(index) = sensitive.iter().filter_map(|pattern| lower.find(pattern)).chain(value_start).min() { line.truncate(index); line.push_str("[redacted]"); }
        }
        if line.len() > 2048 { let end = line.char_indices().map(|(i, _)| i).take_while(|i| *i <= 2048).last().unwrap_or(0); line.truncate(end); line.push_str("…"); }
        if output.iter().map(String::len).sum::<usize>() + line.len() > 8192 { break; }
        output.push(line);
    }
    output.join("\n")
}
struct WorkDir(PathBuf);
impl WorkDir {
    async fn new(root: &Path, id: &str) -> Result<Self> {
        tokio::fs::create_dir_all(root).await?; let path = root.join(id); tokio::fs::create_dir(&path).await?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).await?; }
        Ok(Self(path))
    }
}
impl Drop for WorkDir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
struct LocalFile(PathBuf);
impl Drop for LocalFile { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }
async fn private_file(path: &Path) -> Result<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { options.mode(0o600); }
    Ok(options.open(path).await?)
}
struct AuthFile(PathBuf);
impl AuthFile {
    async fn new(work: &WorkDir, p: &ConnParams) -> Result<Self> {
        let path = work.0.join("auth"); let password = p.password.as_deref().map(|p| p.as_str()).unwrap_or("");
        if p.host.contains(['\0', '\n', '\r']) || p.database.as_deref().unwrap_or_default().contains(['\0', '\n', '\r']) || password.contains(['\0', '\n', '\r']) || p.user.contains(['\0', '\n', '\r']) { return Err(Error::Other("Native client authentication does not support line breaks or NUL in credentials".into())); }
        let contents = if p.engine == DbEngine::Postgres {
            let escape = |s: &str| s.replace('\\', "\\\\").replace(':', "\\:");
            format!("{}:{}:{}:{}:{}\n", escape(&p.host), p.port, escape(p.database.as_deref().unwrap_or("*")), escape(&p.user), escape(password))
        } else { format!("[client]\npassword=\"{}\"\n", password.replace('\\', "\\\\").replace('"', "\\\"")) };
        let contents = zeroize::Zeroizing::new(contents);
        let mut file = private_file(&path).await?; file.write_all(contents.as_bytes()).await?; file.flush().await?;
        Ok(Self(path))
    }
}
fn native_command(tool: &str, args: &[String], p: &ConnParams, auth: &AuthFile) -> Command {
    let mut cmd = Command::new(tool);
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name.starts_with("PG") || name.starts_with("MYSQL") || name.starts_with("MARIADB") { cmd.env_remove(&key); }
    }
    if p.engine == DbEngine::Postgres {
        cmd.env("PGPASSFILE", &auth.0).env("PGSSLMODE", match p.ssl_mode { SslMode::Disable => "disable", SslMode::Prefer => "prefer", SslMode::Require => "require", SslMode::VerifyFull => "verify-full" });
        if let Some(ca) = &p.ca_path { cmd.env("PGSSLROOTCERT", ca); }
    } else {
        cmd.arg(format!("--defaults-file={}", auth.0.display()));
        if tool.starts_with("mariadb") {
            if p.ssl_mode == SslMode::Disable { cmd.arg("--skip-ssl"); }
            else {
                cmd.arg("--ssl");
                cmd.arg(if matches!(p.ssl_mode, SslMode::Require | SslMode::VerifyFull) { "--ssl-verify-server-cert" } else { "--skip-ssl-verify-server-cert" });
            }
        } else {
            cmd.env("MYSQL_TEST_LOGIN_FILE", auth.0.with_file_name("unused-login-path"));
            cmd.arg(format!("--ssl-mode={}", match p.ssl_mode { SslMode::Disable => "DISABLED", SslMode::Prefer => "PREFERRED", SslMode::Require => "REQUIRED", SslMode::VerifyFull => "VERIFY_IDENTITY" }));
        }
        if let Some(ca) = &p.ca_path { cmd.arg(format!("--ssl-ca={ca}")); }
    }
    cmd.args(args);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_assemble_split_secrets_and_drop_entire_oversized_lines() {
        let mut lines = DiagnosticLines::default();
        assert!(lines.push(b"pg_dump: test-sec").is_empty());
        let complete = lines.push(b"ret authentication failed\n");
        let redacted = safe_diagnostic(&complete[0], Some("test-secret"));
        assert!(!redacted.contains("test-secret"));
        assert!(redacted.contains("authentication failed"));
        assert!(lines.push(&vec![b'x'; 8193]).is_empty());
        assert!(lines.push(b"secret-tail\n").is_empty());
        assert_eq!(lines.push(b"last"), Vec::<Vec<u8>>::new());
        assert_eq!(lines.finish(), vec![b"last".to_vec()]);
        assert!(lines.finish().is_empty());
        assert!(!safe_diagnostic(b"INSERT INTO users VALUES ('private-value'); password=test-secret", None).contains("private-value"));
        assert!(safe_diagnostic(b"mysqldump: unknown variable 'column-statistics=0'", None).contains("column-statistics=0"));
        assert!(safe_diagnostic(b"ERROR 1142: SHOW VIEW command denied to user", None).contains("ERROR 1142"));
        assert!(safe_diagnostic(b"ERROR: invalid input syntax for type integer: \"private\"", None).contains("invalid input syntax for type integer"));
        let mut sql_lines = DiagnosticLines::default();
        assert_eq!(sql_lines.push(b"pg_dump: error: Command was: CREATE TABLE users (\nprivate-value text\n);\nROOKERY_PASS:2\n").len(), 2);
        for raw in ["password=unknown-value", "postgresql://user:unknown-value@host/db", "DETAIL: Key (email)=(private-value) already exists", "CONTEXT: COPY users, line 1: private-value", "ERROR 1062 (23000) at line 42: Duplicate entry 'private-value' for key 'users.email'", "ERROR: invalid input syntax for type integer: \"private-value\"", "ERROR 1064: syntax error near 'CREATE TABLE private-value'", "Command was: CREATE TABLE users (\nprivate-value text\n);"] {
            let safe = safe_diagnostic(raw.as_bytes(), None);
            assert!(!safe.contains("unknown-value")); assert!(!safe.contains("private-value"));
        }

    }
    #[test]
    fn import_errors_keep_codes_and_headers_without_quoted_row_values() {
        for diagnostic in ["ERROR 1366: Incorrect integer value: 'private-value' for column 'age'", "ERROR 1292: Incorrect datetime value: 'private-value'", "ERROR: invalid input syntax for type integer: \"private-value\"", "ERROR 1064: syntax error near 'private-value'", "ERROR 1265: Data truncated: 'private-value'"] {
            let safe = import_diagnostic(&safe_diagnostic(diagnostic.as_bytes(), None));
            assert!(safe.starts_with("ERROR")); assert!(!safe.contains("private-value"));
        }
    }
    #[tokio::test]
    async fn server_output_reports_real_stages_and_bounded_safe_diagnostics() {
        let tmp = tempfile::tempdir().unwrap(); let core = crate::Core::init(tmp.path()).unwrap();
        let mut job = job(); let started = Instant::now(); let mut last = started - Duration::from_millis(150); let mut pending = false;
        core.database_files.emit(&mut job);
        core.database_files.server_output(&mut job, started, vec![b"ROOKERY_PASS:1".to_vec()], Some("test-secret"), &mut last, &mut pending);
        assert!(core.database_files.status()[0].stage.contains("pass 1"));
        for i in 0..1000 {
            let message = if i % 2 == 0 { b"Access denied test-secret".to_vec() } else { b"INSERT INTO users VALUES ('private-value')".to_vec() };
            core.database_files.server_output(&mut job, started, vec![message], Some("test-secret"), &mut last, &mut pending);
        }
        assert!(job.log.len() <= 100);
        assert!(core.database_files.status()[0].log.join("\n").contains("Access denied"));
        assert!(job.log.iter().map(String::len).sum::<usize>() <= 32 * 1024);
        assert!(!job.log.join("\n").contains("test-secret"));
        assert!(!job.log.join("\n").contains("private-value"));
        core.database_files.server_output(&mut job, started, vec![b"ROOKERY_STAGE:Verifying server dump checksum".to_vec()], None, &mut last, &mut pending);
        assert_eq!(core.database_files.status()[0].stage, "Verifying server dump checksum");
    }
    fn params(engine: DbEngine) -> ConnParams {
        ConnParams { engine, host: "127.0.0.1".into(), port: if engine == DbEngine::Postgres { 5432 } else { 3306 }, user: "test-user".into(), password: Some(zeroize::Zeroizing::new("test-secret".into())), database: Some("shop".into()), ssl_mode: SslMode::Disable, ca_path: None, timeout_s: 5, row_limit: 500, read_only: false }
    }
    fn tables() -> Vec<TableSelection> {
        vec![TableSelection { schema: "shop".into(), name: "users".into(), mode: TableMode::Data }, TableSelection { schema: "shop".into(), name: "audit".into(), mode: TableMode::Structure }, TableSelection { schema: "shop".into(), name: "excluded".into(), mode: TableMode::Exclude }]
    }
    fn job() -> DatabaseJob {
        DatabaseJob { id: new_id(), session_id: "fixture".into(), state: "running".into(), stage: "Fixture".into(), started_at: now_ms(), bytes: 0, total: None, elapsed_ms: 0, error: None, log: vec![] }
    }
    async fn context() -> NativeContext {
        NativeContext { params: params(DbEngine::Postgres), host_id: None, production: false, conn_key: "fixture".into(), stop: watch::channel(false).1, _guard: Arc::new(tokio::sync::Mutex::new(())).lock_owned().await }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn server_script_streams_dump_and_publishes_without_replacing_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let executable = tmp.path().join("fake-dump");
        tokio::fs::write(&executable, b"#!/bin/sh\nprintf 'fixture dump'\n").await.unwrap();
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).await.unwrap();
        let remote = tmp.path().join("private ' staging");
        let target = tmp.path().join("backup ' $(touch injected).dump");
        tokio::fs::create_dir(&remote).await.unwrap();
        let file = DatabaseFile::Server { path: target.to_string_lossy().into() };
        let script = server_dump_script(&params(DbEngine::Postgres), &tables(), "pg_dump", remote.to_str().unwrap(), &file).unwrap()
            .replace("'pg_dump'", &crate::terminal::shell_quote(executable.to_str().unwrap()));
        assert!(script.contains("ln -T --"));
        assert!(script.contains("--verbose"));
        let script = script.replace("ln -T --", "python3 -c 'import os,sys; os.link(sys.argv[1],sys.argv[2])'");
        assert!(!script.contains("test-secret"));
        let run = async || {
            let mut child = Command::new("sh").arg("-c").arg(&script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
            child.stdin.take().unwrap().write_all(b"private credentials\n").await.unwrap();
            child.wait_with_output().await.unwrap()
        };
        let result = run().await;
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"fixture dump");
        assert!(String::from_utf8_lossy(&result.stdout).trim_start().starts_with("12 "));
        assert!(!String::from_utf8_lossy(&result.stdout).contains("ROOKERY_"));
        assert!(String::from_utf8_lossy(&result.stderr).contains("ROOKERY_PASS:1"));
        assert!(String::from_utf8_lossy(&result.stderr).contains("Verifying server dump checksum"));
        assert!(!remote.join("auth").exists()); assert!(!remote.join("pid").exists());
        assert!(!run().await.status.success());
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"fixture dump");
        tokio::fs::remove_file(&target).await.unwrap();
        tokio::fs::create_dir(&target).await.unwrap();
        assert!(!run().await.status.success());
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_server_script_stops_dump_and_hash_before_publication() {
        use std::os::unix::fs::PermissionsExt;
        for (hash_stage, gzip) in [(false, false), (true, false), (false, true), (true, true)] {
            let tmp = tempfile::tempdir().unwrap(); let remote = tmp.path().join("private");
            tokio::fs::create_dir(&remote).await.unwrap();
            let blocker = tmp.path().join("blocker"); let marker = tmp.path().join("child-pid");
            tokio::fs::write(&blocker, format!("#!/bin/sh\necho $$ > {}\nexec sleep 60\n", crate::terminal::shell_quote(marker.to_str().unwrap()))).await.unwrap();
            tokio::fs::set_permissions(&blocker, std::fs::Permissions::from_mode(0o700)).await.unwrap();
            let target = tmp.path().join("target");
            let script = server_dump_script_compression(&params(DbEngine::Postgres), &tables(), "pg_dump", remote.to_str().unwrap(), &DatabaseFile::Server { path: target.to_string_lossy().into() }, gzip).unwrap();
            let script = if hash_stage { script.replace("'pg_dump'", "'/bin/echo'").replace("sha256sum", &crate::terminal::shell_quote(blocker.to_str().unwrap())) }
                else { script.replace("'pg_dump'", &crate::terminal::shell_quote(blocker.to_str().unwrap())) };
            let mut shell = Command::new("sh").args(["-c", &script]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
            shell.stdin.take().unwrap().write_all(b"credentials\n").await.unwrap();
            for _ in 0..200 { if marker.exists() { break; } tokio::time::sleep(Duration::from_millis(10)).await; }
            assert!(marker.exists(), "fixture did not reach blocking stage");
            let child = tokio::fs::read_to_string(&marker).await.unwrap();
            Command::new("kill").args(["-TERM", &shell.id().unwrap().to_string()]).status().await.unwrap();
            assert!(!tokio::time::timeout(Duration::from_secs(3), shell.wait()).await.unwrap().unwrap().success());
            assert!(!target.exists()); assert!(!remote.join("auth").exists()); assert!(!remote.join("pid").exists());
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert!(!Command::new("sh").args(["-c", "kill -0 \"$1\" 2>/dev/null", "fixture", child.trim()]).status().await.unwrap().success());
        }
    }
    #[test]
    fn postgres_exact_identifiers_and_literal_database_uri() {
        let mut p = params(DbEngine::Postgres);
        p.user = "user:%2F@=?#".into(); p.database = Some("a%2Fb/c?d#e=@".into());
        let uri = url::Url::parse(&pg_database(&p)).unwrap();
        assert_eq!(percent_encoding::percent_decode_str(uri.username()).decode_utf8().unwrap(), p.user);
        assert_eq!(percent_encoding::percent_decode_str(uri.path().trim_start_matches('/')).decode_utf8().unwrap(), p.database.as_deref().unwrap());
        assert!(uri.password().is_none()); assert_eq!(uri.host_str(), Some("127.0.0.1"));
        assert_eq!(pg_pattern("schema.*", "a\"b%?"), "\"schema.*\".\"a\"\"b%?\"");
        let selected = tables();
        let args = dump_arguments(&p, &selected, "pg_dump").unwrap();
        assert!(args[0].windows(2).any(|w| w == ["--table", "\"shop\".\"users\""]));
        assert!(args[0].windows(2).any(|w| w == ["--exclude-table-data", "\"shop\".\"audit\""]));
    }
    #[test]
    fn full_postgres_export_retains_dependencies_and_structure_only_excludes_all_data() {
        let p = params(DbEngine::Postgres);
        let selected: Vec<_> = tables().into_iter().map(|mut t| { t.mode = TableMode::Data; t }).collect();
        let args = dump_arguments(&p, &selected, "pg_dump").unwrap();
        assert!(!args[0].contains(&"--table".into())); assert!(!args[0].contains(&"--schema-only".into()));
        let selected: Vec<_> = selected.into_iter().map(|mut t| { t.mode = TableMode::Structure; t }).collect();
        assert!(dump_arguments(&p, &selected, "pg_dump").unwrap()[0].contains(&"--schema-only".into()));
    }
    #[test]
    fn mixed_mysql_loads_data_before_all_selected_triggers_without_gtid_changes() {
        let p = params(DbEngine::Mysql);
        let args = dump_arguments(&p, &tables(), "mysqldump").unwrap();
        assert_eq!(args.len(), 3);
        assert!(args[0].contains(&"--no-data".into()) && args[0].contains(&"--skip-triggers".into()));
        assert!(args[0].contains(&"users".into()) && args[0].contains(&"audit".into()));
        assert!(args[1].contains(&"--no-create-info".into()) && args[1].contains(&"--skip-triggers".into()));
        assert!(args[1].contains(&"users".into()) && !args[1].contains(&"audit".into()));
        assert!(args[2].contains(&"--no-data".into()) && args[2].contains(&"--no-create-info".into()) && !args[2].contains(&"--skip-triggers".into()));
        assert!(args[2].contains(&"users".into()) && args[2].contains(&"audit".into()));
        for pass in &args { assert!(pass.contains(&"--set-gtid-purged=OFF".into())); assert!(!pass.contains(&"excluded".into())); }
        assert!(dump_arguments(&p, &tables(), "mariadb-dump").unwrap().iter().all(|args| !args.contains(&"--set-gtid-purged=OFF".into())));
    }
    #[test]
    fn empty_cross_database_and_repeated_selections_are_rejected() {
        assert!(validate_selection(&[], DbEngine::Mysql, "shop").is_err());
        assert!(validate_selection(&tables(), DbEngine::Mysql, "another").is_err());
        let mut repeated = tables(); repeated.push(repeated[0].clone());
        assert!(validate_selection(&repeated, DbEngine::Mysql, "shop").is_err());
        assert!(validate_file(&DatabaseFile::Server { path: "/backup.sql".into() }, false).is_err());
        assert!(validate_file(&DatabaseFile::Server { path: "~/backup.sql".into() }, true).is_err());
        assert!(crate::db::is_local_setting(INDEX));
    }
    #[tokio::test]
    async fn native_auth_is_private_escaped_and_absent_from_argv() {
        let tmp = tempfile::tempdir().unwrap(); let work = WorkDir::new(tmp.path(), "auth-test").await.unwrap();
        let mut p = params(DbEngine::Mysql); p.password = Some(zeroize::Zeroizing::new("quote\"and\\slash".into()));
        let auth = AuthFile::new(&work, &p).await.unwrap();
        assert_eq!(tokio::fs::read_to_string(&auth.0).await.unwrap(), "[client]\npassword=\"quote\\\"and\\\\slash\"\n");
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(&auth.0).unwrap().permissions().mode() & 0o777, 0o600); assert_eq!(std::fs::metadata(&work.0).unwrap().permissions().mode() & 0o777, 0o700); }
        let cmd = native_command("mysqldump", &["--host".into(), "127.0.0.1".into()], &p, &auth);
        let args: Vec<_> = cmd.as_std().get_args().map(|s| s.to_string_lossy().to_string()).collect();
        assert!(args[0].starts_with("--defaults-file=")); assert!(!args.join(" ").contains("quote"));
        assert!(cmd.as_std().get_envs().any(|(key, value)| key == "MYSQL_TEST_LOGIN_FILE" && value.is_some()));
        p.password = Some(zeroize::Zeroizing::new("line\nbreak".into()));
        assert!(AuthFile::new(&work, &p).await.is_err());
    }
    #[tokio::test]
    async fn publish_never_overwrites_existing_destination_and_removes_private_partial() {
        let tmp = tempfile::tempdir().unwrap(); let core = crate::Core::init(tmp.path()).unwrap();
        let work = WorkDir::new(tmp.path(), "publish-test").await.unwrap(); let source = work.0.join("dump"); let target = tmp.path().join("existing.dump");
        tokio::fs::write(&source, b"new dump").await.unwrap(); tokio::fs::write(&target, b"original").await.unwrap();
        let mut job = job(); let ctx = context().await;
        assert!(core.database_files.publish(&ctx, &source, &DatabaseFile::Local { path: target.to_string_lossy().into() }, &work, &mut job, Instant::now()).await.is_err());
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"original");
        assert!(!target.with_file_name(format!(".rookery-{}.part", job.id)).exists());
        assert!(core.database_files.records().unwrap().is_empty());
    }
    #[tokio::test]
    async fn changed_backup_is_refused_before_any_restore_client_is_started() {
        let tmp = tempfile::tempdir().unwrap(); let core = crate::Core::init(tmp.path()).unwrap();
        let work = WorkDir::new(tmp.path(), "checksum-test").await.unwrap(); let source = tmp.path().join("dump"); tokio::fs::write(&source, b"changed").await.unwrap();
        let mut ctx = context().await; let mut job = job();
        let record = DatabaseBackup { id: "known".into(), conn_key: "fixture".into(), database: "shop".into(), engine: DbEngine::Postgres, host_id: None, file: DatabaseFile::Local { path: source.to_string_lossy().into() }, format: DumpFormat::PostgresArchive, created_at: 0, bytes: 7, sha256: "wrong".into(), tool_version: "fixture".into(), tables: vec![], verification: "Not restored".into() };
        let error = core.database_files.perform(&mut ctx, DatabaseOperation::Restore { backup_id: "known".into() }, Some(record), &work, &mut job, Instant::now()).await.unwrap_err();
        assert!(error.to_string().contains("SHA-256")); assert_eq!(tokio::fs::read(source).await.unwrap(), b"changed");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn fake_native_export_and_import_stream_large_fixtures_without_editor_or_credentials() {
        let tmp = tempfile::tempdir().unwrap(); let core = crate::Core::init(tmp.path()).unwrap();
        let path = tmp.path().join("output"); let mut dst = private_file(&path).await.unwrap();
        let mut command = Command::new("sh"); command.args(["-c", "dd if=/dev/zero bs=65536 count=32 2>/dev/null; printf 'fixture notice' >&2"]);
        let mut job = job();
        core.database_files.process(command, None, Some(&mut dst), &mut job, Instant::now(), "Fixture export", Some("test-secret")).await.unwrap();
        dst.flush().await.unwrap(); drop(dst);
        assert_eq!(tokio::fs::metadata(&path).await.unwrap().len(), 2 * 1024 * 1024); assert_eq!(job.bytes, 2 * 1024 * 1024);
        let mut src = tokio::fs::File::open(&path).await.unwrap();
        let mut command = Command::new("sh"); command.args(["-c", "cat; printf 'fixture import notice' >&2"]);
        core.database_files.process(command, Some(&mut src), None, &mut job, Instant::now(), "Fixture import", Some("test-secret")).await.unwrap();
        assert_eq!(job.bytes, 2 * 1024 * 1024);
    }
    fn gzip_fixture(bytes: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(bytes).unwrap(); encoder.finish().unwrap()
    }
    #[test]
    fn gzip_export_format_keeps_old_requests_and_postgres_compatible() {
        let operation: DatabaseOperation = serde_json::from_str(r#"{"kind":"export","file":{"location":"local","path":"fixture.sql"},"tables":[]}"#).unwrap();
        let DatabaseOperation::Export { format, .. } = operation else { panic!() };
        assert!(matches!(validate_export_format(DbEngine::Mysql, format.as_ref()).unwrap(), DumpFormat::Sql));
        assert!(matches!(validate_export_format(DbEngine::Postgres, format.as_ref()).unwrap(), DumpFormat::PostgresArchive));
        assert!(validate_export_format(DbEngine::Postgres, Some(&DumpFormat::SqlGzip)).is_err());
        assert!(validate_export_path("backup.sql", &DumpFormat::SqlGzip).is_err());
        assert!(validate_export_path("backup.sql.gz", &DumpFormat::Sql).is_err());
        assert!(validate_export_path("backup.custom", &DumpFormat::SqlGzip).is_ok());
        assert!(validate_file(&DatabaseFile::Local { path: "fixture.zip".into() }, false).unwrap_err().to_string().contains("ZIP"));
    }
    #[tokio::test]
    async fn gzip_streaming_roundtrip_all_members_and_rejects_damage() {
        let tmp = tempfile::tempdir().unwrap(); let core = crate::Core::init(tmp.path()).unwrap(); let mut job = job();
        let data = vec![b'x'; CHUNK * 128];
        let mut compressed = Vec::new(); let mut encoder = Compress::new_gzip(Compression::fast(), 15);
        for input in [&data[..], b"second native pass".as_slice()] {
            core.database_files.gzip(&mut &input[..], &mut compressed, &mut encoder, &mut job, Instant::now(), "fixture").await.unwrap();
        }
        finish_gzip(&mut encoder, &mut compressed).await.unwrap();
        assert_eq!(&compressed[..2], &[0x1f, 0x8b]); assert!(compressed.len() < data.len() / 4);
        let mut expected = data; expected.extend_from_slice(b"second native pass");
        let mut decoded = Vec::new();
        core.database_files.gunzip(&mut compressed.as_slice(), &mut decoded, &mut job, Instant::now(), "fixture").await.unwrap();
        assert_eq!(decoded, expected);
        let mut members = gzip_fixture(b"first"); members.extend(gzip_fixture(b"")); members.extend(gzip_fixture(b"second"));
        let mut decoded = Vec::new();
        core.database_files.gunzip(&mut members.as_slice(), &mut decoded, &mut job, Instant::now(), "fixture").await.unwrap();
        assert_eq!(decoded, b"firstsecond");
        let mut bad_crc = members.clone(); let crc = bad_crc.len() - 8; bad_crc[crc] ^= 1;
        let mut trailing = members.clone(); trailing.extend_from_slice(b"junk");
        for invalid in [vec![], b"not gzip".to_vec(), bad_crc, members[..members.len()-1].to_vec(), trailing] {
            assert!(core.database_files.gunzip(&mut invalid.as_slice(), &mut tokio::io::sink(), &mut job, Instant::now(), "fixture").await.is_err());
        }
    }
    struct Fragmented<'a>(&'a [u8]);
    impl AsyncRead for Fragmented<'_> {
        fn poll_read(mut self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>, dst: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
            let n = self.0.len().min(dst.remaining()).min(7);
            dst.put_slice(&self.0[..n]); self.0 = &self.0[n..]; std::task::Poll::Ready(Ok(()))
        }
    }
    #[tokio::test]
    async fn gzip_fragmented_incompressible_headers_trailers_and_members() {
        let tmp = tempfile::tempdir().unwrap(); let core = crate::Core::init(tmp.path()).unwrap(); let mut job = job();
        let mut seed = 0x726f6f6bu32;
        let data: Vec<u8> = (0..CHUNK * 4 + 83).map(|_| { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; seed as u8 }).collect();
        let mut compressed = Vec::new(); let mut encoder = Compress::new_gzip(Compression::fast(), 15);
        core.database_files.gzip(&mut data.as_slice(), &mut compressed, &mut encoder, &mut job, Instant::now(), "fixture").await.unwrap();
        finish_gzip(&mut encoder, &mut compressed).await.unwrap(); assert!(compressed.len() > CHUNK * 4);
        compressed.extend(gzip_fixture(b"last member"));
        let mut decoded = Vec::new();
        core.database_files.gunzip(&mut Fragmented(&compressed), &mut decoded, &mut job, Instant::now(), "fixture").await.unwrap();
        assert_eq!(&decoded[..data.len()], data); assert_eq!(&decoded[data.len()..], b"last member");
        let mut corrupt_size = compressed.clone(); let end = corrupt_size.len() - 1; corrupt_size[end] ^= 1;
        assert!(core.database_files.gunzip(&mut Fragmented(&corrupt_size), &mut tokio::io::sink(), &mut job, Instant::now(), "fixture").await.is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn native_gzip_export_and_import_stream_into_child_and_check_status() {
        let tmp = tempfile::tempdir().unwrap(); let core = crate::Core::init(tmp.path()).unwrap(); let mut job = job();
        let path = tmp.path().join("only.sql.gz"); let mut dst = private_file(&path).await.unwrap();
        let mut compressor = Compress::new_gzip(Compression::fast(), 15);
        let mut command = Command::new("sh"); command.args(["-c", "dd if=/dev/zero bs=65536 count=32 2>/dev/null"]);
        core.database_files.process_stream(command, None, Some(&mut dst), Some(&mut compressor), false, &mut job, Instant::now(), "fixture", None).await.unwrap();
        finish_gzip(&mut compressor, &mut dst).await.unwrap(); dst.flush().await.unwrap(); drop(dst);
        assert!(tokio::fs::metadata(&path).await.unwrap().len() < CHUNK as u64);
        let restored = tmp.path().join("child-received");
        let mut command = Command::new("sh"); command.args(["-c", &format!("cat > {}", crate::terminal::shell_quote(restored.to_str().unwrap()))]);
        let mut src = tokio::fs::File::open(&path).await.unwrap();
        core.database_files.process_stream(command, Some(&mut src), None, None, true, &mut job, Instant::now(), "fixture", None).await.unwrap();
        assert_eq!(tokio::fs::metadata(restored).await.unwrap().len(), 2 * 1024 * 1024);
        let mut command = Command::new("sh"); command.args(["-c", "printf partial; exit 17"]);
        let mut dst = private_file(&tmp.path().join("failed.gz")).await.unwrap();
        let mut compressor = Compress::new_gzip(Compression::fast(), 15);
        let error = core.database_files.process_stream(command, None, Some(&mut dst), Some(&mut compressor), false, &mut job, Instant::now(), "fixture", None).await.unwrap_err();
        assert!(error.to_string().contains("Native client failed"));
    }
    #[tokio::test]
    async fn gzip_and_zip_format_mismatches_fail_before_native_client() {
        let tmp = tempfile::tempdir().unwrap(); let core = crate::Core::init(tmp.path()).unwrap();
        let work = WorkDir::new(tmp.path(), "formats").await.unwrap(); let path = work.0.join("input");
        let ctx = context().await; let mut job = job();
        for (bytes, format, message) in [(gzip_fixture(b"SELECT 1;"), DumpFormat::Sql, "Select Compressed SQL"), (b"SELECT 1;".to_vec(), DumpFormat::SqlGzip, "not gzip"), (b"PK\x03\x04archive".to_vec(), DumpFormat::Sql, "ZIP archives"), (vec![0x1f, 0x8b, 0, 0], DumpFormat::SqlGzip, "gzip SQL stream")] {
            tokio::fs::write(&path, bytes).await.unwrap();
            let error = core.database_files.restore(&ctx, &path, format, &work, &mut job, Instant::now()).await.unwrap_err().to_string();
            assert!(error.contains(message), "{error}");
            assert!(!work.0.join("auth").exists());
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn server_gzip_streams_only_compressed_output_and_checks_both_children() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap(); let remote = tmp.path().join("private"); tokio::fs::create_dir(&remote).await.unwrap();
        let tool = tmp.path().join("fake-dump"); tokio::fs::write(&tool, b"#!/bin/sh\nprintf 'fixture dump'\n").await.unwrap();
        tokio::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o700)).await.unwrap();
        let target = tmp.path().join("output.sql.gz");
        let script = server_dump_script_compression(&params(DbEngine::Mysql), &tables(), "mysqldump", remote.to_str().unwrap(), &DatabaseFile::Server { path: target.to_string_lossy().into() }, true).unwrap()
            .replace("'mysqldump'", &crate::terminal::shell_quote(tool.to_str().unwrap()))
            .replace("ln -T --", "python3 -c 'import os,sys; os.link(sys.argv[1],sys.argv[2])'");
        let run = async |script: &str| {
            let mut command = Command::new("sh"); command.args(["-c", script]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            let mut child = command.spawn().unwrap(); child.stdin.take().unwrap().write_all(b"secret").await.unwrap();
            tokio::time::timeout(Duration::from_secs(5), child.wait_with_output()).await.unwrap().unwrap()
        };
        let result = run(&script).await; assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        let bytes = tokio::fs::read(&target).await.unwrap(); assert_eq!(&bytes[..2], &[0x1f, 0x8b]);
        let mut decoded = String::new(); std::io::Read::read_to_string(&mut flate2::read::MultiGzDecoder::new(bytes.as_slice()), &mut decoded).unwrap();
        assert_eq!(decoded, "fixture dump".repeat(3));
        assert_eq!(String::from_utf8_lossy(&result.stdout).split_whitespace().nth(1).unwrap(), format!("{:x}", Sha256::digest(&bytes)));
        assert!(!remote.join("stream").exists()); assert!(!tmp.path().join("output.sql").exists());
        tokio::fs::remove_file(&target).await.unwrap();
        for broken in [script.replace("gzip -1 -c", "false"), script.replace(&crate::terminal::shell_quote(tool.to_str().unwrap()), "false")] {
            let result = run(&broken).await; assert!(!result.status.success()); assert!(!target.exists());
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn native_failure_bounds_diagnostics_and_redacts_password() {
        let tmp = tempfile::tempdir().unwrap(); let core = crate::Core::init(tmp.path()).unwrap(); let mut job = job();
        let path = tmp.path().join("output"); let mut dst = private_file(&path).await.unwrap();
        let mut command = Command::new("sh"); command.args(["-c", "printf 'test-secret failed ' >&2; dd if=/dev/zero bs=65536 count=4 >&2 2>/dev/null; exit 9"]);
        let error = tokio::time::timeout(Duration::from_secs(3), core.database_files.process(command, None, Some(&mut dst), &mut job, Instant::now(), "Fixture failure", Some("test-secret"))).await.unwrap().unwrap_err().to_string();
        assert!(error.contains("Native client failed")); assert!(!error.contains("test-secret")); assert!(error.len() < 9000);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn write_failure_kills_native_child_without_waiting_for_full_stdout() {
        let tmp = tempfile::tempdir().unwrap(); let core = crate::Core::init(tmp.path()).unwrap(); let mut job = job();
        let path = tmp.path().join("read-only"); tokio::fs::write(&path, b"original").await.unwrap(); let mut dst = tokio::fs::File::open(&path).await.unwrap();
        let mut command = Command::new("sh"); command.args(["-c", "while :; do printf 'fixture output'; done"]);
        assert!(tokio::time::timeout(Duration::from_secs(3), core.database_files.process(command, None, Some(&mut dst), &mut job, Instant::now(), "Fixture write failure", None)).await.unwrap().is_err());
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"original");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn aborting_process_future_kills_and_reaps_child() {
        let tmp = tempfile::tempdir().unwrap(); let core = crate::Core::init(tmp.path()).unwrap(); let manager = core.database_files.clone();
        let pidfile = tmp.path().join("pid"); let pidpath = pidfile.clone();
        let task = tokio::spawn(async move {
            let mut command = Command::new("sh"); command.args(["-c", "echo $$ > \"$1\"; exec sleep 60", "rookery-fixture"]).arg(&pidpath);
            let mut job = job(); let output = pidpath.with_file_name("output"); let mut dst = private_file(&output).await.unwrap();
            manager.process(command, None, Some(&mut dst), &mut job, Instant::now(), "Fixture cancel", None).await
        });
        for _ in 0..100 { if pidfile.exists() { break; } tokio::time::sleep(Duration::from_millis(10)).await; }
        let pid = tokio::fs::read_to_string(&pidfile).await.unwrap(); task.abort(); let _ = task.await;
        let mut alive = true;
        for _ in 0..100 {
            alive = Command::new("sh").args(["-c", "kill -0 \"$1\" 2>/dev/null", "rookery-fixture", pid.trim()]).status().await.unwrap().success();
            if !alive { break; } tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!alive, "cancelled native child was not reaped");
    }
}
