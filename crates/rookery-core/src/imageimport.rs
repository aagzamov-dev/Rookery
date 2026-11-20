//! "Import images": a `.tar` / `.tar.gz` made by `docker save`, loaded with `docker load -i`.
//!
//! 1. [`inspect_archive`] reads the file on this computer first and only streams it (never loads
//!    it into memory): is it a Docker image archive, which tags does it carry, how big is it
//!    packed and unpacked. Nothing is sent anywhere before the user has seen the answer. The tar
//!    is read by a small parser of our own (not the `tar` crate) so every header body has a hard
//!    size limit and the names we report are the ones Docker's loader would see.
//! 2. On a server the free space is checked before the upload ([`decide_space`]): the upload
//!    folder must hold the file, Docker's data folder must hold the unpacked images (twice, that
//!    is the peak while loading), and when both are on one disk the two add up.
//! 3. The [`ImageImports`] job owns the pipeline: upload over SFTP to a unique private file in
//!    `/var/tmp` (or `$HOME`), `docker load -i` through [`Sudo::exec_docker`], and then ALWAYS
//!    deletes the temporary file (done, failed or cancelled), saying so in the result if it cannot.
//!    This computer needs no upload: `docker load -i <path>` is run with the path as one argument.
//!
//! Cancel: during the upload the transfer stops and the temporary file goes. During `docker load`
//! on a server the command is only abandoned, the server may finish loading; the job says so.

use std::collections::HashMap;
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::collectors::valid_image_ref;
use crate::db::Db;
use crate::images::{clean_message, sh_quote};
use crate::sftp::Sftp;
use crate::ssh::{exec, ConnectionManager, SshHandle};
use crate::sudo::Sudo;
use crate::{new_id, CoreEvent, Error, Result};

/// `manifest.json` / `index.json` bigger than this are not read (real ones are a few KB).
pub const JSON_MAX: u64 = 4 * 1024 * 1024;
/// Long-name and PAX header bodies are tiny; a bigger one is refused, never read.
const META_MAX: u64 = 64 * 1024;
/// Files up to this size are hashed while streaming, to prove that a config/manifest name is
/// really the hash of its content.
const HASH_FILE_MAX: u64 = 1024 * 1024;
const HASH_COUNT_MAX: usize = 4096;
/// Blobs up to this size are kept (up to the total below) to read the OCI manifest's config digest.
const BLOB_KEEP_MAX: u64 = 64 * 1024;
const BLOB_KEEP_TOTAL: usize = 8 * 1024 * 1024;
/// Most digest-shaped paths remembered; real archives have a few hundred.
const PATHS_MAX: usize = 100_000;
const TAGS_MAX: usize = 1000;
/// `docker load` of big images is slow.
const LOAD_SECONDS: u64 = 30 * 60;
const MIB: u64 = 1024 * 1024;
const NOT_DOCKER: &str = "This is not a Docker image file (made with docker save).";
const CHANGED: &str = "The file changed after you confirmed; import again.";
const DEFAULT_UPLOAD_DIR: &str = "/var/tmp";

// ------------------------------------------------------------------ inspect the file

/// The ids an imported name can end up with, only those proven by hashing the archive's own bytes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ImageTagIds {
    pub tag: String,
    /// Image ids (hex, no `sha256:`): the config hash (classic store) and/or the manifest digest
    /// (containerd store), as `docker image ls --no-trunc` would show them.
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ImageArchiveInfo {
    /// Names (`repository:tag`, as `docker image ls` shows them) the images get. Empty = untagged.
    pub tags: Vec<String>,
    /// Verified ids per name (names without a proven id are left out).
    pub tag_ids: Vec<ImageTagIds>,
    /// Names in the file that could not be read (not a full `name:tag`): the images may get names that are not in `tags`.
    pub unreadable_names: u32,
    /// Size of the file as it is on disk.
    #[ts(type = "number")]
    pub file_bytes: u64,
    /// Size of the tar once unpacked (equals `file_bytes` for a plain `.tar`).
    #[ts(type = "number")]
    pub tar_bytes: u64,
    /// The file is gzip compressed (by its first bytes, not by its name).
    pub gzip: bool,
}

struct Counting<R> {
    inner: R,
    n: u64,
    cancel: Option<Arc<AtomicBool>>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(std::io::Error::other("cancelled"));
        }
        let n = self.inner.read(buf)?;
        self.n = self.n.saturating_add(n as u64);
        Ok(n)
    }
}

/// Look into the archive without extracting anything. Blocking: the whole file is read once
/// (the unpacked size is only known at the end), in small blocks.
pub fn inspect_archive(path: &Path) -> Result<ImageArchiveInfo> {
    inspect_archive_with(path, None)
}

/// [`inspect_archive`] that stops (with an error) when `cancel` is set.
pub fn inspect_archive_with(path: &Path, cancel: Option<Arc<AtomicBool>>) -> Result<ImageArchiveInfo> {
    let meta = std::fs::metadata(path).map_err(|e| Error::Other(format!("Cannot read {}: {e}", path.display())))?;
    if !meta.is_file() {
        return Err(Error::Other("Choose a file, not a folder.".into()));
    }
    let mut file = std::fs::File::open(path).map_err(|e| Error::Other(format!("Cannot read {}: {e}", path.display())))?;
    let mut magic = [0u8; 2];
    let got = read_up_to(&mut file, &mut magic)?;
    let gzip = got == 2 && magic == [0x1f, 0x8b];
    std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(0))?;
    let reader = std::io::BufReader::with_capacity(256 * 1024, file);
    let (found, tar_bytes) = if gzip { scan_tar(flate2::read::MultiGzDecoder::new(reader), cancel)? } else { scan_tar(reader, cancel)? };
    let (tags, tag_ids, unreadable_names) = tags_of(&found)?;
    Ok(ImageArchiveInfo { tags, tag_ids, unreadable_names, file_bytes: meta.len(), tar_bytes, gzip })
}

fn read_up_to(r: &mut impl Read, buf: &mut [u8]) -> Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

#[derive(Default)]
struct Found {
    entries: u64,
    manifest: Option<Vec<u8>>,
    index: Option<Vec<u8>>,
    /// Path → sha256 (hex) of its content, for the small files that could be an image config or
    /// manifest; `None` when the path appears more than once.
    hashes: HashMap<String, Option<String>>,
    /// Content of the small hashed files (see `BLOB_KEEP_MAX`).
    blobs: HashMap<String, Vec<u8>>,
    kept: usize,
    /// Top-level `repositories` file (old `docker save` layout).
    repositories: Option<Vec<u8>>,
    /// Names of earlier links, and every folder an earlier entry lives in: a later entry may not
    /// go through a link, and a link may not take the place of a folder already used.
    links: std::collections::HashSet<String>,
    parents: std::collections::HashSet<String>,
}

fn damaged(e: impl std::fmt::Display) -> Error {
    Error::Other(format!("The file is damaged or incomplete ({e})."))
}

fn scan_tar<R: Read>(reader: R, cancel: Option<Arc<AtomicBool>>) -> Result<(Found, u64)> {
    let mut counted = Counting { inner: reader, n: 0, cancel: cancel.clone() };
    let found = scan_entries(&mut counted);
    if cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
        return Err(Error::Other("cancelled".into()));
    }
    let found = found?;
    // Padding after the end-of-archive marker: counted so the size is the real one.
    std::io::copy(&mut counted, &mut std::io::sink()).map_err(damaged)?;
    Ok((found, counted.n))
}

struct Header {
    name: Vec<u8>,
    size: u64,
    kind: u8,
}

fn cstr(b: &[u8]) -> &[u8] {
    &b[..b.iter().position(|c| *c == 0).unwrap_or(b.len())]
}

fn parse_octal(b: &[u8]) -> Option<u64> {
    let t = std::str::from_utf8(b).ok()?.trim_matches(|c| c == '\0' || c == ' ');
    if t.is_empty() { Some(0) } else { u64::from_str_radix(t, 8).ok() }
}

/// Octal digits, or the GNU/PAX base-256 form (high bit of the first byte) for sizes over 8 GB.
fn parse_size(b: &[u8]) -> Option<u64> {
    if b[0] & 0x80 == 0 {
        return parse_octal(b);
    }
    let mut v: u64 = (b[0] & 0x7f) as u64;
    for x in &b[1..] {
        v = v.checked_mul(256)?.checked_add(*x as u64)?;
    }
    Some(v)
}

fn parse_header(b: &[u8; 512]) -> Option<Header> {
    let stored = parse_octal(&b[148..156])?;
    let sum: u64 = b.iter().enumerate().map(|(i, x)| if (148..156).contains(&i) { 32 } else { *x as u64 }).sum();
    if sum != stored {
        return None;
    }
    let mut name = cstr(&b[..100]).to_vec();
    if &b[257..262] == b"ustar" && b[262] == 0 {
        let prefix = cstr(&b[345..500]);
        if !prefix.is_empty() {
            let mut full = prefix.to_vec();
            full.push(b'/');
            full.extend_from_slice(&name);
            name = full;
        }
    }
    Some(Header { name, size: parse_size(&b[124..136])?, kind: b[156] })
}

/// `<len> key=value\n` records of a PAX header: (key, value).
fn parse_pax(body: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < body.len() {
        let Some(sp) = body[pos..].iter().position(|c| *c == b' ') else { break };
        let Some(len) = std::str::from_utf8(&body[pos..pos + sp]).ok().and_then(|t| t.parse::<usize>().ok()) else { break };
        // `len` comes from the file: no addition on it may wrap.
        let Some(end) = pos.checked_add(len).filter(|end| *end <= body.len()) else { break };
        if len <= sp + 1 {
            break;
        }
        let rec = &body[pos + sp + 1..end];
        let rec = rec.strip_suffix(b"\n").unwrap_or(rec);
        if let Some(eq) = rec.iter().position(|c| *c == b'=') {
            out.push((String::from_utf8_lossy(&rec[..eq]).into_owned(), String::from_utf8_lossy(&rec[eq + 1..]).into_owned()));
        }
        pos = end;
    }
    out
}

fn read_exact_n(r: &mut impl Read, n: u64) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    r.take(n).read_to_end(&mut buf).map_err(damaged)?;
    if buf.len() as u64 != n {
        return Err(damaged("the file ends inside an entry"));
    }
    Ok(buf)
}

fn skip(r: &mut impl Read, n: u64) -> Result<()> {
    let copied = std::io::copy(&mut r.take(n), &mut std::io::sink()).map_err(damaged)?;
    if copied != n {
        return Err(damaged("the file ends inside an entry"));
    }
    Ok(())
}

fn padding(size: u64) -> u64 {
    (512 - size % 512) % 512
}

/// Names that can be an image config (`<64 hex>.json`) or a blob (`blobs/sha256/<64 hex>`): the hex.
fn digest_of_path(p: &str) -> Option<String> {
    let base = match p.strip_prefix("blobs/sha256/") {
        Some(b) => b,
        None if !p.contains('/') => p,
        None => return None,
    };
    let hex = base.strip_suffix(".json").unwrap_or(base);
    (hex.len() == 64 && hex.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))).then(|| hex.to_string())
}

fn refuse(msg: String) -> Error {
    Error::Other(msg)
}

fn scan_entries<R: Read>(r: &mut Counting<R>) -> Result<Found> {
    let mut found = Found::default();
    // Long-name / PAX headers waiting for the entry they describe.
    let mut pending = Pending::default();
    let mut hashed = 0usize;
    let mut block = [0u8; 512];
    loop {
        let first = found.entries == 0;
        let got = read_up_to(r, &mut block).map_err(|e| if first { Error::Other(NOT_DOCKER.into()) } else { damaged(e) })?;
        if got < 512 {
            return Err(if first { Error::Other(NOT_DOCKER.into()) } else { damaged("the file ends without an end marker") });
        }
        if block.iter().all(|b| *b == 0) {
            break;
        }
        let Some(hdr) = parse_header(&block) else {
            return Err(if first { Error::Other(NOT_DOCKER.into()) } else { damaged("unreadable entry header") });
        };
        found.entries = found.entries.saturating_add(1);
        // Long names and PAX records: small, read here, and applied to the next entry. Anything
        // bigger than the limit is refused before a byte of it is read.
        if matches!(hdr.kind, b'L' | b'K' | b'x' | b'g' | b'X') {
            if hdr.size > META_MAX {
                return Err(refuse("This file has an oversized header entry, so it is not a Docker image file.".into()));
            }
            let body = read_exact_n(r, hdr.size)?;
            skip(r, padding(hdr.size))?;
            match hdr.kind {
                b'L' => {
                    pending.note(b'L', false)?;
                    pending.name = Some(cstr(&body).to_vec());
                }
                b'K' => pending.note(b'K', false)?,
                b'x' => {
                    let records = parse_pax(&body);
                    pending.note(b'x', records.iter().any(|(k, _)| k == "path"))?;
                    for (k, v) in records {
                        match k.as_str() {
                            "path" => pending.name = Some(v.into_bytes()),
                            "size" => pending.size = v.parse().ok(),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let raw_name = pending.name.take().unwrap_or(hdr.name);
        // Links, directories and devices carry no data whatever their size field says.
        let size = if matches!(hdr.kind, b'1'..=b'6') { 0 } else { pending.size.take().unwrap_or(hdr.size) };
        pending = Pending::default();
        let name = clean_path(&raw_name)?;
        let regular = matches!(hdr.kind, b'0' | 0);
        let is_link = matches!(hdr.kind, b'1' | b'2');
        check_placement(&mut found, &name, is_link)?;
        if name == "manifest.json" || name == "index.json" || name == "repositories" {
            // Docker's loader takes the LAST such entry and follows links: anything but exactly one
            // regular file would let it see other names than the ones shown to the user.
            if !regular {
                return Err(refuse(format!("{name} in this file is not a regular file, so it is not a normal Docker image file.")));
            }
            let slot = match name.as_str() {
                "manifest.json" => &mut found.manifest,
                "index.json" => &mut found.index,
                _ => &mut found.repositories,
            };
            if slot.is_some() {
                return Err(refuse(format!("This file has {name} more than once, so it is not a normal Docker image file.")));
            }
            if size > JSON_MAX {
                return Err(refuse(format!("{name} in this file is larger than {} MB. Real image files have a small one, so this is not a normal Docker image file.", JSON_MAX / MIB)));
            }
            *slot = Some(read_exact_n(r, size)?);
            skip(r, padding(size))?;
            continue;
        }
        // `docker save` only ever links a layer to the same layer of another image folder. A link
        // anywhere else could redirect later entries (`x -> .`, then `x/manifest.json`) and make
        // Docker's loader write over a file we have already read.
        if is_link && !name.ends_with("/layer.tar") {
            return Err(refuse(format!("This file has a link (“{}”) that Docker image files do not have, so it is not a normal Docker image file.", name.chars().take(80).collect::<String>())));
        }
        if digest_of_path(&name).is_some() {
            // Every path that could be an image config or manifest is recorded, whatever it is or
            // however big: a second entry of the same path, a link, or a file too large to hash
            // leaves it untrusted (`None`), because which one Docker takes is not ours to guess.
            if found.hashes.contains_key(&name) {
                found.hashes.insert(name.clone(), None);
                if let Some(old) = found.blobs.remove(&name) {
                    found.kept -= old.len();
                }
                skip_entry(r, size)?;
                continue;
            }
            if found.hashes.len() >= PATHS_MAX {
                return Err(refuse("This file has far too many entries to be a normal Docker image file.".into()));
            }
            if regular && size <= HASH_FILE_MAX && hashed < HASH_COUNT_MAX {
                hashed += 1;
                let keep = size <= BLOB_KEEP_MAX && found.kept + size as usize <= BLOB_KEEP_TOTAL;
                let mut kept: Vec<u8> = Vec::new();
                let mut hasher = Sha256::new();
                let mut left = size;
                let mut buf = [0u8; 64 * 1024];
                while left > 0 {
                    let want = left.min(buf.len() as u64) as usize;
                    let n = r.read(&mut buf[..want]).map_err(damaged)?;
                    if n == 0 {
                        return Err(damaged("the file ends inside an entry"));
                    }
                    hasher.update(&buf[..n]);
                    if keep {
                        kept.extend_from_slice(&buf[..n]);
                    }
                    left -= n as u64;
                }
                skip(r, padding(size))?;
                found.hashes.insert(name.clone(), Some(format!("{:x}", hasher.finalize())));
                if keep {
                    found.kept += kept.len();
                    found.blobs.insert(name, kept);
                }
            } else {
                found.hashes.insert(name, None);
                skip_entry(r, size)?;
            }
            continue;
        }
        skip_entry(r, size)?;
    }
    Ok(found)
}

/// Where an entry sits relative to links and folders seen so far (see `Found::links`).
fn check_placement(found: &mut Found, name: &str, is_link: bool) -> Result<()> {
    let bad = |why: &str| refuse(format!("This file is not a normal Docker image file: “{}” {why}.", name.chars().take(80).collect::<String>()));
    if found.links.contains(name) {
        return Err(bad("repeats the name of a link"));
    }
    let mut prefix = String::new();
    let parts: Vec<&str> = name.split('/').collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(part);
        if found.links.contains(&prefix) {
            return Err(bad("goes through a link"));
        }
        if !found.parents.contains(&prefix) {
            if found.parents.len() >= PATHS_MAX {
                return Err(refuse("This file has far too many entries to be a normal Docker image file.".into()));
            }
            found.parents.insert(prefix.clone());
        }
    }
    if is_link {
        if found.parents.contains(name) {
            return Err(bad("is a link in the place of a folder that already has files"));
        }
        if found.links.len() >= PATHS_MAX {
            return Err(refuse("This file has far too many entries to be a normal Docker image file.".into()));
        }
        found.links.insert(name.to_string());
    }
    Ok(())
}

/// Skip an entry's data and its padding; a size that cannot be added up is refused.
fn skip_entry(r: &mut impl Read, size: u64) -> Result<()> {
    let total = size.checked_add(padding(size)).ok_or_else(|| refuse("An entry in this file claims an impossible size, so it is not a Docker image file.".into()))?;
    skip(r, total)
}

#[derive(Default)]
struct Pending {
    name: Option<Vec<u8>>,
    size: Option<u64>,
    long: bool,
    link: bool,
    pax: bool,
    pax_path: bool,
}

impl Pending {
    /// A long-name (`L`), link-name (`K`) or PAX (`x`) header came before the entry. Docker reads
    /// the entry with Go's rules, which differ in what wins when several are given, so more than
    /// one header of a kind, or a long name together with a PAX path, is refused.
    fn note(&mut self, kind: u8, pax_path: bool) -> Result<()> {
        let again = match kind {
            b'L' => std::mem::replace(&mut self.long, true),
            b'K' => std::mem::replace(&mut self.link, true),
            _ => std::mem::replace(&mut self.pax, true),
        };
        self.pax_path |= pax_path;
        if again || (self.long && self.pax_path) {
            return Err(refuse("This file has conflicting name headers for one entry, so it is not a normal Docker image file.".into()));
        }
        Ok(())
    }
}

/// The entry name the way Go's path cleaning sees it: empty and `.` parts dropped (`.//a`, `a/.`,
/// `a/`), `..` refused. Names that could escape a folder if the file were ever extracted are
/// refused (we only read, but a file like that is not a Docker image). Link targets are not looked
/// at: old `docker save` files link to `../<id>/layer.tar` on purpose.
fn clean_path(raw: &[u8]) -> Result<String> {
    let name = String::from_utf8_lossy(raw).into_owned();
    let bad = name.contains('\0')
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.split(['/', '\\']).any(|part| part == "..")
        || (name.len() >= 2 && name.as_bytes()[1] == b':' && name.as_bytes()[0].is_ascii_alphabetic());
    if bad {
        let shown: String = name.chars().filter(|c| !c.is_control()).take(80).collect();
        return Err(Error::Other(format!("This file has an unsafe path inside it (“{shown}”), so it is not a Docker image file.")));
    }
    Ok(name.split('/').filter(|p| !p.is_empty() && *p != ".").collect::<Vec<_>>().join("/"))
}

/// One name given to an image by a list in the archive, and the file whose hash is its id.
struct Named {
    tag: String,
    path: Option<String>,
}

fn tags_of(found: &Found) -> Result<(Vec<String>, Vec<ImageTagIds>, u32)> {
    let manifest = found.manifest.as_deref().map(parse_manifest);
    let index = found.index.as_deref().map(parse_index);
    if found.manifest.is_none() && found.index.is_none() {
        return Err(Error::Other(if found.repositories.is_some() {
            "This is an old Docker export format (it has a repositories file but no manifest.json), which Rookery does not import.".into()
        } else {
            NOT_DOCKER.into()
        }));
    }
    // Names in a `repositories` file are shown too. Real `docker save` / Podman files carry it next
    // to `manifest.json`, and moby only reads it when `manifest.json` is missing (legacy loader), so
    // with a manifest it changes nothing and names the manifest lists keep their proof; names only
    // `repositories` has get no proof, so they warn. Without `manifest.json` (index.json only) it is
    // not known which file the loader goes by, so every name in `repositories` stays unproven.
    let (legacy, mut unreadable) = match found.repositories.as_deref() {
        Some(raw) => parse_repositories(raw)?,
        None => (Vec::new(), 0),
    };
    let (mut classic, mut oci): (Vec<Named>, Vec<Named>) = (Vec::new(), Vec::new());
    let mut images = 0usize;
    let mut error = None;
    for (parsed, into) in [(manifest, &mut classic), (index, &mut oci)] {
        match parsed {
            Some(Ok((names, n, bad))) => {
                images += n;
                unreadable += bad;
                into.extend(names);
            }
            Some(Err(e)) => error = Some(e),
            None => {}
        }
    }
    // One unreadable list is fine while the other one is good.
    if images == 0 {
        return Err(error.unwrap_or_else(|| Error::Other("This Docker image file contains no images.".into())));
    }
    let mut tags: Vec<String> = Vec::new();
    for tag in classic.iter().chain(oci.iter()).map(|n| &n.tag).chain(legacy.iter()) {
        if !tags.contains(tag) {
            if tags.len() >= TAGS_MAX {
                return Err(Error::Other(format!("This file names more than {TAGS_MAX} images, which is not a normal Docker image file.")));
            }
            tags.push(tag.clone());
        }
    }
    let tag_ids = tags
        .iter()
        .filter_map(|t| {
            if found.manifest.is_none() && legacy.contains(t) {
                return None;
            }
            let m: Vec<&Named> = classic.iter().filter(|n| &n.tag == t).collect();
            let i: Vec<&Named> = oci.iter().filter(|n| &n.tag == t).collect();
            proven_ids(&m, &i, found).map(|ids| ImageTagIds { tag: t.clone(), ids })
        })
        .collect();
    Ok((tags, tag_ids, unreadable))
}

/// The hash of the file at `path` when the archive holds exactly one such file and its bytes
/// really hash to the hex in its name.
fn verified(found: &Found, path: Option<&str>) -> Option<String> {
    let path = path?;
    let hex = digest_of_path(path)?;
    (found.hashes.get(path)?.as_deref() == Some(hex.as_str())).then_some(hex)
}

/// `config.digest` (hex) of an OCI image manifest.
fn config_digest(blob: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(blob).ok()?;
    v.get("config")?.get("digest")?.as_str()?.strip_prefix("sha256:").map(str::to_string)
}

/// The ids a name will have after loading, or `None` (= the user gets the warning) unless every
/// list that names it names it exactly once, every pairing is verified, and when both lists name it
/// they agree: the OCI manifest's config digest is the classic list's `Config`. Without that, one
/// list could show a harmless pairing while the loader acts on the other.
fn proven_ids(m: &[&Named], i: &[&Named], found: &Found) -> Option<Vec<String>> {
    if m.len() > 1 || i.len() > 1 {
        return None;
    }
    let classic = match m.first() {
        Some(n) => Some(verified(found, n.path.as_deref())?),
        None => None,
    };
    let oci = match i.first() {
        Some(n) => Some((verified(found, n.path.as_deref())?, n.path.clone()?)),
        None => None,
    };
    let manifest_config = oci.as_ref().and_then(|(_, path)| found.blobs.get(path)).and_then(|b| config_digest(b));
    match (classic, oci) {
        (Some(c), Some((d, _))) => (manifest_config.as_deref() == Some(c.as_str())).then(|| vec![c, d]),
        (Some(c), None) => Some(vec![c]),
        (None, Some((d, _))) => {
            let mut ids = vec![d];
            // The config of a verified manifest is an id too (classic store loading an OCI file).
            if let Some(c) = manifest_config {
                if verified(found, Some(&format!("blobs/sha256/{c}"))).as_deref() == Some(c.as_str()) {
                    ids.push(c);
                }
            }
            Some(ids)
        }
        (None, None) => None,
    }
}

fn parse_manifest(raw: &[u8]) -> Result<(Vec<Named>, usize, u32)> {
    let bad = || Error::Other("manifest.json in this file is damaged, so it is not a usable Docker image file.".into());
    let v: serde_json::Value = serde_json::from_slice(raw).map_err(|_| bad())?;
    let list = v.as_array().ok_or_else(bad)?;
    let mut names = Vec::new();
    let mut unreadable = 0u32;
    for e in list {
        let config = e.get("Config").and_then(|c| c.as_str()).and_then(|c| clean_path(c.as_bytes()).ok());
        for t in e.get("RepoTags").and_then(|t| t.as_array()).into_iter().flatten() {
            match t.as_str().and_then(normalize_ref) {
                Some(tag) => names.push(Named { tag, path: config.clone() }),
                None => unreadable = unreadable.saturating_add(1),
            }
        }
    }
    Ok((names, list.len(), unreadable))
}

fn parse_index(raw: &[u8]) -> Result<(Vec<Named>, usize, u32)> {
    let bad = || Error::Other("index.json in this file is damaged, so it is not a usable Docker image file.".into());
    let v: serde_json::Value = serde_json::from_slice(raw).map_err(|_| bad())?;
    let list = v.get("manifests").and_then(|m| m.as_array()).ok_or_else(bad)?;
    let mut names = Vec::new();
    let mut unreadable = 0u32;
    for m in list {
        let blob = m.get("digest").and_then(|d| d.as_str()).and_then(|d| d.strip_prefix("sha256:")).map(|h| format!("blobs/sha256/{h}"));
        // One descriptor can carry the same name twice (`image.name` and `ref.name`): that is one naming.
        let mut seen: Vec<String> = Vec::new();
        let mut given = 0u32;
        for key in ["io.containerd.image.name", "org.opencontainers.image.ref.name"] {
            // `ref.name` is often only the tag (`latest`) next to a full name: not a name by itself.
            let value = m.get("annotations").and_then(|a| a.get(key)).and_then(|s| s.as_str());
            given += u32::from(value.is_some());
            if let Some(tag) = value.and_then(normalize_ref) {
                if !seen.contains(&tag) {
                    seen.push(tag.clone());
                    names.push(Named { tag, path: blob.clone() });
                }
            }
        }
        // Names were given, but none of them is a full `name:tag` (a bare `app`): the loader may still use one.
        if given > 0 && seen.is_empty() {
            unreadable = unreadable.saturating_add(1);
        }
    }
    Ok((names, list.len(), unreadable))
}

/// Old-style `repositories` file: `{"repo": {"tag": "<layer id>"}}` → names, and how many could not be read.
fn parse_repositories(raw: &[u8]) -> Result<(Vec<String>, u32)> {
    let bad = || Error::Other("repositories in this file is damaged, so it is not a usable Docker image file.".into());
    let v: serde_json::Value = serde_json::from_slice(raw).map_err(|_| bad())?;
    let repos = v.as_object().ok_or_else(bad)?;
    let (mut tags, mut unreadable) = (Vec::new(), 0u32);
    for (repo, per_tag) in repos {
        for tag in per_tag.as_object().ok_or_else(bad)?.keys() {
            match normalize_ref(&format!("{repo}:{tag}")) {
                Some(t) => tags.push(t),
                None => unreadable = unreadable.saturating_add(1),
            }
        }
    }
    Ok((tags, unreadable))
}

/// `docker.io/library/nginx:latest` → `nginx:latest` (how `docker image ls` shows it); a trailing
/// `@sha256:…` is dropped. `None` for anything that is not a full `name:tag` (no tag, digest only,
/// odd characters).
pub fn normalize_ref(r: &str) -> Option<String> {
    let r = r.trim();
    if !valid_image_ref(r) {
        return None;
    }
    let r = r.split('@').next().unwrap_or(r);
    let mut n = r;
    for prefix in ["index.docker.io/", "docker.io/"] {
        if let Some(rest) = n.strip_prefix(prefix) {
            n = rest;
            break;
        }
    }
    if let Some(rest) = n.strip_prefix("library/") {
        if !rest.contains('/') {
            n = rest;
        }
    }
    let last = n.rsplit('/').next().unwrap_or(n);
    let (name, tag) = last.split_once(':')?;
    (!name.is_empty() && !tag.is_empty()).then(|| n.to_string())
}

// ------------------------------------------------------------------ free space

/// One filesystem as `df -Pk` reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct Fs {
    pub device: String,
    pub mount: String,
    pub free: u64,
}

/// The data line of `df -Pk <path>` (POSIX format: one line per filesystem). The columns are read
/// from the right (`1024-blocks Used Available Capacity`) because device and mount point names
/// can contain spaces.
pub fn parse_df(out: &str) -> Option<Fs> {
    let line = out.lines().skip_while(|l| !l.trim_start().starts_with("Filesystem")).nth(1).or_else(|| out.lines().nth(1))?;
    let t: Vec<&str> = line.split_whitespace().collect();
    let pct = t.iter().rposition(|x| x.ends_with('%') && x[..x.len() - 1].chars().all(|c| c.is_ascii_digit()) || *x == "-")?;
    if pct < 4 || pct + 1 >= t.len() {
        return None;
    }
    let avail_kb: u64 = t[pct - 1].parse().ok()?;
    t[pct - 2].parse::<u64>().ok()?;
    t[pct - 3].parse::<u64>().ok()?;
    Some(Fs { device: t[..pct - 3].join(" "), mount: t[pct + 1..].join(" "), free: avail_kb.saturating_mul(1024) })
}

/// ZFS-like `pool/dataset` (not a path, no `host:`): the pool.
fn pool_of(device: &str) -> Option<&str> {
    let (pool, _) = device.split_once('/')?;
    (!pool.is_empty() && !pool.contains(':')).then_some(pool)
}

/// Do these share their free space? Same mount point, the same real block device (bind mounts,
/// subfolders of one disk), or datasets of one pool (`rpool/ROOT`, `rpool/var`). `tmpfs` /
/// `overlay` names say nothing, so they only match by mount.
pub fn same_disk(a: &Fs, b: &Fs) -> bool {
    a.mount == b.mount
        || (a.device == b.device && a.device.starts_with("/dev/"))
        || (!a.device.starts_with('/') && pool_of(&a.device).is_some() && pool_of(&a.device) == pool_of(&b.device))
}

/// Safety margin on top of what a copy needs: 5%, at least 256 MB.
fn margin(n: u64) -> u64 {
    (n / 20).max(256 * MIB)
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ImportSpaceReport {
    /// false for this computer: no upload, nothing measured.
    pub checked: bool,
    pub upload_dir: Option<String>,
    /// The upload folder is not `/var/tmp` (the home folder is used instead).
    pub upload_in_home: bool,
    #[ts(type = "number | null")]
    pub upload_free: Option<u64>,
    pub docker_root: Option<String>,
    #[ts(type = "number | null")]
    pub docker_free: Option<u64>,
    /// The upload folder and Docker's folder are on one disk, so the two needs add up.
    pub shared_disk: bool,
    /// Archive size plus margin.
    #[ts(type = "number")]
    pub needed_upload: u64,
    /// Peak need on Docker's folder: twice the unpacked size (loading unpacks to a temporary
    /// place first) plus margin.
    #[ts(type = "number")]
    pub needed_docker: u64,
    /// Why the import must not start (not enough space).
    pub problem: Option<String>,
    /// Something could not be measured; the import may still go on.
    pub warning: Option<String>,
}

impl ImportSpaceReport {
    pub fn unchecked() -> Self {
        Self { checked: false, upload_dir: None, upload_in_home: false, upload_free: None, docker_root: None, docker_free: None, shared_disk: false, needed_upload: 0, needed_docker: 0, problem: None, warning: None }
    }
}

pub fn human(n: u64) -> String {
    if n < 1000 {
        return format!("{n} B");
    }
    let units = ["kB", "MB", "GB", "TB"];
    let (mut v, mut u) = (n as f64, 0usize);
    v /= 1000.0;
    while v >= 1000.0 && u < units.len() - 1 {
        v /= 1000.0;
        u += 1;
    }
    if v >= 100.0 { format!("{v:.0} {}", units[u]) } else { format!("{v:.1} {}", units[u]) }
}

/// What is known about Docker's data folder on the server.
pub enum DockerSide<'a> {
    /// Folder, and its filesystem if `df` answered.
    Known(&'a str, Option<&'a Fs>),
    /// `docker info` did not answer.
    Unknown,
    /// The server's Docker CLI talks to another Docker (context / `DOCKER_HOST`): the text says which.
    Elsewhere(&'a str),
}

/// Is there room? `upload` = (folder, its filesystem if it could be read). A half that could not
/// be measured is skipped with a warning; a measured half that is too small is a `problem`.
pub fn decide_space(upload: (&str, Option<&Fs>), docker: DockerSide<'_>, archive_bytes: u64, tar_bytes: u64) -> ImportSpaceReport {
    let needed_upload = archive_bytes.saturating_add(margin(archive_bytes));
    let needed_docker = tar_bytes.saturating_mul(2).saturating_add(margin(tar_bytes));
    let (up_dir, up_fs) = upload;
    let (docker_root, docker_fs, elsewhere) = match docker {
        DockerSide::Known(root, fs) => (Some(root.to_string()), fs, None),
        DockerSide::Unknown => (None, None, None),
        DockerSide::Elsewhere(what) => (None, None, Some(what)),
    };
    let mut r = ImportSpaceReport {
        checked: true,
        upload_dir: Some(up_dir.to_string()),
        upload_in_home: up_dir != DEFAULT_UPLOAD_DIR,
        upload_free: up_fs.map(|f| f.free),
        docker_root,
        docker_free: docker_fs.map(|f| f.free),
        shared_disk: false,
        needed_upload,
        needed_docker,
        problem: None,
        warning: None,
    };
    let mut warnings = Vec::new();
    let mut problems = Vec::new();
    if up_fs.is_none() {
        warnings.push(format!("Could not read the free space in {up_dir}, so it was not checked."));
    }
    match (docker_fs, elsewhere) {
        (_, Some(what)) => warnings.push(format!("This server's Docker CLI uses {what}, so Docker's data folder was not checked.")),
        (None, None) => warnings.push("Could not read Docker's data folder, so the space for loading the images was not checked.".to_string()),
        _ => {}
    }
    let peak = format!("images {} unpacked, up to twice that while loading, plus a safety margin", human(tar_bytes));
    match (up_fs, docker_fs) {
        (Some(u), Some(d)) if same_disk(u, d) => {
            r.shared_disk = true;
            let need = needed_upload.saturating_add(needed_docker);
            if u.free < need {
                problems.push(format!(
                    "Not enough free space. {up_dir} and Docker's folder {} are on the same disk with {} free, and the upload plus loading needs up to {} at peak (file {}, {peak}).",
                    r.docker_root.as_deref().unwrap_or("?"),
                    human(u.free),
                    human(need),
                    human(archive_bytes),
                ));
            }
        }
        (u, d) => {
            if let Some(u) = u {
                if u.free < needed_upload {
                    problems.push(format!("Not enough free space to upload the file: {up_dir} has {} free, the upload needs {} (file {} plus a safety margin).", human(u.free), human(needed_upload), human(archive_bytes)));
                }
            }
            if let Some(d) = d {
                if d.free < needed_docker {
                    problems.push(format!(
                        "Not enough free space for Docker to load the images: {} has {} free, loading needs up to {} at peak ({peak}).",
                        r.docker_root.as_deref().unwrap_or("Docker's folder"),
                        human(d.free),
                        human(needed_docker),
                    ));
                }
            }
        }
    }
    r.problem = (!problems.is_empty()).then(|| problems.join(" "));
    r.warning = (!warnings.is_empty()).then(|| warnings.join(" "));
    r
}

const DIR_MARK: &str = "ROOKERY-DIR:";

/// Output of the upload-folder probe: the marked folder line (login banners before it are
/// ignored) and the `df` text after it.
pub fn parse_upload_probe(out: &str) -> Result<(String, Option<Fs>)> {
    let none = || Error::Other("No folder to upload to: /var/tmp is not writable on the server and it has no home folder.".into());
    let mut lines = out.lines();
    let dir = lines.by_ref().find_map(|l| l.strip_prefix(DIR_MARK)).ok_or_else(none)?;
    let dir = dir.trim().trim_end_matches('/');
    if !dir.starts_with('/') || dir.chars().any(char::is_control) {
        return Err(none());
    }
    let df: Vec<&str> = lines.collect();
    Ok((dir.to_string(), parse_df(&df.join("\n"))))
}

/// What the Docker CLI of the login points at, if not the default local Docker.
pub fn parse_context_probe(out: &str) -> Option<String> {
    let get = |mark: &str| out.lines().find_map(|l| l.strip_prefix(mark)).map(str::trim).unwrap_or("");
    let (ctx, host) = (get("ROOKERY-CTX:"), get("ROOKERY-HOST:"));
    let short = |s: &str| s.chars().filter(|c| !c.is_control()).take(80).collect::<String>();
    if !host.is_empty() {
        Some(format!("DOCKER_HOST={}", short(host)))
    } else if !ctx.is_empty() && ctx != "default" {
        Some(format!("the Docker context “{}”", short(ctx)))
    } else {
        None
    }
}

/// `Loaded image: nginx:latest` / `Loaded image ID: sha256:…` lines of `docker load`: the names
/// (or `sha256:<id>` for images without a tag).
pub fn parse_loaded(out: &str) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for l in out.lines().map(str::trim) {
        let item = l.strip_prefix("Loaded image ID:").or_else(|| l.strip_prefix("Loaded image:")).map(str::trim).filter(|s| !s.is_empty());
        if let Some(s) = item {
            if !v.iter().any(|x| x == s) {
                v.push(s.to_string());
            }
        }
    }
    v
}

// ------------------------------------------------------------------ the job

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ImageImportRequest {
    pub host_id: String,
    /// Absolute path of the `.tar` / `.tar.gz` / `.tgz` chosen in the file dialog.
    pub path: String,
    /// What the user confirmed: the job reads the file again and refuses if it is different now.
    #[ts(type = "number")]
    pub file_bytes: u64,
    pub tags: Vec<String>,
    pub tag_ids: Vec<ImageTagIds>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ImageImportJob {
    pub id: String,
    pub host_id: String,
    pub path: String,
    /// running | done | failed | cancelled
    pub state: String,
    /// While running: checking | uploading | loading
    pub phase: String,
    /// Bytes uploaded so far (servers only).
    #[ts(type = "number")]
    pub bytes: u64,
    /// File size.
    #[ts(type = "number")]
    pub total: u64,
    /// What `docker load` reported: names, or `sha256:<id>` for untagged images.
    pub loaded: Vec<String>,
    pub error: Option<String>,
    /// Things the user should know that are not the error: space not measurable, the temporary
    /// file left on the server, a cancelled load that may still finish.
    pub note: Option<String>,
}

impl ImageImportJob {
    fn add_note(&mut self, text: &str) {
        self.note = Some(match self.note.take() {
            Some(n) => format!("{n} {text}"),
            None => text.to_string(),
        });
    }
}

enum Outcome {
    Done,
    Cancelled,
}

/// The file is what the user confirmed.
fn check_unchanged(info: &ImageArchiveInfo, req: &ImageImportRequest) -> Result<()> {
    if info.file_bytes != req.file_bytes || info.tags != req.tags || info.tag_ids != req.tag_ids {
        return Err(Error::Other(CHANGED.into()));
    }
    Ok(())
}

pub struct ImageImports {
    db: Arc<Db>,
    conns: Arc<ConnectionManager>,
    sudo: Arc<Sudo>,
    sftp: Arc<Sftp>,
    events: broadcast::Sender<CoreEvent>,
    /// Running jobs: id → (cancel flag, host). An entry goes away only after the temporary file
    /// is cleaned up (or the cleanup failed), so "nothing running" means "nothing left to clean".
    running: Mutex<HashMap<String, (Arc<AtomicBool>, String)>>,
    /// Set while the app locks: no job starts.
    stopping: AtomicBool,
}

impl ImageImports {
    pub fn new(db: Arc<Db>, conns: Arc<ConnectionManager>, sudo: Arc<Sudo>, sftp: Arc<Sftp>, events: broadcast::Sender<CoreEvent>) -> Self {
        Self { db, conns, sudo, sftp, events, running: Default::default(), stopping: AtomicBool::new(false) }
    }

    fn check_path(path: &str) -> Result<PathBuf> {
        let p = PathBuf::from(path);
        if !p.is_absolute() {
            return Err(Error::Other("Choose the file in the file dialog.".into()));
        }
        Ok(p)
    }

    /// [`inspect_archive`] off the async workers.
    pub async fn inspect(&self, path: &str) -> Result<ImageArchiveInfo> {
        Self::inspect_with(path, None).await
    }

    async fn inspect_with(path: &str, cancel: Option<Arc<AtomicBool>>) -> Result<ImageArchiveInfo> {
        let p = Self::check_path(path)?;
        tokio::task::spawn_blocking(move || inspect_archive_with(&p, cancel))
            .await
            .map_err(|e| Error::Other(format!("reading the file failed: {e}")))?
    }

    /// Free space before the upload. This computer: nothing to check.
    pub async fn check_space(&self, host_id: &str, archive_bytes: u64, tar_bytes: u64) -> Result<ImportSpaceReport> {
        if host_id == crate::computer::ID {
            return Ok(ImportSpaceReport::unchecked());
        }
        self.db.get_host(host_id)?;
        let lease = self.conns.acquire(host_id).await?;
        let h = lease.handle().await?;
        self.space_report(&h, host_id, archive_bytes, tar_bytes).await
    }

    async fn space_report(&self, h: &SshHandle, host_id: &str, archive_bytes: u64, tar_bytes: u64) -> Result<ImportSpaceReport> {
        let (dir, up_fs) = probe_upload_dir(h).await?;
        let docker = self.probe_docker_root(h, host_id).await?;
        let side = match &docker {
            DockerProbe::Root(root, fs) => DockerSide::Known(root, fs.as_ref()),
            DockerProbe::Unknown => DockerSide::Unknown,
            DockerProbe::Elsewhere(what) => DockerSide::Elsewhere(what),
        };
        let mut r = decide_space((&dir, up_fs.as_ref()), side, archive_bytes, tar_bytes);
        if r.upload_in_home && self.sudo.enabled(host_id) {
            let w = format!("The file goes to {dir} because {DEFAULT_UPLOAD_DIR} is not writable. If that home folder is on NFS, root (sudo) may not be able to read the file and docker load can fail.");
            r.warning = Some(match r.warning.take() {
                Some(x) => format!("{x} {w}"),
                None => w,
            });
        }
        Ok(r)
    }

    /// Docker's data folder and its filesystem; `Unknown` when `docker info` does not answer.
    async fn probe_docker_root(&self, h: &SshHandle, host_id: &str) -> Result<DockerProbe> {
        let ctx = exec(h, "c=$(docker context show 2>/dev/null); printf 'ROOKERY-CTX:%s\\nROOKERY-HOST:%s\\n' \"$c\" \"${DOCKER_HOST:-}\"", Duration::from_secs(20)).await;
        if let Some(what) = ctx.ok().and_then(|o| parse_context_probe(&o.stdout)) {
            return Ok(DockerProbe::Elsewhere(what));
        }
        let out = match self.sudo.exec_docker(h, host_id, &format!("info --format {}", sh_quote("{{.DockerRootDir}}")), Duration::from_secs(30)).await {
            Ok(o) if o.exit == Some(0) => o,
            Ok(_) => return Ok(DockerProbe::Unknown),
            // A refused sudo password must be seen, not skipped.
            Err(e) if self.sudo.state(host_id).error.is_some() => return Err(e),
            Err(_) => return Ok(DockerProbe::Unknown),
        };
        let Some(root) = out.stdout.lines().map(str::trim).rev().find(|l| l.starts_with('/') && !l.chars().any(char::is_control)) else {
            return Ok(DockerProbe::Unknown);
        };
        let fs = exec(h, &format!("df -Pk {} 2>&1", sh_quote(root)), Duration::from_secs(20)).await.ok().and_then(|o| if o.exit == Some(0) { parse_df(&o.stdout) } else { None });
        Ok(DockerProbe::Root(root.to_string(), fs))
    }

    /// Check the request and start the import; progress comes as `CoreEvent::ImageImport`.
    pub fn start(self: &Arc<Self>, req: ImageImportRequest) -> Result<String> {
        Self::check_path(&req.path)?;
        let meta = std::fs::metadata(&req.path).map_err(|e| Error::Other(format!("Cannot read {}: {e}", req.path)))?;
        if !meta.is_file() {
            return Err(Error::Other("Choose a file, not a folder.".into()));
        }
        if req.host_id != crate::computer::ID {
            self.db.get_host(&req.host_id)?;
        }
        let id = new_id();
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut running = self.running.lock();
            if self.stopping.load(Ordering::SeqCst) {
                return Err(Error::Other("Rookery is locking; no import can start now.".into()));
            }
            if running.values().any(|(_, host)| *host == req.host_id) {
                return Err(Error::Other("Another import to this server is still running. Wait for it to finish or cancel it.".into()));
            }
            running.insert(id.clone(), (cancel.clone(), req.host_id.clone()));
        }
        let this = self.clone();
        let job_id = id.clone();
        tokio::spawn(async move {
            let initial = ImageImportJob {
                id: job_id.clone(),
                host_id: req.host_id.clone(),
                path: req.path.clone(),
                state: "running".into(),
                phase: "checking".into(),
                bytes: 0,
                total: meta.len(),
                loaded: Vec::new(),
                error: None,
                note: None,
            };
            this.emit(&initial);
            // Shared with the worker so the cleanup still knows the file if the worker panics.
            let temp: Arc<Mutex<Option<String>>> = Default::default();
            // One session for the whole job, cleanup included: it stays open even if every other user lets go.
            let hold = if req.host_id == crate::computer::ID { None } else { until_cancelled(this.conns.acquire(&req.host_id), &cancel).await.and_then(|r| r.ok()) };
            let worker = {
                let (this, req, cancel, temp, mut job) = (this.clone(), req.clone(), cancel.clone(), temp.clone(), initial.clone());
                tokio::spawn(async move {
                    match this.run(&req, &cancel, &mut job, &temp).await {
                        Ok(Outcome::Done) => job.state = "done".into(),
                        Ok(Outcome::Cancelled) => job.state = "cancelled".into(),
                        Err(e) => {
                            job.state = "failed".into();
                            job.error = Some(e.to_string());
                        }
                    }
                    job
                })
            };
            let mut job = match worker.await {
                Ok(job) => job,
                Err(_) => {
                    let mut j = initial;
                    j.state = "failed".into();
                    j.error = Some("The import stopped because of an internal error.".into());
                    j
                }
            };
            // The temporary file goes in every case.
            let leftover = temp.lock().take();
            if let Some(path) = leftover {
                if let Err(e) = this.sftp.remove_file_best_effort(&req.host_id, &path).await {
                    let why = clean_message(&e.to_string());
                    job.add_note(&format!("The temporary file {path} could not be deleted from the server ({why}). Delete it by hand."));
                }
            }
            drop(hold);
            job.phase = String::new();
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

    /// Lock / quit: no new job starts and every running one is cancelled. [`Self::allow_new`] undoes it.
    pub fn begin_shutdown(&self) {
        // Under the same lock as `start`, so no job slips in between the flag and the cancel.
        let running = self.running.lock();
        self.stopping.store(true, Ordering::SeqCst);
        for (flag, _) in running.values() {
            flag.store(true, Ordering::SeqCst);
        }
    }

    pub fn allow_new(&self) {
        self.stopping.store(false, Ordering::SeqCst);
    }

    pub fn has_running(&self) -> bool {
        !self.running.lock().is_empty()
    }

    /// Wait (at most `max`) until every job has finished, temporary files cleaned up included.
    /// Used before connections close (vault lock, quit) so the cleanup can still reach the server.
    pub async fn wait_idle(&self, max: Duration) {
        let end = Instant::now() + max;
        while self.has_running() && Instant::now() < end {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn emit(&self, job: &ImageImportJob) {
        let _ = self.events.send(CoreEvent::ImageImport { job: job.clone() });
    }

    async fn run(&self, req: &ImageImportRequest, cancel: &Arc<AtomicBool>, job: &mut ImageImportJob, temp: &Mutex<Option<String>>) -> Result<Outcome> {
        // Every wait below can be abandoned by Cancel (a stalled connection must not trap the job).
        macro_rules! stoppable {
            ($f:expr) => {
                match until_cancelled($f, cancel).await {
                    Some(v) => v,
                    None => return Ok(Outcome::Cancelled),
                }
            };
        }
        // Always read again: the file may have changed since the dialog.
        let info = match stoppable!(Self::inspect_with(&req.path, Some(cancel.clone()))) {
            Ok(i) => i,
            Err(_) if cancel.load(Ordering::SeqCst) => return Ok(Outcome::Cancelled),
            Err(e) => return Err(e),
        };
        check_unchanged(&info, req)?;
        job.total = info.file_bytes;
        if req.host_id == crate::computer::ID {
            return self.load_local(&req.path, cancel, job).await;
        }

        let lease = stoppable!(self.conns.acquire(&req.host_id))?;
        let h = stoppable!(lease.handle())?;
        let space = stoppable!(self.space_report(&h, &req.host_id, info.file_bytes, info.tar_bytes))?;
        if let Some(problem) = space.problem {
            return Err(Error::Other(problem));
        }
        if let Some(w) = space.warning {
            job.add_note(&w);
        }
        let dir = space.upload_dir.unwrap_or_else(|| DEFAULT_UPLOAD_DIR.into());
        // Leftovers of earlier imports that never got cleaned up (a crash): ours only, over a day old, no sudo.
        let sweep = format!("find {} -maxdepth 1 -type f -name 'rookery-import-????????-????-????-????-????????????.tar*' -user \"$(id -u)\" -mmin +1440 -delete 2>/dev/null; true", sh_quote(&dir));
        let _ = stoppable!(exec(&h, &sweep, Duration::from_secs(20)));

        // Unique, private (mode 600, created exclusively); root (sudo) can read it.
        let remote = format!("{dir}/rookery-import-{}.tar{}", job.id, if info.gzip { ".gz" } else { "" });
        *temp.lock() = Some(remote.clone());
        job.phase = "uploading".into();
        self.emit(job);
        let events = self.events.clone();
        let mut snapshot = job.clone();
        let put = self.sftp.put_new_file(&req.host_id, Path::new(&req.path), &remote, cancel, move |bytes| {
            snapshot.bytes = bytes;
            let _ = events.send(CoreEvent::ImageImport { job: snapshot.clone() });
        });
        let sent = match until_cancelled_after(put, cancel, Duration::from_secs(3)).await {
            Some(r) => r?,
            None => {
                // Still stuck in a write after the grace time: the session may be in an unknown state, so it is not reused.
                self.sftp.forget_session(&req.host_id).await;
                false
            }
        };
        if !sent {
            job.add_note("The upload was stopped and nothing was loaded.");
            return Ok(Outcome::Cancelled);
        }
        job.bytes = job.total;
        job.phase = "loading".into();
        self.emit(job);

        let command = format!("load -i {}", sh_quote(&remote));
        let began = Instant::now();
        let load = self.sudo.exec_docker(&h, &req.host_id, &command, Duration::from_secs(LOAD_SECONDS));
        let Some(result) = until_cancelled(load, cancel).await else {
            if began.elapsed() < Duration::from_secs(2) {
                job.add_note("Cancelled just as docker load was starting. It is not known whether it started on the server: refresh the list to check.");
            } else {
                job.add_note("Cancelled while docker load was running. The command was abandoned here but it may still be running on the server: the images may appear anyway, so refresh the list.");
            }
            return Ok(Outcome::Cancelled);
        };
        let out = result.map_err(|e| {
            let m = e.to_string();
            if m.contains("timed out") { Error::Other("docker load did not finish within 30 minutes. It may still be running on the server: refresh the list to see the result.".into()) } else { e }
        })?;
        if out.exit != Some(0) {
            return Err(Error::Other(clean_message(&out.stdout)));
        }
        job.loaded = parse_loaded(&out.stdout);
        Ok(Outcome::Done)
    }

    /// This computer: no upload, `docker load -i <path>` with the path as one argument (no shell).
    async fn load_local(&self, path: &str, cancel: &AtomicBool, job: &mut ImageImportJob) -> Result<Outcome> {
        job.phase = "loading".into();
        self.emit(job);
        let args = vec!["load".to_string(), "-i".to_string(), path.to_string()];
        let run = crate::computer::run_output("docker", &args, None, LOAD_SECONDS, true);
        let Some(result) = until_cancelled(run, cancel).await else {
            job.add_note("Cancelled while docker load was running. The Docker command was stopped, but Docker may already have loaded some images: refresh the list.");
            return Ok(Outcome::Cancelled);
        };
        let out = result.map_err(|e| Error::Other(clean_message(&e.to_string())))?;
        job.loaded = parse_loaded(&out);
        Ok(Outcome::Done)
    }
}

enum DockerProbe {
    Root(String, Option<Fs>),
    Unknown,
    Elsewhere(String),
}

/// The result of `fut`, or `None` as soon as `cancel` is set (the future is dropped).
async fn until_cancelled<F: Future>(fut: F, cancel: &AtomicBool) -> Option<F::Output> {
    until_cancelled_after(fut, cancel, Duration::ZERO).await
}

/// Like [`until_cancelled`], but a future that checks the flag itself gets `grace` to finish on
/// its own after the flag is set, so it is only dropped (abandoned mid-way) when it is stuck.
async fn until_cancelled_after<F: Future>(fut: F, cancel: &AtomicBool, grace: Duration) -> Option<F::Output> {
    tokio::pin!(fut);
    loop {
        tokio::select! {
            r = &mut fut => return Some(r),
            _ = tokio::time::sleep(Duration::from_millis(150)) => {
                if cancel.load(Ordering::SeqCst) {
                    return tokio::time::timeout(grace, &mut fut).await.ok();
                }
            }
        }
    }
}

/// `/var/tmp` (disk-backed, unlike `/tmp` which can be tmpfs) when it is writable, else `$HOME`;
/// with the filesystem the folder is on (`None` when `df` did not answer).
async fn probe_upload_dir(h: &SshHandle) -> Result<(String, Option<Fs>)> {
    let script = format!("d={DEFAULT_UPLOAD_DIR}; if [ ! -d \"$d\" ] || [ ! -w \"$d\" ]; then d=\"$HOME\"; fi; printf '{DIR_MARK}%s\\n' \"$d\"; df -Pk \"$d\" 2>&1");
    let out = exec(h, &script, Duration::from_secs(20)).await?;
    parse_upload_probe(&out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ---- tiny tar writer: full control over names, types and sizes

    fn header(name: &str, size: u64, kind: u8, link: &str) -> [u8; 512] {
        let mut h = [0u8; 512];
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[100..107].copy_from_slice(b"0000644");
        h[108..115].copy_from_slice(b"0000000");
        h[116..123].copy_from_slice(b"0000000");
        h[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
        h[136..147].copy_from_slice(b"00000000000");
        h[148..156].copy_from_slice(b"        ");
        h[156] = kind;
        h[157..157 + link.len()].copy_from_slice(link.as_bytes());
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        let sum: u32 = h.iter().map(|b| *b as u32).sum();
        h[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        h
    }

    fn file(out: &mut Vec<u8>, name: &str, data: &[u8]) {
        out.extend_from_slice(&header(name, data.len() as u64, b'0', ""));
        out.extend_from_slice(data);
        out.resize(out.len().div_ceil(512) * 512, 0);
    }

    fn finish(mut out: Vec<u8>) -> Vec<u8> {
        out.extend_from_slice(&[0u8; 1024]);
        out
    }

    fn docker_tar(tags: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        file(&mut out, "blobs/sha256/layer1", &[7u8; 3000]);
        let tags: Vec<String> = tags.iter().map(|t| format!("\"{t}\"")).collect();
        let manifest = format!("[{{\"Config\":\"blobs/sha256/abc\",\"RepoTags\":[{}],\"Layers\":[\"blobs/sha256/layer1\"]}}]", tags.join(","));
        file(&mut out, "manifest.json", manifest.as_bytes());
        finish(out)
    }

    fn write_tmp(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn gz(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn msg(r: Result<ImageArchiveInfo>) -> String {
        r.unwrap_err().to_string()
    }

    // ---- inspection

    #[test]
    fn reads_tags_and_sizes_of_a_docker_save_file() {
        let dir = tempfile::tempdir().unwrap();
        let tar = docker_tar(&["myapp:latest", "myapp:1.2", "registry.local:5000/team/api:v3"]);
        let p = write_tmp(dir.path(), "a.tar", &tar);
        let info = inspect_archive(&p).unwrap();
        assert_eq!(info.tags, vec!["myapp:latest", "myapp:1.2", "registry.local:5000/team/api:v3"]);
        assert_eq!(info.file_bytes, tar.len() as u64);
        assert_eq!(info.tar_bytes, tar.len() as u64);
        assert!(!info.gzip);
    }

    #[test]
    fn untagged_images_have_no_tags() {
        let dir = tempfile::tempdir().unwrap();
        let mut out = Vec::new();
        file(&mut out, "manifest.json", br#"[{"Config":"x.json","RepoTags":null,"Layers":[]}]"#);
        let p = write_tmp(dir.path(), "u.tar", &finish(out));
        assert!(inspect_archive(&p).unwrap().tags.is_empty());
        let p = write_tmp(dir.path(), "v.tar", &docker_tar(&[]));
        assert!(inspect_archive(&p).unwrap().tags.is_empty());
    }

    #[test]
    fn gzip_is_found_by_its_first_bytes_not_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let tar = docker_tar(&["web:1"]);
        let zipped = gz(&tar);
        // a gzip file called .tar, and a plain tar called .tar.gz
        let a = inspect_archive(&write_tmp(dir.path(), "looks-plain.tar", &zipped)).unwrap();
        assert!(a.gzip);
        assert_eq!(a.tags, vec!["web:1"]);
        assert_eq!(a.file_bytes, zipped.len() as u64);
        assert_eq!(a.tar_bytes, tar.len() as u64, "unpacked size is counted while streaming");
        assert!(a.file_bytes < a.tar_bytes);
        let b = inspect_archive(&write_tmp(dir.path(), "looks-zipped.tar.gz", &tar)).unwrap();
        assert!(!b.gzip);
        assert_eq!(b.tar_bytes, tar.len() as u64);
    }

    #[test]
    fn unpacked_size_includes_padding_after_the_end_marker() {
        let dir = tempfile::tempdir().unwrap();
        let mut tar = docker_tar(&["a:1"]);
        tar.resize(10240, 0); // tar pads to 10 KiB records
        let info = inspect_archive(&write_tmp(dir.path(), "p.tar", &gz(&tar))).unwrap();
        assert_eq!(info.tar_bytes, 10240);
    }

    #[test]
    fn oci_layout_uses_full_names_from_annotations() {
        let dir = tempfile::tempdir().unwrap();
        let mut out = Vec::new();
        file(&mut out, "oci-layout", br#"{"imageLayoutVersion":"1.0.0"}"#);
        let index = r#"{"schemaVersion":2,"manifests":[
            {"digest":"sha256:1","annotations":{"io.containerd.image.name":"docker.io/library/nginx:latest","org.opencontainers.image.ref.name":"latest"}},
            {"digest":"sha256:2","annotations":{"io.containerd.image.name":"docker.io/acme/web:2","org.opencontainers.image.ref.name":"2"}},
            {"digest":"sha256:3","annotations":{"org.opencontainers.image.ref.name":"ghcr.io/acme/tool:9"}},
            {"digest":"sha256:4","annotations":{"org.opencontainers.image.ref.name":"only-a-tag"}},
            {"digest":"sha256:5"}]}"#;
        file(&mut out, "index.json", index.as_bytes());
        let p = write_tmp(dir.path(), "oci.tar", &finish(out));
        assert_eq!(inspect_archive(&p).unwrap().tags, vec!["nginx:latest", "acme/web:2", "ghcr.io/acme/tool:9"]);
    }

    #[test]
    fn manifest_and_index_together_do_not_repeat_names() {
        let dir = tempfile::tempdir().unwrap();
        let mut out = Vec::new();
        file(&mut out, "manifest.json", br#"[{"RepoTags":["nginx:latest"]}]"#);
        file(&mut out, "index.json", br#"{"manifests":[{"annotations":{"io.containerd.image.name":"docker.io/library/nginx:latest"}}]}"#);
        let p = write_tmp(dir.path(), "both.tar", &finish(out));
        assert_eq!(inspect_archive(&p).unwrap().tags, vec!["nginx:latest"]);
    }

    #[test]
    fn not_a_tar_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes) in [
            ("text.tar", b"hello, this is not an archive at all\n".repeat(100)),
            ("empty.tar", Vec::new()),
            ("zeros.tar", vec![0u8; 4096]),
            ("zip.tar", b"PK\x03\x04garbage".repeat(200)),
        ] {
            assert_eq!(msg(inspect_archive(&write_tmp(dir.path(), name, &bytes))), NOT_DOCKER, "{name}");
        }
        // gzip around something that is not a tar
        assert_eq!(msg(inspect_archive(&write_tmp(dir.path(), "t.tgz", &gz(&b"plain text".repeat(500))))), NOT_DOCKER);
        // a folder and a missing file
        assert!(inspect_archive(dir.path()).is_err());
        assert!(inspect_archive(&dir.path().join("missing.tar")).is_err());
    }

    #[test]
    fn a_tar_without_a_manifest_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut out = Vec::new();
        file(&mut out, "etc/passwd", b"root:x:0:0\n");
        file(&mut out, "nested/manifest.json", b"[]");
        let p = write_tmp(dir.path(), "plain.tar", &finish(out));
        assert_eq!(msg(inspect_archive(&p)), NOT_DOCKER);
    }

    #[test]
    fn a_huge_manifest_is_not_read() {
        let dir = tempfile::tempdir().unwrap();
        // The header claims 5 MB but the file ends: refused from the header alone.
        let mut out = Vec::new();
        out.extend_from_slice(&header("manifest.json", 5 * MIB, b'0', ""));
        let p = write_tmp(dir.path(), "huge.tar", &out);
        let m = msg(inspect_archive(&p));
        assert!(m.contains("larger than 4 MB"), "{m}");
        // 5 MB of real data behind it
        let mut out = Vec::new();
        file(&mut out, "index.json", &vec![b' '; (5 * MIB) as usize]);
        let p = write_tmp(dir.path(), "huge2.tar", &finish(out));
        assert!(msg(inspect_archive(&p)).contains("larger than 4 MB"));
    }

    #[test]
    fn a_garbage_manifest_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for (i, body) in ["not json {{{", "{\"a\":1}", "\"just a string\"", "[]"].iter().enumerate() {
            let mut out = Vec::new();
            file(&mut out, "manifest.json", body.as_bytes());
            let p = write_tmp(dir.path(), &format!("g{i}.tar"), &finish(out));
            let m = msg(inspect_archive(&p));
            assert!(m.contains("damaged") || m.contains("no images"), "{body}: {m}");
        }
        // a good index rescues a bad manifest
        let mut out = Vec::new();
        file(&mut out, "manifest.json", b"nope");
        file(&mut out, "index.json", br#"{"manifests":[{"annotations":{"io.containerd.image.name":"a/b:1"}}]}"#);
        assert_eq!(inspect_archive(&write_tmp(dir.path(), "mix.tar", &finish(out))).unwrap().tags, vec!["a/b:1"]);
    }

    #[test]
    fn path_traversal_names_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["../evil", "a/../../evil", "/etc/passwd", "..\\evil", "C:/x", "ok/..", "\\\\server\\share"] {
            let mut out = Vec::new();
            file(&mut out, bad, b"x");
            file(&mut out, "manifest.json", br#"[{"RepoTags":["a:1"]}]"#);
            let p = write_tmp(dir.path(), "t.tar", &finish(out));
            let m = msg(inspect_archive(&p));
            assert!(m.contains("unsafe path"), "{bad}: {m}");
        }
        // ...but dots inside names and "./" prefixes are fine, and so are old-style link targets
        let mut out = Vec::new();
        file(&mut out, "./blobs/a..b/c.json", b"x");
        out.extend_from_slice(&header("abc/layer.tar", 0, b'2', "../def/layer.tar"));
        file(&mut out, "./manifest.json", br#"[{"RepoTags":["a:1"]}]"#);
        let p = write_tmp(dir.path(), "ok.tar", &finish(out));
        assert_eq!(inspect_archive(&p).unwrap().tags, vec!["a:1"]);
    }

    #[test]
    fn a_cut_off_file_is_reported_as_damaged() {
        let dir = tempfile::tempdir().unwrap();
        let mut tar = docker_tar(&["a:1"]);
        tar.truncate(1000); // inside the first entry's data
        let m = msg(inspect_archive(&write_tmp(dir.path(), "cut.tar", &tar)));
        assert!(m.contains("damaged or incomplete"), "{m}");
        let zipped = gz(&docker_tar(&["a:1"]));
        let m = msg(inspect_archive(&write_tmp(dir.path(), "cut.tgz", &zipped[..zipped.len() / 2])));
        assert!(m.contains("damaged or incomplete") || m == NOT_DOCKER, "{m}");
    }

    #[test]
    fn names_are_normalised_like_docker_image_ls() {
        assert_eq!(normalize_ref("docker.io/library/nginx:latest").as_deref(), Some("nginx:latest"));
        assert_eq!(normalize_ref("index.docker.io/library/nginx:1").as_deref(), Some("nginx:1"));
        assert_eq!(normalize_ref("docker.io/acme/web:2").as_deref(), Some("acme/web:2"));
        assert_eq!(normalize_ref("library/nginx:1").as_deref(), Some("nginx:1"));
        assert_eq!(normalize_ref("localhost:5000/app:1").as_deref(), Some("localhost:5000/app:1"));
        assert_eq!(normalize_ref("localhost:5000/app"), None, "a registry port is not a tag");
        assert_eq!(normalize_ref("latest"), None);
        assert_eq!(normalize_ref("nginx@sha256:abcd"), None);
        assert_eq!(normalize_ref("nginx:"), None);
        assert_eq!(normalize_ref("bad name:1"), None);
        assert_eq!(normalize_ref(""), None);
    }

    // ---- free space

    const DF: &str = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/sda1         41152812  12345678  26543210      32% /\n";

    #[test]
    fn parses_df() {
        let fs = parse_df(DF).unwrap();
        assert_eq!(fs, Fs { device: "/dev/sda1".into(), mount: "/".into(), free: 26_543_210 * 1024 });
        // names with spaces, long device names, a wrapped-looking header
        let odd = "Filesystem 1024-blocks Used Available Capacity Mounted on\nmap auto_home 100 40 60 40% /System/Volumes/Data/home\n";
        let fs = parse_df(odd).unwrap();
        assert_eq!((fs.device.as_str(), fs.mount.as_str(), fs.free), ("map auto_home", "/System/Volumes/Data/home", 60 * 1024));
        let tmp = "Filesystem 1024-blocks Used Available Capacity Mounted on\ntmpfs 2000 0 2000 0% /var/tmp\n";
        assert_eq!(parse_df(tmp).unwrap().mount, "/var/tmp");
        assert_eq!(parse_df("df: /nope: No such file or directory\n"), None);
        assert_eq!(parse_df(""), None);
        assert_eq!(parse_df("Filesystem 1024-blocks Used Available Capacity Mounted on\n"), None);
        assert_eq!(parse_df("Filesystem blocks\nshort line 5%\n"), None);
    }

    fn fs(device: &str, mount: &str, free_gb: u64) -> Fs {
        Fs { device: device.into(), mount: mount.into(), free: free_gb * 1_000_000_000 }
    }

    #[test]
    fn different_disks_are_checked_separately() {
        let up = fs("/dev/sda1", "/", 5);
        let dk = fs("/dev/sdb1", "/var/lib/docker", 25);
        // file 4 GB (needs 4.3 GB with margin), images 10 GB (peak: 2 x 10 + 0.5 = 20.5 GB)
        let r = decide_space(("/var/tmp", Some(&up)), DockerSide::Known("/var/lib/docker", Some(&dk)), 4_000_000_000, 10_000_000_000);
        assert!(r.problem.is_none(), "{:?}", r.problem);
        assert!(!r.shared_disk);
        assert_eq!(r.needed_upload, 4_000_000_000 + 256 * MIB);
        assert_eq!(r.needed_docker, 20_000_000_000 + 500_000_000);
        // upload folder too small
        let small = fs("/dev/sda1", "/", 3);
        let r = decide_space(("/var/tmp", Some(&small)), DockerSide::Known("/var/lib/docker", Some(&dk)), 4_000_000_000, 10_000_000_000);
        let p = r.problem.unwrap();
        assert!(p.contains("upload the file") && p.contains("/var/tmp") && p.contains("3.0 GB") && !p.contains("load the images"), "{p}");
        // docker folder too small
        let tiny = fs("/dev/sdb1", "/var/lib/docker", 8);
        let p = decide_space(("/var/tmp", Some(&up)), DockerSide::Known("/var/lib/docker", Some(&tiny)), 4_000_000_000, 10_000_000_000).problem.unwrap();
        assert!(p.contains("for Docker to load") && p.contains("8.0 GB") && p.contains("up to 20.5 GB at peak"), "{p}");
        // both
        let p = decide_space(("/var/tmp", Some(&small)), DockerSide::Known("/var/lib/docker", Some(&tiny)), 4_000_000_000, 10_000_000_000).problem.unwrap();
        assert!(p.contains("upload the file") && p.contains("for Docker to load"));
    }

    #[test]
    fn one_disk_needs_the_sum() {
        let root = fs("/dev/sda1", "/", 24);
        // 4.27 + 20.5 = 24.77 GB needed but 24 GB free
        let r = decide_space(("/var/tmp", Some(&root)), DockerSide::Known("/var/lib/docker", Some(&root)), 4_000_000_000, 10_000_000_000);
        assert!(r.shared_disk);
        let p = r.problem.unwrap();
        assert!(p.contains("same disk") && p.contains("24.0 GB free") && p.contains("up to 24.8 GB at peak"), "{p}");
        // each half alone would have fit
        assert!(decide_space(("/var/tmp", Some(&root)), DockerSide::Unknown, 4_000_000_000, 10_000_000_000).problem.is_none());
        let roomy = fs("/dev/sda1", "/", 26);
        assert!(decide_space(("/var/tmp", Some(&roomy)), DockerSide::Known("/var/lib/docker", Some(&roomy)), 4_000_000_000, 10_000_000_000).problem.is_none());
    }

    #[test]
    fn same_disk_rules() {
        assert!(same_disk(&fs("/dev/sda1", "/", 1), &fs("/dev/sda1", "/var/lib/docker", 1)), "bind mounts of one device");
        assert!(same_disk(&fs("tmpfs", "/var", 1), &fs("tmpfs", "/var", 1)));
        assert!(!same_disk(&fs("tmpfs", "/var/tmp", 1), &fs("tmpfs", "/run", 1)), "two tmpfs are two memory areas");
        assert!(!same_disk(&fs("/dev/sda1", "/", 1), &fs("/dev/sdb1", "/data", 1)));
        assert!(!same_disk(&fs("overlay", "/", 1), &fs("overlay", "/data", 1)));
        // ZFS-style datasets of one pool share their space
        assert!(same_disk(&fs("rpool/ROOT/ubuntu", "/", 1), &fs("rpool/var/lib/docker", "/var/lib/docker", 1)));
        assert!(!same_disk(&fs("rpool/ROOT", "/", 1), &fs("tank/data", "/data", 1)));
        assert!(!same_disk(&fs("server:/export/a", "/a", 1), &fs("other:/export/a", "/b", 1)));
    }

    #[test]
    fn unmeasurable_halves_warn_and_do_not_block() {
        let up = fs("/dev/sda1", "/", 50);
        let r = decide_space(("/var/tmp", Some(&up)), DockerSide::Unknown, 1_000_000_000, 3_000_000_000);
        assert!(r.problem.is_none());
        assert!(r.warning.unwrap().contains("Docker's data folder"));
        let r = decide_space(("/home/me", None), DockerSide::Known("/var/lib/docker", Some(&up)), 1_000_000_000, 3_000_000_000);
        assert!(r.problem.is_none() && r.warning.unwrap().contains("/home/me"));
        // what could be measured is still enforced
        let r = decide_space(("/home/me", None), DockerSide::Known("/var/lib/docker", Some(&fs("/dev/sdb1", "/var/lib/docker", 1))), 1_000_000_000, 3_000_000_000);
        assert!(r.problem.is_some() && r.warning.is_some());
        assert!(!ImportSpaceReport::unchecked().checked);
    }

    #[test]
    fn sizes_read_like_the_screen() {
        assert_eq!(human(999), "999 B");
        assert_eq!(human(1_500_000_000), "1.5 GB");
        assert_eq!(human(192_000_000), "192 MB");
        assert_eq!(human(0), "0 B");
    }

    // ---- docker load output

    #[test]
    fn parses_loaded_lines() {
        let out = "Loaded image: myapp:latest\nLoaded image: myapp:1.2\nLoaded image ID: sha256:0123456789abcdef\nLoaded image: myapp:latest\nsome warning\n";
        assert_eq!(parse_loaded(out), vec!["myapp:latest", "myapp:1.2", "sha256:0123456789abcdef"]);
        assert_eq!(parse_loaded("Loaded image:   \nnothing here"), Vec::<String>::new());
        assert!(parse_loaded("").is_empty());
    }

    // ---- job

    #[tokio::test]
    async fn requests_are_checked_before_anything_starts() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::init(dir.path()).unwrap();
        let imports = Arc::new(ImageImports::new(core.db.clone(), core.connections.clone(), core.sudo.clone(), core.sftp.clone(), core.events.clone()));
        let p = write_tmp(dir.path(), "a.tar", &docker_tar(&["a:1"]));
        let req = |host: &str, path: &str| ImageImportRequest { host_id: host.into(), path: path.into(), file_bytes: 0, tags: vec![], tag_ids: vec![] };
        assert!(imports.start(req("nope", "relative.tar")).is_err());
        assert!(imports.start(req("nope", &dir.path().to_string_lossy())).is_err());
        assert!(imports.start(req("nope", &p.to_string_lossy())).is_err(), "unknown server");
        assert!(imports.start(req("nope", &dir.path().join("missing.tar").to_string_lossy())).is_err());
        assert!(imports.running.lock().is_empty());
    }

    #[tokio::test]
    async fn a_file_that_is_not_an_image_fails_the_job_before_any_connection() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::init(dir.path()).unwrap();
        let imports = Arc::new(ImageImports::new(core.db.clone(), core.connections.clone(), core.sudo.clone(), core.sftp.clone(), core.events.clone()));
        let p = write_tmp(dir.path(), "notes.tar", b"just some notes");
        let mut rx = core.subscribe_events();
        imports.start(ImageImportRequest { host_id: crate::computer::ID.into(), path: p.to_string_lossy().into_owned(), file_bytes: 15, tags: vec![], tag_ids: vec![] }).unwrap();
        let last = loop {
            if let CoreEvent::ImageImport { job } = rx.recv().await.unwrap() {
                if job.state != "running" {
                    break job;
                }
            }
        };
        assert_eq!(last.state, "failed");
        assert_eq!(last.error.as_deref(), Some(NOT_DOCKER));
        assert!(imports.running.lock().is_empty(), "the slot is free again");
    }

    #[tokio::test]
    async fn one_import_per_server_at_a_time_and_cancel_flags_the_job() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::init(dir.path()).unwrap();
        let imports = Arc::new(ImageImports::new(core.db.clone(), core.connections.clone(), core.sudo.clone(), core.sftp.clone(), core.events.clone()));
        let flag = Arc::new(AtomicBool::new(false));
        imports.running.lock().insert("j1".into(), (flag.clone(), crate::computer::ID.into()));
        let p = write_tmp(dir.path(), "a.tar", &docker_tar(&["a:1"]));
        let err = imports.start(ImageImportRequest { host_id: crate::computer::ID.into(), path: p.to_string_lossy().into_owned(), file_bytes: 0, tags: vec![], tag_ids: vec![] }).unwrap_err();
        assert!(err.to_string().contains("still running"));
        imports.cancel("j1");
        assert!(flag.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn until_cancelled_returns_the_result_or_none() {
        let flag = AtomicBool::new(false);
        assert_eq!(until_cancelled(async { 5 }, &flag).await, Some(5));
        flag.store(true, Ordering::SeqCst);
        assert_eq!(until_cancelled(std::future::pending::<u8>(), &flag).await, None);
    }

    #[test]
    fn job_notes_accumulate() {
        let mut j = ImageImportJob { id: "j".into(), host_id: "h".into(), path: "p".into(), state: "running".into(), phase: String::new(), bytes: 0, total: 0, loaded: vec![], error: None, note: None };
        j.add_note("One.");
        j.add_note("Two.");
        assert_eq!(j.note.as_deref(), Some("One. Two."));
    }


    // ---- hostile headers

    fn sha(b: &[u8]) -> String {
        format!("{:x}", Sha256::digest(b))
    }

    fn pax(k: &str, v: &str) -> Vec<u8> {
        let body = format!(" {k}={v}\n");
        let mut len = body.len() + 1;
        while len.to_string().len() + body.len() != len {
            len = len.to_string().len() + body.len();
        }
        format!("{len}{body}").into_bytes()
    }

    fn meta(out: &mut Vec<u8>, kind: u8, body: &[u8]) {
        out.extend_from_slice(&header("././@meta", body.len() as u64, kind, ""));
        out.extend_from_slice(body);
        out.resize(out.len().div_ceil(512) * 512, 0);
    }

    #[test]
    fn oversized_long_name_and_pax_entries_are_refused_unread() {
        let dir = tempfile::tempdir().unwrap();
        for kind in [b'L', b'x', b'K', b'g'] {
            // Only a header that claims 4 GB: the parser must not try to read that much.
            let mut out = header("././@meta", 4 << 30, kind, "").to_vec();
            out.extend_from_slice(&[b'a'; 1000]);
            let m = msg(inspect_archive(&write_tmp(dir.path(), "big.tar", &out)));
            assert!(m.contains("oversized header entry"), "{}: {m}", kind as char);
            // the same inside a gzip (the case that used to allocate gigabytes)
            let m = msg(inspect_archive(&write_tmp(dir.path(), "big.tgz", &gz(&out))));
            assert!(m.contains("oversized header entry"), "{}: {m}", kind as char);
        }
        // just under the limit is read normally
        let mut out = Vec::new();
        meta(&mut out, b'g', &vec![b'x'; 60_000]);
        file(&mut out, "manifest.json", br#"[{"RepoTags":["a:1"]}]"#);
        assert_eq!(inspect_archive(&write_tmp(dir.path(), "ok.tar", &finish(out))).unwrap().tags, vec!["a:1"]);
    }

    #[test]
    fn long_name_and_pax_headers_apply_to_the_next_entry() {
        let dir = tempfile::tempdir().unwrap();
        // GNU long name: the real name is manifest.json, the short one is a decoy
        let mut out = Vec::new();
        meta(&mut out, b'L', b"manifest.json\0");
        file(&mut out, "decoy", br#"[{"RepoTags":["long:1"]}]"#);
        assert_eq!(inspect_archive(&write_tmp(dir.path(), "l.tar", &finish(out))).unwrap().tags, vec!["long:1"]);
        // PAX path
        let mut out = Vec::new();
        meta(&mut out, b'x', &pax("path", "manifest.json"));
        file(&mut out, "decoy", br#"[{"RepoTags":["pax:1"]}]"#);
        assert_eq!(inspect_archive(&write_tmp(dir.path(), "x.tar", &finish(out))).unwrap().tags, vec!["pax:1"]);
        // PAX size beats the header size (layers over 8 GB are written that way)
        let mut out = Vec::new();
        meta(&mut out, b'x', &pax("size", "700"));
        out.extend_from_slice(&header("blobs/sha256/big", 0, b'0', ""));
        out.extend_from_slice(&[9u8; 700]);
        out.resize(out.len().div_ceil(512) * 512, 0);
        file(&mut out, "manifest.json", br#"[{"RepoTags":["after:1"]}]"#);
        assert_eq!(inspect_archive(&write_tmp(dir.path(), "s.tar", &finish(out))).unwrap().tags, vec!["after:1"]);
        // a path made unsafe through a long name is still refused
        let mut out = Vec::new();
        meta(&mut out, b'L', b"../../evil\0");
        file(&mut out, "x", b"1");
        assert!(msg(inspect_archive(&write_tmp(dir.path(), "e.tar", &finish(out)))).contains("unsafe path"));
    }

    #[test]
    fn base_256_sizes_are_understood() {
        let mut h = header("blobs/sha256/huge", 0, b'0', "");
        h[124..136].copy_from_slice(&[0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10, 0]); // 4096
        let sum: u32 = h.iter().enumerate().map(|(i, b)| if (148..156).contains(&i) { 32 } else { *b as u32 }).sum();
        h[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        assert_eq!(parse_header(&h).unwrap().size, 4096);
    }

    // ---- what Docker's loader would see

    #[test]
    fn a_repeated_manifest_or_index_is_refused_in_every_spelling() {
        let dir = tempfile::tempdir().unwrap();
        for (a, b) in [("manifest.json", "manifest.json"), ("manifest.json", "./manifest.json"), ("./index.json", "././index.json"), ("manifest.json", "manifest.json/")] {
            let mut out = Vec::new();
            file(&mut out, a, br#"[{"RepoTags":["shown:1"]}]"#);
            file(&mut out, b, br#"[{"RepoTags":["loaded:2"]}]"#);
            let m = msg(inspect_archive(&write_tmp(dir.path(), "dup.tar", &finish(out))));
            assert!(m.contains("more than once") || m.contains("not a regular file"), "{a} + {b}: {m}");
        }
    }

    #[test]
    fn a_manifest_that_is_a_link_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for kind in [b'2', b'1', b'5'] {
            let mut out = Vec::new();
            file(&mut out, "real.json", br#"[{"RepoTags":["hidden:1"]}]"#);
            out.extend_from_slice(&header("manifest.json", 0, kind, "real.json"));
            let m = msg(inspect_archive(&write_tmp(dir.path(), "link.tar", &finish(out))));
            assert!(m.contains("not a regular file"), "{}: {m}", kind as char);
        }
        let mut out = Vec::new();
        out.extend_from_slice(&header("index.json", 0, b'2', "elsewhere.json"));
        assert!(msg(inspect_archive(&write_tmp(dir.path(), "link2.tar", &finish(out)))).contains("not a regular file"));
    }

    #[test]
    fn too_many_names_are_refused_not_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let tags: Vec<String> = (0..=TAGS_MAX).map(|i| format!("\"app:{i}\"")).collect();
        let mut out = Vec::new();
        file(&mut out, "manifest.json", format!("[{{\"RepoTags\":[{}]}}]", tags.join(",")).as_bytes());
        assert!(msg(inspect_archive(&write_tmp(dir.path(), "many.tar", &finish(out)))).contains("more than 1000"));
    }

    #[test]
    fn a_digest_after_the_tag_is_dropped() {
        assert_eq!(normalize_ref("nginx:1.25@sha256:abcd").as_deref(), Some("nginx:1.25"));
        assert_eq!(normalize_ref("docker.io/library/nginx:1@sha256:abcd").as_deref(), Some("nginx:1"));
        assert_eq!(normalize_ref("nginx@sha256:abcd"), None);
    }

    // ---- image ids proven by hashing

    #[test]
    fn classic_config_names_are_trusted_only_when_the_content_hashes_to_them() {
        let dir = tempfile::tempdir().unwrap();
        let config = br#"{"architecture":"amd64","os":"linux"}"#;
        let id = sha(config);
        // new-style path and old-style <id>.json both work
        for config_path in [format!("blobs/sha256/{id}"), format!("{id}.json")] {
            let mut out = Vec::new();
            file(&mut out, &config_path, config);
            file(&mut out, "manifest.json", format!("[{{\"Config\":\"{config_path}\",\"RepoTags\":[\"app:1\",\"app:latest\"],\"Layers\":[]}}]").as_bytes());
            let info = inspect_archive(&write_tmp(dir.path(), "c.tar", &finish(out))).unwrap();
            assert_eq!(info.tag_ids, vec![ImageTagIds { tag: "app:1".into(), ids: vec![id.clone()] }, ImageTagIds { tag: "app:latest".into(), ids: vec![id.clone()] }], "{config_path}");
        }
        // forged: the file is called after the id of some other image, but holds something else
        let victim = "a".repeat(64);
        let mut out = Vec::new();
        file(&mut out, &format!("blobs/sha256/{victim}"), config);
        file(&mut out, "manifest.json", format!("[{{\"Config\":\"blobs/sha256/{victim}\",\"RepoTags\":[\"app:1\"]}}]").as_bytes());
        let info = inspect_archive(&write_tmp(dir.path(), "forged.tar", &finish(out))).unwrap();
        assert_eq!(info.tags, vec!["app:1"]);
        assert!(info.tag_ids.is_empty(), "{:?}", info.tag_ids);
        // config missing from the archive, config named in a odd way, config appearing twice
        let mut out = Vec::new();
        file(&mut out, "manifest.json", format!("[{{\"Config\":\"blobs/sha256/{id}\",\"RepoTags\":[\"app:1\"]}}]").as_bytes());
        assert!(inspect_archive(&write_tmp(dir.path(), "missing.tar", &finish(out))).unwrap().tag_ids.is_empty());
        let mut out = Vec::new();
        file(&mut out, &format!("blobs/sha256/{id}"), config);
        file(&mut out, &format!("./blobs/sha256/{id}"), config);
        let m = format!("[{{\"Config\":\"blobs/sha256/{id}\",\"RepoTags\":[\"app:1\"]}}]");
        file(&mut out, "manifest.json", m.as_bytes());
        // ("./x" and "x" are the same path, so neither copy is trusted)
        let found = inspect_archive(&write_tmp(dir.path(), "twice.tar", &finish(out))).unwrap();
        assert!(found.tag_ids.is_empty());
    }

    #[test]
    fn oci_manifest_digests_are_trusted_only_when_the_blob_hashes_to_them() {
        let dir = tempfile::tempdir().unwrap();
        let blob = br#"{"schemaVersion":2,"config":{}}"#;
        let digest = sha(blob);
        let index = |d: &str| format!("{{\"manifests\":[{{\"digest\":\"sha256:{d}\",\"annotations\":{{\"io.containerd.image.name\":\"docker.io/library/web:2\"}}}}]}}");
        let mut out = Vec::new();
        file(&mut out, &format!("blobs/sha256/{digest}"), blob);
        file(&mut out, "index.json", index(&digest).as_bytes());
        let info = inspect_archive(&write_tmp(dir.path(), "o.tar", &finish(out))).unwrap();
        assert_eq!(info.tag_ids, vec![ImageTagIds { tag: "web:2".into(), ids: vec![digest.clone()] }]);
        // forged blob name
        let fake = "b".repeat(64);
        let mut out = Vec::new();
        file(&mut out, &format!("blobs/sha256/{fake}"), blob);
        file(&mut out, "index.json", index(&fake).as_bytes());
        assert!(inspect_archive(&write_tmp(dir.path(), "of.tar", &finish(out))).unwrap().tag_ids.is_empty());
        // classic and OCI lists for one name give both ids
        let config = br#"{"os":"linux"}"#;
        let tied = format!("{{\"schemaVersion\":2,\"config\":{{\"digest\":\"sha256:{}\"}}}}", sha(config));
        let tied_digest = sha(tied.as_bytes());
        let mut out = Vec::new();
        file(&mut out, &format!("blobs/sha256/{}", sha(config)), config);
        file(&mut out, &format!("blobs/sha256/{tied_digest}"), tied.as_bytes());
        file(&mut out, "manifest.json", format!("[{{\"Config\":\"blobs/sha256/{}\",\"RepoTags\":[\"web:2\"]}}]", sha(config)).as_bytes());
        file(&mut out, "index.json", index(&tied_digest).as_bytes());
        let info = inspect_archive(&write_tmp(dir.path(), "both.tar", &finish(out))).unwrap();
        assert_eq!(info.tag_ids[0].ids, vec![sha(config), tied_digest]);
        // the two lists name the tag but do not agree (the manifest's config is another one): no id is proven
        let mut out = Vec::new();
        file(&mut out, &format!("blobs/sha256/{}", sha(config)), config);
        file(&mut out, &format!("blobs/sha256/{digest}"), blob);
        file(&mut out, "manifest.json", format!("[{{\"Config\":\"blobs/sha256/{}\",\"RepoTags\":[\"web:2\"]}}]", sha(config)).as_bytes());
        file(&mut out, "index.json", index(&digest).as_bytes());
        let info = inspect_archive(&write_tmp(dir.path(), "apart.tar", &finish(out))).unwrap();
        assert_eq!(info.tags, vec!["web:2"]);
        assert!(info.tag_ids.is_empty(), "{:?}", info.tag_ids);
    }

    // ---- probes

    #[test]
    fn upload_probe_ignores_login_banners() {
        let out = "Welcome to Ubuntu\nLast login: today\nROOKERY-DIR:/var/tmp\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 40 60 40% /\n";
        let (dir, fs) = parse_upload_probe(out).unwrap();
        assert_eq!(dir, "/var/tmp");
        assert_eq!(fs.unwrap().free, 60 * 1024);
        let (dir, fs) = parse_upload_probe("banner\nROOKERY-DIR:/home/me/\ndf: not found\n").unwrap();
        assert_eq!((dir.as_str(), fs), ("/home/me", None));
        assert!(parse_upload_probe("ROOKERY-DIR:\n").is_err());
        assert!(parse_upload_probe("ROOKERY-DIR:relative\n").is_err());
        assert!(parse_upload_probe("just a banner\n").is_err());
    }

    #[test]
    fn a_non_default_docker_is_recognised() {
        assert_eq!(parse_context_probe("banner\nROOKERY-CTX:default\nROOKERY-HOST:\n"), None);
        assert_eq!(parse_context_probe("ROOKERY-CTX:\nROOKERY-HOST:\n"), None);
        assert!(parse_context_probe("ROOKERY-CTX:prod\nROOKERY-HOST:\n").unwrap().contains("context “prod”"));
        assert!(parse_context_probe("ROOKERY-CTX:default\nROOKERY-HOST:tcp://10.0.0.5:2375\n").unwrap().contains("DOCKER_HOST=tcp://10.0.0.5:2375"));
        let r = decide_space(("/var/tmp", Some(&fs("/dev/sda1", "/", 50))), DockerSide::Elsewhere("DOCKER_HOST=tcp://x"), 1_000_000_000, 3_000_000_000);
        assert!(r.problem.is_none() && r.warning.unwrap().contains("DOCKER_HOST=tcp://x"));
    }

    #[test]
    fn the_home_folder_is_reported() {
        let up = fs("/dev/sda1", "/", 50);
        assert!(!decide_space(("/var/tmp", Some(&up)), DockerSide::Unknown, 1, 1).upload_in_home);
        assert!(decide_space(("/home/me", Some(&up)), DockerSide::Unknown, 1, 1).upload_in_home);
    }

    // ---- the job around a changed file, and shutdown

    #[tokio::test]
    async fn a_file_that_changed_after_confirmation_is_not_imported() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::init(dir.path()).unwrap();
        let imports = Arc::new(ImageImports::new(core.db.clone(), core.connections.clone(), core.sudo.clone(), core.sftp.clone(), core.events.clone()));
        let tar = docker_tar(&["a:1"]);
        let p = write_tmp(dir.path(), "a.tar", &tar);
        let path = p.to_string_lossy().into_owned();
        for (bytes, tags) in [(tar.len() as u64 + 1, vec!["a:1".to_string()]), (tar.len() as u64, vec!["other:1".to_string()])] {
            let mut rx = core.subscribe_events();
            imports.start(ImageImportRequest { host_id: crate::computer::ID.into(), path: path.clone(), file_bytes: bytes, tags, tag_ids: vec![] }).unwrap();
            let last = loop {
                if let CoreEvent::ImageImport { job } = rx.recv().await.unwrap() {
                    if job.state != "running" {
                        break job;
                    }
                }
            };
            assert_eq!(last.state, "failed");
            assert_eq!(last.error.as_deref(), Some(CHANGED));
        }
        let info = inspect_archive(&p).unwrap();
        assert!(check_unchanged(&info, &ImageImportRequest { host_id: "h".into(), path: path.clone(), file_bytes: tar.len() as u64, tags: vec!["a:1".into()], tag_ids: vec![] }).is_ok());
    }

    #[tokio::test]
    async fn wait_idle_returns_when_jobs_are_gone_or_time_is_up() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::init(dir.path()).unwrap();
        let imports = Arc::new(ImageImports::new(core.db.clone(), core.connections.clone(), core.sudo.clone(), core.sftp.clone(), core.events.clone()));
        imports.wait_idle(Duration::from_secs(5)).await;
        imports.running.lock().insert("j".into(), (Arc::new(AtomicBool::new(false)), "h".into()));
        assert!(imports.has_running());
        let t = Instant::now();
        imports.wait_idle(Duration::from_millis(300)).await;
        assert!(t.elapsed() >= Duration::from_millis(300) && imports.has_running(), "gives up after the limit");
        let later = imports.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            later.running.lock().clear();
        });
        let t = Instant::now();
        imports.wait_idle(Duration::from_secs(5)).await;
        assert!(t.elapsed() < Duration::from_secs(3) && !imports.has_running());
    }

    // ---- arithmetic on numbers from the file never panics or wraps

    #[test]
    fn huge_numbers_in_headers_are_refused_not_wrapped() {
        // PAX record length near u64::MAX
        assert!(parse_pax(b"18446744073709551615 path=x\n").is_empty());
        assert!(parse_pax(b"18446744073709551610 path=x\n").is_empty());
        assert!(parse_pax(b"99999999999999999999999 path=x\n").is_empty());
        assert_eq!(parse_pax(&pax("path", "a/b")), vec![("path".to_string(), "a/b".to_string())]);
        // The same inside a real file, followed by a good manifest
        let dir = tempfile::tempdir().unwrap();
        let mut out = Vec::new();
        meta(&mut out, b'x', b"18446744073709551615 path=x\n");
        file(&mut out, "manifest.json", br#"[{"RepoTags":["a:1"]}]"#);
        assert!(inspect_archive(&write_tmp(dir.path(), "pax.tar", &finish(out))).is_ok());
        // entry size u64::MAX (base-256): size + padding overflows
        for name in ["layer.tar", "blobs/sha256/".to_string().as_str()] {
            let mut h = header(name, 0, b'0', "");
            h[124..136].copy_from_slice(&[0x80, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
            let sum: u32 = h.iter().enumerate().map(|(i, b)| if (148..156).contains(&i) { 32 } else { *b as u32 }).sum();
            h[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
            let m = msg(inspect_archive(&write_tmp(dir.path(), "max.tar", &h)));
            assert!(m.contains("impossible size"), "{name}: {m}");
        }
        // a PAX size of u64::MAX on a normal entry
        let mut out = Vec::new();
        meta(&mut out, b'x', &pax("size", "18446744073709551615"));
        file(&mut out, "layer.tar", b"x");
        let m = msg(inspect_archive(&write_tmp(dir.path(), "paxmax.tar", &finish(out))));
        assert!(m.contains("impossible size") || m.contains("damaged"), "{m}");
        // a size that is merely bigger than the file
        let mut out = Vec::new();
        out.extend_from_slice(&header("layer.tar", 1 << 32, b'0', ""));
        assert!(msg(inspect_archive(&write_tmp(dir.path(), "short.tar", &out))).contains("damaged"));
    }

    // ---- names the way Go sees them

    #[test]
    fn manifest_names_are_cleaned_before_they_are_compared() {
        let dir = tempfile::tempdir().unwrap();
        for (a, b) in [("manifest.json", ".//manifest.json"), ("manifest.json", "manifest.json/."), ("./manifest.json", "a/../manifest.json"), ("index.json", ".//./index.json")] {
            let mut out = Vec::new();
            file(&mut out, a, br#"[{"RepoTags":["shown:1"]}]"#);
            file(&mut out, b, br#"[{"RepoTags":["loaded:2"]}]"#);
            let m = msg(inspect_archive(&write_tmp(dir.path(), "dup.tar", &finish(out))));
            assert!(m.contains("more than once") || m.contains("unsafe path"), "{a} + {b}: {m}");
        }
        // an odd spelling alone is the manifest
        let mut out = Vec::new();
        file(&mut out, ".//manifest.json", br#"[{"RepoTags":["only:1"]}]"#);
        assert_eq!(inspect_archive(&write_tmp(dir.path(), "odd.tar", &finish(out))).unwrap().tags, vec!["only:1"]);
        assert_eq!(clean_path(b"./a//b/./c/").unwrap(), "a/b/c");
        assert!(clean_path(b"a/../b").is_err());
    }

    #[test]
    fn conflicting_name_headers_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let good = br#"[{"RepoTags":["a:1"]}]"#;
        let cases: Vec<(&str, Vec<(u8, Vec<u8>)>)> = vec![
            ("long name + pax path", vec![(b'L', b"manifest.json\0".to_vec()), (b'x', pax("path", "decoy"))]),
            ("pax path + long name", vec![(b'x', pax("path", "decoy")), (b'L', b"manifest.json\0".to_vec())]),
            ("two pax", vec![(b'x', pax("mtime", "1")), (b'x', pax("path", "manifest.json"))]),
            ("two long names", vec![(b'L', b"a\0".to_vec()), (b'L', b"manifest.json\0".to_vec())]),
            ("two link names", vec![(b'K', b"a\0".to_vec()), (b'K', b"b\0".to_vec())]),
        ];
        for (what, metas) in cases {
            let mut out = Vec::new();
            for (k, body) in &metas {
                meta(&mut out, *k, body);
            }
            file(&mut out, "decoy", good);
            let m = msg(inspect_archive(&write_tmp(dir.path(), "c.tar", &finish(out))));
            assert!(m.contains("conflicting name headers"), "{what}: {m}");
        }
        // one of each kind, and headers for separate entries, are fine
        let mut out = Vec::new();
        meta(&mut out, b'x', &pax("mtime", "1"));
        meta(&mut out, b'K', b"t\0");
        file(&mut out, "other", b"1");
        meta(&mut out, b'x', &pax("path", "manifest.json"));
        file(&mut out, "decoy", good);
        assert_eq!(inspect_archive(&write_tmp(dir.path(), "fine.tar", &finish(out))).unwrap().tags, vec!["a:1"]);
    }

    #[test]
    fn a_repeated_digest_path_is_never_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let config = br#"{"os":"linux"}"#;
        let id = sha(config);
        let path = format!("blobs/sha256/{id}");
        let manifest = format!("[{{\"Config\":\"{path}\",\"RepoTags\":[\"app:1\"]}}]");
        let ids = |out: Vec<u8>| inspect_archive(&write_tmp(dir.path(), "r.tar", &finish(out))).unwrap().tag_ids;
        // control: once, it is proven
        let mut out = Vec::new();
        file(&mut out, &path, config);
        file(&mut out, "manifest.json", manifest.as_bytes());
        assert_eq!(ids(out).len(), 1);
        // again as a large file (too big to hash), as a link, in another spelling, after the manifest
        let big = vec![b'x'; (HASH_FILE_MAX + 10) as usize];
        let repeats: Vec<Box<dyn Fn(&mut Vec<u8>)>> = vec![
            Box::new(|o| file(o, &format!("blobs/sha256/{}", &sha(br#"{"os":"linux"}"#)), &vec![b'x'; (HASH_FILE_MAX + 10) as usize])),
            Box::new(|o| file(o, &format!("blobs/./sha256/{}", sha(br#"{"os":"linux"}"#)), br#"{"os":"linux"}"#)),
            Box::new(|o| file(o, &format!("./blobs//sha256/{}", sha(br#"{"os":"linux"}"#)), b"{}")),
        ];
        assert!(big.len() > 1);
        for (n, repeat) in repeats.iter().enumerate() {
            for before_manifest in [true, false] {
                let mut out = Vec::new();
                file(&mut out, &path, config);
                if before_manifest {
                    repeat(&mut out);
                }
                file(&mut out, "manifest.json", manifest.as_bytes());
                if !before_manifest {
                    repeat(&mut out);
                }
                assert!(ids(out).is_empty(), "repeat {n} (before manifest: {before_manifest})");
            }
        }
        // a link under a blob name is refused outright (see `links_are_only_for_layers`); an oversized file is just not proven
        let mut out = Vec::new();
        out.extend_from_slice(&header(&path, 0, b'2', "elsewhere"));
        file(&mut out, "manifest.json", manifest.as_bytes());
        assert!(inspect_archive(&write_tmp(dir.path(), "l.tar", &finish(out))).is_err());
        let mut out = Vec::new();
        file(&mut out, &path, &big);
        file(&mut out, "manifest.json", manifest.as_bytes());
        assert!(ids(out).is_empty());
    }

    // ---- two lists must not tell different stories

    #[test]
    fn a_tag_named_differently_by_the_two_lists_is_not_called_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let evil = br#"{"os":"linux","cmd":["/evil"]}"#;
        let real_config = br#"{"os":"linux","cmd":["/app"]}"#;
        // E: a real, public image manifest, whose config is the real config
        let e_manifest = format!("{{\"schemaVersion\":2,\"config\":{{\"digest\":\"sha256:{}\"}}}}", sha(real_config));
        let e = sha(e_manifest.as_bytes());
        let mut out = Vec::new();
        file(&mut out, &format!("blobs/sha256/{}", sha(evil)), evil);
        file(&mut out, &format!("blobs/sha256/{}", sha(real_config)), real_config);
        file(&mut out, &format!("blobs/sha256/{e}"), e_manifest.as_bytes());
        // classic loader: app:1 becomes the evil config; the index claims the real image
        file(&mut out, "manifest.json", format!("[{{\"Config\":\"blobs/sha256/{}\",\"RepoTags\":[\"app:1\"]}}]", sha(evil)).as_bytes());
        file(&mut out, "index.json", format!("{{\"manifests\":[{{\"digest\":\"sha256:{e}\",\"annotations\":{{\"io.containerd.image.name\":\"docker.io/library/app:1\"}}}}]}}").as_bytes());
        let info = inspect_archive(&write_tmp(dir.path(), "forged.tar", &finish(out))).unwrap();
        assert_eq!(info.tags, vec!["app:1"]);
        assert!(info.tag_ids.is_empty(), "{:?}", info.tag_ids);
        // the same two lists, agreeing: proven, with both ids
        let honest = format!("[{{\"Config\":\"blobs/sha256/{}\",\"RepoTags\":[\"app:1\"]}}]", sha(real_config));
        let mut out = Vec::new();
        file(&mut out, &format!("blobs/sha256/{}", sha(real_config)), real_config);
        file(&mut out, &format!("blobs/sha256/{e}"), e_manifest.as_bytes());
        file(&mut out, "manifest.json", honest.as_bytes());
        file(&mut out, "index.json", format!("{{\"manifests\":[{{\"digest\":\"sha256:{e}\",\"annotations\":{{\"io.containerd.image.name\":\"docker.io/library/app:1\"}}}}]}}").as_bytes());
        let info = inspect_archive(&write_tmp(dir.path(), "honest.tar", &finish(out))).unwrap();
        assert_eq!(info.tag_ids, vec![ImageTagIds { tag: "app:1".into(), ids: vec![sha(real_config), e.clone()] }]);
        // a tag named twice in one list is not proven, whatever the pairings say
        let mut out = Vec::new();
        file(&mut out, &format!("blobs/sha256/{}", sha(real_config)), real_config);
        file(&mut out, "manifest.json", format!("[{{\"Config\":\"blobs/sha256/{c}\",\"RepoTags\":[\"app:1\"]}},{{\"Config\":\"blobs/sha256/{c}\",\"RepoTags\":[\"app:1\"]}}]", c = sha(real_config)).as_bytes());
        assert!(inspect_archive(&write_tmp(dir.path(), "twice.tar", &finish(out))).unwrap().tag_ids.is_empty());
    }

    // ---- links cannot redirect later entries

    fn link(out: &mut Vec<u8>, name: &str, target: &str) {
        out.extend_from_slice(&header(name, 0, b'2', target));
    }

    #[test]
    fn links_are_only_for_layers() {
        let dir = tempfile::tempdir().unwrap();
        let good = br#"[{"RepoTags":["shown:1"]}]"#;
        let evil = br#"[{"RepoTags":["loaded:2"]}]"#;
        // x -> . then x/manifest.json would overwrite the manifest we read
        let mut out = Vec::new();
        file(&mut out, "manifest.json", good);
        link(&mut out, "x", ".");
        file(&mut out, "x/manifest.json", evil);
        assert!(msg(inspect_archive(&write_tmp(dir.path(), "x.tar", &finish(out)))).contains("link"));
        // b -> blobs then b/sha256/<E> replaces a verified config
        let config = br#"{"os":"linux"}"#;
        let e = sha(config);
        let mut out = Vec::new();
        file(&mut out, &format!("blobs/sha256/{e}"), config);
        link(&mut out, "b", "blobs");
        file(&mut out, &format!("b/sha256/{e}"), b"{}");
        file(&mut out, "manifest.json", format!("[{{\"Config\":\"blobs/sha256/{e}\",\"RepoTags\":[\"app:1\"]}}]").as_bytes());
        assert!(msg(inspect_archive(&write_tmp(dir.path(), "b.tar", &finish(out)))).contains("link"));
        // hardlinks too
        let mut out = Vec::new();
        out.extend_from_slice(&header("y", 0, b'1', "manifest.json"));
        file(&mut out, "manifest.json", good);
        assert!(msg(inspect_archive(&write_tmp(dir.path(), "h.tar", &finish(out)))).contains("link"));
    }

    #[test]
    fn entries_may_not_go_through_or_replace_links() {
        let dir = tempfile::tempdir().unwrap();
        let good = br#"[{"RepoTags":["a:1"]}]"#;
        // through a layer link
        let mut out = Vec::new();
        link(&mut out, "abc/layer.tar", "../def/layer.tar");
        file(&mut out, "abc/layer.tar/manifest.json", b"x");
        file(&mut out, "manifest.json", good);
        assert!(msg(inspect_archive(&write_tmp(dir.path(), "t.tar", &finish(out)))).contains("goes through a link"));
        // a link in the place of a folder that already holds files
        let mut out = Vec::new();
        file(&mut out, "abc/layer.tar/manifest.json", b"x");
        link(&mut out, "abc/layer.tar", "../def/layer.tar");
        file(&mut out, "manifest.json", good);
        assert!(msg(inspect_archive(&write_tmp(dir.path(), "p.tar", &finish(out)))).contains("place of a folder"));
        // a file with the name of a link
        let mut out = Vec::new();
        link(&mut out, "abc/layer.tar", "../def/layer.tar");
        file(&mut out, "abc/layer.tar", b"data");
        file(&mut out, "manifest.json", good);
        assert!(msg(inspect_archive(&write_tmp(dir.path(), "n.tar", &finish(out)))).contains("repeats the name of a link"));
    }

    #[test]
    fn an_old_style_docker_save_still_passes() {
        let dir = tempfile::tempdir().unwrap();
        let (l1, l2) = ("1".repeat(64), "2".repeat(64));
        let config = br#"{"os":"linux"}"#;
        let mut out = Vec::new();
        for l in [&l1, &l2] {
            out.extend_from_slice(&header(&format!("{l}/"), 0, b'5', ""));
            file(&mut out, &format!("{l}/VERSION"), b"1.0");
            file(&mut out, &format!("{l}/json"), b"{}");
        }
        file(&mut out, &format!("{l1}/layer.tar"), &[5u8; 2000]);
        // the second image shares the first one's layer through a link
        link(&mut out, &format!("{l2}/layer.tar"), &format!("../{l1}/layer.tar"));
        file(&mut out, &format!("{}.json", sha(config)), config);
        file(&mut out, "manifest.json", format!("[{{\"Config\":\"{}.json\",\"RepoTags\":[\"old:1\"],\"Layers\":[\"{l1}/layer.tar\",\"{l2}/layer.tar\"]}}]", sha(config)).as_bytes());
        file(&mut out, "repositories", format!("{{\"old\":{{\"1\":\"{l2}\"}}}}").as_bytes());
        let info = inspect_archive(&write_tmp(dir.path(), "old.tar", &finish(out))).unwrap();
        assert_eq!(info.tags, vec!["old:1"]);
        // `repositories` next to manifest.json does not cancel the proof of the config
        assert_eq!(info.tag_ids, vec![ImageTagIds { tag: "old:1".into(), ids: vec![sha(config)] }]);
        assert_eq!(info.unreadable_names, 0);
    }

    // ---- names that cannot be read are counted, not dropped

    #[test]
    fn old_export_formats_and_repository_names() {
        let dir = tempfile::tempdir().unwrap();
        // repositories without manifest.json: the legacy loader would apply its names
        let mut out = Vec::new();
        file(&mut out, "repositories", br#"{"app":{"v1":"abc"}}"#);
        file(&mut out, &format!("{}/layer.tar", "a".repeat(64)), b"x");
        let m = msg(inspect_archive(&write_tmp(dir.path(), "legacy.tar", &finish(out))));
        assert!(m.contains("old Docker export format"), "{m}");
        // with a manifest, tags that only `repositories` has are shown (and never proven)
        let mut out = Vec::new();
        file(&mut out, "manifest.json", br#"[{"RepoTags":["app:1"]}]"#);
        file(&mut out, "repositories", br#"{"app":{"1":"x","extra":"y"},"other/img":{"9":"z"}}"#);
        let info = inspect_archive(&write_tmp(dir.path(), "r.tar", &finish(out))).unwrap();
        assert_eq!(info.tags, vec!["app:1", "app:extra", "other/img:9"]);
        assert!(info.tag_ids.is_empty());
        // a damaged repositories file and a repeated one
        let mut out = Vec::new();
        file(&mut out, "manifest.json", br#"[{"RepoTags":["app:1"]}]"#);
        file(&mut out, "repositories", b"{{{");
        assert!(msg(inspect_archive(&write_tmp(dir.path(), "d.tar", &finish(out)))).contains("repositories in this file is damaged"));
        let mut out = Vec::new();
        file(&mut out, "manifest.json", br#"[{"RepoTags":["app:1"]}]"#);
        file(&mut out, "repositories", b"{}");
        file(&mut out, "./repositories", b"{}");
        assert!(msg(inspect_archive(&write_tmp(dir.path(), "dd.tar", &finish(out)))).contains("more than once"));
    }

    #[test]
    fn unreadable_names_are_counted() {
        let dir = tempfile::tempdir().unwrap();
        let mut out = Vec::new();
        file(&mut out, "manifest.json", br#"[{"RepoTags":["good:1","Bad Name:1","notag"]}]"#);
        file(&mut out, "index.json", br#"{"manifests":[
            {"annotations":{"org.opencontainers.image.ref.name":"app"}},
            {"annotations":{"io.containerd.image.name":"docker.io/library/web:2","org.opencontainers.image.ref.name":"2"}},
            {"annotations":{"org.opencontainers.image.ref.name":"latest"}},
            {"digest":"sha256:1"}]}"#);
        let info = inspect_archive(&write_tmp(dir.path(), "u.tar", &finish(out))).unwrap();
        assert_eq!(info.tags, vec!["good:1", "web:2"]);
        // "Bad Name:1", "notag", and the two descriptors whose only name is a bare tag; the "2" next to a full name is normal
        assert_eq!(info.unreadable_names, 4);
        let mut out = Vec::new();
        file(&mut out, "manifest.json", br#"[{"RepoTags":["good:1"]}]"#);
        assert_eq!(inspect_archive(&write_tmp(dir.path(), "z.tar", &finish(out))).unwrap().unreadable_names, 0);
    }

    #[test]
    fn a_modern_docker_save_with_repositories_is_proven() {
        let dir = tempfile::tempdir().unwrap();
        let config = br#"{"architecture":"amd64","os":"linux","rootfs":{}}"#;
        let id = sha(config);
        let layer = sha(b"layer");
        let mut out = Vec::new();
        out.extend_from_slice(&header("blobs/", 0, b'5', ""));
        out.extend_from_slice(&header("blobs/sha256/", 0, b'5', ""));
        file(&mut out, &format!("blobs/sha256/{layer}"), &[3u8; 3000]);
        file(&mut out, &format!("blobs/sha256/{id}"), config);
        file(&mut out, "manifest.json", format!("[{{\"Config\":\"blobs/sha256/{id}\",\"RepoTags\":[\"myapp:latest\"],\"Layers\":[\"blobs/sha256/{layer}\"]}}]").as_bytes());
        file(&mut out, "repositories", format!("{{\"myapp\":{{\"latest\":\"{layer}\"}}}}").as_bytes());
        let tar = finish(out);
        let info = inspect_archive(&write_tmp(dir.path(), "modern.tar", &tar)).unwrap();
        assert_eq!(info.tags, vec!["myapp:latest"]);
        assert_eq!(info.tag_ids, vec![ImageTagIds { tag: "myapp:latest".into(), ids: vec![id.clone()] }]);
        // a name only `repositories` has is shown but not proven
        let mut out = Vec::new();
        file(&mut out, &format!("blobs/sha256/{id}"), config);
        file(&mut out, "manifest.json", format!("[{{\"Config\":\"blobs/sha256/{id}\",\"RepoTags\":[\"myapp:latest\"]}}]").as_bytes());
        file(&mut out, "repositories", br#"{"myapp":{"latest":"x","hidden":"y"}}"#);
        let info = inspect_archive(&write_tmp(dir.path(), "extra.tar", &finish(out))).unwrap();
        assert_eq!(info.tags, vec!["myapp:latest", "myapp:hidden"]);
        assert_eq!(info.tag_ids.iter().map(|t| t.tag.as_str()).collect::<Vec<_>>(), vec!["myapp:latest"]);
        // index.json without manifest.json plus repositories: unknown which one the loader uses, so no proof
        let manifest_blob = format!("{{\"config\":{{\"digest\":\"sha256:{id}\"}}}}");
        let m = sha(manifest_blob.as_bytes());
        let mut out = Vec::new();
        file(&mut out, &format!("blobs/sha256/{m}"), manifest_blob.as_bytes());
        file(&mut out, "index.json", format!("{{\"manifests\":[{{\"digest\":\"sha256:{m}\",\"annotations\":{{\"io.containerd.image.name\":\"docker.io/library/myapp:latest\"}}}}]}}").as_bytes());
        file(&mut out, "repositories", br#"{"myapp":{"latest":"x"}}"#);
        let info = inspect_archive(&write_tmp(dir.path(), "ocirepo.tar", &finish(out))).unwrap();
        assert_eq!(info.tags, vec!["myapp:latest"]);
        assert!(info.tag_ids.is_empty());
    }
}
