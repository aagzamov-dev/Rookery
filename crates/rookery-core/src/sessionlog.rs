//! Session logging (docs/03 §3.9): terminal output → plain-text file, escape codes removed,
//! one local timestamp per line. Only output is logged — what you type (and passwords the
//! sudo helper sends) never reaches the file.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use time::macros::format_description;
use time::{OffsetDateTime, UtcOffset};

use crate::Result;

/// Escape-sequence state for a byte stream that is split at arbitrary points.
#[derive(Default, PartialEq, Eq, Clone, Copy)]
enum Esc {
    #[default]
    None,
    Start,
    /// CSI: ESC [ … final byte 0x40–0x7E
    Csi,
    /// OSC / DCS / APC / PM: ends with BEL or ESC \
    Str,
    StrEsc,
}

pub struct SessionLog {
    out: BufWriter<File>,
    path: PathBuf,
    line: Vec<u8>,
    esc: Esc,
    pending_cr: bool,
    offset: UtcOffset,
}

fn local_offset() -> UtcOffset {
    UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC)
}

fn slug(s: &str) -> String {
    let out: String = s.chars().map(|c| if c.is_alphanumeric() || c == '.' { c } else { '-' }).collect();
    let out = out.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if out.is_empty() { "server".into() } else { out.chars().take(48).collect() }
}

impl SessionLog {
    /// `<dir>/<host>/<YYYY-MM-DD_HH-MM-SS>[_<container>].log`
    pub fn create(dir: &Path, host_name: &str, address: &str, container: Option<&str>) -> Result<Self> {
        let offset = local_offset();
        let now = OffsetDateTime::now_utc().to_offset(offset);
        let stamp = now
            .format(format_description!("[year]-[month]-[day]_[hour]-[minute]-[second]"))
            .unwrap_or_default();
        let folder = dir.join(slug(host_name));
        std::fs::create_dir_all(&folder)?;
        let name = match container {
            Some(c) => format!("{stamp}_{}.log", slug(c)),
            None => format!("{stamp}.log"),
        };
        let path = folder.join(name);
        let mut out = BufWriter::new(File::create(&path)?);
        let pretty = now
            .format(format_description!("[year]-[month]-[day] [hour]:[minute]:[second]"))
            .unwrap_or_default();
        writeln!(out, "# Rookery session log · {host_name} ({address}){} · started {pretty}", container.map(|c| format!(" · container {c}")).unwrap_or_default())?;
        Ok(Self { out, path, line: Vec::new(), esc: Esc::None, pending_cr: false, offset })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn stamp(&self) -> String {
        OffsetDateTime::now_utc()
            .to_offset(self.offset)
            .format(format_description!("[hour]:[minute]:[second]"))
            .unwrap_or_default()
    }

    fn end_line(&mut self) {
        let text = String::from_utf8_lossy(&self.line);
        let _ = writeln!(self.out, "[{}] {}", self.stamp(), text.trim_end());
        self.line.clear();
    }

    /// Feed raw terminal output.
    pub fn push(&mut self, bytes: &[u8]) {
        for &b in bytes {
            match self.esc {
                Esc::Start => {
                    self.esc = match b {
                        b'[' => Esc::Csi,
                        b']' | b'P' | b'_' | b'^' => Esc::Str,
                        _ => Esc::None, // two-byte sequence (ESC 7, ESC =, …)
                    };
                    continue;
                }
                Esc::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        self.esc = Esc::None;
                    }
                    continue;
                }
                Esc::Str => {
                    match b {
                        0x07 => self.esc = Esc::None,
                        0x1b => self.esc = Esc::StrEsc,
                        _ => {}
                    }
                    continue;
                }
                Esc::StrEsc => {
                    self.esc = if b == b'\\' { Esc::None } else { Esc::Str };
                    continue;
                }
                Esc::None => {}
            }
            if self.pending_cr {
                self.pending_cr = false;
                if b != b'\n' {
                    // bare CR: the line is redrawn (progress bars, prompts) — keep the latest text
                    self.line.clear();
                }
            }
            match b {
                0x1b => self.esc = Esc::Start,
                b'\r' => self.pending_cr = true,
                b'\n' => self.end_line(),
                0x08 => {
                    self.line.pop();
                }
                b'\t' => self.line.push(b'\t'),
                0x00..=0x1f | 0x7f => {}
                _ => self.line.push(b),
            }
        }
        if self.line.len() > 64 * 1024 {
            self.end_line();
        }
    }

    pub fn flush(&mut self) {
        let _ = self.out.flush();
    }

    pub fn finish(mut self, reason: &str) {
        if !self.line.is_empty() {
            self.end_line();
        }
        let _ = writeln!(self.out, "# ended: {reason}");
        self.flush();
    }
}

/// Delete logs older than `days` (0 = keep forever). Returns how many files were removed.
pub fn cleanup(dir: &Path, days: u32) -> u32 {
    if days == 0 {
        return 0;
    }
    let cutoff = SystemTime::now() - Duration::from_secs(days as u64 * 86_400);
    let mut removed = 0;
    let Ok(hosts) = std::fs::read_dir(dir) else { return 0 };
    for host in hosts.flatten() {
        let Ok(files) = std::fs::read_dir(host.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            let old = f.metadata().and_then(|m| m.modified()).map(|t| t < cutoff).unwrap_or(false);
            if old && p.extension().is_some_and(|e| e == "log") && std::fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
        let _ = std::fs::remove_dir(host.path()); // only succeeds when empty
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_escapes_and_handles_redraws() {
        let tmp = tempfile::tempdir().unwrap();
        let mut log = SessionLog::create(tmp.path(), "prod api", "10.0.0.1", None).unwrap();
        // colours, a title OSC, a progress bar redrawn with CR, a backspace, split mid-sequence
        log.push(b"\x1b]0;user@host\x07\x1b[32muser@host\x1b[0m:~$ ls\r\n");
        log.push(b"10%\r50%\r100%\r\nab\x08c\r\n\x1b[");
        log.push(b"1mbold\x1b[0m\n");
        let path = log.path().to_path_buf();
        log.finish("closed");
        let text = std::fs::read_to_string(&path).unwrap();
        let body: Vec<&str> = text.lines().skip(1).map(|l| l.split_once("] ").map(|x| x.1).unwrap_or(l)).collect();
        assert_eq!(body, vec!["user@host:~$ ls", "100%", "ac", "bold", "# ended: closed"]);
        assert!(path.parent().unwrap().ends_with("prod-api"));
    }

    #[test]
    fn cleanup_keeps_recent_logs() {
        let tmp = tempfile::tempdir().unwrap();
        let log = SessionLog::create(tmp.path(), "web", "1.2.3.4", Some("app")).unwrap();
        log.finish("closed");
        assert_eq!(cleanup(tmp.path(), 30), 0);
        assert_eq!(cleanup(tmp.path(), 0), 0);
    }
}
