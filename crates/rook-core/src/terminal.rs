//! Interactive terminals = PTY channels on the host's shared SSH session.
//! A terminal holds a lease, so the session stays open while any terminal exists.

use std::collections::HashMap;
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use russh::ChannelMsg;
use tokio::sync::{broadcast, mpsc};

use crate::model::TermOpen;
use crate::ssh::ConnectionManager;
use crate::{new_id, CoreEvent, Error, Result};

enum TermCmd {
    Write(Vec<u8>),
    Resize(u16, u16),
    Close,
}

struct TermHandle {
    host_id: String,
    tx: mpsc::UnboundedSender<TermCmd>,
}

pub struct Terminals {
    conns: Arc<ConnectionManager>,
    events: broadcast::Sender<CoreEvent>,
    map: Arc<Mutex<HashMap<String, TermHandle>>>,
}

impl Terminals {
    pub fn new(conns: Arc<ConnectionManager>, events: broadcast::Sender<CoreEvent>) -> Self {
        Self { conns, events, map: Default::default() }
    }

    pub async fn open(&self, req: TermOpen) -> Result<String> {
        let lease = self.conns.acquire(&req.host_id).await?;
        let handle = lease.handle().await?;
        let mut ch = handle.channel_open_session().await?;
        ch.request_pty(false, "xterm-256color", req.cols.max(2) as u32, req.rows.max(2) as u32, 0, 0, &[])
            .await?;

        if let Some(container) = &req.container {
            if !container.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) {
                return Err(Error::Other("invalid container name".into()));
            }
            ch.exec(
                true,
                format!("docker exec -it {container} sh -c 'command -v bash >/dev/null && exec bash || exec sh'"),
            )
            .await?;
        } else if let Some(cwd) = req.cwd.as_deref().filter(|c| !c.is_empty()) {
            ch.exec(true, format!("cd {} 2>/dev/null; exec \"${{SHELL:-/bin/sh}}\" -l", shell_quote(cwd)))
                .await?;
        } else {
            ch.request_shell(true).await?;
        }

        let term_id = new_id();
        let (tx, mut rx) = mpsc::unbounded_channel();
        self.map.lock().insert(term_id.clone(), TermHandle { host_id: req.host_id.clone(), tx });

        let events = self.events.clone();
        let map = self.map.clone();
        let id = term_id.clone();
        tokio::spawn(async move {
            let _lease = lease; // keeps the session alive for the terminal's lifetime
            let mut code = None;
            let mut reason = None;
            loop {
                tokio::select! {
                    cmd = rx.recv() => match cmd {
                        Some(TermCmd::Write(bytes)) => {
                            if ch.data(&bytes[..]).await.is_err() {
                                reason = Some("write failed".to_string());
                                break;
                            }
                        }
                        Some(TermCmd::Resize(c, r)) => {
                            let _ = ch.window_change(c as u32, r as u32, 0, 0).await;
                        }
                        Some(TermCmd::Close) | None => {
                            let _ = ch.close().await;
                            reason = Some("closed".to_string());
                            break;
                        }
                    },
                    msg = ch.wait() => match msg {
                        Some(ChannelMsg::Data { ref data }) | Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            let _ = events.send(CoreEvent::TermData { term_id: id.clone(), data: B64.encode(&data[..]) });
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                        Some(ChannelMsg::Close) => break,
                        None => {
                            reason = Some("connection lost".to_string());
                            break;
                        }
                        _ => {}
                    },
                }
            }
            map.lock().remove(&id);
            let _ = events.send(CoreEvent::TermExit { term_id: id, code, reason });
        });

        Ok(term_id)
    }

    fn send(&self, term_id: &str, cmd: TermCmd) -> Result<()> {
        let map = self.map.lock();
        let t = map.get(term_id).ok_or_else(|| Error::NotFound(format!("terminal {term_id}")))?;
        t.tx.send(cmd).map_err(|_| Error::Other("terminal closed".into()))
    }

    pub fn write(&self, term_id: &str, bytes: Vec<u8>) -> Result<()> {
        self.send(term_id, TermCmd::Write(bytes))
    }

    pub fn resize(&self, term_id: &str, cols: u16, rows: u16) -> Result<()> {
        self.send(term_id, TermCmd::Resize(cols, rows))
    }

    pub fn close(&self, term_id: &str) -> Result<()> {
        self.send(term_id, TermCmd::Close)
    }

    pub fn host_terminals(&self, host_id: &str) -> Vec<String> {
        self.map.lock().iter().filter(|(_, t)| t.host_id == host_id).map(|(k, _)| k.clone()).collect()
    }

    pub async fn close_all(&self) {
        let ids: Vec<String> = self.map.lock().keys().cloned().collect();
        for id in ids {
            let _ = self.close(&id);
        }
    }
}

/// POSIX single-quote a path for `sh`.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::shell_quote;

    #[test]
    fn quotes_safely() {
        assert_eq!(shell_quote("/var/www"), "'/var/www'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }
}
