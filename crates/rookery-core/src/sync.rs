//! Dashboard sync (docs/04 §4): explicit "Sync now" runs and the auto-sync scheduler.
//!
//! Separate from subscriptions. Runs only when the user presses Sync or turned a group's
//! Auto-sync switch on. Every result lands in `server_snapshots`; the Dashboard renders
//! from the DB and never waits on the network.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::{broadcast, Semaphore};

use crate::collectors::{parse_sync, sync_script};
use crate::db::Db;
use crate::model::*;
use crate::ssh::{exec, ConnectionManager};
use crate::vault::Vault;
use crate::{new_id, now_ms, CoreEvent, Error, Result};

/// Connect + collect, per host.
const HOST_TIMEOUT: Duration = Duration::from_secs(25);
const COLLECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Offline hosts fail fast instead of waiting for the SSH connect timeout.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const TICK: Duration = Duration::from_secs(5);
/// Auto-sync pauses after the window has been hidden this long (unless "keep running").
const HIDDEN_GRACE_MS: i64 = 60_000;
const BACKOFF_CAP_S: u64 = 30 * 60;
const MAX_CONCURRENCY: usize = 6;

#[derive(Default)]
struct Inner {
    /// Hosts queued or running in any job.
    busy: HashSet<String>,
    running: HashSet<String>,
    /// Cancel flags of live jobs.
    jobs: HashMap<String, Arc<AtomicBool>>,
    /// Consecutive failures per host (backoff).
    fails: HashMap<String, u32>,
    /// Last attempt per host, ms (falls back to the snapshot's `taken_at`).
    last_attempt: HashMap<String, i64>,
}

pub struct SyncEngine {
    db: Arc<Db>,
    vault: Arc<Mutex<Vault>>,
    conns: Arc<ConnectionManager>,
    events: broadcast::Sender<CoreEvent>,
    inner: Mutex<Inner>,
    permits: Arc<Semaphore>,
    limit: Mutex<usize>,
    visible: AtomicBool,
    hidden_since: AtomicI64,
}

impl SyncEngine {
    pub fn new(
        db: Arc<Db>,
        vault: Arc<Mutex<Vault>>,
        conns: Arc<ConnectionManager>,
        events: broadcast::Sender<CoreEvent>,
    ) -> Self {
        let limit = db.sync_settings().map(|s| s.concurrency as usize).unwrap_or(3).clamp(1, MAX_CONCURRENCY);
        Self {
            db,
            vault,
            conns,
            events,
            inner: Mutex::new(Inner::default()),
            permits: Arc::new(Semaphore::new(limit)),
            limit: Mutex::new(limit),
            visible: AtomicBool::new(true),
            hidden_since: AtomicI64::new(0),
        }
    }

    pub fn status(&self) -> Result<SyncStatus> {
        let mut running: Vec<String> = self.inner.lock().running.iter().cloned().collect();
        running.sort();
        Ok(SyncStatus { settings: self.db.sync_settings()?, global: self.db.global_refresh()?, running })
    }

    pub fn set_settings(&self, mut s: SyncSettings) -> Result<SyncSettings> {
        s.concurrency = s.concurrency.clamp(1, MAX_CONCURRENCY as u8);
        self.db.set_setting("sync.settings", &s)?;
        self.set_limit(s.concurrency as usize);
        Ok(s)
    }

    fn set_limit(&self, next: usize) {
        let mut cur = self.limit.lock();
        if next > *cur {
            self.permits.add_permits(next - *cur);
        } else if next < *cur {
            // Take the surplus permits out of circulation as they come back.
            let n = (*cur - next) as u32;
            let permits = self.permits.clone();
            tokio::spawn(async move {
                if let Ok(p) = permits.acquire_many_owned(n).await {
                    p.forget();
                }
            });
        }
        *cur = next;
    }

    /// The window was shown / hidden (minimised). Auto-sync pauses after a minute hidden.
    pub fn set_visible(&self, visible: bool) {
        let was = self.visible.swap(visible, Ordering::SeqCst);
        if was && !visible {
            self.hidden_since.store(now_ms(), Ordering::SeqCst);
        }
    }

    pub fn cancel(&self, job_id: &str) {
        if let Some(flag) = self.inner.lock().jobs.get(job_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    /// App locked: queued hosts are dropped; running collects finish on their own.
    pub fn cancel_all(&self) {
        for flag in self.inner.lock().jobs.values() {
            flag.store(true, Ordering::SeqCst);
        }
    }

    fn emit(&self, job_id: &str, host_id: &str, state: SyncState, snapshot: Option<Snapshot>) {
        let _ = self.events.send(CoreEvent::SyncProgress {
            job_id: job_id.to_string(),
            host_id: host_id.to_string(),
            state,
            snapshot,
        });
    }

    /// Hosts in a scope. Groups include their sub-groups.
    fn hosts_in(&self, scope: &SyncScope) -> Result<Vec<Host>> {
        let hosts = self.db.list_hosts()?;
        Ok(match scope {
            SyncScope::All => hosts,
            SyncScope::Host { id } => hosts.into_iter().filter(|h| &h.id == id).collect(),
            SyncScope::Hosts { ids } => hosts.into_iter().filter(|h| ids.contains(&h.id)).collect(),
            SyncScope::Group { id } if id == UNGROUPED => {
                let groups: HashSet<String> = self.db.list_groups()?.into_iter().map(|g| g.id).collect();
                hosts.into_iter().filter(|h| h.group_id.as_ref().map(|g| !groups.contains(g)).unwrap_or(true)).collect()
            }
            SyncScope::Group { id } => {
                let tree = subtree(&self.db.list_groups()?, id);
                hosts.into_iter().filter(|h| h.group_id.as_ref().map(|g| tree.contains(g)).unwrap_or(false)).collect()
            }
        })
    }

    /// Start a run. `explicit` = the user asked (per-card ↻ even syncs hosts set to Never).
    /// Returns at once; progress arrives as `SyncProgress` / `SyncDone` events.
    pub fn run(self: &Arc<Self>, scope: SyncScope, auto: bool) -> Result<String> {
        if !self.vault.lock().is_unlocked() {
            return Err(Error::VaultLocked);
        }
        let single = matches!(scope, SyncScope::Host { .. });
        let job_id = new_id();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut summary = SyncSummary::default();
        let mut todo = Vec::new();
        {
            let hosts = self.hosts_in(&scope)?;
            let mut inner = self.inner.lock();
            for h in hosts {
                let eff = self.db.effective_refresh(&h)?;
                let skip = (eff.mode == RefreshMode::Never && !single) || inner.busy.contains(&h.id);
                if skip {
                    summary.skipped += 1;
                    if !inner.busy.contains(&h.id) {
                        self.emit(&job_id, &h.id, SyncState::Skipped, None);
                    }
                    continue;
                }
                inner.busy.insert(h.id.clone());
                todo.push((h, eff));
            }
            inner.jobs.insert(job_id.clone(), cancel.clone());
        }
        for (h, _) in &todo {
            self.emit(&job_id, &h.id, SyncState::Queued, None);
        }

        let me = self.clone();
        let job = job_id.clone();
        tokio::spawn(async move {
            let mut set = tokio::task::JoinSet::new();
            for (host, eff) in todo {
                let me = me.clone();
                let job = job.clone();
                let cancel = cancel.clone();
                set.spawn(async move {
                    let state = me.sync_host(&job, &host, &eff, &cancel).await;
                    me.inner.lock().busy.remove(&host.id);
                    state
                });
            }
            while let Some(r) = set.join_next().await {
                match r.unwrap_or(SyncState::Failed) {
                    SyncState::Ok => summary.ok += 1,
                    SyncState::Locked => summary.locked += 1,
                    SyncState::Skipped => summary.skipped += 1,
                    _ => summary.failed += 1,
                }
            }
            me.inner.lock().jobs.remove(&job);
            let _ = me.events.send(CoreEvent::SyncDone { job_id: job, auto, summary });
        });
        Ok(job_id)
    }

    async fn sync_host(&self, job: &str, host: &Host, eff: &EffectiveRefresh, cancel: &AtomicBool) -> SyncState {
        let Ok(_permit) = self.permits.clone().acquire_owned().await else { return SyncState::Skipped };
        if cancel.load(Ordering::SeqCst) || !self.vault.lock().is_unlocked() {
            self.emit(job, &host.id, SyncState::Skipped, None);
            return SyncState::Skipped;
        }
        {
            let mut inner = self.inner.lock();
            inner.running.insert(host.id.clone());
            inner.last_attempt.insert(host.id.clone(), now_ms());
        }
        self.emit(job, &host.id, SyncState::Running, None);

        let started = Instant::now();
        let result = tokio::time::timeout(HOST_TIMEOUT, self.collect(host, eff.collect))
            .await
            .unwrap_or_else(|_| Err(Error::Ssh("timed out".into())));
        let duration_ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;

        let prev = self.db.get_snapshot(&host.id).ok().flatten();
        let now = now_ms();
        let snap = match result {
            Ok(c) => Snapshot {
                host_id: host.id.clone(),
                taken_at: now,
                state: SyncState::Ok,
                error: None,
                last_ok_at: Some(now),
                prev_cpu_pct: prev.as_ref().and_then(|p| p.metrics.as_ref()).and_then(|m| m.cpu_pct),
                metrics: Some(c.metrics),
                os: c.os.or_else(|| prev.as_ref().and_then(|p| p.os.clone())),
                docker: c.docker,
                failed_services: c.failed_services,
                duration_ms: Some(duration_ms),
            },
            Err(e) => {
                let (state, msg) = describe(&e);
                // Keep the last good numbers; the card shows them faded with the error.
                let mut s = prev.unwrap_or(Snapshot {
                    host_id: host.id.clone(),
                    taken_at: now,
                    state,
                    error: None,
                    last_ok_at: None,
                    metrics: None,
                    prev_cpu_pct: None,
                    os: None,
                    docker: None,
                    failed_services: None,
                    duration_ms: None,
                });
                s.taken_at = now;
                s.state = state;
                s.error = Some(msg);
                s.duration_ms = Some(duration_ms);
                s
            }
        };
        {
            let mut inner = self.inner.lock();
            inner.running.remove(&host.id);
            if snap.state == SyncState::Ok {
                inner.fails.remove(&host.id);
            } else {
                *inner.fails.entry(host.id.clone()).or_default() += 1;
            }
        }
        if let Err(e) = self.db.upsert_snapshot(&snap) {
            tracing::warn!(host = %host.name, "saving snapshot failed: {e}");
        }
        let state = snap.state;
        self.emit(job, &host.id, state, Some(snap));
        state
    }

    /// One connection, one exec. Reuses an open session (server tab), otherwise opens a
    /// temporary one and closes it right after.
    async fn collect(&self, host: &Host, what: Collect) -> Result<crate::collectors::SyncCollected> {
        let reuse = self.conns.is_connected(&host.id);
        if !reuse {
            let probe = tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect((host.address.as_str(), host.port))).await;
            match probe {
                Err(_) => return Err(Error::Ssh("offline (no answer on the SSH port)".into())),
                Ok(Err(e)) => return Err(Error::Ssh(format!("offline ({e})"))),
                Ok(Ok(_)) => {}
            }
        }
        let lease = self.conns.acquire(&host.id).await?;
        let out = async {
            let handle = lease.handle().await?;
            exec(&handle, &sync_script(what), COLLECT_TIMEOUT).await
        }
        .await;
        drop(lease);
        if !reuse {
            self.conns.close_if_unused(&host.id).await;
        }
        let out = out?;
        parse_sync(&out.stdout, what, now_ms()).ok_or_else(|| {
            let hint = out.stderr.lines().chain(out.stdout.lines()).find(|l| !l.trim().is_empty()).unwrap_or("");
            Error::Other(format!("unexpected output (Linux server needed) {hint}").trim().to_string())
        })
    }

    // ------------------------------------------------------------ scheduler

    /// Runs forever. Every few seconds, start one run with the hosts that are due.
    pub async fn run_scheduler(self: Arc<Self>) {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            match self.due_hosts() {
                Ok(due) if !due.is_empty() => {
                    if let Err(e) = self.run(SyncScope::Hosts { ids: due }, true) {
                        tracing::debug!("auto-sync not started: {e}");
                    }
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("auto-sync check failed: {e}"),
            }
        }
    }

    fn paused(&self, s: &SyncSettings) -> bool {
        if s.paused || !self.vault.lock().is_unlocked() {
            return true;
        }
        !self.visible.load(Ordering::SeqCst)
            && !s.run_when_hidden
            && now_ms() - self.hidden_since.load(Ordering::SeqCst) > HIDDEN_GRACE_MS
    }

    fn due_hosts(&self) -> Result<Vec<String>> {
        let settings = self.db.sync_settings()?;
        if self.paused(&settings) {
            return Ok(vec![]);
        }
        let groups = self.db.list_groups()?;
        let on: HashSet<&str> = groups.iter().filter(|g| g.auto_sync_enabled).map(|g| g.id.as_str()).collect();
        let known: HashSet<&str> = groups.iter().map(|g| g.id.as_str()).collect();
        let snaps: HashMap<String, i64> = self.db.list_snapshots()?.into_iter().map(|s| (s.host_id, s.taken_at)).collect();
        let now = now_ms();
        let inner = self.inner.lock();
        let mut due = Vec::new();
        for h in self.db.list_hosts()? {
            let switch_on = match h.group_id.as_deref() {
                Some(g) if known.contains(g) => on.contains(g),
                _ => settings.ungrouped_auto,
            };
            if !switch_on || inner.busy.contains(&h.id) {
                continue;
            }
            let eff = self.db.effective_refresh(&h)?;
            if eff.mode != RefreshMode::Auto || !eff.desktop {
                continue;
            }
            let interval = backoff_interval(eff.interval_s as u64, inner.fails.get(&h.id).copied().unwrap_or(0));
            let last = inner.last_attempt.get(&h.id).copied().or_else(|| snaps.get(&h.id).copied());
            if last.map(|t| now - t >= interval as i64 * 1000).unwrap_or(true) {
                due.push(h.id);
            }
        }
        Ok(due)
    }
}

/// After 3 failures in a row the interval doubles each time, up to 30 min.
pub fn backoff_interval(interval_s: u64, fails: u32) -> u64 {
    if fails < 3 {
        return interval_s;
    }
    let factor = 1u64 << (fails - 2).min(10);
    (interval_s.saturating_mul(factor)).min(BACKOFF_CAP_S.max(interval_s))
}

/// Group id plus all its descendants.
fn subtree(groups: &[Group], root: &str) -> HashSet<String> {
    let mut out: HashSet<String> = HashSet::from([root.to_string()]);
    loop {
        let before = out.len();
        for g in groups {
            if g.parent_id.as_ref().map(|p| out.contains(p)).unwrap_or(false) {
                out.insert(g.id.clone());
            }
        }
        if out.len() == before {
            return out;
        }
    }
}

/// Error → card state + short message. A sync never prompts: missing secrets mean Locked.
fn describe(e: &Error) -> (SyncState, String) {
    match e {
        Error::VaultLocked => (SyncState::Locked, "App is locked".into()),
        Error::SecretRequired(what) => (SyncState::Locked, format!("Needs {what} — add it to the identity")),
        Error::UnknownHostKey { .. } => {
            (SyncState::Failed, "Host key not confirmed yet — open the server once to trust it".into())
        }
        Error::HostKeyChanged { .. } => (SyncState::Failed, "Host key changed — open the server to review it".into()),
        Error::AuthFailed => (SyncState::Failed, "Login failed — check the identity".into()),
        other => (SyncState::Failed, other.to_string().trim_start_matches("ssh error: ").to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_after_three_failures_and_caps() {
        assert_eq!(backoff_interval(60, 0), 60);
        assert_eq!(backoff_interval(60, 2), 60);
        assert_eq!(backoff_interval(60, 3), 120);
        assert_eq!(backoff_interval(60, 4), 240);
        assert_eq!(backoff_interval(60, 30), 1800);
        assert_eq!(backoff_interval(3600, 5), 3600);
    }

    #[test]
    fn subtree_includes_nested_groups() {
        let g = |id: &str, parent: Option<&str>| Group {
            id: id.into(),
            parent_id: parent.map(String::from),
            name: id.into(),
            color: String::new(),
            sort: 0,
            identity_id: None,
            jump_host_id: None,
            theme: None,
            start_folder: None,
            refresh: RefreshSetting::default(),
            auto_sync_enabled: false,
        };
        let groups = vec![g("a", None), g("b", Some("a")), g("c", Some("b")), g("d", None)];
        let t = subtree(&groups, "a");
        assert!(t.contains("a") && t.contains("b") && t.contains("c") && !t.contains("d"));
    }

    #[test]
    fn missing_secret_is_locked_not_failed() {
        assert_eq!(describe(&Error::SecretRequired("password for root".into())).0, SyncState::Locked);
        assert_eq!(describe(&Error::Ssh("offline".into())).0, SyncState::Failed);
    }
}
