//! Docker images of a server (or this computer): list with the containers using each one,
//! remove, and prune. Saving images to a file is in [`crate::imageexport`].
//!
//! Remote commands go through [`Sudo::exec_docker`] (so auto sudo applies); this computer uses
//! the local Docker CLI. Image references are validated before they reach a shell.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use serde::Serialize;
use ts_rs::TS;

use crate::collectors::valid_image_ref;
use crate::ssh::ConnectionManager;
use crate::sudo::Sudo;
use crate::{Error, Result};

/// Most images removed in one request.
pub const REMOVE_MAX: usize = 500;
/// Ids per `docker inspect` call (keeps command lines short).
const INSPECT_CHUNK: usize = 100;

/// One row of `docker image ls` (an image with several tags appears once per tag).
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct DockerImage {
    /// Full image id (hex, without the `sha256:` prefix).
    pub id: String,
    /// `<none>` for untagged images.
    pub repository: String,
    pub tag: String,
    /// What `docker rmi` / `docker save` take for this row: `repository:tag`, or the short id
    /// when the image has no repository or no tag.
    pub reference: String,
    #[ts(type = "number")]
    pub size: u64,
    /// Unix seconds.
    #[ts(type = "number")]
    pub created_at: i64,
    /// Names of the containers (running or stopped) created from this image.
    pub containers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ImageFailure {
    pub reference: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ImageRemoveResult {
    pub removed: Vec<String>,
    pub failed: Vec<ImageFailure>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ImagePruneResult {
    /// Docker's own wording, e.g. `1.2GB`.
    pub reclaimed: String,
}

// ---------------------------------------------------------------- running docker

struct Runner<'a> {
    sudo: &'a Sudo,
    host_id: &'a str,
    lease: Option<crate::ssh::Lease>,
}

/// Output of one docker call. Remote: stdout and stderr together.
struct Out {
    text: String,
    ok: bool,
}

impl<'a> Runner<'a> {
    async fn new(conns: &'a ConnectionManager, sudo: &'a Sudo, host_id: &'a str) -> Result<Runner<'a>> {
        let lease = if host_id == crate::computer::ID { None } else { Some(conns.acquire(host_id).await?) };
        Ok(Self { sudo, host_id, lease })
    }

    async fn run(&self, args: &[&str], seconds: u64) -> Result<Out> {
        match &self.lease {
            None => {
                let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
                Ok(match crate::computer::run_output("docker", &args, None, seconds, false).await {
                    Ok(text) => Out { text, ok: true },
                    Err(e) => Out { text: e.to_string(), ok: false },
                })
            }
            Some(lease) => {
                let h = lease.handle().await?;
                let cmd = args.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");
                let out = self.sudo.exec_docker(&h, self.host_id, &cmd, Duration::from_secs(seconds)).await?;
                Ok(Out { ok: out.exit == Some(0), text: out.stdout })
            }
        }
    }

    /// A call that must succeed.
    async fn strict(&self, args: &[&str], seconds: u64) -> Result<String> {
        let out = self.run(args, seconds).await?;
        if out.ok {
            Ok(out.text)
        } else {
            Err(Error::Other(clean_message(&out.text)))
        }
    }
}

/// Single-quote `s` for `sh` unless it only has harmless characters.
pub fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.-/:@=,".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

pub(crate) fn clean_message(text: &str) -> String {
    let t = text.trim();
    let t = t.strip_prefix("Error response from daemon: ").unwrap_or(t);
    let t = t.strip_prefix("Error: ").unwrap_or(t);
    if t.is_empty() {
        "docker failed without a message".into()
    } else {
        t.chars().take(600).collect()
    }
}

// ---------------------------------------------------------------- list

pub async fn list(conns: &ConnectionManager, sudo: &Sudo, host_id: &str) -> Result<Vec<DockerImage>> {
    let r = Runner::new(conns, sudo, host_id).await?;
    let ls = r.strict(&["image", "ls", "--no-trunc", "--format", "{{json .}}"], 30).await?;
    let rows = parse_image_ls(&ls);
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect::<BTreeSet<_>>().into_iter().collect();

    // Exact sizes and creation times; the human-readable values of `image ls` are the fallback.
    let mut exact = HashMap::new();
    for chunk in ids.chunks(INSPECT_CHUNK) {
        let mut args = vec!["image", "inspect", "--format", "{{.Id}}|{{.Size}}|{{.Created}}"];
        args.extend(chunk.iter().map(String::as_str));
        if let Ok(out) = r.run(&args, 30).await {
            exact.extend(parse_image_inspect(&out.text));
        }
    }

    // Which containers (running or not) use which image, matched by full image id.
    let mut users: HashMap<String, Vec<String>> = HashMap::new();
    let ps = r.strict(&["ps", "-a", "-q", "--no-trunc"], 30).await?;
    let container_ids: Vec<&str> = ps.lines().map(str::trim).filter(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_hexdigit())).collect();
    for chunk in container_ids.chunks(INSPECT_CHUNK) {
        let mut args = vec!["container", "inspect", "--format", "{{.Image}}|{{.Name}}"];
        args.extend(chunk.iter().copied());
        // A container removed between `ps` and `inspect` makes the exit code non-zero; the
        // lines for the others are still there.
        let out = r.run(&args, 30).await?;
        for (image, name) in parse_container_images(&out.text) {
            users.entry(image).or_default().push(name);
        }
    }
    Ok(build_images(rows, &exact, users))
}

/// One parsed `docker image ls` row.
#[derive(Debug, Clone, PartialEq)]
pub struct RawImage {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: Option<u64>,
    pub created: Option<i64>,
}

/// `docker image ls --format '{{json .}}'` lines. Lines that are not JSON are skipped.
pub fn parse_image_ls(out: &str) -> Vec<RawImage> {
    out.lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .filter_map(|v| {
            let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let id = normalize_id(&s("ID"));
            if id.is_empty() {
                return None;
            }
            Some(RawImage {
                id,
                repository: or_none(s("Repository")),
                tag: or_none(s("Tag")),
                size: parse_size(&s("Size")),
                created: parse_created_at(&s("CreatedAt")),
            })
        })
        .collect()
}

fn or_none(s: String) -> String {
    if s.is_empty() { "<none>".into() } else { s }
}

/// `sha256:abcd…` → `abcd…`
pub fn normalize_id(id: &str) -> String {
    id.trim().strip_prefix("sha256:").unwrap_or(id.trim()).to_string()
}

/// Docker's human-readable size (`77.8MB`, `1.2GB`, `12.5kB`, `512B`, also `1.5GiB`) in bytes.
/// Docker's `MB`/`GB` are decimal; the `iB` units are binary.
pub fn parse_size(text: &str) -> Option<u64> {
    let t = text.trim();
    let split = t.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
    let (num, unit) = t.split_at(split);
    let n: f64 = num.parse().ok()?;
    let mult: f64 = match unit.trim().to_ascii_lowercase().as_str() {
        "b" => 1.0,
        "kb" => 1e3,
        "mb" => 1e6,
        "gb" => 1e9,
        "tb" => 1e12,
        "kib" => 1024.0,
        "mib" => 1024.0 * 1024.0,
        "gib" => 1024.0 * 1024.0 * 1024.0,
        "tib" => 1024.0_f64.powi(4),
        _ => return None,
    };
    Some((n * mult).round() as u64)
}

/// `2024-05-01 10:11:12 +0000 UTC` (the zone name at the end is ignored) → unix seconds.
pub fn parse_created_at(text: &str) -> Option<i64> {
    let mut parts = text.split_whitespace();
    let (date, time, offset) = (parts.next()?, parts.next()?, parts.next()?);
    let format = time::macros::format_description!("[year]-[month]-[day] [hour]:[minute]:[second] [offset_hour sign:mandatory][offset_minute]");
    time::OffsetDateTime::parse(&format!("{date} {time} {offset}"), &format).ok().map(|t| t.unix_timestamp())
}

/// `docker image inspect --format '{{.Id}}|{{.Size}}|{{.Created}}'` → id → (bytes, unix seconds).
/// Other lines (errors for images that vanished) are skipped.
pub fn parse_image_inspect(out: &str) -> HashMap<String, (u64, i64)> {
    out.lines()
        .filter_map(|l| {
            let mut p = l.trim().split('|');
            let id = p.next()?;
            let size: u64 = p.next()?.trim().parse().ok()?;
            let created = time::OffsetDateTime::parse(p.next()?.trim(), &time::format_description::well_known::Rfc3339).ok()?.unix_timestamp();
            id.starts_with("sha256:").then(|| (normalize_id(id), (size, created)))
        })
        .collect()
}

/// `docker container inspect --format '{{.Image}}|{{.Name}}'` → (image id, container name).
pub fn parse_container_images(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|l| {
            let (image, name) = l.trim().split_once('|')?;
            image.starts_with("sha256:").then(|| (normalize_id(image), name.trim_start_matches('/').to_string()))
        })
        .collect()
}

/// The `docker rmi` / `docker save` reference of a row.
pub fn reference(repository: &str, tag: &str, id: &str) -> String {
    if repository != "<none>" && tag != "<none>" {
        format!("{repository}:{tag}")
    } else {
        id.chars().take(12).collect()
    }
}

fn build_images(rows: Vec<RawImage>, exact: &HashMap<String, (u64, i64)>, mut users: HashMap<String, Vec<String>>) -> Vec<DockerImage> {
    for names in users.values_mut() {
        names.sort();
        names.dedup();
    }
    let mut list: Vec<DockerImage> = rows
        .into_iter()
        .map(|r| {
            let (size, created) = match exact.get(&r.id) {
                Some(&(s, c)) => (s, c),
                None => (r.size.unwrap_or(0), r.created.unwrap_or(0)),
            };
            DockerImage {
                reference: reference(&r.repository, &r.tag, &r.id),
                containers: users.get(&r.id).cloned().unwrap_or_default(),
                id: r.id,
                repository: r.repository,
                tag: r.tag,
                size,
                created_at: created,
            }
        })
        .collect();
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.reference.cmp(&b.reference)));
    list
}

// ---------------------------------------------------------------- remove, prune

/// `docker rmi <ref>` for each reference, one at a time (no `-f`: Docker refuses images that
/// containers use). Failures are collected per reference; a sudo failure stops everything.
pub async fn remove(conns: &ConnectionManager, sudo: &Sudo, host_id: &str, refs: &[String]) -> Result<ImageRemoveResult> {
    let refs = check_refs(refs, REMOVE_MAX)?;
    let r = Runner::new(conns, sudo, host_id).await?;
    let mut result = ImageRemoveResult { removed: Vec::new(), failed: Vec::new() };
    let mut lost: Option<String> = None;
    for reference in refs {
        if let Some(why) = &lost {
            result.failed.push(ImageFailure { reference, message: format!("not attempted: {why}") });
            continue;
        }
        match r.run(&["rmi", &reference], 120).await {
            Ok(out) if out.ok => result.removed.push(reference),
            Ok(out) => result.failed.push(ImageFailure { reference, message: clean_message(&out.text) }),
            // sudo refusing the password stops everything (retrying would count as more failed logins).
            Err(e) if sudo.state(host_id).error.is_some() => return Err(e),
            // Any other error belongs to this image; results so far are kept. A lost connection
            // would fail every remaining image the same way, so those are not attempted.
            Err(e) => {
                if matches!(e, Error::Ssh(_) | Error::AuthFailed) {
                    lost = Some(e.to_string());
                }
                result.failed.push(ImageFailure { reference, message: clean_message(&e.to_string()) });
            }
        }
    }
    Ok(result)
}

/// Validated, de-duplicated references (1 to `max`); the export module uses this too.
pub fn check_refs(refs: &[String], max: usize) -> Result<Vec<String>> {
    if refs.is_empty() || refs.len() > max {
        return Err(Error::Other(format!("Choose 1 to {max} images.")));
    }
    if refs.iter().any(|r| !valid_image_ref(r)) {
        return Err(Error::Other("invalid image reference".into()));
    }
    let mut seen = BTreeSet::new();
    Ok(refs.iter().filter(|r| seen.insert(r.as_str())).cloned().collect())
}

/// `docker image prune -f` (dangling only) or, with `all`, `docker image prune -a -f`.
pub async fn prune(conns: &ConnectionManager, sudo: &Sudo, host_id: &str, all: bool) -> Result<ImagePruneResult> {
    let r = Runner::new(conns, sudo, host_id).await?;
    let args: &[&str] = if all { &["image", "prune", "-a", "-f"] } else { &["image", "prune", "-f"] };
    // Pruning many large images can take a long time.
    let text = r.strict(args, 30 * 60).await.map_err(|e| {
        let m = e.to_string();
        if m.contains("timed out") { Error::Other(format!("{m} The prune may still be running on the server: refresh the list to see the result.")) } else { e }
    })?;
    Ok(ImagePruneResult { reclaimed: parse_reclaimed(&text).unwrap_or_else(|| "0B".into()) })
}

/// `Total reclaimed space: 1.2GB` → `1.2GB`
pub fn parse_reclaimed(out: &str) -> Option<String> {
    out.lines().find_map(|l| l.trim().strip_prefix("Total reclaimed space:").map(|v| v.trim().to_string())).filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LS: &str = r#"{"Containers":"N/A","CreatedAt":"2026-11-01 10:11:12 +0000 UTC","CreatedSince":"3 weeks ago","Digest":"<none>","ID":"sha256:aaaaaaaaaaaa1111111111111111111111111111111111111111111111111111","Repository":"nginx","SharedSize":"N/A","Size":"192MB","Tag":"latest","UniqueSize":"N/A","VirtualSize":"192MB"}
{"CreatedAt":"2026-11-10 08:00:00 +0100 CET","ID":"sha256:bbbbbbbbbbbb2222222222222222222222222222222222222222222222222222","Repository":"<none>","Size":"1.5GB","Tag":"<none>"}
{"CreatedAt":"2026-11-01 10:11:12 +0000 UTC","ID":"sha256:aaaaaaaaaaaa1111111111111111111111111111111111111111111111111111","Repository":"web/app","Size":"192MB","Tag":"v2"}
not json at all
"#;

    #[test]
    fn parses_image_ls_rows() {
        let rows = parse_image_ls(LS);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].repository, "nginx");
        assert_eq!(rows[0].id, "aaaaaaaaaaaa1111111111111111111111111111111111111111111111111111");
        assert_eq!(rows[0].size, Some(192_000_000));
        assert_eq!(rows[0].created, Some(1_793_527_872));
        assert_eq!(rows[1].tag, "<none>");
        assert_eq!(rows[1].size, Some(1_500_000_000));
        assert_eq!(rows[1].created, Some(1_794_294_000)); // 08:00 +0100 = 07:00 UTC
    }

    #[test]
    fn parses_sizes() {
        assert_eq!(parse_size("77.8MB"), Some(77_800_000));
        assert_eq!(parse_size("12.5kB"), Some(12_500));
        assert_eq!(parse_size("0B"), Some(0));
        assert_eq!(parse_size("1.2GB"), Some(1_200_000_000));
        assert_eq!(parse_size("1.5GiB"), Some(1_610_612_736));
        assert_eq!(parse_size("2TB"), Some(2_000_000_000_000));
        assert_eq!(parse_size("N/A"), None);
        assert_eq!(parse_size(""), None);
        assert_eq!(parse_size("12"), None);
    }

    #[test]
    fn parses_dates() {
        assert_eq!(parse_created_at("1970-01-02 00:00:00 +0000 UTC"), Some(86_400));
        assert_eq!(parse_created_at("1970-01-02 01:00:00 +0100 CET"), Some(86_400));
        assert_eq!(parse_created_at("garbage"), None);
    }

    #[test]
    fn parses_inspect_lines_and_skips_errors() {
        let out = "sha256:aaaa|192000123|2026-11-01T10:11:12.123456789Z\nError response from daemon: no such image: x\nsha256:bbbb|5|bad-date\n";
        let m = parse_image_inspect(out);
        assert_eq!(m.len(), 1);
        assert_eq!(m["aaaa"], (192_000_123, 1_793_527_872));
        let c = parse_container_images("sha256:aaaa|/shop-web-1\nError: No such container: gone\nsha256:aaaa|/other\n");
        assert_eq!(c, vec![("aaaa".to_string(), "shop-web-1".to_string()), ("aaaa".to_string(), "other".to_string())]);
    }

    #[test]
    fn builds_rows_newest_first_with_users_matched_by_id() {
        let rows = parse_image_ls(LS);
        let exact: HashMap<String, (u64, i64)> = [("aaaaaaaaaaaa1111111111111111111111111111111111111111111111111111".to_string(), (191_000_000, 1_793_527_872))].into();
        let users: HashMap<String, Vec<String>> = [("aaaaaaaaaaaa1111111111111111111111111111111111111111111111111111".to_string(), vec!["web-2".to_string(), "web-1".to_string(), "web-1".to_string()])].into();
        let list = build_images(rows, &exact, users);
        assert_eq!(list.len(), 3);
        // untagged image (newest) first, using the id as reference and the `image ls` size
        assert_eq!(list[0].reference, "bbbbbbbbbbbb");
        assert_eq!(list[0].size, 1_500_000_000);
        assert!(list[0].containers.is_empty());
        // both tags of the used image show the same containers and the exact size
        assert_eq!(list[1].reference, "nginx:latest");
        assert_eq!(list[1].size, 191_000_000);
        assert_eq!(list[1].containers, vec!["web-1", "web-2"]);
        assert_eq!(list[2].reference, "web/app:v2");
        assert_eq!(list[2].containers.len(), 2);
    }

    #[test]
    fn references() {
        assert_eq!(reference("nginx", "latest", "abc"), "nginx:latest");
        assert_eq!(reference("<none>", "<none>", "0123456789abcdef"), "0123456789ab");
        assert_eq!(reference("repo", "<none>", "0123456789abcdef"), "0123456789ab");
    }

    #[test]
    fn prune_output() {
        let out = "Deleted Images:\ndeleted: sha256:aaa\n\nTotal reclaimed space: 1.234GB\n";
        assert_eq!(parse_reclaimed(out).as_deref(), Some("1.234GB"));
        assert_eq!(parse_reclaimed("Total reclaimed space: 0B"), Some("0B".into()));
        assert_eq!(parse_reclaimed("nothing"), None);
    }

    #[test]
    fn checks_references_and_quotes() {
        assert!(check_refs(&[], 5).is_err());
        assert!(check_refs(&["nginx; id".into()], 5).is_err());
        assert!(check_refs(&["-f".into()], 5).is_err());
        assert_eq!(check_refs(&["a:1".into(), "a:1".into(), "b".into()], 5).unwrap(), vec!["a:1", "b"]);
        assert!(check_refs(&vec!["a".to_string(); 6], 5).is_err());
        assert_eq!(sh_quote("{{json .}}"), "'{{json .}}'");
        assert_eq!(sh_quote("nginx:1.2"), "nginx:1.2");
        assert_eq!(sh_quote("a'b"), r"'a'\''b'");
    }

    #[test]
    fn clean_messages() {
        assert_eq!(clean_message("Error response from daemon: conflict: image is being used by container abc\n"), "conflict: image is being used by container abc");
        assert_eq!(clean_message("  "), "docker failed without a message");
    }
}
