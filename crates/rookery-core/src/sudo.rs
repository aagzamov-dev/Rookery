//! Auto sudo, per server (off by default).
//!
//! When it is on for a server, Docker commands run as `sudo docker …` (for logins outside
//! the `docker` group) and the terminal fills `[sudo]` prompts by itself. The password comes
//! from the vault (the login's sudo password, else its SSH password) or was typed for this app
//! session only. It goes to sudo's stdin and never reaches the webview or a command line.
//!
//! Safety: sudo refusing the password stops every automatic attempt for that server until a
//! new password is entered, so a wrong password can't lock the account (pam_faillock).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use ts_rs::TS;
use zeroize::Zeroizing;

use crate::db::Db;
use crate::model::AuthKind;
use crate::ssh::{exec, exec_stream_with, exec_with_input, ExecOutput, SshHandle, StreamChunk, StreamInput};
use crate::vault::Vault;
use crate::{Error, Result};

/// Server ids with auto sudo on (a per-device setting, see `db::LOCAL_SETTING_KEYS`).
pub const AUTO_HOSTS_KEY: &str = "sudo.auto.hosts";
/// Prompt asked of sudo in streamed (pty) commands; answered once, then removed from the output.
const STREAM_PROMPT: &[u8] = b"[rookery-sudo]";
/// One automatic terminal fill per this period; a prompt right after one means it was wrong.
const TERM_AUTO_GAP: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SudoState {
    pub enabled: bool,
    /// A password is available (vault or typed this session). Without one, `sudo -n` is used.
    pub has_password: bool,
    /// Set after sudo refused the password: automatic sudo is paused until a new one is entered.
    pub error: Option<String>,
}

/// How a Docker command runs on a server.
pub enum Elevation {
    Plain,
    /// `sudo -n` (NOPASSWD rules).
    NoPassword,
    Password(Zeroizing<String>),
}

impl Elevation {
    /// For a script that runs docker more than once: (prelude, docker command). With a password
    /// the script's stdin carries it: the prelude reads it and each call pipes it to `sudo -S`
    /// (`printf` is a shell builtin, so it never shows in the process list).
    pub fn script(&self) -> (&'static str, &'static str) {
        match self {
            Elevation::Plain => ("", "docker"),
            Elevation::NoPassword => ("", "sudo -n docker"),
            Elevation::Password(_) => ("IFS= read -r RK_SUDO_PW; ", "printf '%s\\n' \"$RK_SUDO_PW\" | sudo -S -p '' docker"),
        }
    }

    /// The script's stdin.
    pub fn script_input(&self) -> Option<Zeroizing<Vec<u8>>> {
        match self {
            Elevation::Password(p) => Some(line(p)),
            _ => None,
        }
    }
}

pub struct Sudo {
    db: Arc<Db>,
    vault: Arc<Mutex<Vault>>,
    /// Typed for this app session only: host → password.
    typed: Mutex<HashMap<String, Zeroizing<String>>>,
    /// Hosts where sudo refused the password → message.
    refused: Mutex<HashMap<String, String>>,
    /// Terminal → last automatic fill.
    term_filled: Mutex<HashMap<String, Instant>>,
}

impl Sudo {
    pub fn new(db: Arc<Db>, vault: Arc<Mutex<Vault>>) -> Self {
        Self { db, vault, typed: Default::default(), refused: Default::default(), term_filled: Default::default() }
    }

    fn hosts(&self) -> Vec<String> {
        self.db.get_setting::<Vec<String>>(AUTO_HOSTS_KEY).ok().flatten().unwrap_or_default()
    }

    pub fn enabled(&self, host_id: &str) -> bool {
        host_id != crate::computer::ID && self.hosts().iter().any(|h| h == host_id)
    }

    pub fn state(&self, host_id: &str) -> SudoState {
        SudoState {
            enabled: self.enabled(host_id),
            has_password: self.password(host_id).ok().flatten().is_some(),
            error: self.refused.lock().get(host_id).cloned(),
        }
    }

    /// Turn auto sudo on or off. A typed `password` is kept for this app session, or saved as
    /// the login's sudo password with `save`. Entering one clears an earlier refusal.
    pub fn set(&self, host_id: &str, enabled: bool, password: Option<String>, save: bool) -> Result<SudoState> {
        if host_id == crate::computer::ID {
            return Err(Error::Other("Auto sudo is only for servers.".into()));
        }
        let password = password.map(Zeroizing::new).filter(|p| !p.is_empty());
        if let Some(p) = password {
            if p.contains(['\n', '\r', '\0']) {
                return Err(Error::Other("The password cannot contain line breaks.".into()));
            }
            if save {
                let ident = self.identity(host_id)?;
                self.vault.lock().set(&ident.secret_id("sudo"), &p)?;
                self.typed.lock().remove(host_id);
            } else {
                self.typed.lock().insert(host_id.to_string(), p);
            }
            self.refused.lock().remove(host_id);
        } else if enabled {
            if self.enabled(host_id) && self.refused.lock().contains_key(host_id) {
                // "Save" with no new password would only retry the password sudo just refused
                // (one more failed attempt toward a lockout).
                return Err(Error::Other(
                    "sudo refused the current password. Type the correct one, or turn sudo off and on to retry the same password.".into(),
                ));
            }
            // Turning it on again is the explicit retry after a refusal.
            self.refused.lock().remove(host_id);
        }
        let mut hosts = self.hosts();
        hosts.retain(|h| h != host_id);
        if enabled {
            hosts.push(host_id.to_string());
        } else {
            self.typed.lock().remove(host_id);
        }
        self.db.set_setting(AUTO_HOSTS_KEY, &hosts)?;
        Ok(self.state(host_id))
    }

    fn identity(&self, host_id: &str) -> Result<crate::model::Identity> {
        let host = self.db.get_host(host_id)?;
        let id = self
            .db
            .resolve_identity_id(&host)?
            .ok_or_else(|| Error::SecretRequired("this server has no login identity".into()))?;
        self.db.get_identity(&id)
    }

    /// Typed this session, else the login's sudo password, else its SSH password.
    pub fn password(&self, host_id: &str) -> Result<Option<Zeroizing<String>>> {
        if let Some(p) = self.typed.lock().get(host_id) {
            return Ok(Some(p.clone()));
        }
        let Ok(ident) = self.identity(host_id) else { return Ok(None) };
        let v = self.vault.lock();
        if !v.is_unlocked() {
            return Err(Error::VaultLocked);
        }
        Ok(match v.get(&ident.secret_id("sudo"))? {
            Some(p) => Some(p),
            None if ident.auth == AuthKind::Password => v.get(&ident.secret_id("password"))?,
            None => None,
        })
    }

    pub fn mark_refused(&self, host_id: &str, message: &str) {
        self.refused.lock().insert(host_id.to_string(), message.to_string());
    }

    /// Forget typed passwords and refusals (vault lock).
    pub fn clear(&self) {
        self.typed.lock().clear();
        self.refused.lock().clear();
        self.term_filled.lock().clear();
    }

    /// How Docker runs on this server now. Fails while a refused password is waiting to be replaced.
    pub fn docker(&self, host_id: &str) -> Result<Elevation> {
        if !self.enabled(host_id) {
            return Ok(Elevation::Plain);
        }
        if let Some(msg) = self.refused.lock().get(host_id) {
            return Err(Error::Other(msg.clone()));
        }
        Ok(match self.password(host_id)? {
            Some(p) => Elevation::Password(p),
            None => Elevation::NoPassword,
        })
    }

    /// One `docker <args>` (stdout and stderr together). Sudo failures become errors.
    pub async fn exec_docker(&self, h: &SshHandle, host_id: &str, args: &str, timeout: Duration) -> Result<ExecOutput> {
        let out = match self.docker(host_id)? {
            Elevation::Plain => return exec(h, &format!("docker {args} 2>&1"), timeout).await,
            Elevation::NoPassword => exec(h, &format!("LC_ALL=C sudo -n docker {args} 2>&1"), timeout).await?,
            Elevation::Password(p) => {
                exec_with_input(h, &format!("LC_ALL=C sudo -S -p '' docker {args} 2>&1"), &line(&p), timeout).await?
            }
        };
        if out.exit != Some(0) {
            self.check_output(host_id, &out.stdout)?;
        }
        Ok(out)
    }

    /// A long-lived `docker <args>`. With `pty` the password answers sudo's prompt (stopping the
    /// stream kills the command); without it the password goes on stdin (bounded commands only).
    pub async fn stream_docker(&self, h: &SshHandle, host_id: &str, args: &str, pty: bool) -> Result<tokio::sync::mpsc::Receiver<StreamChunk>> {
        let (cmd, input) = match self.docker(host_id)? {
            Elevation::Plain => (format!("exec docker {args} 2>&1"), None),
            Elevation::NoPassword => (format!("exec env LC_ALL=C sudo -n docker {args} 2>&1"), None),
            Elevation::Password(p) if pty => (
                format!("exec env LC_ALL=C sudo -S -p '{}' docker {args} 2>&1", String::from_utf8_lossy(STREAM_PROMPT)),
                Some(StreamInput::Prompt { prompt: STREAM_PROMPT, reply: line(&p) }),
            ),
            Elevation::Password(p) => (format!("exec env LC_ALL=C sudo -S -p '' docker {args} 2>&1"), Some(StreamInput::Stdin(line(&p)))),
        };
        exec_stream_with(h, &cmd, pty, input).await
    }

    /// Turn sudo's own failure in `text` into an error; a refused password pauses auto sudo.
    pub fn check_output(&self, host_id: &str, text: &str) -> Result<()> {
        match failure(text) {
            Some((refused, msg)) => {
                if refused {
                    self.mark_refused(host_id, &msg);
                }
                Err(Error::Other(msg))
            }
            None => Ok(()),
        }
    }

    /// Prefix for `docker` typed into a terminal (`docker exec -it …`): the terminal fills the prompt.
    pub fn terminal_prefix(&self, host_id: &str) -> &'static str {
        if self.enabled(host_id) { TERMINAL_SUDO } else { "" }
    }

    /// May the terminal fill this prompt by itself? At most once per [`TERM_AUTO_GAP`] per terminal.
    pub fn term_auto_allowed(&self, term_id: &str, host_id: &str) -> bool {
        if !self.enabled(host_id) || self.refused.lock().contains_key(host_id) {
            return false;
        }
        let mut filled = self.term_filled.lock();
        let now = Instant::now();
        filled.retain(|_, at| now.duration_since(*at) < TERM_AUTO_GAP);
        if filled.contains_key(term_id) {
            return false;
        }
        filled.insert(term_id.to_string(), now);
        true
    }
}

/// `sudo` with the standard prompt, which the terminal recognises.
pub const TERMINAL_SUDO: &str = "sudo -p '[sudo] password for %u: ' ";

fn line(p: &str) -> Zeroizing<Vec<u8>> {
    let mut v = Zeroizing::new(Vec::with_capacity(p.len() + 1));
    v.extend_from_slice(p.as_bytes());
    v.push(b'\n');
    v
}

/// Sudo's own failure in command output (run with `LC_ALL=C`): (password refused, message).
/// Only lines sudo writes are looked at, so container output can't trigger it.
pub fn failure(text: &str) -> Option<(bool, String)> {
    for l in text.lines().take(8).map(str::trim) {
        let lower = l.to_ascii_lowercase();
        if lower.ends_with("sudo: not found") || lower.ends_with("sudo: command not found") {
            return Some((false, "sudo is not installed on this server.".into()));
        }
        let sudo_line = l.starts_with("sudo:") || l == "Sorry, try again." || l.contains("is not in the sudoers file");
        if !sudo_line {
            continue;
        }
        if lower.contains("incorrect password") || lower.starts_with("sorry, try again") || l == crate::ssh::PROMPT_REFUSED {
            return Some((true, "sudo refused the password. Auto sudo is paused for this server: enter the right password with “Use sudo”.".into()));
        }
        if lower.contains("a password is required") || lower.contains("no password was provided") {
            return Some((false, "sudo needs a password for this login. Use “Use sudo” and enter it, or save it as the login's sudo password.".into()));
        }
        if lower.contains("sudoers") || lower.contains("not allowed to execute") {
            return Some((false, "This login may not run Docker with sudo on the server.".into()));
        }
        if lower.contains("terminal is required") || lower.contains("must have a tty") {
            return Some((false, "sudo on this server only works in a terminal (requiretty).".into()));
        }
        if lower.contains("docker: command not found") {
            return Some((false, "sudo cannot find docker (it is not on sudo's secure_path).".into()));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_sudo_failures_only_on_sudo_lines() {
        assert!(failure("Sorry, try again.\nsudo: 1 incorrect password attempt\n").unwrap().0);
        assert!(failure(crate::ssh::PROMPT_REFUSED).unwrap().0);
        let (refused, msg) = failure("sudo: a password is required\n").unwrap();
        assert!(!refused && msg.contains("needs a password"));
        assert!(failure("deploy is not in the sudoers file.  This incident will be reported.\n").unwrap().1.contains("may not"));
        assert!(failure("sudo: sorry, you must have a tty to run sudo\n").unwrap().1.contains("terminal"));
        assert!(failure("Error response from daemon: No such container: x\n").is_none());
        assert!(failure("app | incorrect password attempt for user bob\n").is_none());
        assert!(failure("sh: 1: sudo: not found").unwrap().1.contains("not installed"));
        assert!(failure("sudo: docker: command not found").unwrap().1.contains("secure_path"));
        assert!(failure("").is_none());
    }

    #[test]
    fn auto_sudo_is_per_server_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::init(dir.path()).unwrap();
        assert!(!core.sudo.enabled("h1"));
        assert!(matches!(core.sudo.docker("h1").unwrap(), Elevation::Plain));
        core.db.set_setting(AUTO_HOSTS_KEY, &vec!["h1".to_string()]).unwrap();
        assert!(core.sudo.enabled("h1"));
        assert!(!core.sudo.enabled("h2"));
        assert!(!core.sudo.enabled(crate::computer::ID));
        assert!(core.sudo.set(crate::computer::ID, true, None, false).is_err());
        assert_eq!(core.sudo.terminal_prefix("h1"), TERMINAL_SUDO);
        assert_eq!(core.sudo.terminal_prefix("h2"), "");
    }

    #[test]
    fn a_refusal_pauses_automatic_sudo_until_a_new_password() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::init(dir.path()).unwrap();
        core.db.set_setting(AUTO_HOSTS_KEY, &vec!["h1".to_string()]).unwrap();
        core.sudo.typed.lock().insert("h1".into(), Zeroizing::new("pw".into()));
        assert!(matches!(core.sudo.docker("h1").unwrap(), Elevation::Password(_)));
        assert!(core.sudo.term_auto_allowed("t1", "h1"));
        assert!(!core.sudo.term_auto_allowed("t1", "h1"), "second prompt right after = wrong password");
        assert!(core.sudo.check_output("h1", "sudo: 1 incorrect password attempt").is_err());
        assert!(core.sudo.docker("h1").is_err());
        assert!(!core.sudo.term_auto_allowed("t2", "h1"));
        assert!(core.sudo.state("h1").error.is_some());
        // "Save" without a new password does not retry the refused one...
        assert!(core.sudo.set("h1", true, None, false).is_err());
        assert!(core.sudo.docker("h1").is_err());
        // ...turning it off and on again is the explicit retry.
        core.sudo.set("h1", false, None, false).unwrap();
        assert!(core.sudo.set("h1", true, None, false).unwrap().error.is_none());
        core.sudo.mark_refused("h1", "sudo: incorrect password");
        core.sudo.typed.lock().clear();
        core.sudo.refused.lock().clear();
        core.sudo.typed.lock().insert("h1".into(), Zeroizing::new("new".into()));
        assert!(matches!(core.sudo.docker("h1").unwrap(), Elevation::Password(_)));
    }
}
