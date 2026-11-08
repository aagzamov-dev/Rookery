//! "Download logs": `docker logs` of the chosen containers for a period, saved as one zip on
//! this computer (one `<container>.log` per container plus `manifest.txt`).
//!
//! Gentle on the server: containers are read one after another, never in parallel, and each
//! log streams straight into the zip, so neither side holds a whole log in memory. The zip is
//! written next to the target as `.part` and only renamed when complete.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::collectors::{valid_container_ref, valid_since};
use crate::db::Db;
use crate::ssh::{ConnectionManager, StreamChunk};
use crate::sudo::Sudo;
use crate::{new_id, CoreEvent, Error, Result};

/// Stop adding log text after this much (uncompressed), keeping the zip far below 4 GiB.
const TOTAL_MAX: u64 = 2 * 1024 * 1024 * 1024;
const CONTAINERS_MAX: usize = 200;
/// A container whose log sends nothing for this long is given up on. Long on purpose:
/// with `--since`, Docker reads the whole log file before the first matching line, which
/// takes minutes on multi-GB logs. Cancel still works at any time.
const IDLE_MAX: Duration = Duration::from_secs(15 * 60);
const PROGRESS_EVERY: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ExportContainer {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct LogExportRequest {
    pub host_id: String,
    pub containers: Vec<ExportContainer>,
    /// RFC 3339; `None` = from the start of what Docker keeps / until now.
    pub since: Option<String>,
    pub until: Option<String>,
    /// `docker logs --timestamps`.
    pub timestamps: bool,
    /// Zip file chosen in a save dialog.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct LogExportJob {
    pub id: String,
    pub host_id: String,
    pub path: String,
    /// running | done | failed | cancelled
    pub state: String,
    pub total: u32,
    pub done: u32,
    pub current: Option<String>,
    /// Log text read so far (before compression).
    #[ts(type = "number")]
    pub bytes: u64,
    pub error: Option<String>,
    /// Containers whose log could not be read (details are in manifest.txt).
    pub failed: Vec<String>,
}

pub struct LogExports {
    db: Arc<Db>,
    conns: Arc<ConnectionManager>,
    sudo: Arc<Sudo>,
    events: broadcast::Sender<CoreEvent>,
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl LogExports {
    pub fn new(db: Arc<Db>, conns: Arc<ConnectionManager>, sudo: Arc<Sudo>, events: broadcast::Sender<CoreEvent>) -> Self {
        Self { db, conns, sudo, events, running: Default::default() }
    }

    /// Check the request and start the export; progress comes as `CoreEvent::LogExport`.
    pub fn start(self: &Arc<Self>, req: LogExportRequest) -> Result<String> {
        validate(&req)?;
        let id = new_id();
        let cancel = Arc::new(AtomicBool::new(false));
        self.running.lock().insert(id.clone(), cancel.clone());
        let this = self.clone();
        let job_id = id.clone();
        tokio::spawn(async move {
            let mut job = LogExportJob {
                id: job_id.clone(),
                host_id: req.host_id.clone(),
                path: req.path.clone(),
                state: "running".into(),
                total: req.containers.len() as u32,
                done: 0,
                current: None,
                bytes: 0,
                error: None,
                failed: Vec::new(),
            };
            this.emit(&job);
            let part = part_path(Path::new(&req.path));
            let result = this.run(&req, &part, &cancel, &mut job).await;
            match result {
                Ok(()) if cancel.load(Ordering::SeqCst) => job.state = "cancelled".into(),
                Ok(()) => match std::fs::rename(&part, &req.path) {
                    Ok(()) => job.state = "done".into(),
                    Err(e) => {
                        job.state = "failed".into();
                        job.error = Some(format!("could not save {}: {e}", req.path));
                    }
                },
                Err(e) => {
                    job.state = "failed".into();
                    job.error = Some(e.to_string());
                }
            }
            if job.state != "done" {
                let _ = std::fs::remove_file(&part);
            }
            job.current = None;
            this.running.lock().remove(&job_id);
            this.emit(&job);
        });
        Ok(id)
    }

    pub fn cancel(&self, job_id: &str) {
        if let Some(flag) = self.running.lock().get(job_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    pub fn cancel_all(&self) {
        for flag in self.running.lock().values() {
            flag.store(true, Ordering::SeqCst);
        }
    }

    fn emit(&self, job: &LogExportJob) {
        let _ = self.events.send(CoreEvent::LogExport { job: job.clone() });
    }

    async fn run(&self, req: &LogExportRequest, part: &Path, cancel: &AtomicBool, job: &mut LogExportJob) -> Result<()> {
        let local = req.host_id == crate::computer::ID;
        let server = if local {
            "This computer".to_string()
        } else {
            let h = self.db.get_host(&req.host_id)?;
            format!("{} ({})", h.name, h.address)
        };
        // Hold the session for the whole export (one connection, reused per container).
        let lease = if local { None } else { Some(self.conns.acquire(&req.host_id).await?) };
        let file = std::fs::File::create(part).map_err(|e| Error::Other(format!("cannot write {}: {e}", part.display())))?;
        let mut zip = ZipWriter::new(std::io::BufWriter::with_capacity(256 * 1024, file));
        let mut rows: Vec<String> = Vec::new();
        let mut names = std::collections::HashSet::new();
        let mut stopped: Option<String> = None;
        for c in &req.containers {
            if let Some(why) = &stopped {
                rows.push(format!("{}\t-\t-\tskipped: {why}", label(c)));
                continue;
            }
            if cancel.load(Ordering::SeqCst) {
                return Ok(());
            }
            let file_name = unique_name(&mut names, c);
            job.current = Some(c.name.clone());
            self.emit(job);
            zip.start(&file_name)?;
            let before = job.bytes;
            let read = if let Some(lease) = &lease {
                self.read_remote(lease, req, c, cancel, job, &mut zip).await
            } else {
                read_local(req, c, cancel, job, &mut zip, &self.events).await
            };
            zip.finish_entry()?;
            let size = human(job.bytes - before);
            match read {
                Ok(Outcome::Complete) => rows.push(format!("{}\t{file_name}\t{size}\tok", label(c))),
                Ok(Outcome::Cancelled) => return Ok(()),
                Ok(Outcome::LimitReached) => {
                    rows.push(format!("{}\t{file_name}\t{size}\tcut short: the {} export limit was reached", label(c), human(TOTAL_MAX)));
                    stopped = Some("export limit reached".into());
                }
                Err(ReadError::Container(msg)) => {
                    rows.push(format!("{}\t{file_name}\t{size}\tfailed: {msg}", label(c)));
                    job.failed.push(c.name.clone());
                }
                // sudo refused / connection lost: the remaining containers would fail the same way.
                Err(ReadError::Fatal(e)) => return Err(e),
            }
            job.done += 1;
            self.emit(job);
        }
        let manifest = manifest(&server, req, &rows);
        zip.start("manifest.txt")?;
        zip.write(manifest.as_bytes())?;
        zip.finish_entry()?;
        zip.finish()?;
        Ok(())
    }

    async fn read_remote<W: Write>(
        &self,
        lease: &crate::ssh::Lease,
        req: &LogExportRequest,
        c: &ExportContainer,
        cancel: &AtomicBool,
        job: &mut LogExportJob,
        zip: &mut ZipWriter<W>,
    ) -> std::result::Result<Outcome, ReadError> {
        let h = lease.handle().await.map_err(ReadError::Fatal)?;
        // No pty: `docker logs` without -f ends by itself; stdin carries the sudo password.
        let mut rx = self.sudo.stream_docker(&h, &req.host_id, &logs_args(req, &c.id), false).await.map_err(ReadError::Fatal)?;
        let mut head: Vec<u8> = Vec::new();
        let mut last_data = Instant::now();
        let mut last_emit = Instant::now();
        let mut exit = None;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Ok(Outcome::Cancelled);
            }
            let chunk = match tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) if last_data.elapsed() > IDLE_MAX => {
                    return Err(ReadError::Container("no output for 15 minutes; gave up".into()));
                }
                Err(_) => continue,
            };
            match chunk {
                StreamChunk::Data(bytes) => {
                    last_data = Instant::now();
                    if head.len() < 1024 {
                        head.extend_from_slice(&bytes[..bytes.len().min(1024 - head.len())]);
                    }
                    let room = TOTAL_MAX.saturating_sub(job.bytes);
                    let take = (bytes.len() as u64).min(room) as usize;
                    zip.write(&bytes[..take]).map_err(ReadError::Fatal)?;
                    job.bytes += take as u64;
                    if take < bytes.len() {
                        return Ok(Outcome::LimitReached);
                    }
                    if last_emit.elapsed() > PROGRESS_EVERY {
                        last_emit = Instant::now();
                        self.emit(job);
                    }
                }
                StreamChunk::Exit(code) => exit = code,
            }
        }
        match exit {
            Some(0) => Ok(Outcome::Complete),
            code => {
                let text = String::from_utf8_lossy(&head);
                // sudo's own failure (a refusal also pauses auto sudo) stops the whole export.
                self.sudo.check_output(&req.host_id, &text).map_err(ReadError::Fatal)?;
                let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
                Err(ReadError::Container(match code {
                    Some(c) if first.is_empty() => format!("docker logs exited with {c}"),
                    Some(_) => first.chars().take(300).collect(),
                    None => "the connection closed before the log ended".into(),
                }))
            }
        }
    }
}

enum Outcome {
    Complete,
    Cancelled,
    LimitReached,
}

enum ReadError {
    /// This container only (shown in the manifest; the export goes on).
    Container(String),
    /// Stops the export.
    Fatal(Error),
}

/// This computer: the local Docker CLI, line by line.
async fn read_local<W: Write>(
    req: &LogExportRequest,
    c: &ExportContainer,
    cancel: &AtomicBool,
    job: &mut LogExportJob,
    zip: &mut ZipWriter<W>,
    events: &broadcast::Sender<CoreEvent>,
) -> std::result::Result<Outcome, ReadError> {
    let mut args = vec!["logs".to_string()];
    if req.timestamps {
        args.push("--timestamps".into());
    }
    for (flag, v) in [("--since", &req.since), ("--until", &req.until)] {
        if let Some(v) = v {
            args.extend([flag.to_string(), v.clone()]);
        }
    }
    args.push(c.id.clone());
    let mut outcome = Outcome::Complete;
    let mut last_emit = Instant::now();
    let stream = crate::computer::docker_stream(args, |lines| {
        let r = (|| {
            if cancel.load(Ordering::SeqCst) {
                outcome = Outcome::Cancelled;
                return Err(Error::Other("cancelled".into()));
            }
            for line in lines {
                let n = line.len() as u64 + 1;
                if job.bytes + n > TOTAL_MAX {
                    outcome = Outcome::LimitReached;
                    return Err(Error::Other("limit".into()));
                }
                zip.write(line.as_bytes())?;
                zip.write(b"\n")?;
                job.bytes += n;
            }
            if last_emit.elapsed() > PROGRESS_EVERY {
                last_emit = Instant::now();
                let _ = events.send(CoreEvent::LogExport { job: job.clone() });
            }
            Ok(())
        })();
        std::future::ready(r)
    });
    // Cancel must also work while Docker is silent (searching a big log for `--since`):
    // dropping the stream kills the local docker process (kill_on_drop).
    let watch_cancel = async {
        while !cancel.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    };
    let result = tokio::select! {
        r = stream => r,
        _ = watch_cancel => return Ok(Outcome::Cancelled),
    };
    match (result, outcome) {
        (_, Outcome::Cancelled) => Ok(Outcome::Cancelled),
        (_, Outcome::LimitReached) => Ok(Outcome::LimitReached),
        (Ok(()), o) => Ok(o),
        (Err(Error::Io(e)), _) => Err(ReadError::Fatal(Error::Io(e))),
        (Err(e), _) => Err(ReadError::Container(e.to_string())),
    }
}

fn validate(req: &LogExportRequest) -> Result<()> {
    if req.containers.is_empty() || req.containers.len() > CONTAINERS_MAX {
        return Err(Error::Other(format!("Choose 1 to {CONTAINERS_MAX} containers.")));
    }
    if req.containers.iter().any(|c| !valid_container_ref(&c.id)) {
        return Err(Error::Other("invalid container".into()));
    }
    for t in [&req.since, &req.until].into_iter().flatten() {
        if !valid_since(t) {
            return Err(Error::Other("invalid time range".into()));
        }
    }
    let path = Path::new(&req.path);
    if !path.is_absolute() || !req.path.to_ascii_lowercase().ends_with(".zip") {
        return Err(Error::Other("Choose where to save the .zip file.".into()));
    }
    if !path.parent().is_some_and(Path::is_dir) {
        return Err(Error::Other("The folder for the zip file does not exist.".into()));
    }
    Ok(())
}

fn logs_args(req: &LogExportRequest, id: &str) -> String {
    let mut a = String::from("logs");
    if req.timestamps {
        a.push_str(" --timestamps");
    }
    if let Some(s) = &req.since {
        a.push_str(&format!(" --since {s}"));
    }
    if let Some(u) = &req.until {
        a.push_str(&format!(" --until {u}"));
    }
    a.push(' ');
    a.push_str(id);
    a
}

fn part_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

/// `<name>.log`, unique within the zip; the name is kept to safe characters.
fn unique_name(used: &mut std::collections::HashSet<String>, c: &ExportContainer) -> String {
    let base = if valid_container_ref(&c.name) { c.name.clone() } else { c.id.chars().take(12).collect() };
    let mut name = format!("{base}.log");
    let mut n = 2;
    while !used.insert(name.clone()) {
        name = format!("{base}-{n}.log");
        n += 1;
    }
    name
}

fn label(c: &ExportContainer) -> String {
    format!("{} ({})", c.name, c.id.chars().take(12).collect::<String>())
}

fn human(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{bytes} B") } else { format!("{v:.1} {}", UNITS[i]) }
}

fn manifest(server: &str, req: &LogExportRequest, rows: &[String]) -> String {
    let now = time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default();
    let mut m = String::new();
    m.push_str("Rookery: Docker logs\n\n");
    m.push_str(&format!("Server:     {server}\n"));
    m.push_str(&format!("From:       {}\n", req.since.as_deref().unwrap_or("the oldest log Docker keeps")));
    m.push_str(&format!("Until:      {}\n", req.until.as_deref().unwrap_or("the time of export")));
    m.push_str(&format!("Exported:   {now}\n"));
    m.push_str(&format!("Timestamps: {}\n\n", if req.timestamps { "yes (RFC 3339, UTC)" } else { "no" }));
    m.push_str("Container\tFile\tSize\tResult\n");
    for r in rows {
        m.push_str(r);
        m.push('\n');
    }
    m.push_str("\nOnly what the container's log driver still keeps can be exported: rotated logs may be gone,\nand drivers that send logs elsewhere (syslog, fluentd, …) cannot be read with docker logs.\n");
    m
}

// ---------------------------------------------------------------- zip

/// Minimal streaming zip writer: deflate, data descriptors, UTF-8 names, no zip64
/// (the export stays below [`TOTAL_MAX`], far under the 4 GiB limit).
struct ZipWriter<W: Write> {
    out: W,
    offset: u64,
    entries: Vec<ZipEntry>,
    current: Option<Current>,
    buf: Vec<u8>,
}

struct ZipEntry {
    name: String,
    crc: u32,
    compressed: u32,
    size: u32,
    offset: u32,
}

struct Current {
    name: String,
    offset: u64,
    crc: flate2::Crc,
    z: flate2::Compress,
    compressed: u64,
}

const VERSION: u16 = 20;
/// Bit 3: sizes in a data descriptor; bit 11: UTF-8 name.
const FLAGS: u16 = 0x0808;

impl<W: Write> ZipWriter<W> {
    fn new(out: W) -> Self {
        Self { out, offset: 0, entries: Vec::new(), current: None, buf: Vec::with_capacity(64 * 1024) }
    }

    fn put(&mut self, bytes: &[u8]) -> Result<()> {
        self.out.write_all(bytes)?;
        self.offset += bytes.len() as u64;
        Ok(())
    }

    fn start(&mut self, name: &str) -> Result<()> {
        if self.current.is_some() {
            self.finish_entry()?;
        }
        let (time, date) = dos_now();
        let mut h = Vec::with_capacity(30 + name.len());
        h.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        h.extend_from_slice(&VERSION.to_le_bytes());
        h.extend_from_slice(&FLAGS.to_le_bytes());
        h.extend_from_slice(&8u16.to_le_bytes()); // deflate
        h.extend_from_slice(&time.to_le_bytes());
        h.extend_from_slice(&date.to_le_bytes());
        h.extend_from_slice(&[0; 12]); // crc, sizes: in the data descriptor
        h.extend_from_slice(&(name.len() as u16).to_le_bytes());
        h.extend_from_slice(&0u16.to_le_bytes());
        h.extend_from_slice(name.as_bytes());
        let offset = self.offset;
        self.put(&h)?;
        self.current = Some(Current {
            name: name.to_string(),
            offset,
            crc: flate2::Crc::new(),
            z: flate2::Compress::new(flate2::Compression::new(6), false),
            compressed: 0,
        });
        Ok(())
    }

    fn write(&mut self, data: &[u8]) -> Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        self.deflate(data, flate2::FlushCompress::None)
    }

    fn deflate(&mut self, mut input: &[u8], flush: flate2::FlushCompress) -> Result<()> {
        let cur = self.current.as_mut().ok_or_else(|| Error::Other("zip: no open entry".into()))?;
        cur.crc.update(input);
        loop {
            self.buf.clear();
            let before = cur.z.total_in();
            let status = cur
                .z
                .compress_vec(input, &mut self.buf, flush)
                .map_err(|e| Error::Other(format!("zip: {e}")))?;
            let used = (cur.z.total_in() - before) as usize;
            input = &input[used..];
            cur.compressed += self.buf.len() as u64;
            let produced = !self.buf.is_empty();
            self.out.write_all(&self.buf)?;
            self.offset += self.buf.len() as u64;
            let finishing = matches!(flush, flate2::FlushCompress::Finish);
            if finishing && status == flate2::Status::StreamEnd {
                return Ok(());
            }
            if !finishing && input.is_empty() {
                return Ok(());
            }
            if used == 0 && !produced && status == flate2::Status::BufError {
                return Err(Error::Other("zip: compressor made no progress".into()));
            }
        }
    }

    fn finish_entry(&mut self) -> Result<()> {
        if self.current.is_none() {
            return Ok(());
        }
        self.deflate(&[], flate2::FlushCompress::Finish)?;
        let cur = self.current.take().expect("checked above");
        let size = cur.z.total_in();
        let fits = |v: u64| u32::try_from(v).map_err(|_| Error::Other("zip: the export is too large".into()));
        let entry = ZipEntry {
            name: cur.name,
            crc: cur.crc.sum(),
            compressed: fits(cur.compressed)?,
            size: fits(size)?,
            offset: fits(cur.offset)?,
        };
        let mut d = Vec::with_capacity(16);
        d.extend_from_slice(&0x0807_4b50u32.to_le_bytes());
        d.extend_from_slice(&entry.crc.to_le_bytes());
        d.extend_from_slice(&entry.compressed.to_le_bytes());
        d.extend_from_slice(&entry.size.to_le_bytes());
        self.put(&d)?;
        self.entries.push(entry);
        Ok(())
    }

    fn finish(mut self) -> Result<()> {
        self.finish_entry()?;
        let (time, date) = dos_now();
        let cd_start = self.offset;
        let entries = std::mem::take(&mut self.entries);
        for e in &entries {
            let mut c = Vec::with_capacity(46 + e.name.len());
            c.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            c.extend_from_slice(&((3u16 << 8) | VERSION).to_le_bytes()); // made by: Unix
            c.extend_from_slice(&VERSION.to_le_bytes());
            c.extend_from_slice(&FLAGS.to_le_bytes());
            c.extend_from_slice(&8u16.to_le_bytes());
            c.extend_from_slice(&time.to_le_bytes());
            c.extend_from_slice(&date.to_le_bytes());
            c.extend_from_slice(&e.crc.to_le_bytes());
            c.extend_from_slice(&e.compressed.to_le_bytes());
            c.extend_from_slice(&e.size.to_le_bytes());
            c.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            c.extend_from_slice(&[0; 8]); // extra, comment, disk, internal attributes
            c.extend_from_slice(&(0o100644u32 << 16).to_le_bytes()); // -rw-r--r--
            c.extend_from_slice(&e.offset.to_le_bytes());
            c.extend_from_slice(e.name.as_bytes());
            self.put(&c)?;
        }
        let cd_size = self.offset - cd_start;
        let fits = |v: u64| u32::try_from(v).map_err(|_| Error::Other("zip: the export is too large".into()));
        let mut end = Vec::with_capacity(22);
        end.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        end.extend_from_slice(&[0; 4]); // disk numbers
        end.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        end.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        end.extend_from_slice(&fits(cd_size)?.to_le_bytes());
        end.extend_from_slice(&fits(cd_start)?.to_le_bytes());
        end.extend_from_slice(&0u16.to_le_bytes());
        self.put(&end)?;
        self.out.flush()?;
        Ok(())
    }
}

/// Local time as MS-DOS (time, date).
fn dos_now() -> (u16, u16) {
    let t = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    let time = ((t.hour() as u16) << 11) | ((t.minute() as u16) << 5) | (t.second() as u16 / 2);
    let date = (((t.year() - 1980).clamp(0, 127) as u16) << 9) | ((t.month() as u16) << 5) | t.day() as u16;
    (time, date)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn u16_at(b: &[u8], i: usize) -> u16 {
        u16::from_le_bytes([b[i], b[i + 1]])
    }
    fn u32_at(b: &[u8], i: usize) -> u32 {
        u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
    }

    /// Read every entry back through the central directory and inflate it.
    fn unzip(b: &[u8]) -> Vec<(String, Vec<u8>)> {
        let end = b.len() - 22;
        assert_eq!(u32_at(b, end), 0x0605_4b50);
        let count = u16_at(b, end + 10) as usize;
        let mut p = u32_at(b, end + 16) as usize;
        let mut out = Vec::new();
        for _ in 0..count {
            assert_eq!(u32_at(b, p), 0x0201_4b50);
            let crc = u32_at(b, p + 16);
            let csize = u32_at(b, p + 20) as usize;
            let size = u32_at(b, p + 24) as usize;
            let nlen = u16_at(b, p + 28) as usize;
            let off = u32_at(b, p + 42) as usize;
            let name = String::from_utf8(b[p + 46..p + 46 + nlen].to_vec()).unwrap();
            assert_eq!(u32_at(b, off), 0x0403_4b50);
            let data_at = off + 30 + u16_at(b, off + 26) as usize + u16_at(b, off + 28) as usize;
            let mut data = Vec::new();
            flate2::read::DeflateDecoder::new(&b[data_at..data_at + csize]).read_to_end(&mut data).unwrap();
            assert_eq!(data.len(), size);
            let mut c = flate2::Crc::new();
            c.update(&data);
            assert_eq!(c.sum(), crc);
            assert_eq!(u32_at(b, data_at + csize), 0x0807_4b50, "data descriptor follows the data");
            out.push((name, data));
            p += 46 + nlen;
        }
        out
    }

    #[test]
    fn zip_round_trips_streamed_entries() {
        let mut bytes = Vec::new();
        let mut z = ZipWriter::new(&mut bytes);
        z.start("web.log").unwrap();
        let big: Vec<u8> = (0..300_000u32).flat_map(|i| format!("2026-11-07T10:00:00Z line {i}\n").into_bytes()).collect();
        for chunk in big.chunks(7_000) {
            z.write(chunk).unwrap();
        }
        z.start("empty.log").unwrap();
        z.start("manifest.txt").unwrap();
        z.write("héllo\n".as_bytes()).unwrap();
        z.finish().unwrap();
        let files = unzip(&bytes);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].0, "web.log");
        assert_eq!(files[0].1, big);
        assert!(files[1].1.is_empty());
        assert_eq!(files[2].1, "héllo\n".as_bytes());
        assert!(bytes.len() < big.len() / 4, "log text compresses");
    }

    #[test]
    fn requests_are_checked_before_anything_runs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs.zip").to_string_lossy().into_owned();
        let ok = LogExportRequest {
            host_id: "h".into(),
            containers: vec![ExportContainer { id: "abc123".into(), name: "web".into() }],
            since: Some("2026-11-06T00:00:00Z".into()),
            until: None,
            timestamps: true,
            path: path.clone(),
        };
        assert!(validate(&ok).is_ok());
        let bad = |f: &dyn Fn(&mut LogExportRequest)| {
            let mut r = ok.clone();
            f(&mut r);
            validate(&r).is_err()
        };
        assert!(bad(&|r| r.containers.clear()));
        assert!(bad(&|r| r.containers[0].id = "$(reboot)".into()));
        assert!(bad(&|r| r.since = Some("now; rm -rf /".into())));
        assert!(bad(&|r| r.path = "logs.zip".into()));
        assert!(bad(&|r| r.path = dir.path().join("logs.txt").to_string_lossy().into_owned()));
        assert!(bad(&|r| r.path = dir.path().join("missing/logs.zip").to_string_lossy().into_owned()));
        assert_eq!(logs_args(&ok, "abc123"), "logs --timestamps --since 2026-11-06T00:00:00Z abc123");
    }

    #[test]
    fn file_names_are_safe_and_unique() {
        let mut used = std::collections::HashSet::new();
        let c = |name: &str| ExportContainer { id: "0123456789abcdef".into(), name: name.into() };
        assert_eq!(unique_name(&mut used, &c("web")), "web.log");
        assert_eq!(unique_name(&mut used, &c("web")), "web-2.log");
        assert_eq!(unique_name(&mut used, &c("../../etc/passwd")), "0123456789ab.log");
        assert_eq!(human(512), "512 B");
        assert_eq!(human(1536), "1.5 KB");
    }
}
