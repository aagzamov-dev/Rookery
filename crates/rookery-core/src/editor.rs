//! Editor (docs/08-EDITOR.md): open a text file on a server, save it without ever losing a
//! change, yours or someone else's.
//!
//! - Opening remembers the file's version (size, mtime, SHA-256 of the bytes).
//! - Saving reads the file again first: a different SHA-256 means someone changed it, and
//!   nothing is written (the UI shows a three-way merge).
//! - The server's version is copied to a local backup before anything is written.
//! - Writing: own file → temp file + one `mv -f` (atomic); someone else's writable file →
//!   in place (owner / permissions stay); not writable → "Save with sudo" (`sudo cp` from a
//!   private temp file; the password is the only thing on sudo's stdin).
//! - The result is read back and must match what was saved.
//! - File contents are never logged.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use ts_rs::TS;
use zeroize::Zeroizing;

use crate::db::Db;
use crate::model::AuthKind;
use crate::sftp::{Conn, Sftp};
use crate::ssh::{exec, exec_with_input};
use crate::terminal::shell_quote;
use crate::vault::Vault;
use crate::{new_id, now_ms, Error, Result};

/// Larger files open read-only (use Files → Edit locally).
pub const EDIT_MAX: u64 = 5 * 1024 * 1024;
/// Larger files are not opened at all.
pub const VIEW_MAX: u64 = 20 * 1024 * 1024;
const BACKUPS_KEEP: usize = 20;
const BACKUP_MAX_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const CMD_TIMEOUT: Duration = Duration::from_secs(30);
const BOM: &[u8] = b"\xEF\xBB\xBF";

// ------------------------------------------------------------------ types

/// What was on the server when the file was opened (or last saved).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct FileVersion {
    #[ts(type = "number")]
    pub size: u64,
    /// Seconds since 1970 (as the server reports it).
    #[ts(type = "number")]
    pub mtime: i64,
    pub sha256: String,
}

/// The cheap "did it change?" check (no content read).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct FileStamp {
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub mtime: i64,
    pub exists: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum Eol {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct EditorFile {
    /// The path as asked for.
    pub path: String,
    /// The real file (symlinks resolved); this is what gets written.
    pub real_path: String,
    /// Text with `\n` line ends (the file's own style is in `eol`).
    pub content: String,
    pub version: FileVersion,
    pub eol: Eol,
    /// The file had both LF and CRLF lines; it is saved with `eol` only.
    pub mixed_eol: bool,
    pub bom: bool,
    pub read_only: bool,
    pub read_only_reason: Option<String>,
    /// The login owns the file (saving can be atomic).
    pub owned: bool,
    /// Octal permissions, e.g. "644".
    pub mode: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum SaveMode {
    /// Only if the file is still the version it was opened as.
    Normal,
    /// Same, written with sudo (after "Permission denied").
    Sudo,
    /// Replace whatever is there now (merge view → "Overwrite theirs", confirmed twice).
    Overwrite,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SaveOutcome {
    /// `method` = atomic | in_place | sudo
    Saved { version: FileVersion, method: String },
    /// The file changed on the server since `base`: nothing was written.
    Conflict {
        /// Its current text (`\n` line ends); empty when it was deleted.
        theirs: String,
        theirs_version: FileVersion,
        deleted: bool,
    },
    /// No permission to write; "Save with sudo" may work.
    NeedsSudo { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct EditorBackup {
    pub id: String,
    #[ts(type = "number")]
    pub at: i64,
    #[ts(type = "number")]
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct BackupIndex {
    host_id: String,
    path: String,
    entries: Vec<EditorBackup>,
}

// ------------------------------------------------------------ pure helpers

pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in d {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[derive(Debug)]
pub struct Decoded {
    pub text: String,
    pub eol: Eol,
    pub mixed: bool,
    pub bom: bool,
}

/// Bytes → editable text. Refuses binary and non-UTF-8 data (they would be damaged by saving).
pub fn decode(bytes: &[u8]) -> std::result::Result<Decoded, String> {
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err("This looks like a binary file; it is not opened, so it cannot be damaged.".into());
    }
    let (bom, body) = match bytes.strip_prefix(BOM) {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    let text = std::str::from_utf8(body).map_err(|_| "This file is not UTF-8 text; it is not opened, so it cannot be damaged.".to_string())?;
    let crlf = text.matches("\r\n").count();
    let lf_only = text.matches('\n').count() - crlf;
    let eol = if crlf > lf_only { Eol::Crlf } else { Eol::Lf };
    let mixed = crlf > 0 && lf_only > 0;
    let text = if crlf > 0 { text.replace("\r\n", "\n") } else { text.to_string() };
    Ok(Decoded { text, eol, mixed, bom })
}

/// Editor text (`\n` line ends) → the bytes to write, in the file's own style.
/// A `\r` in the text is content (the editor keeps it as a character), so it is written as is.
pub fn encode(text: &str, eol: Eol, bom: bool) -> Vec<u8> {
    let body = match eol {
        Eol::Lf => text.to_string(),
        Eol::Crlf => text.replace('\n', "\r\n"),
    };
    let mut out = Vec::with_capacity(body.len() + 3);
    if bom {
        out.extend_from_slice(BOM);
    }
    out.extend_from_slice(body.as_bytes());
    out
}

/// An absolute, clean remote path: no `..`, no NUL, single slashes.
pub fn clean_path(p: &str) -> Result<String> {
    if p.contains('\0') {
        return Err(Error::Other("invalid path".into()));
    }
    if !p.starts_with('/') {
        return Err(Error::Other("use an absolute path (starting with /)".into()));
    }
    let mut parts = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => return Err(Error::Other("paths with .. are not allowed".into())),
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        return Err(Error::Other("that is a folder, not a file".into()));
    }
    Ok(format!("/{}", parts.join("/")))
}

fn parent_and_name(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(0) => ("/", &path[1..]),
        Some(i) => (&path[..i], &path[i + 1..]),
        None => (".", path),
    }
}

fn is_denied(e: &impl std::fmt::Display) -> bool {
    let m = e.to_string().to_ascii_lowercase();
    m.contains("permission") || m.contains("denied")
}

fn is_missing(e: &impl std::fmt::Display) -> bool {
    let m = e.to_string().to_ascii_lowercase();
    m.contains("no such file") || m.contains("not found") || m.contains("nosuchfile")
}

/// Keep the newest `keep` entries younger than `max_age_ms`; returns the ones to delete.
fn prune(entries: &mut Vec<EditorBackup>, now: i64, keep: usize, max_age_ms: i64) -> Vec<EditorBackup> {
    entries.sort_by(|a, b| b.at.cmp(&a.at));
    let mut removed = Vec::new();
    let mut kept = Vec::new();
    for (i, e) in entries.drain(..).enumerate() {
        if i < keep && now - e.at <= max_age_ms {
            kept.push(e);
        } else {
            removed.push(e);
        }
    }
    *entries = kept;
    removed
}

// ------------------------------------------------------------------ engine

pub struct Editor {
    sftp: Arc<Sftp>,
    db: Arc<Db>,
    vault: Arc<Mutex<Vault>>,
    store: Backups,
    /// The login's uid per host (`id -u`), to know whether we own a file.
    uids: Mutex<HashMap<String, u32>>,
}

impl Editor {
    pub fn new(sftp: Arc<Sftp>, db: Arc<Db>, vault: Arc<Mutex<Vault>>, backups_dir: PathBuf) -> Self {
        Self { sftp, db, vault, store: Backups::new(backups_dir), uids: Mutex::new(HashMap::new()) }
    }

    async fn uid(&self, host_id: &str) -> Option<u32> {
        if let Some(u) = self.uids.lock().get(host_id) {
            return Some(*u);
        }
        let c = self.sftp.conn(host_id).await.ok()?;
        let h = c.lease.handle().await.ok()?;
        let out = exec(&h, "id -u", CMD_TIMEOUT).await.ok()?;
        let u: u32 = out.stdout.trim().parse().ok()?;
        self.uids.lock().insert(host_id.to_string(), u);
        Some(u)
    }

    /// `~/x` → home + `/x`; then cleaned.
    async fn resolve(&self, host_id: &str, path: &str) -> Result<String> {
        let p = path.trim();
        if p == "~" || p.starts_with("~/") {
            let home = self.sftp.home(host_id).await?;
            return clean_path(&format!("{home}/{}", p.trim_start_matches('~').trim_start_matches('/')));
        }
        clean_path(p)
    }

    async fn read_all(&self, host_id: &str, path: &str) -> Result<(Vec<u8>, FileAttributes)> {
        let c = self.sftp.conn(host_id).await?;
        let r = c.s.metadata(path).await;
        let meta = self.sftp.on_err(host_id, r).await?;
        if meta.is_dir() {
            return Err(Error::Other("that is a folder, not a file".into()));
        }
        if meta.size.unwrap_or(0) > VIEW_MAX {
            return Err(Error::Other(format!(
                "this file is larger than {} MB; open it with Files → Edit locally or download it",
                VIEW_MAX / 1024 / 1024
            )));
        }
        let mut f = c.s.open(path).await.map_err(|e| Error::Other(format!("cannot open {path}: {e}")))?;
        let mut data = Vec::new();
        f.read_to_end(&mut data).await?;
        Ok((data, meta))
    }

    pub async fn open(&self, host_id: &str, path: &str) -> Result<EditorFile> {
        let asked = self.resolve(host_id, path).await?;
        let c = self.sftp.conn(host_id).await?;
        let real = c.s.canonicalize(&asked).await.map_err(|e| {
            if is_missing(&e) {
                Error::NotFound(asked.clone())
            } else {
                Error::Other(format!("cannot open {asked}: {e}"))
            }
        })?;
        let real = clean_path(&real)?;
        let (bytes, meta) = self.read_all(host_id, &real).await?;
        let d = decode(&bytes).map_err(Error::Other)?;
        let owned = match (meta.uid, self.uid(host_id).await) {
            (Some(file), Some(me)) => file == me,
            _ => false,
        };
        let too_big = bytes.len() as u64 > EDIT_MAX;
        Ok(EditorFile {
            path: asked,
            real_path: real,
            content: d.text,
            version: FileVersion { size: bytes.len() as u64, mtime: meta.mtime.unwrap_or(0) as i64, sha256: sha256_hex(&bytes) },
            eol: d.eol,
            mixed_eol: d.mixed,
            bom: d.bom,
            read_only: too_big,
            read_only_reason: too_big.then(|| format!("Larger than {} MB: read-only here. Use Files → Edit locally to change it.", EDIT_MAX / 1024 / 1024)),
            owned,
            mode: format!("{:o}", meta.permissions.unwrap_or(0) & 0o7777),
        })
    }

    pub async fn stat(&self, host_id: &str, real_path: &str) -> Result<FileStamp> {
        let path = clean_path(real_path)?;
        let c = self.sftp.conn(host_id).await?;
        match c.s.metadata(&path).await {
            Ok(m) => Ok(FileStamp { size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as i64, exists: true }),
            Err(e) if is_missing(&e) => Ok(FileStamp { size: 0, mtime: 0, exists: false }),
            Err(e) => self.sftp.on_err(host_id, Err(e)).await,
        }
    }

    /// Save `content` to `real_path` (see the module docs for the rules).
    pub async fn save(&self, host_id: &str, real_path: &str, content: &str, eol: Eol, bom: bool, base: &FileVersion, mode: SaveMode) -> Result<SaveOutcome> {
        let path = clean_path(real_path)?;
        let new_bytes = encode(content, eol, bom);
        if new_bytes.len() as u64 > EDIT_MAX {
            return Err(Error::Other(format!("the text is larger than {} MB; it is not saved", EDIT_MAX / 1024 / 1024)));
        }

        // 1. What is on the server now?
        let current = match self.read_all(host_id, &path).await {
            Ok(v) => Some(v),
            Err(Error::Ssh(m)) if is_missing(&m) => None,
            Err(e) if is_missing(&e) => None,
            Err(e) => return Err(e),
        };
        // Already exactly this text (e.g. someone saved the same change): nothing to write.
        if let Some((bytes, meta)) = &current {
            if sha256_hex(bytes) == sha256_hex(&new_bytes) {
                return Ok(SaveOutcome::Saved {
                    version: FileVersion { size: bytes.len() as u64, mtime: meta.mtime.unwrap_or(0) as i64, sha256: sha256_hex(bytes) },
                    method: "unchanged".into(),
                });
            }
        }
        if mode != SaveMode::Overwrite {
            match &current {
                None => {
                    return Ok(SaveOutcome::Conflict { theirs: String::new(), theirs_version: FileVersion { size: 0, mtime: 0, sha256: String::new() }, deleted: true });
                }
                Some((bytes, meta)) if sha256_hex(bytes) != base.sha256 => {
                    let theirs = decode(bytes).map(|d| d.text).map_err(Error::Other)?;
                    return Ok(SaveOutcome::Conflict {
                        theirs,
                        theirs_version: FileVersion { size: bytes.len() as u64, mtime: meta.mtime.unwrap_or(0) as i64, sha256: sha256_hex(bytes) },
                        deleted: false,
                    });
                }
                _ => {}
            }
        }

        // 2. Keep the server's version on this PC first. No backup, no write.
        if let Some((bytes, _)) = &current {
            self.store.add(host_id, &path, bytes).map_err(|e| Error::Other(format!("could not make the backup, nothing was saved: {e}")))?;
        }

        // 3. Write.
        let orig = current.as_ref().map(|(_, m)| m.clone());
        let owned = match (orig.as_ref().and_then(|m| m.uid), self.uid(host_id).await) {
            (Some(file), Some(me)) => file == me,
            _ => false,
        };
        let method = if mode == SaveMode::Sudo {
            self.write_sudo(host_id, &path, &new_bytes).await?;
            "sudo"
        } else {
            match self.write_normal(host_id, &path, &new_bytes, orig.as_ref(), owned).await {
                Ok(m) => m,
                Err(e) if is_denied(&e) => {
                    return Ok(SaveOutcome::NeedsSudo { message: format!("Permission denied: your login cannot write {path}.") });
                }
                Err(e) => return Err(e),
            }
        };

        // 4. Read it back: it must be exactly what was saved.
        let (back, meta) = self.read_all(host_id, &path).await?;
        if sha256_hex(&back) != sha256_hex(&new_bytes) {
            return Err(Error::Other(format!(
                "{path} was written, but reading it back gives different content (someone may have changed it at the same moment). Your text is still in the editor; the previous version is in History."
            )));
        }
        Ok(SaveOutcome::Saved {
            version: FileVersion { size: back.len() as u64, mtime: meta.mtime.unwrap_or(0) as i64, sha256: sha256_hex(&back) },
            method: method.into(),
        })
    }

    /// Own file: temp file next to it + `mv -f` (atomic). Otherwise: in place (keeps owner / mode).
    async fn write_normal(&self, host_id: &str, path: &str, bytes: &[u8], orig: Option<&FileAttributes>, owned: bool) -> Result<&'static str> {
        let c = self.sftp.conn(host_id).await?;
        if owned && self.write_atomic(&c, path, bytes, orig).await? {
            return Ok("atomic");
        }
        let mut f = c
            .s
            .open_with_flags(path, OpenFlags::WRITE | OpenFlags::TRUNCATE | OpenFlags::CREATE)
            .await
            .map_err(|e| Error::Other(format!("cannot write {path}: {e}")))?;
        f.write_all(bytes).await?;
        let _ = f.sync_all().await;
        f.shutdown().await?;
        Ok("in_place")
    }

    /// Write a temp file in the same folder, give it the original's group and permissions, and
    /// `mv -f` it over the original, but only if it then looks exactly like the original (one
    /// link, same group, same mode). `Ok(false)`: not possible here, write in place instead.
    /// An error while writing the temp file (e.g. disk full) is returned: the original is untouched.
    async fn write_atomic(&self, c: &Conn, path: &str, bytes: &[u8], orig: Option<&FileAttributes>) -> Result<bool> {
        let Some(orig) = orig else { return Ok(false) };
        let perms = orig.permissions.unwrap_or(0o644) & 0o7777;
        let (dir, name) = parent_and_name(path);
        let tmp = format!("{}/.{}.rookery-{}.tmp", dir.trim_end_matches('/'), name, &new_id()[..8]);
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(perms & 0o777);
        let Ok(mut f) = c.s.open_with_flags_and_attributes(&tmp, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE, attrs).await else {
            return Ok(false); // e.g. the folder is not writable, only the file
        };
        let written = async {
            f.write_all(bytes).await?;
            // A new file gets the umask and the login's group: set both like the original.
            if let (Some(uid), Some(gid)) = (orig.uid, orig.gid) {
                let mut a = FileAttributes::empty();
                a.uid = Some(uid);
                a.gid = Some(gid);
                let _ = f.set_metadata(a).await;
            }
            let mut a = FileAttributes::empty();
            a.permissions = Some(perms);
            let _ = f.set_metadata(a).await;
            let _ = f.sync_all().await;
            f.shutdown().await?;
            Ok::<_, Error>(())
        }
        .await;
        if let Err(e) = written {
            let _ = c.s.remove_file(&tmp).await;
            return Err(e);
        }
        let (t, d) = (shell_quote(&tmp), shell_quote(path));
        let cmd = format!("d=$(stat -c '%h:%g:%a' -- {d}) && t=$(stat -c '%h:%g:%a' -- {t}) && [ \"$d\" = \"$t\" ] && mv -f -- {t} {d}");
        let moved = match c.lease.handle().await {
            Ok(h) => matches!(exec(&h, &cmd, CMD_TIMEOUT).await, Ok(o) if o.exit == Some(0)),
            Err(_) => false,
        };
        if !moved {
            let _ = c.s.remove_file(&tmp).await;
        }
        Ok(moved)
    }

    /// `sudo cp` from a private temp file; the sudo password is the only thing on stdin.
    async fn write_sudo(&self, host_id: &str, path: &str, bytes: &[u8]) -> Result<()> {
        let password = self.sudo_password(host_id)?;
        let c = self.sftp.conn(host_id).await?;
        let tmp = format!("/tmp/.rookery-{}.tmp", new_id());
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(0o600);
        let mut f = c
            .s
            .open_with_flags_and_attributes(&tmp, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE, attrs)
            .await
            .map_err(|e| Error::Other(format!("cannot write a temporary file in /tmp: {e}")))?;
        let res = async {
            f.write_all(bytes).await?;
            f.shutdown().await?;
            let h = c.lease.handle().await?;
            let mut input = Zeroizing::new(Vec::with_capacity(password.len() + 1));
            input.extend_from_slice(password.as_bytes());
            input.push(b'\n');
            // cp onto an existing file keeps its owner and permissions.
            let cmd = format!("sudo -S -p '' cp -- {} {}", shell_quote(&tmp), shell_quote(path));
            let out = exec_with_input(&h, &cmd, &input, CMD_TIMEOUT).await?;
            if out.exit != Some(0) {
                let err = out.stderr.to_ascii_lowercase();
                return Err(Error::Other(if err.contains("incorrect password") || err.contains("sorry") {
                    "sudo refused the saved password; update it in the server's login".into()
                } else if err.contains("not in the sudoers") || err.contains("not allowed") {
                    "this login may not use sudo on the server".into()
                } else {
                    format!("sudo could not save the file: {}", out.stderr.trim())
                }));
            }
            Ok(())
        }
        .await;
        let _ = c.s.remove_file(&tmp).await;
        res
    }

    fn sudo_password(&self, host_id: &str) -> Result<Zeroizing<String>> {
        let host = self.db.get_host(host_id)?;
        let ident_id = self
            .db
            .resolve_identity_id(&host)?
            .ok_or_else(|| Error::SecretRequired("this server has no login identity".into()))?;
        let ident = self.db.get_identity(&ident_id)?;
        let v = self.vault.lock();
        if !v.is_unlocked() {
            return Err(Error::VaultLocked);
        }
        match v.get(&ident.secret_id("sudo"))? {
            Some(p) => Ok(p),
            None if ident.auth == AuthKind::Password => v
                .get(&ident.secret_id("password"))?
                .ok_or_else(|| Error::SecretRequired("no sudo password saved for this login — add it in the server's login".into())),
            None => Err(Error::SecretRequired("no sudo password saved for this login — add it in the server's login".into())),
        }
    }

    pub fn backups(&self, host_id: &str, real_path: &str) -> Result<Vec<EditorBackup>> {
        self.store.list(host_id, &clean_path(real_path)?)
    }

    pub fn backup_read(&self, host_id: &str, real_path: &str, id: &str) -> Result<String> {
        let bytes = self.store.read(host_id, &clean_path(real_path)?, id)?;
        decode(&bytes).map(|d| d.text).map_err(Error::Other)
    }
}

// ------------------------------------------------------------------ backups

/// `<root>/<server>/<file id>/<id>.bak` + `index.json`. On this PC only: never synced or backed up.
pub struct Backups {
    root: PathBuf,
}

impl Backups {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn dir(&self, host_id: &str, path: &str) -> PathBuf {
        let safe_host: String = host_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        self.root.join(safe_host).join(&sha256_hex(path.as_bytes())[..20])
    }

    fn index(dir: &Path) -> BackupIndex {
        std::fs::read(dir.join("index.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn add(&self, host_id: &str, path: &str, bytes: &[u8]) -> Result<()> {
        let dir = self.dir(host_id, path);
        std::fs::create_dir_all(&dir)?;
        let mut idx = Self::index(&dir);
        idx.host_id = host_id.into();
        idx.path = path.into();
        let sha = sha256_hex(bytes);
        let now = now_ms();
        // The same version twice (save, save again): one copy is enough.
        if !idx.entries.iter().any(|e| e.sha256 == sha) {
            let id = format!("{now}-{}", &new_id()[..6]);
            std::fs::write(dir.join(format!("{id}.bak")), bytes)?;
            idx.entries.push(EditorBackup { id, at: now, size: bytes.len() as u64, sha256: sha });
        }
        let removed = prune(&mut idx.entries, now, BACKUPS_KEEP, BACKUP_MAX_AGE_MS);
        let tmp = dir.join("index.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&idx)?)?;
        std::fs::rename(&tmp, dir.join("index.json"))?;
        for old in removed {
            let _ = std::fs::remove_file(dir.join(format!("{}.bak", old.id)));
        }
        Ok(())
    }

    pub fn list(&self, host_id: &str, path: &str) -> Result<Vec<EditorBackup>> {
        let mut e = Self::index(&self.dir(host_id, path)).entries;
        e.sort_by(|a, b| b.at.cmp(&a.at));
        Ok(e)
    }

    pub fn read(&self, host_id: &str, path: &str, id: &str) -> Result<Vec<u8>> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(Error::Other("invalid backup id".into()));
        }
        std::fs::read(self.dir(host_id, path).join(format!("{id}.bak"))).map_err(|_| Error::NotFound("that backup".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crlf_and_bom_round_trip() {
        let original = b"\xEF\xBB\xBFAPP_ENV=production\r\nDB_HOST=127.0.0.1\r\n";
        let d = decode(original).unwrap();
        assert!(d.bom && d.eol == Eol::Crlf && !d.mixed);
        assert_eq!(d.text, "APP_ENV=production\nDB_HOST=127.0.0.1\n");
        assert_eq!(encode(&d.text, d.eol, d.bom), original.to_vec());
    }

    #[test]
    fn lf_files_stay_lf_and_keep_the_final_newline_as_it_was() {
        for original in [&b"a\nb\n"[..], b"a\nb"] {
            let d = decode(original).unwrap();
            assert_eq!(d.eol, Eol::Lf);
            assert_eq!(encode(&d.text, d.eol, d.bom), original.to_vec());
        }
    }

    #[test]
    fn stray_carriage_returns_survive() {
        for original in [&b"a\rb\n"[..], b"a\r\r\nb\r\n", b"x\r"] {
            let d = decode(original).unwrap();
            assert_eq!(encode(&d.text, d.eol, d.bom), original.to_vec(), "{original:?}");
        }
    }

    #[test]
    fn mixed_line_ends_are_reported() {
        let d = decode(b"a\r\nb\r\nc\n").unwrap();
        assert!(d.mixed);
        assert_eq!(d.eol, Eol::Crlf);
        assert_eq!(encode(&d.text, d.eol, false), b"a\r\nb\r\nc\r\n".to_vec());
    }

    #[test]
    fn binary_and_non_utf8_are_refused() {
        assert!(decode(b"PK\x03\x04\x00\x00").unwrap_err().contains("binary"));
        assert!(decode(b"caf\xe9").unwrap_err().contains("UTF-8"));
        assert!(decode("café ✓".as_bytes()).is_ok());
    }

    #[test]
    fn paths_must_be_absolute_and_clean() {
        assert_eq!(clean_path("/var//www/./shop/.env").unwrap(), "/var/www/shop/.env");
        assert!(clean_path("var/www").is_err());
        assert!(clean_path("/var/www/../../etc/shadow").is_err());
        assert!(clean_path("/").is_err());
        assert!(clean_path("/a\0b").is_err());
        assert_eq!(parent_and_name("/etc/nginx/nginx.conf"), ("/etc/nginx", "nginx.conf"));
        assert_eq!(parent_and_name("/.env"), ("/", ".env"));
    }

    #[test]
    fn sha256_matches_known_value() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn backups_keep_the_newest_twenty_and_thirty_days() {
        let now = 100 * 24 * 3600 * 1000;
        let mut e: Vec<EditorBackup> = (0..25)
            .map(|i| EditorBackup { id: format!("{i}"), at: now - i * 1000, size: 1, sha256: format!("{i}") })
            .collect();
        e.push(EditorBackup { id: "old".into(), at: now - BACKUP_MAX_AGE_MS - 1, size: 1, sha256: "old".into() });
        let removed = prune(&mut e, now, BACKUPS_KEEP, BACKUP_MAX_AGE_MS);
        assert_eq!(e.len(), 20);
        assert_eq!(e[0].id, "0");
        assert_eq!(removed.len(), 6);
        assert!(removed.iter().any(|r| r.id == "old"));
    }

    #[test]
    fn backup_files_round_trip_and_dedupe() {
        let tmp = tempfile::tempdir().unwrap();
        let b = Backups::new(tmp.path().to_path_buf());
        b.add("h1", "/srv/app/.env", b"A=1\n").unwrap();
        b.add("h1", "/srv/app/.env", b"A=1\n").unwrap(); // same content: no second copy
        b.add("h1", "/srv/app/.env", b"A=2\n").unwrap();
        let list = b.list("h1", "/srv/app/.env").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(b.read("h1", "/srv/app/.env", &list[0].id).unwrap(), b"A=2\n");
        assert!(b.read("h1", "/srv/app/.env", "../../x").is_err());
        assert!(b.list("h2", "/srv/app/.env").unwrap().is_empty(), "per server");
        assert!(b.list("h1", "/srv/app/.env.bak").unwrap().is_empty(), "per file");
    }
}
