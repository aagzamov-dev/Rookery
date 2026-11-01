use crate::model::{FileEntry, FileKind};
use crate::{Error, Result};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, UNIX_EPOCH};
use tokio::io::AsyncReadExt;

pub const ID: &str = "__computer__";
pub const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

pub fn display(path: &Path) -> String {
    let value = path.to_string_lossy();
    let value = value
        .strip_prefix(r"\\?\UNC\")
        .map(|p| format!("//{p}"))
        .unwrap_or_else(|| value.strip_prefix(r"\\?\").unwrap_or(&value).to_string());
    if cfg!(windows) {
        value.replace('\\', "/")
    } else {
        value
    }
}

pub fn path(value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.contains('\0') || value.len() > 32768 {
        return Err(Error::Other("Enter an absolute local path.".into()));
    }
    let home =
        || dirs::home_dir().ok_or_else(|| Error::Other("Home folder is unavailable.".into()));
    let p = if value == "~" {
        home()?
    } else if let Some(rest) = value.strip_prefix("~/") {
        home()?.join(rest)
    } else {
        PathBuf::from(value)
    };
    if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(Error::Other("Use an absolute path without ..".into()));
    }
    Ok(p)
}

pub fn home() -> Result<String> {
    dirs::home_dir()
        .map(|p| display(&p))
        .ok_or_else(|| Error::Other("Home folder is unavailable.".into()))
}
pub fn mtime(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_secs() as i64)
        .unwrap_or(0)
}

pub fn list(value: &str) -> Result<Vec<FileEntry>> {
    let folder = path(value)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(folder)? {
        if entries.len() >= 20_000 {
            return Err(Error::Other(
                "This folder has more than 20,000 entries. Open a smaller folder.".into(),
            ));
        }
        let entry = entry?;
        let meta = std::fs::symlink_metadata(entry.path())?;
        let kind = if meta.is_symlink() {
            FileKind::Link
        } else if meta.is_dir() {
            FileKind::Dir
        } else {
            FileKind::File
        };
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            Some(meta.permissions().mode())
        };
        #[cfg(not(unix))]
        let mode = None;
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: display(&entry.path()),
            kind,
            size: meta.len(),
            mtime: mtime(&meta),
            mode,
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != FileKind::Dir)
            .cmp(&(b.kind != FileKind::Dir))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}
pub fn mkdir(value: &str) -> Result<()> {
    Ok(std::fs::create_dir(path(value)?)?)
}
pub fn rename(from: &str, to: &str) -> Result<()> {
    let to = path(to)?;
    if std::fs::symlink_metadata(&to).is_ok() {
        return Err(Error::Other(
            "The destination already exists; nothing was replaced.".into(),
        ));
    }
    rename_exclusive(&path(from)?, &to)
}
fn rename_exclusive(from: &Path, to: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let from = std::ffi::CString::new(from.as_os_str().as_bytes())
            .map_err(|_| Error::Other("Invalid path.".into()))?;
        let to = std::ffi::CString::new(to.as_os_str().as_bytes())
            .map_err(|_| Error::Other("Invalid path.".into()))?;
        // RENAME_EXCL atomically refuses an existing destination.
        let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileW(from: *const u16, to: *const u16) -> i32;
        }
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        let result = unsafe { MoveFileW(from.as_ptr(), to.as_ptr()) };
        if result == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Err(Error::Other(
            "Local rename is supported on macOS and Windows.".into(),
        ))
    }
}
pub fn delete(value: &str, recursive: bool, confirmed: bool) -> Result<()> {
    if !confirmed {
        return Err(Error::Other(
            "Confirm deletion on this computer first.".into(),
        ));
    }
    let p = path(value)?;
    let parent = p
        .parent()
        .ok_or_else(|| Error::Other("The root folder cannot be deleted here.".into()))?;
    let canonical_parent = std::fs::canonicalize(parent)?;
    let resolved = canonical_parent.join(
        p.file_name()
            .ok_or_else(|| Error::Other("Choose a file or folder.".into()))?,
    );
    let meta = std::fs::symlink_metadata(&p)?;
    let target = if meta.is_dir() && !meta.is_symlink() {
        std::fs::canonicalize(&p)?
    } else {
        resolved
    };
    let is_home = !meta.is_symlink()
        && dirs::home_dir()
            .and_then(|home| std::fs::canonicalize(home).ok())
            .is_some_and(|home| {
                if cfg!(windows) {
                    let home = display(&home).to_lowercase();
                    let target = display(&target).to_lowercase();
                    home == target
                        || home.starts_with(&format!("{}/", target.trim_end_matches('/')))
                } else {
                    home.starts_with(&target)
                }
            });
    if p.parent().is_none() || is_home {
        return Err(Error::Other(
            "The root and home folders cannot be deleted here.".into(),
        ));
    }
    if meta.is_dir() && !meta.is_symlink() {
        if recursive {
            std::fs::remove_dir_all(p)?;
        } else {
            std::fs::remove_dir(p)?;
        }
    } else {
        std::fs::remove_file(p)?;
    }
    Ok(())
}
pub fn read(value: &str, limit: u64) -> Result<(Vec<u8>, std::fs::Metadata)> {
    let p = path(value)?;
    if !std::fs::metadata(&p)?.is_file() {
        return Err(Error::Other("Select a regular file.".into()));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let f = options.open(p)?;
    let meta = f.metadata()?;
    if !meta.is_file() {
        return Err(Error::Other("Select a regular file.".into()));
    }
    if meta.len() > limit {
        return Err(Error::Other(
            "This file is too large to open in the editor.".into(),
        ));
    }
    let mut bytes = Vec::new();
    f.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(Error::Other(
            "This file grew beyond the editor limit.".into(),
        ));
    }
    Ok((bytes, meta))
}

pub fn docker_endpoint() -> String {
    if cfg!(windows) {
        return "npipe:////./pipe/docker_engine".into();
    }
    if let Some(home) = dirs::home_dir() {
        let socket = home.join(".docker/run/docker.sock");
        if socket.exists() {
            return format!("unix://{}", display(&socket));
        }
    }
    "unix:///var/run/docker.sock".into()
}
pub const DOCKER_ENV: &[&str] = &[
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
];

fn pin_docker_command(command: &mut tokio::process::Command, endpoint: &str) {
    for key in DOCKER_ENV {
        command.env_remove(key);
    }
    command.args(["--host", endpoint]);
}

pub fn executable(program: &str) -> PathBuf {
    let name = if cfg!(windows) {
        format!("{program}.exe")
    } else {
        program.to_string()
    };
    if let Some(path) = std::env::var_os("PATH") {
        if let Some(found) = std::env::split_paths(&path)
            .map(|p| p.join(&name))
            .find(|p| p.is_file())
        {
            return found;
        }
    }
    #[cfg(target_os = "macos")]
    if program == "docker" {
        let path = PathBuf::from("/Applications/Docker.app/Contents/Resources/bin/docker");
        if path.is_file() {
            return path;
        }
    }
    #[cfg(windows)]
    if let Some(base) =
        std::env::var_os("ProgramFiles").filter(|_| program == "git" || program == "docker")
    {
        let path = PathBuf::from(base).join(if program == "git" {
            r"Git\cmd\git.exe"
        } else {
            r"Docker\Docker\resources\bin\docker.exe"
        });
        if path.is_file() {
            return path;
        }
    }
    PathBuf::from(program)
}

pub fn command(program: &str) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(executable(program));
    if program == "docker" {
        pin_docker_command(&mut c, &docker_endpoint());
    }
    c.kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    c.creation_flags(0x08000000);
    c
}
pub async fn run(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    seconds: u64,
) -> Result<String> {
    run_output(program, args, cwd, seconds, false).await
}
pub async fn run_output(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    seconds: u64,
    combine: bool,
) -> Result<String> {
    let mut command = command(program);
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_ASKPASS", "echo")
        .env("SSH_ASKPASS", "echo")
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("GIT_EDITOR", "true")
        .env("LC_ALL", "C");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(test)]
    command.env("GIT_CONFIG_NOSYSTEM", "1").env(
        "GIT_CONFIG_GLOBAL",
        if cfg!(windows) { "NUL" } else { "/dev/null" },
    );
    let mut child = command.spawn().map_err(|e| Error::Other(format!("Cannot start {program} on this computer: {e}. Install it and restart Rookery, then Reload.")))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let work = async {
        let read = |stream: Box<dyn tokio::io::AsyncRead + Unpin + Send>| async move {
            let mut out = Vec::new();
            stream
                .take(OUTPUT_LIMIT as u64 + 1)
                .read_to_end(&mut out)
                .await?;
            if out.len() > OUTPUT_LIMIT {
                return Err(Error::Other(
                    "Command output exceeds 4 MB. Narrow the selection.".into(),
                ));
            }
            Ok::<_, Error>(out)
        };
        let (out, err) = tokio::try_join!(read(Box::new(stdout)), read(Box::new(stderr)))?;
        let status = child.wait().await?;
        if !status.success() {
            return Err(Error::Other(
                format!(
                    "{}{}",
                    String::from_utf8_lossy(&err),
                    String::from_utf8_lossy(&out)
                )
                .trim()
                .to_string(),
            ));
        }
        let mut out = out;
        if combine {
            out.extend_from_slice(&err);
        }
        String::from_utf8(out).map_err(|_| Error::Other("Command output is not UTF-8 text.".into()))
    };
    tokio::time::timeout(Duration::from_secs(seconds), work)
        .await
        .map_err(|_| {
            Error::Other(format!(
                "{program} timed out. Reload before retrying; the operation may have completed."
            ))
        })?
}
pub fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| v.to_string()).collect()
}

pub struct Metrics {
    system: sysinfo::System,
    disks: sysinfo::Disks,
    networks: sysinfo::Networks,
    previous: Option<std::time::Instant>,
}
impl Metrics {
    pub fn new() -> Self {
        Self {
            system: sysinfo::System::new(),
            disks: sysinfo::Disks::new(),
            networks: sysinfo::Networks::new(),
            previous: None,
        }
    }
    pub fn sample(&mut self) -> crate::model::MetricsSample {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.networks.refresh(true);
        self.disks.refresh(true);
        let now = std::time::Instant::now();
        let elapsed = self.previous.map(|p| now.duration_since(p).as_secs_f64());
        let home = dirs::home_dir().unwrap_or_default();
        let disk = self
            .disks
            .iter()
            .filter(|d| home.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().as_os_str().len());
        let total = disk.map(|d| d.total_space()).unwrap_or(0);
        let used = disk
            .map(|d| d.total_space().saturating_sub(d.available_space()))
            .unwrap_or(0);
        let rx: u64 = self
            .networks
            .iter()
            .filter(|(n, _)| !n.to_ascii_lowercase().starts_with("lo"))
            .map(|(_, n)| n.received())
            .sum();
        let tx: u64 = self
            .networks
            .iter()
            .filter(|(n, _)| !n.to_ascii_lowercase().starts_with("lo"))
            .map(|(_, n)| n.transmitted())
            .sum();
        let load = sysinfo::System::load_average();
        self.previous = Some(now);
        crate::model::MetricsSample {
            ts_ms: crate::now_ms(),
            cpu_pct: elapsed.map(|_| self.system.global_cpu_usage()),
            ram_used_bytes: self.system.used_memory(),
            ram_total_bytes: self.system.total_memory(),
            disk_pct: if total > 0 {
                used as f32 / total as f32 * 100.0
            } else {
                0.0
            },
            disk_used_bytes: used,
            disk_total_bytes: total,
            load1: load.one as f32,
            load5: load.five as f32,
            load15: load.fifteen as f32,
            uptime_s: sysinfo::System::uptime(),
            net_rx_bps: elapsed.map(|e| (rx as f64 / e.max(0.001)) as u64),
            net_tx_bps: elapsed.map(|e| (tx as f64 / e.max(0.001)) as u64),
        }
    }
}

pub async fn docker_stream<F, Fut>(values: Vec<String>, mut emit: F) -> Result<()>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let mut child = command("docker").args(values).spawn().map_err(|e| {
        Error::Other(format!(
            "Cannot start Docker CLI: {e}. Install Docker and restart Rookery, then Reload Docker."
        ))
    })?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let mut stdout = crate::ssh::LineSplitter::default();
    let mut stderr = crate::ssh::LineSplitter::default();
    let (mut out_open, mut err_open) = (true, true);
    let mut ob = [0u8; 16384];
    let mut eb = [0u8; 16384];
    let mut error = String::new();
    while out_open || err_open {
        tokio::select! {
            n=out.read(&mut ob),if out_open=>{let n=n?;if n==0 {out_open=false;} else {let lines=stdout.push(&ob[..n]);if !lines.is_empty(){emit(lines).await?;}}},
            n=err.read(&mut eb),if err_open=>{let n=n?;if n==0 {err_open=false;} else {if error.len()<8192 {error.push_str(&String::from_utf8_lossy(&eb[..n.min(8192-error.len())]));}let lines=stderr.push(&eb[..n]);if !lines.is_empty(){emit(lines).await?;}}},
        }
    }
    let status = child.wait().await?;
    if !status.success() {
        return Err(Error::Other(if error.trim().is_empty() {
            "Docker stopped. Check Docker Desktop, then Reload Docker.".into()
        } else {
            error.trim().into()
        }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn computer_resource_never_acquires_an_ssh_session() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::init(dir.path()).unwrap();
        assert!(core.connections.acquire(ID).await.is_err());
        assert!(core.connections.all_info().is_empty());
    }
    #[test]
    fn docker_is_pinned_to_local_socket_and_remote_environment_is_removed() {
        let mut command = tokio::process::Command::new("docker");
        command
            .env("DOCKER_HOST", "ssh://production")
            .env("DOCKER_CONTEXT", "production");
        pin_docker_command(&mut command, "unix:///fixture/docker.sock");
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|v| v.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, vec!["--host", "unix:///fixture/docker.sock"]);
        let vars: std::collections::HashMap<_, _> = command.as_std().get_envs().collect();
        for name in DOCKER_ENV {
            assert_eq!(vars.get(std::ffi::OsStr::new(name)), Some(&None));
        }
    }
    #[test]
    fn local_files_are_bounded_and_rename_never_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("file '$() &.txt");
        let other = dir.path().join("other.txt");
        std::fs::write(&original, b"original").unwrap();
        std::fs::write(&other, b"other").unwrap();
        assert!(read(&display(&original), 3).is_err());
        assert!(delete(&display(&original), false, false).is_err());
        assert_eq!(std::fs::read(&original).unwrap(), b"original");
        assert!(rename(&display(&original), &display(&other)).is_err());
        assert_eq!(std::fs::read(&other).unwrap(), b"other");
        let next = dir.path().join("new.txt");
        rename(&display(&original), &display(&next)).unwrap();
        assert_eq!(read(&display(&next), 20).unwrap().0, b"original");
        assert!(path("relative/file").is_err());
        assert!(path(&format!("{}/../file", display(dir.path()))).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn local_read_rejects_fifo_and_symlink_to_fifo_without_opening_it() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("pipe");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(read(&display(&fifo), 100).is_err());
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&fifo, &link).unwrap();
        assert!(read(&display(&link), 100).is_err());
        assert!(read(&display(dir.path()), 100).is_err());
    }
}
