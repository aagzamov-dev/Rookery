//! "Download images": one `docker save` of the chosen images, written to a `.tar` (loadable with
//! `docker load -i`) or `.tar.gz` on this computer.
//!
//! Binary safety: the archive is docker's stdout and nothing else. On a server the command runs
//! without a pty and without `2>&1`, stderr arrives on its own SSH channel stream (sudo's own
//! messages go there too, `sudo -S -p ''` prints no prompt), so error text can never land in the
//! tar. Locally the Docker CLI's stdout is read as raw bytes. The first block is also checked to
//! be a tar header, which catches a login script that prints text to stdout. Gzip is done here,
//! so the server only sends the plain tar. The file is written as `.part` and renamed when whole.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc};
use ts_rs::TS;

use crate::db::Db;
use crate::images::{check_refs, sh_quote};
use crate::ssh::{BinChunk, ConnectionManager};
use crate::sudo::Sudo;
use crate::{new_id, CoreEvent, Error, Result};

pub const IMAGES_MAX: usize = 100;
/// `docker save` that sends nothing for this long is given up on (it normally starts at once).
const IDLE_MAX: Duration = Duration::from_secs(5 * 60);
const PROGRESS_EVERY: Duration = Duration::from_millis(400);
const STDERR_MAX: usize = 8192;

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ImageExportRequest {
    pub host_id: String,
    /// `repository:tag` or (untagged) short id, as in [`crate::images::DockerImage::reference`].
    pub refs: Vec<String>,
    /// Sum of the chosen images' sizes, for the progress bar (the real tar can be smaller:
    /// layers shared by several images are saved once).
    #[ts(type = "number")]
    pub expected_bytes: u64,
    /// `.tar`, `.tar.gz` or `.tgz` file chosen in a save dialog.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ImageExportJob {
    pub id: String,
    pub host_id: String,
    pub path: String,
    /// running | done | failed | cancelled
    pub state: String,
    /// Number of images chosen.
    pub total: u32,
    /// The images being saved (one `docker save` covers all of them).
    pub current: Option<String>,
    /// Archive bytes received from Docker so far (before compression).
    #[ts(type = "number")]
    pub bytes: u64,
    #[ts(type = "number")]
    pub expected_bytes: u64,
    /// Size of the finished file on disk (set when done; smaller than `bytes` when compressed).
    #[ts(type = "number")]
    pub file_bytes: u64,
    /// Written compressed (`.tar.gz`).
    pub gzip: bool,
    pub error: Option<String>,
}

pub struct ImageExports {
    db: Arc<Db>,
    conns: Arc<ConnectionManager>,
    sudo: Arc<Sudo>,
    events: broadcast::Sender<CoreEvent>,
    /// Running jobs: id → (cancel flag, target path).
    running: Mutex<HashMap<String, (Arc<AtomicBool>, String)>>,
}

impl ImageExports {
    pub fn new(db: Arc<Db>, conns: Arc<ConnectionManager>, sudo: Arc<Sudo>, events: broadcast::Sender<CoreEvent>) -> Self {
        Self { db, conns, sudo, events, running: Default::default() }
    }

    /// Check the request and start the export; progress comes as `CoreEvent::ImageExport`.
    pub fn start(self: &Arc<Self>, mut req: ImageExportRequest) -> Result<String> {
        req.refs = validate(&req)?;
        let id = new_id();
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut running = self.running.lock();
            if running.values().any(|(_, path)| *path == req.path) {
                return Err(Error::Other("Another download is already saving to this file. Choose a different name or wait for it.".into()));
            }
            running.insert(id.clone(), (cancel.clone(), req.path.clone()));
        }
        let this = self.clone();
        let job_id = id.clone();
        tokio::spawn(async move {
            let mut job = ImageExportJob {
                id: job_id.clone(),
                host_id: req.host_id.clone(),
                path: req.path.clone(),
                state: "running".into(),
                total: req.refs.len() as u32,
                current: Some(summary(&req.refs)),
                bytes: 0,
                expected_bytes: req.expected_bytes,
                file_bytes: 0,
                gzip: is_gzip(&req.path),
                error: None,
            };
            this.emit(&job);
            let part = part_path(Path::new(&req.path), &job_id);
            match this.run(&req, &part, &cancel, &mut job).await {
                Ok(()) if cancel.load(Ordering::SeqCst) => job.state = "cancelled".into(),
                Ok(()) => match std::fs::rename(&part, &req.path) {
                    Ok(()) => {
                        job.state = "done".into();
                        job.file_bytes = std::fs::metadata(&req.path).map(|m| m.len()).unwrap_or(0);
                    }
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
        if let Some((flag, _)) = self.running.lock().get(job_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    pub fn cancel_all(&self) {
        for (flag, _) in self.running.lock().values() {
            flag.store(true, Ordering::SeqCst);
        }
    }

    fn emit(&self, job: &ImageExportJob) {
        let _ = self.events.send(CoreEvent::ImageExport { job: job.clone() });
    }

    async fn run(&self, req: &ImageExportRequest, part: &Path, cancel: &AtomicBool, job: &mut ImageExportJob) -> Result<()> {
        let local = req.host_id == crate::computer::ID;
        // Fail early on a bad host / sudo state, before creating the file.
        let (lease, rx) = if local {
            let mut args = vec!["save".to_string()];
            args.extend(req.refs.iter().cloned());
            (None, crate::computer::docker_stream_bytes(args)?)
        } else {
            self.db.get_host(&req.host_id)?;
            let lease = self.conns.acquire(&req.host_id).await?;
            let h = lease.handle().await?;
            let args = save_args(&req.refs);
            let rx = self.sudo.stream_docker_binary(&h, &req.host_id, &args).await?;
            (Some(lease), rx)
        };
        let _hold = lease; // one session for the whole export
        let file = std::fs::File::create(part).map_err(|e| Error::Other(format!("cannot write {}: {e}", part.display())))?;
        let writer = Writer::new(file, job.gzip);
        let events = &self.events;
        let emit = |j: &ImageExportJob| {
            let _ = events.send(CoreEvent::ImageExport { job: j.clone() });
        };
        // sudo's own failure (a refusal also pauses auto sudo) gets its explanation.
        let explain = |stderr: &str| if local { Ok(()) } else { self.sudo.check_output(&req.host_id, stderr) };
        receive(rx, writer, cancel, job, &emit, &explain, IDLE_MAX).await.map(|_| ())
    }
}

/// Takes the docker output stream and writes it to the file. `Ok(false)` = cancelled (the caller
/// removes the file). `explain` may turn docker's stderr into a better error (sudo failures).
async fn receive(
    mut rx: mpsc::Receiver<BinChunk>,
    mut writer: Writer,
    cancel: &AtomicBool,
    job: &mut ImageExportJob,
    emit: &(dyn Fn(&ImageExportJob) + Sync),
    explain: &(dyn Fn(&str) -> Result<()> + Sync),
    idle_max: Duration,
) -> Result<bool> {
    let streamed = stream_into(&mut rx, &mut writer, cancel, job, emit, explain, idle_max).await;
    drop(rx); // stops the remote / local docker if it is still running
    match streamed {
        Ok(true) => writer.finish().await.map(|_| true),
        Ok(false) => {
            let _ = writer.finish().await;
            Ok(false)
        }
        Err(e) => {
            let _ = writer.finish().await;
            Err(e)
        }
    }
}

async fn stream_into(
    rx: &mut mpsc::Receiver<BinChunk>,
    writer: &mut Writer,
    cancel: &AtomicBool,
    job: &mut ImageExportJob,
    emit: &(dyn Fn(&ImageExportJob) + Sync),
    explain: &(dyn Fn(&str) -> Result<()> + Sync),
    idle_max: Duration,
) -> Result<bool> {
    let mut head: Vec<u8> = Vec::with_capacity(TAR_BLOCK);
    let mut checked = false;
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit = None;
    let mut last_data = Instant::now();
    let mut last_emit = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let chunk = match tokio::time::timeout(Duration::from_millis(100), rx.recv()).await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) if last_data.elapsed() > idle_max => {
                return Err(Error::Other("docker save sent nothing for 5 minutes; gave up".into()));
            }
            Err(_) => continue,
        };
        match chunk {
            BinChunk::Out(bytes) => {
                last_data = Instant::now();
                job.bytes += bytes.len() as u64;
                if checked {
                    writer.write(bytes).await?;
                } else {
                    head.extend_from_slice(&bytes);
                    if head.len() >= TAR_BLOCK {
                        check_tar_start(&head)?;
                        writer.write(std::mem::take(&mut head)).await?;
                        checked = true;
                    }
                }
                if last_emit.elapsed() > PROGRESS_EVERY {
                    last_emit = Instant::now();
                    emit(job);
                }
            }
            BinChunk::Err(bytes) => {
                let room = STDERR_MAX.saturating_sub(stderr.len());
                stderr.extend_from_slice(&bytes[..bytes.len().min(room)]);
            }
            BinChunk::Exit(code) => exit = code,
        }
    }
    let text = String::from_utf8_lossy(&stderr).into_owned();
    match exit {
        Some(0) if checked => Ok(true),
        Some(0) => Err(Error::Other(if head.is_empty() { "docker save returned no data".into() } else { not_a_tar(&head) })),
        code => {
            explain(&text)?;
            Err(Error::Other(save_error(&text, code)))
        }
    }
}

/// Writes the file on its own thread: gzip and disk writes never block a tokio worker, so the
/// reader of the SSH stream keeps draining (the session is shared with terminals and collectors).
struct Writer {
    tx: Option<mpsc::Sender<Vec<u8>>>,
    thread: Option<std::thread::JoinHandle<Result<()>>>,
}

impl Writer {
    fn new(file: std::fs::File, gzip: bool) -> Self {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(32);
        let thread = std::thread::spawn(move || {
            let mut sink = Sink::new(file, gzip);
            while let Some(bytes) = rx.blocking_recv() {
                sink.write_all(&bytes)?;
            }
            sink.finish()
        });
        Self { tx: Some(tx), thread: Some(thread) }
    }

    async fn write(&mut self, bytes: Vec<u8>) -> Result<()> {
        let sent = match &self.tx {
            Some(tx) => tx.send(bytes).await.is_ok(),
            None => false,
        };
        if sent { Ok(()) } else { self.finish_inner().await.and(Err(Error::Other("cannot write the file".into()))) }
    }

    /// Everything written and flushed (gzip trailer included).
    async fn finish(mut self) -> Result<()> {
        self.finish_inner().await
    }

    async fn finish_inner(&mut self) -> Result<()> {
        self.tx = None;
        match self.thread.take() {
            Some(t) => tokio::task::spawn_blocking(move || t.join())
                .await
                .map_err(|e| Error::Other(format!("file writer failed: {e}")))?
                .map_err(|_| Error::Other("file writer panicked".into()))?,
            None => Ok(()),
        }
    }
}

/// Where the shell command line for `docker save` is built: quoted even though validated.
fn save_args(refs: &[String]) -> String {
    let mut a = String::from("save");
    for r in refs {
        a.push(' ');
        a.push_str(&sh_quote(r));
    }
    a
}

fn save_error(stderr: &str, code: Option<u32>) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return match code {
            Some(c) => format!("docker save exited with {c}"),
            None => "the connection closed before the archive was complete".into(),
        };
    }
    let text = lines.join(" ");
    let text = text.strip_prefix("Error response from daemon: ").unwrap_or(&text);
    text.chars().take(400).collect()
}

const TAR_BLOCK: usize = 512;

/// A tar header has `ustar` at byte 257 (docker writes POSIX/PAX tars).
fn is_tar_start(head: &[u8]) -> bool {
    head.len() >= 262 && &head[257..262] == b"ustar"
}

fn check_tar_start(head: &[u8]) -> Result<()> {
    if is_tar_start(head) { Ok(()) } else { Err(Error::Other(not_a_tar(head))) }
}

fn not_a_tar(head: &[u8]) -> String {
    let first: String = String::from_utf8_lossy(head).lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().filter(|c| !c.is_control()).take(120).collect();
    format!("The server did not send an image archive (it sent: “{first}”). A login script that prints text can cause this.")
}

/// Plain or gzip file writer.
enum Sink {
    Plain(std::io::BufWriter<std::fs::File>),
    Gzip(Box<flate2::write::GzEncoder<std::io::BufWriter<std::fs::File>>>),
}

impl Sink {
    fn new(file: std::fs::File, gzip: bool) -> Self {
        let w = std::io::BufWriter::with_capacity(256 * 1024, file);
        if gzip { Sink::Gzip(Box::new(flate2::write::GzEncoder::new(w, flate2::Compression::new(6)))) } else { Sink::Plain(w) }
    }

    fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        match self {
            Sink::Plain(w) => w.write_all(bytes),
            Sink::Gzip(w) => w.write_all(bytes),
        }
        .map_err(|e| Error::Other(format!("cannot write the file: {e}")))
    }

    fn finish(self) -> Result<()> {
        match self {
            Sink::Plain(mut w) => w.flush(),
            Sink::Gzip(w) => w.finish().and_then(|mut inner| inner.flush()),
        }
        .map_err(|e| Error::Other(format!("cannot write the file: {e}")))
    }
}

fn is_gzip(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.ends_with(".gz") || p.ends_with(".tgz")
}

fn validate(req: &ImageExportRequest) -> Result<Vec<String>> {
    let refs = check_refs(&req.refs, IMAGES_MAX)?;
    let path = Path::new(&req.path);
    let lower = req.path.to_ascii_lowercase();
    if !path.is_absolute() || !(lower.ends_with(".tar") || lower.ends_with(".tar.gz") || lower.ends_with(".tgz")) {
        return Err(Error::Other("Choose where to save the .tar or .tar.gz file.".into()));
    }
    if !path.parent().is_some_and(Path::is_dir) {
        return Err(Error::Other("The folder for the file does not exist.".into()));
    }
    Ok(refs)
}

fn summary(refs: &[String]) -> String {
    match refs {
        [one] => one.clone(),
        [first, rest @ ..] => format!("{first} and {} more", rest.len()),
        [] => String::new(),
    }
}

/// `<file>.<job id>.part`: unique per job, so two exports never share a partial file.
fn part_path(path: &Path, job_id: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(format!(".{job_id}.part"));
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(path: &str, refs: &[&str]) -> ImageExportRequest {
        ImageExportRequest { host_id: "h".into(), refs: refs.iter().map(|s| s.to_string()).collect(), expected_bytes: 0, path: path.into() }
    }

    #[test]
    fn validates_requests() {
        let dir = tempfile::tempdir().unwrap();
        let p = |n: &str| dir.path().join(n).to_string_lossy().into_owned();
        assert_eq!(validate(&req(&p("a.tar"), &["nginx:1", "nginx:1", "b"])).unwrap(), vec!["nginx:1", "b"]);
        assert!(validate(&req(&p("a.TAR.GZ"), &["x"])).is_ok());
        assert!(validate(&req(&p("a.tgz"), &["x"])).is_ok());
        assert!(validate(&req(&p("a.zip"), &["x"])).is_err());
        assert!(validate(&req("relative.tar", &["x"])).is_err());
        assert!(validate(&req(&p("missing/a.tar"), &["x"])).is_err());
        assert!(validate(&req(&p("a.tar"), &[])).is_err());
        assert!(validate(&req(&p("a.tar"), &["x; rm -rf /"])).is_err());
        assert!(validate(&req(&p("a.tar"), &["--output=/etc/x"])).is_err());
        let many: Vec<String> = (0..=IMAGES_MAX).map(|i| format!("img{i}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert!(validate(&req(&p("a.tar"), &many)).is_err());
    }

    #[test]
    fn detects_tar_start_and_text_noise() {
        let mut block = vec![0u8; 512];
        block[..8].copy_from_slice(b"blobs/\0\0");
        block[257..263].copy_from_slice(b"ustar\0");
        assert!(is_tar_start(&block));
        assert!(check_tar_start(&block).is_ok());
        let banner = format!("Welcome to the server\n{}", " ".repeat(600));
        assert!(!is_tar_start(banner.as_bytes()));
        assert!(not_a_tar(banner.as_bytes()).contains("Welcome to the server"));
        assert!(!is_tar_start(b"short"));
    }

    #[test]
    fn save_command_is_quoted_and_error_text_is_readable() {
        assert_eq!(save_args(&["nginx:1.25".into(), "0123456789ab".into()]), "save nginx:1.25 0123456789ab");
        assert_eq!(save_error("Error response from daemon: reference does not exist\n", Some(1)), "reference does not exist");
        assert_eq!(save_error("", Some(125)), "docker save exited with 125");
        assert!(save_error("", None).contains("connection closed"));
    }

    #[test]
    fn gzip_and_names() {
        assert!(is_gzip("/x/a.tar.gz") && is_gzip("/x/a.TGZ") && !is_gzip("/x/a.tar"));
        assert_eq!(summary(&["a".into()]), "a");
        assert_eq!(summary(&["a".into(), "b".into(), "c".into()]), "a and 2 more");
        assert_eq!(part_path(Path::new("/x/a.tar"), "j1"), PathBuf::from("/x/a.tar.j1.part"));
    }

    #[test]
    fn sink_writes_plain_and_valid_gzip() {
        use std::io::Read;
        let dir = tempfile::tempdir().unwrap();
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        for gzip in [false, true] {
            let path = dir.path().join(if gzip { "a.tar.gz" } else { "a.tar" });
            let mut sink = Sink::new(std::fs::File::create(&path).unwrap(), gzip);
            for chunk in data.chunks(7000) {
                sink.write_all(chunk).unwrap();
            }
            sink.finish().unwrap();
            let raw = std::fs::read(&path).unwrap();
            let back = if gzip {
                let mut out = Vec::new();
                flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut out).unwrap();
                out
            } else {
                raw
            };
            assert_eq!(back, data);
        }
    }

    #[tokio::test]
    async fn an_unknown_server_fails_with_an_error_and_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::init(dir.path()).unwrap();
        let exports = Arc::new(ImageExports::new(core.db.clone(), core.connections.clone(), core.sudo.clone(), core.events.clone()));
        // Unknown server: fails before any file is created and reports a readable error.
        let target = dir.path().join("out.tar");
        let mut rx = core.subscribe_events();
        exports.start(req(&target.to_string_lossy(), &["nginx:1"])).unwrap();
        let last = loop {
            if let CoreEvent::ImageExport { job } = rx.recv().await.unwrap() {
                if job.state != "running" {
                    break job;
                }
            }
        };
        assert_eq!(last.state, "failed");
        assert!(last.error.is_some());
        assert!(!target.exists());
        assert!(std::fs::read_dir(dir.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".part")));
    }

    // ---- receive loop

    fn tar_bytes(extra: usize) -> Vec<u8> {
        let mut v = vec![0u8; 512 + extra];
        v[..6].copy_from_slice(b"blobs/");
        v[257..263].copy_from_slice(b"ustar\0");
        for (i, b) in v[512..].iter_mut().enumerate() {
            *b = (i % 253) as u8;
        }
        v
    }

    fn job(gzip: bool) -> ImageExportJob {
        ImageExportJob {
            id: "j".into(),
            host_id: "h".into(),
            path: "x".into(),
            state: "running".into(),
            total: 1,
            current: None,
            bytes: 0,
            expected_bytes: 0,
            file_bytes: 0,
            gzip,
            error: None,
        }
    }

    /// Feed `chunks` through `receive` into a file; returns (result, file contents).
    async fn feed(chunks: Vec<BinChunk>, gzip: bool, hold_open: bool, cancel: bool) -> (Result<bool>, Vec<u8>, ImageExportJob) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out");
        let (tx, rx) = mpsc::channel(64);
        for c in chunks {
            tx.send(c).await.unwrap();
        }
        let _keep = hold_open.then_some(tx); // otherwise the stream ends here
        let flag = AtomicBool::new(cancel);
        let mut j = job(gzip);
        let writer = Writer::new(std::fs::File::create(&path).unwrap(), gzip);
        let r = receive(rx, writer, &flag, &mut j, &|_| {}, &|_| Ok(()), Duration::from_secs(5)).await;
        (r, std::fs::read(&path).unwrap(), j)
    }

    #[tokio::test]
    async fn success_writes_the_bytes_exactly() {
        let data = tar_bytes(100_000);
        let chunks = data.chunks(7000).map(|c| BinChunk::Out(c.to_vec())).chain([BinChunk::Exit(Some(0))]).collect();
        let (r, file, j) = feed(chunks, false, false, false).await;
        assert!(r.unwrap());
        assert_eq!(file, data);
        assert_eq!(j.bytes, data.len() as u64);
    }

    #[tokio::test]
    async fn gzip_round_trips() {
        use std::io::Read;
        let data = tar_bytes(300_000);
        let chunks = data.chunks(32_768).map(|c| BinChunk::Out(c.to_vec())).chain([BinChunk::Exit(Some(0))]).collect();
        let (r, file, _) = feed(chunks, true, false, false).await;
        assert!(r.unwrap());
        let mut back = Vec::new();
        flate2::read::GzDecoder::new(&file[..]).read_to_end(&mut back).unwrap();
        assert_eq!(back, data);
    }

    #[tokio::test]
    async fn a_banner_instead_of_a_tar_is_rejected() {
        let banner = format!("Welcome to the server\n{}", " ".repeat(700)).into_bytes();
        let (r, _, _) = feed(vec![BinChunk::Out(banner), BinChunk::Exit(Some(0))], false, false, false).await;
        assert!(r.unwrap_err().to_string().contains("Welcome to the server"));
        // too short to even hold a header
        let (r, _, _) = feed(vec![BinChunk::Out(b"hi".to_vec()), BinChunk::Exit(Some(0))], false, false, false).await;
        assert!(r.is_err());
        let (r, _, _) = feed(vec![BinChunk::Exit(Some(0))], false, false, false).await;
        assert!(r.unwrap_err().to_string().contains("no data"));
    }

    #[tokio::test]
    async fn a_failed_docker_gives_its_stderr_as_the_error() {
        let chunks = vec![BinChunk::Err(b"Error response from daemon: reference does not exist\n".to_vec()), BinChunk::Exit(Some(1))];
        let (r, _, _) = feed(chunks, false, false, false).await;
        assert_eq!(r.unwrap_err().to_string(), "reference does not exist");
        // failure after data: stderr still wins, nothing is reported as success
        let chunks = vec![BinChunk::Out(tar_bytes(10)), BinChunk::Err(b"write error\n".to_vec()), BinChunk::Exit(Some(1))];
        let (r, _, _) = feed(chunks, false, false, false).await;
        assert_eq!(r.unwrap_err().to_string(), "write error");
    }

    #[tokio::test]
    async fn a_stream_without_exit_status_fails() {
        let (r, _, _) = feed(vec![BinChunk::Out(tar_bytes(1000))], false, false, false).await;
        assert!(r.unwrap_err().to_string().contains("connection closed"));
    }

    #[tokio::test]
    async fn cancel_stops_even_while_docker_is_silent() {
        let (r, _, _) = feed(vec![BinChunk::Out(tar_bytes(10))], false, true, true).await;
        assert!(!r.unwrap());
    }

    #[tokio::test]
    async fn a_silent_stream_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel::<BinChunk>(4);
        let flag = AtomicBool::new(false);
        let mut j = job(false);
        let writer = Writer::new(std::fs::File::create(dir.path().join("o")).unwrap(), false);
        let r = receive(rx, writer, &flag, &mut j, &|_| {}, &|_| Ok(()), Duration::from_millis(250)).await;
        drop(tx);
        assert!(r.unwrap_err().to_string().contains("nothing for"));
    }

    #[tokio::test]
    async fn sudo_explanations_replace_the_docker_message() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel(4);
        tx.send(BinChunk::Err(b"sudo: a password is required\n".to_vec())).await.unwrap();
        tx.send(BinChunk::Exit(Some(1))).await.unwrap();
        drop(tx);
        let flag = AtomicBool::new(false);
        let mut j = job(false);
        let writer = Writer::new(std::fs::File::create(dir.path().join("o")).unwrap(), false);
        let r = receive(rx, writer, &flag, &mut j, &|_| {}, &|t| Err(Error::Other(format!("explained: {t}"))), Duration::from_secs(1)).await;
        assert!(r.unwrap_err().to_string().starts_with("explained: sudo"));
    }
}
