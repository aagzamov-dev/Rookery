//! One-off server actions (each reuses the host's open SSH session).

use std::time::Duration;

use crate::collectors::{parse_processes, parse_services, valid_container_ref, PROCESSES, SERVICES};
use crate::model::{Process, Service};
use crate::ssh::{exec, ConnectionManager};
use crate::{Error, Result};

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DockerAction {
    Start,
    Stop,
    Restart,
    Kill,
    Remove,
}

pub async fn docker_action(conns: &ConnectionManager, host_id: &str, container: &str, action: DockerAction) -> Result<()> {
    if !valid_container_ref(container) {
        return Err(Error::Other("invalid container".into()));
    }
    let verb = match action {
        DockerAction::Start => "start",
        DockerAction::Stop => "stop",
        DockerAction::Restart => "restart",
        DockerAction::Kill => "kill",
        DockerAction::Remove => "rm",
    };
    let lease = conns.acquire(host_id).await?;
    let h = lease.handle().await?;
    let out = exec(&h, &format!("docker {verb} {container} 2>&1"), Duration::from_secs(90)).await?;
    if out.exit.unwrap_or(0) != 0 {
        return Err(Error::Other(out.stdout.trim().to_string()));
    }
    // The Docker view refreshes itself from `docker events`.
    Ok(())
}

pub async fn services_list(conns: &ConnectionManager, host_id: &str) -> Result<Vec<Service>> {
    let lease = conns.acquire(host_id).await?;
    let h = lease.handle().await?;
    let out = exec(&h, SERVICES, Duration::from_secs(15)).await?;
    parse_services(&out.stdout).map_err(Error::Other)
}

pub async fn processes_list(conns: &ConnectionManager, host_id: &str) -> Result<Vec<Process>> {
    let lease = conns.acquire(host_id).await?;
    let h = lease.handle().await?;
    let out = exec(&h, PROCESSES, Duration::from_secs(10)).await?;
    let list = parse_processes(&out.stdout);
    if list.is_empty() && !out.stdout.trim().is_empty() {
        return Err(Error::Other("this server's ps does not support the needed columns".into()));
    }
    Ok(list)
}

/// `kill -TERM` (or `-KILL` with `force`). Fails with "Operation not permitted" for other users' processes.
pub async fn process_kill(conns: &ConnectionManager, host_id: &str, pid: u32, force: bool) -> Result<()> {
    let lease = conns.acquire(host_id).await?;
    let h = lease.handle().await?;
    let sig = if force { "KILL" } else { "TERM" };
    let out = exec(&h, &format!("kill -{sig} {pid} 2>&1"), Duration::from_secs(10)).await?;
    if out.exit.unwrap_or(0) != 0 {
        return Err(Error::Other(out.stdout.trim().to_string()));
    }
    Ok(())
}

/// Shell integration: the prompt reports the current folder (OSC 7) so the Files panel
/// can follow `cd` without ever polling. Appends a marked block to ~/.bashrc and ~/.zshrc once.
/// v2 also reports the last command's exit code (OSC 133;D) for "command finished" notifications.
pub const SHELL_INTEGRATION: &str = r#"M='# rook-shell-integration-v2'
n=0
for f in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$f" ] || continue
  grep -q "$M" "$f" && { n=$((n+1)); continue; }
  cat >> "$f" <<'ROOK'

# rook-shell-integration-v2 — lets Rookery follow your folder and notice finished commands
__rook_osc7() { local e=$?; printf '\033]133;D;%s\007\033]7;file://%s%s\033\\' "$e" "${HOSTNAME:-$(hostname)}" "$PWD"; return $e; }
if [ -n "$ZSH_VERSION" ]; then
  (( ${precmd_functions[(I)__rook_osc7]} )) || precmd_functions+=(__rook_osc7)
else
  case ";$PROMPT_COMMAND;" in *";__rook_osc7;"*|*";__rook_osc7"*) ;; *) PROMPT_COMMAND="__rook_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac
fi
ROOK
  n=$((n+1))
done
echo "rook-ok $n""#;

pub async fn install_shell_integration(conns: &ConnectionManager, host_id: &str) -> Result<u32> {
    let lease = conns.acquire(host_id).await?;
    let h = lease.handle().await?;
    let out = exec(&h, SHELL_INTEGRATION, Duration::from_secs(15)).await?;
    let n = out
        .stdout
        .lines()
        .find_map(|l| l.strip_prefix("rook-ok "))
        .and_then(|v| v.trim().parse().ok())
        .ok_or_else(|| Error::Other(format!("could not update shell config: {}", out.stdout.trim())))?;
    if n == 0 {
        return Err(Error::Other("no ~/.bashrc or ~/.zshrc found on this server".into()));
    }
    Ok(n)
}
