//! Local terminal tabs (PowerShell / cmd / WSL / Git Bash / zsh…) via portable-pty.
//! Output uses the same `TermData` / `TermExit` events as SSH terminals.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::broadcast;

use crate::model::LocalShell;
use crate::{new_id, CoreEvent, Error, Result};

struct LocalTerm {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

pub struct LocalTerminals {
    events: broadcast::Sender<CoreEvent>,
    map: Arc<Mutex<HashMap<String, LocalTerm>>>,
}

fn on_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(exe)).find(|p| p.is_file())
}

fn shell(id: &str, label: &str, program: impl AsRef<Path>, args: &[&str]) -> LocalShell {
    LocalShell {
        id: id.into(),
        label: label.into(),
        program: program.as_ref().to_string_lossy().into_owned(),
        args: args.iter().map(|s| s.to_string()).collect(),
    }
}

/// Shells installed on this computer, best first.
pub fn available_shells() -> Vec<LocalShell> {
    let mut out = Vec::new();
    if cfg!(windows) {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let sys32 = Path::new(&sys).join("System32");
        if let Some(p) = on_path("pwsh.exe") {
            out.push(shell("pwsh", "PowerShell 7", p, &["-NoLogo"]));
        }
        let ps = sys32.join(r"WindowsPowerShell\v1.0\powershell.exe");
        if ps.is_file() {
            out.push(shell("powershell", "Windows PowerShell", ps, &["-NoLogo"]));
        }
        let cmd = std::env::var("ComSpec").map(PathBuf::from).unwrap_or_else(|_| sys32.join("cmd.exe"));
        if cmd.is_file() {
            out.push(shell("cmd", "Command Prompt", cmd, &[]));
        }
        let wsl = sys32.join("wsl.exe");
        if wsl.is_file() {
            out.push(shell("wsl", "WSL", wsl, &[]));
        }
        for p in [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"] {
            if Path::new(p).is_file() {
                out.push(shell("gitbash", "Git Bash", p, &["--login", "-i"]));
                break;
            }
        }
    } else {
        if let Ok(sh) = std::env::var("SHELL") {
            let name = Path::new(&sh).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "shell".into());
            out.push(shell("login", &format!("{name} (login shell)"), &sh, &["-l"]));
        }
        for (id, p) in [("zsh", "/bin/zsh"), ("bash", "/bin/bash"), ("fish", "/opt/homebrew/bin/fish")] {
            if Path::new(p).is_file() && !out.iter().any(|s| s.program == p) {
                out.push(shell(id, id, p, &["-l"]));
            }
        }
    }
    out
}

impl LocalTerminals {
    pub fn new(events: broadcast::Sender<CoreEvent>) -> Self {
        Self { events, map: Default::default() }
    }

    pub fn open(&self, shell_id: &str, cols: u16, rows: u16) -> Result<String> {
        let sh = available_shells()
            .into_iter()
            .find(|s| s.id == shell_id)
            .ok_or_else(|| Error::NotFound(format!("shell {shell_id}")))?;
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| Error::Other(format!("could not open a terminal: {e}")))?;
        let mut cmd = CommandBuilder::new(&sh.program);
        cmd.args(&sh.args);
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| Error::Other(format!("could not start {}: {e}", sh.label)))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| Error::Other(e.to_string()))?;
        let writer = pair.master.take_writer().map_err(|e| Error::Other(e.to_string()))?;
        let killer = child.clone_killer();

        let id = format!("local:{}", new_id());
        self.map.lock().insert(id.clone(), LocalTerm { writer, master: pair.master, killer });

        // Output → TermData
        let events = self.events.clone();
        let tid = id.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = events.send(CoreEvent::TermData { term_id: tid.clone(), data: B64.encode(&buf[..n]) });
                    }
                }
            }
        });

        // Exit → TermExit (and free the pty so the reader thread ends too)
        let events = self.events.clone();
        let map = self.map.clone();
        let tid = id.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            map.lock().remove(&tid);
            let code = status.ok().map(|s| s.exit_code());
            let _ = events.send(CoreEvent::TermExit { term_id: tid, code, reason: None });
        });

        Ok(id)
    }

    pub fn write(&self, id: &str, bytes: &[u8]) -> Result<()> {
        let mut map = self.map.lock();
        let t = map.get_mut(id).ok_or_else(|| Error::NotFound(format!("terminal {id}")))?;
        t.writer.write_all(bytes).map_err(Error::Io)?;
        t.writer.flush().map_err(Error::Io)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let map = self.map.lock();
        let t = map.get(id).ok_or_else(|| Error::NotFound(format!("terminal {id}")))?;
        t.master
            .resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| Error::Other(e.to_string()))
    }

    pub fn close(&self, id: &str) {
        if let Some(mut t) = self.map.lock().remove(id) {
            let _ = t.killer.kill();
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self.map.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }
}
