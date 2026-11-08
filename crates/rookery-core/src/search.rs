//! Search on a server (or this computer): file contents with `grep`, file names with `find`.
//!
//! - Runs at low priority (`nice`) and stops after a time limit (`timeout`), on a pty, so a
//!   cancelled or superseded search is killed on the server (SIGHUP), never left running.
//! - One search per host at a time: a new one cancels the previous (typing with debounce).
//! - Stops reading after `max_results` hits or [`OUTPUT_MAX`] bytes; long lines are cut.
//! - Only the search runs: the pattern and paths are always quoted, never interpreted.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;
use ts_rs::TS;

use crate::ssh::{exec_stream, ConnectionManager, StreamChunk};
use crate::terminal::shell_quote;
use crate::{Error, Result};

const TIME_LIMIT_S: u64 = 60;
const OUTPUT_MAX: usize = 16 * 1024 * 1024;
const LINE_MAX: usize = 400;
const RESULTS_MAX: u32 = 5000;
const WARNINGS_KEEP: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum SearchMode {
    /// Lines inside files (grep).
    Content,
    /// File or folder names (find).
    Names,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SearchRequest {
    pub host_id: String,
    /// Who asks ("search" tab, "quick" open): a new search replaces the previous one of the
    /// same host and slot only.
    pub slot: String,
    /// Absolute folder to search in.
    pub folder: String,
    pub query: String,
    pub mode: SearchMode,
    /// Content: extended regular expression instead of plain text.
    pub regex: bool,
    pub case_sensitive: bool,
    /// Content: whole words only.
    pub whole_word: bool,
    /// File name patterns to search (`*.php`); empty = all files.
    pub include: Vec<String>,
    /// File name patterns to skip.
    pub exclude: Vec<String>,
    /// Folder names to skip (`node_modules`, `.git`).
    pub exclude_dirs: Vec<String>,
    /// Look inside hidden files and folders (names starting with a dot).
    pub hidden: bool,
    /// Follow symbolic links to folders (may visit the same files twice).
    pub follow_links: bool,
    /// Names: find folders instead of files.
    pub folders: bool,
    /// Names: how many folder levels deep (None = no limit).
    pub max_depth: Option<u32>,
    pub max_results: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SearchHit {
    pub path: String,
    /// Content: 1-based line number.
    pub line: Option<u32>,
    /// Content: the line (cut at 400 characters).
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// Stopped at the result limit (there may be more).
    pub truncated: bool,
    /// Stopped by the time limit.
    pub timed_out: bool,
    /// A few of the messages grep/find printed (unreadable folders, bad patterns).
    pub warnings: Vec<String>,
    /// How many such messages there were.
    pub warning_count: u32,
}

fn check_list(list: &[String], what: &str) -> Result<()> {
    if list.len() > 50 || list.iter().any(|g| g.is_empty() || g.len() > 200 || g.contains(['\0', '\n', '\r', '/'])) {
        return Err(Error::Other(format!("{what}: up to 50 names or patterns, without slashes")));
    }
    Ok(())
}

pub fn validate(r: &SearchRequest) -> Result<()> {
    if r.query.trim().is_empty() || r.query.len() > 1000 || r.query.contains(['\0', '\n', '\r']) {
        return Err(Error::Other("Type what to search for (one line, up to 1000 characters).".into()));
    }
    let local = r.host_id == crate::computer::ID;
    if r.folder.is_empty() || r.folder.contains(['\0', '\n', '\r']) || (!local && !r.folder.starts_with('/')) {
        return Err(Error::Other("Choose a folder to search in (an absolute path).".into()));
    }
    check_list(&r.include, "Files to include")?;
    check_list(&r.exclude, "Files to exclude")?;
    check_list(&r.exclude_dirs, "Folders to exclude")?;
    if r.slot.is_empty() || r.slot.len() > 32 {
        return Err(Error::Other("invalid search slot".into()));
    }
    if r.max_results == 0 || r.max_results > RESULTS_MAX {
        return Err(Error::Other(format!("Results: between 1 and {RESULTS_MAX}.")));
    }
    if r.max_depth.is_some_and(|d| d == 0 || d > 100) {
        return Err(Error::Other("Depth: between 1 and 100.".into()));
    }
    Ok(())
}

/// A name query without wildcards matches anywhere in the name (`conf` → `*conf*`).
fn name_glob(query: &str) -> String {
    let q = query.trim();
    if q.contains(['*', '?', '[']) {
        q.to_string()
    } else {
        format!("*{q}*")
    }
}

/// `find` selecting what to search: skips excluded and (unless `hidden`) dot folders below the
/// start folder (never the start folder itself, even when its name starts with a dot).
/// `find -path` takes a pattern: a folder named `app[1]` must match itself literally.
fn path_pattern(p: &str) -> String {
    p.chars().fold(String::new(), |mut out, c| {
        if matches!(c, '*' | '?' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
        out
    })
}

fn find_expr(r: &SearchRequest, tests: Vec<String>) -> String {
    let folder = shell_quote(&r.folder);
    let start = shell_quote(&path_pattern(&r.folder));
    let mut prune: Vec<String> = r.exclude_dirs.iter().map(|d| format!("-name {}", shell_quote(d))).collect();
    if !r.hidden {
        prune.push("-name '.*'".into());
    }
    let prune = if prune.is_empty() {
        String::new()
    } else {
        format!("\\( -type d \\( {} \\) ! -path {start} \\) -prune -o ", prune.join(" -o "))
    };
    let depth = r.max_depth.map(|d| format!("-maxdepth {d} ")).unwrap_or_default();
    let follow = if r.follow_links { "-L " } else { "" };
    format!("find {follow}{folder} {depth}{prune}\\( {} \\) ! -path {start} -print0", tests.join(" "))
}

/// The shell command for `r` (already validated). Runs `nice`d under `timeout` when available;
/// the pattern and paths are quoted, never interpreted.
pub fn command(r: &SearchRequest) -> String {
    let mut files = vec![if r.mode == SearchMode::Names && r.folders { "-type d".to_string() } else { "-type f".to_string() }];
    if r.mode == SearchMode::Names {
        let name = if r.case_sensitive { "-name" } else { "-iname" };
        files.insert(0, format!("{name} {}", shell_quote(&name_glob(&r.query))));
    }
    if !(r.mode == SearchMode::Names && r.folders) {
        if !r.include.is_empty() {
            files.push(format!("\\( {} \\)", r.include.iter().map(|g| format!("-name {}", shell_quote(g))).collect::<Vec<_>>().join(" -o ")));
        }
        for g in &r.exclude {
            files.push(format!("! -name {}", shell_quote(g)));
        }
    }
    if !r.hidden {
        files.push("! -name '.*'".into());
    }
    let find = find_expr(r, files);
    let tool = match r.mode {
        SearchMode::Names => find,
        SearchMode::Content => {
            let mut a = vec!["-n", "-I", "-H", "--null", "--color=never", if r.regex { "-E" } else { "-F" }];
            if !r.case_sensitive {
                a.push("-i");
            }
            if r.whole_word {
                a.push("-w");
            }
            // xargs gives grep /dev/null as input and runs nothing when no file matched (-r).
            format!("{find} | xargs -0 -r grep {} -e {} --", a.join(" "), shell_quote(&r.query))
        }
    };
    format!(
        "export LC_ALL=C; T=; command -v timeout >/dev/null 2>&1 && T='timeout {TIME_LIMIT_S}'; N=; command -v nice >/dev/null 2>&1 && N='nice -n 10'; exec $T $N sh -c {}",
        shell_quote(&tool)
    )
}

/// Turns the byte stream into hits. Hit records end with `\0` (names) or contain one after
/// the path (content: `path\0line:text\n`); lines without one are messages (warnings).
struct Collector {
    mode: SearchMode,
    max: usize,
    buf: Vec<u8>,
    bytes: usize,
    out: SearchResult,
}

impl Collector {
    fn new(mode: SearchMode, max: u32) -> Self {
        Self { mode, max: max as usize, buf: Vec::new(), bytes: 0, out: SearchResult { hits: Vec::new(), truncated: false, timed_out: false, warnings: Vec::new(), warning_count: 0 } }
    }

    fn full(&self) -> bool {
        self.out.truncated
    }

    fn warn(&mut self, line: &[u8]) {
        let text = String::from_utf8_lossy(line).trim().to_string();
        if text.is_empty() {
            return;
        }
        self.out.warning_count += 1;
        if self.out.warnings.len() < WARNINGS_KEEP {
            self.out.warnings.push(text.chars().take(300).collect());
        }
    }

    fn hit(&mut self, hit: SearchHit) {
        if self.out.hits.len() >= self.max {
            self.out.truncated = true;
            return;
        }
        self.out.hits.push(hit);
    }

    /// Feed bytes; returns false once enough was read.
    fn push(&mut self, data: &[u8]) -> bool {
        self.bytes += data.len();
        self.buf.extend_from_slice(data);
        match self.mode {
            SearchMode::Content => {
                while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = self.buf.drain(..=nl).collect();
                    self.content_line(&line[..line.len() - 1]);
                }
                if self.buf.len() > 1024 * 1024 {
                    // A gigantic line (minified file): cut it.
                    let line = std::mem::take(&mut self.buf);
                    self.content_line(&line);
                }
            }
            SearchMode::Names => loop {
                // Messages arrive as `find: ...\n` lines between NUL-ended paths.
                let nul = self.buf.iter().position(|&b| b == 0);
                let nl = self.buf.iter().position(|&b| b == b'\n');
                match (nul, nl) {
                    (Some(z), Some(n)) if n < z && self.buf.starts_with(b"find:") => {
                        let line: Vec<u8> = self.buf.drain(..=n).collect();
                        self.warn(&line);
                    }
                    (Some(z), _) => {
                        let rec: Vec<u8> = self.buf.drain(..=z).collect();
                        let path = String::from_utf8_lossy(&rec[..rec.len() - 1]).trim_start_matches(['\r', '\n']).to_string();
                        if !path.is_empty() {
                            self.hit(SearchHit { path, line: None, text: None });
                        }
                    }
                    (None, Some(n)) if self.buf.starts_with(b"find:") || self.buf.starts_with(b"timeout:") => {
                        let line: Vec<u8> = self.buf.drain(..=n).collect();
                        self.warn(&line);
                    }
                    _ => break,
                }
            },
        }
        !self.full() && self.bytes < OUTPUT_MAX
    }

    fn content_line(&mut self, line: &[u8]) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let Some(z) = line.iter().position(|&b| b == 0) else { return self.warn(line) };
        let path = String::from_utf8_lossy(&line[..z]).to_string();
        let rest = &line[z + 1..];
        let Some(colon) = rest.iter().position(|&b| b == b':') else { return self.warn(line) };
        let Ok(n) = std::str::from_utf8(&rest[..colon]).unwrap_or("").parse::<u32>() else { return self.warn(line) };
        let text = String::from_utf8_lossy(&rest[colon + 1..]);
        let text: String = if text.chars().count() > LINE_MAX { text.chars().take(LINE_MAX).chain("…".chars()).collect() } else { text.into_owned() };
        self.hit(SearchHit { path, line: Some(n), text: Some(text) });
    }

    fn finish(mut self, exit: Option<u32>) -> SearchResult {
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            match self.mode {
                SearchMode::Content => self.content_line(&rest),
                SearchMode::Names => self.warn(&rest),
            }
        }
        // 124: stopped by `timeout`.
        self.out.timed_out = exit == Some(124);
        self.out
    }
}

pub struct Search {
    conns: Arc<ConnectionManager>,
    /// The running search per host (a new one cancels it).
    running: Mutex<HashMap<String, (u64, Arc<Notify>)>>,
    next: std::sync::atomic::AtomicU64,
}

struct Running<'a>(&'a Search, String, u64);
impl Drop for Running<'_> {
    fn drop(&mut self) {
        let mut map = self.0.running.lock();
        if map.get(&self.1).is_some_and(|(id, _)| *id == self.2) {
            map.remove(&self.1);
        }
    }
}

impl Search {
    pub fn new(conns: Arc<ConnectionManager>) -> Self {
        Self { conns, running: Mutex::new(HashMap::new()), next: Default::default() }
    }

    /// Stop the running search of this host and slot (if any).
    pub fn cancel(&self, host_id: &str, slot: &str) {
        if let Some((_, n)) = self.running.lock().remove(&format!("{host_id}|{slot}")) {
            n.notify_one();
        }
    }

    pub async fn run(&self, r: &SearchRequest) -> Result<SearchResult> {
        validate(r)?;
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let stop = Arc::new(Notify::new());
        let key = format!("{}|{}", r.host_id, r.slot);
        if let Some((_, old)) = self.running.lock().insert(key.clone(), (id, stop.clone())) {
            old.notify_one();
        }
        let _running = Running(self, key, id);
        let cmd = command(r);
        let mut c = Collector::new(r.mode, r.max_results);
        let cancelled = || Error::Other("Search cancelled.".into());
        if r.host_id == crate::computer::ID {
            let mut child = crate::computer::command("sh").args(["-c", &cmd]).stderr(std::process::Stdio::null()).spawn()
                .map_err(|e| Error::Other(format!("Cannot search on this computer: {e}")))?;
            let mut out = child.stdout.take().ok_or_else(|| Error::Other("no output".into()))?;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                tokio::select! {
                    n = out.read(&mut buf) => match n? {
                        0 => break,
                        n => if !c.push(&buf[..n]) { break },
                    },
                    _ = stop.notified() => return Err(cancelled()),
                }
            }
            // kill_on_drop stops it when it was cut short.
            let exit = if c.full() { None } else { child.wait().await.ok().and_then(|s| s.code()).map(|c| c as u32) };
            return Ok(c.finish(exit));
        }
        let lease = self.conns.acquire(&r.host_id).await?;
        let h = lease.handle().await?;
        let mut rx = exec_stream(&h, &cmd, true).await?;
        let mut exit = None;
        let deadline = tokio::time::sleep(Duration::from_secs(TIME_LIMIT_S + 10));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                chunk = rx.recv() => match chunk {
                    Some(StreamChunk::Data(b)) => if !c.push(&b) { break },
                    Some(StreamChunk::Exit(code)) => exit = code,
                    None => break,
                },
                _ = stop.notified() => return Err(cancelled()),
                _ = &mut deadline => { exit = Some(124); break }
            }
        }
        // Dropping `rx` closes the channel: the server stops grep/find (SIGHUP).
        Ok(c.finish(exit))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(mode: SearchMode) -> SearchRequest {
        SearchRequest {
            host_id: "h".into(),
            slot: "search".into(),
            folder: "/srv/app".into(),
            query: "it's $(x)".into(),
            mode,
            regex: false,
            case_sensitive: false,
            whole_word: false,
            include: vec!["*.php".into()],
            exclude: vec![],
            exclude_dirs: vec!["node_modules".into()],
            hidden: false,
            follow_links: false,
            folders: false,
            max_depth: None,
            max_results: 100,
        }
    }

    #[test]
    fn commands_quote_everything() {
        let c = command(&req(SearchMode::Content));
        let inner = "find '/srv/app' \\( -type d \\( -name 'node_modules' -o -name '.*' \\) ! -path '/srv/app' \\) -prune -o \\( -type f \\( -name '*.php' \\) ! -name '.*' \\) ! -path '/srv/app' -print0 | xargs -0 -r grep -n -I -H --null --color=never -F -i -e 'it'\\''s $(x)' --";
        assert!(c.ends_with(&format!("exec $T $N sh -c {}", shell_quote(inner))), "{c}");
        let n = command(&SearchRequest { max_depth: Some(3), ..req(SearchMode::Names) });
        let inner = "find '/srv/app' -maxdepth 3 \\( -type d \\( -name 'node_modules' -o -name '.*' \\) ! -path '/srv/app' \\) -prune -o \\( -iname '*it'\\''s $(x)*' -type f \\( -name '*.php' \\) ! -name '.*' \\) ! -path '/srv/app' -print0";
        assert!(n.ends_with(&format!("exec $T $N sh -c {}", shell_quote(inner))), "{n}");
    }

    #[test]
    fn start_folder_is_matched_literally() {
        assert_eq!(path_pattern("/srv/app[1]/*x?"), "/srv/app\\[1\\]/\\*x\\?");
        let c = command(&SearchRequest { folder: "/srv/a[1]".into(), ..req(SearchMode::Names) });
        assert!(c.contains(&shell_quote("! -path '/srv/a\\[1\\]' -print0")[1..30]) || c.contains("a\\[1\\]"), "{c}");
    }

    #[test]
    fn validation() {
        assert!(validate(&req(SearchMode::Content)).is_ok());
        assert!(validate(&SearchRequest { query: " ".into(), ..req(SearchMode::Content) }).is_err());
        assert!(validate(&SearchRequest { query: "a\nb".into(), ..req(SearchMode::Content) }).is_err());
        assert!(validate(&SearchRequest { folder: "rel".into(), ..req(SearchMode::Content) }).is_err());
        assert!(validate(&SearchRequest { include: vec!["a/b".into()], ..req(SearchMode::Content) }).is_err());
        assert!(validate(&SearchRequest { max_results: 0, ..req(SearchMode::Content) }).is_err());
        assert!(validate(&SearchRequest { max_results: 5001, ..req(SearchMode::Content) }).is_err());
    }

    #[test]
    fn content_output_is_parsed_in_pieces() {
        let mut c = Collector::new(SearchMode::Content, 2);
        assert!(c.push(b"/a/x.php\x0012:  $user = 1;\r\n/a/y"));
        assert!(c.push(b".php\x003:b\r\ngrep: /a/secret: Permission denied\r\n"));
        assert!(!c.push(b"/a/z.php\x001:c\r\n"));
        let r = c.finish(Some(2));
        assert_eq!(r.hits.len(), 2);
        assert_eq!((r.hits[0].path.as_str(), r.hits[0].line, r.hits[0].text.as_deref()), ("/a/x.php", Some(12), Some("  $user = 1;")));
        assert_eq!(r.hits[1].path, "/a/y.php");
        assert!(r.truncated);
        assert_eq!(r.warning_count, 1);
        assert!(r.warnings[0].contains("Permission denied"));
    }

    #[test]
    fn names_output_and_timeout() {
        let mut c = Collector::new(SearchMode::Names, 10);
        c.push(b"/a/one.conf\0find: '/a/locked': Permission denied\r\n/a/t");
        c.push(b"wo.conf\0");
        let r = c.finish(Some(124));
        assert_eq!(r.hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), ["/a/one.conf", "/a/two.conf"]);
        assert_eq!(r.warning_count, 1);
        assert!(r.timed_out);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn real_grep_and_find_on_this_computer() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("src/a.php"), "one\nfind the Needle here\n").unwrap();
        std::fs::write(root.join("src/deep/b.txt"), "needle again\n").unwrap();
        std::fs::write(root.join("node_modules/c.php"), "needle\n").unwrap();
        std::fs::write(root.join(".git/d"), "needle\n").unwrap();
        std::fs::write(root.join("bin.dat"), b"needle\0binary").unwrap();
        let s = Search::new(Arc::new(ConnectionManager::new(
            Arc::new(crate::db::Db::open(root.join("x.db")).unwrap()),
            Arc::new(Mutex::new(crate::vault::Vault::load_or_new(root.join("v.bin")).unwrap())),
            tokio::sync::broadcast::channel(4).0,
        )));
        let base = SearchRequest {
            host_id: crate::computer::ID.into(),
            slot: "search".into(),
            folder: root.to_string_lossy().into_owned(),
            query: "needle".into(),
            mode: SearchMode::Content,
            regex: false,
            case_sensitive: false,
            whole_word: false,
            include: vec![],
            exclude: vec![],
            exclude_dirs: vec!["node_modules".into()],
            hidden: false,
            follow_links: false,
            folders: false,
            max_depth: None,
            max_results: 100,
        };
        let r = s.run(&base).await.unwrap();
        let mut found: Vec<String> = r.hits.iter().map(|h| format!("{}:{}", h.path.rsplit('/').next().unwrap(), h.line.unwrap())).collect();
        found.sort();
        assert_eq!(found, ["a.php:2", "b.txt:1"], "{r:?}");
        let r = s.run(&SearchRequest { case_sensitive: true, ..base.clone() }).await.unwrap();
        assert_eq!(r.hits.len(), 1);
        let r = s.run(&SearchRequest { include: vec!["*.php".into()], ..base.clone() }).await.unwrap();
        assert_eq!(r.hits.len(), 1);
        let r = s.run(&SearchRequest { max_results: 1, ..base.clone() }).await.unwrap();
        assert!(r.truncated && r.hits.len() == 1);
        let r = s.run(&SearchRequest { mode: SearchMode::Names, query: "B.T".into(), ..base.clone() }).await.unwrap();
        assert_eq!(r.hits.iter().map(|h| h.path.rsplit('/').next().unwrap()).collect::<Vec<_>>(), ["b.txt"], "{r:?}");
        let r = s.run(&SearchRequest { mode: SearchMode::Names, query: "deep".into(), folders: true, ..base.clone() }).await.unwrap();
        assert_eq!(r.hits.len(), 1);
        let r = s.run(&SearchRequest { mode: SearchMode::Names, query: "*.php".into(), max_depth: Some(1), ..base.clone() }).await.unwrap();
        assert!(r.hits.is_empty(), "{r:?}");
    }

    #[test]
    fn long_lines_are_cut() {
        let mut c = Collector::new(SearchMode::Content, 10);
        let long = format!("/a\x001:{}\n", "x".repeat(5000));
        c.push(long.as_bytes());
        let t = c.finish(Some(0)).hits[0].text.clone().unwrap();
        assert_eq!(t.chars().count(), LINE_MAX + 1);
    }
}
