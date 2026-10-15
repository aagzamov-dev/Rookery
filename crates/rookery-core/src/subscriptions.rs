//! Subscriptions (docs/01-ARCHITECTURE.md §4.3).
//!
//! The UI subscribes to a data source only while it is visible. The first subscription
//! for (host, source, param) starts the collector; the last unsubscribe stops it (and,
//! for streams, closes the channel so the remote process ends). The latest value is
//! cached so re-showing a view renders instantly before the next update.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::collectors::{
    parse_docker_ps, parse_docker_stats_line, parse_metrics, valid_container_ref, valid_since, RawCounters, DOCKER_EVENTS,
    DOCKER_PS, DOCKER_STATS, METRICS_SCRIPT,
};
use crate::model::{Container, ContainerStats, MetricsSample, SubParams};
use crate::ssh::{exec, exec_stream, ConnectionManager, Lease, LineSplitter, StreamChunk};
use crate::terminal::shell_quote;
use crate::{new_id, now_ms, CoreEvent, Error, Result};

pub const METRICS_DEFAULT_MS: u32 = 3_000;
pub const METRICS_MIN_MS: u32 = 1_000;
const LOG_BATCH_MS: u64 = 150;
const LOG_BATCH_MAX: usize = 500;
const STATS_EMIT_MS: u64 = 2_000;

struct Running {
    refs: u32,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct Caches {
    metrics: HashMap<String, MetricsSample>,
    docker: HashMap<String, Vec<Container>>,
}

pub struct Subscriptions {
    conns: Arc<ConnectionManager>,
    events: broadcast::Sender<CoreEvent>,
    running: tokio::sync::Mutex<HashMap<String, Running>>,
    subs: Mutex<HashMap<String, String>>,
    cache: Arc<Mutex<Caches>>,
}

impl Subscriptions {
    pub fn new(conns: Arc<ConnectionManager>, events: broadcast::Sender<CoreEvent>) -> Self {
        Self { conns, events, running: Default::default(), subs: Default::default(), cache: Default::default() }
    }

    /// Returns the subscription id and the cached last value for this source (if any).
    pub async fn subscribe(
        &self,
        host_id: &str,
        source: &str,
        params: SubParams,
    ) -> Result<(String, Option<serde_json::Value>)> {
        let param = match source {
            "metrics" | "docker" | "docker.stats" => String::new(),
            "docker.logs" => {
                let c = params.container.clone().unwrap_or_default();
                if !valid_container_ref(&c) {
                    return Err(Error::Other("invalid container".into()));
                }
                if let Some(s) = &params.since {
                    if !valid_since(s) {
                        return Err(Error::Other("invalid timestamp".into()));
                    }
                }
                c
            }
            "file.tail" => {
                let p = params.path.clone().unwrap_or_default();
                if p.is_empty() || p.len() > 1024 || p.contains(['\0', '\n']) {
                    return Err(Error::Other("invalid file path".into()));
                }
                p
            }
            other => return Err(Error::Other(format!("unknown source '{other}'"))),
        };
        let key = format!("{host_id}|{source}|{param}");

        {
            let mut running = self.running.lock().await;
            let alive = running.get(&key).map(|r| !r.task.is_finished()).unwrap_or(false);
            if alive {
                running.get_mut(&key).unwrap().refs += 1;
            } else {
                let lease = self.conns.acquire(host_id).await?;
                let task = self.spawn(lease, source, &param, &params);
                // A finished stream (log ended) is replaced; keep its ref count.
                let refs = running.remove(&key).map(|r| r.refs).unwrap_or(0) + 1;
                running.insert(key.clone(), Running { refs, task });
            }
        }
        let sub_id = new_id();
        self.subs.lock().insert(sub_id.clone(), key);

        let cached = {
            let c = self.cache.lock();
            match source {
                "metrics" => c.metrics.get(host_id).and_then(|m| serde_json::to_value(m).ok()),
                "docker" => c.docker.get(host_id).and_then(|d| serde_json::to_value(d).ok()),
                _ => None,
            }
        };
        Ok((sub_id, cached))
    }

    fn spawn(&self, lease: Lease, source: &str, param: &str, params: &SubParams) -> JoinHandle<()> {
        let events = self.events.clone();
        let cache = self.cache.clone();
        match source {
            "metrics" => {
                let every = params.interval_ms.unwrap_or(METRICS_DEFAULT_MS).max(METRICS_MIN_MS);
                tokio::spawn(metrics_loop(lease, Duration::from_millis(every as u64), events, cache))
            }
            "docker" => tokio::spawn(docker_loop(lease, events, cache)),
            "docker.stats" => tokio::spawn(docker_stats_loop(lease, events)),
            "docker.logs" => {
                let since = params.since.as_deref().map(|s| format!(" --since {s}")).unwrap_or_else(|| " --tail 200".into());
                let cmd = format!("exec docker logs --timestamps{since} -f {param} 2>&1");
                tokio::spawn(log_loop(lease, events, format!("docker:{param}"), cmd))
            }
            _ => {
                let cmd = format!("exec tail -n 200 -F -- {} 2>&1", shell_quote(param));
                tokio::spawn(log_loop(lease, events, format!("file:{param}"), cmd))
            }
        }
    }

    pub async fn unsubscribe(&self, sub_id: &str) {
        let Some(key) = self.subs.lock().remove(sub_id) else { return };
        let mut running = self.running.lock().await;
        let stop = match running.get_mut(&key) {
            Some(r) => {
                r.refs = r.refs.saturating_sub(1);
                r.refs == 0
            }
            None => false,
        };
        if stop {
            if let Some(r) = running.remove(&key) {
                r.task.abort(); // drops the lease and any stream receiver inside the task
            }
        }
    }

    pub async fn stop_all(&self) {
        self.subs.lock().clear();
        for (_, r) in self.running.lock().await.drain() {
            r.task.abort();
        }
    }

    pub fn cached_metrics(&self, host_id: &str) -> Option<MetricsSample> {
        self.cache.lock().metrics.get(host_id).cloned()
    }

    pub async fn active(&self) -> Vec<(String, String, u32)> {
        self.running
            .lock()
            .await
            .iter()
            .map(|(k, r)| {
                let mut it = k.splitn(2, '|');
                (it.next().unwrap_or_default().to_string(), it.next().unwrap_or_default().to_string(), r.refs)
            })
            .collect()
    }
}

// ----------------------------------------------------------------- metrics

async fn metrics_loop(lease: Lease, every: Duration, events: broadcast::Sender<CoreEvent>, cache: Arc<Mutex<Caches>>) {
    let host_id = lease.host_id().to_string();
    let mut prev: Option<RawCounters> = None;
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let Ok(handle) = lease.handle().await else {
            prev = None; // reconnecting; rates restart after reconnect
            continue;
        };
        match exec(&handle, METRICS_SCRIPT, Duration::from_secs(8)).await {
            Ok(out) => match parse_metrics(&out.stdout, prev.as_ref(), now_ms()) {
                Some((sample, raw)) => {
                    prev = Some(raw);
                    cache.lock().metrics.insert(host_id.clone(), sample.clone());
                    let _ = events.send(CoreEvent::Metrics { host_id: host_id.clone(), sample });
                }
                None => {
                    let _ = events.send(CoreEvent::CollectorError {
                        host_id: host_id.clone(),
                        source: "metrics".into(),
                        message: "unsupported system (needs Linux /proc)".into(),
                    });
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            },
            Err(e) => {
                let _ = events.send(CoreEvent::CollectorError {
                    host_id: host_id.clone(),
                    source: "metrics".into(),
                    message: e.to_string(),
                });
            }
        }
    }
}

// ------------------------------------------------------------------ docker

/// `docker ps` once, then again only when `docker events` reports a change.
async fn docker_loop(lease: Lease, events: broadcast::Sender<CoreEvent>, cache: Arc<Mutex<Caches>>) {
    let host_id = lease.host_id().to_string();
    loop {
        let Ok(h) = lease.handle().await else {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        };
        if !relist(&h, &host_id, &events, &cache).await {
            tokio::time::sleep(Duration::from_secs(30)).await;
            continue;
        }
        if let Ok(mut rx) = exec_stream(&h, DOCKER_EVENTS, true).await {
            let mut lines = LineSplitter::default();
            let mut dirty = false;
            loop {
                tokio::select! {
                    chunk = rx.recv() => match chunk {
                        Some(StreamChunk::Data(b)) => {
                            if lines.push(&b).iter().any(|l| l.starts_with('{')) {
                                dirty = true;
                            }
                        }
                        _ => break,
                    },
                    // Debounce bursts (compose up/down emits many events).
                    _ = tokio::time::sleep(Duration::from_millis(400)), if dirty => {
                        dirty = false;
                        relist(&h, &host_id, &events, &cache).await;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

async fn relist(
    h: &crate::ssh::SshHandle,
    host_id: &str,
    events: &broadcast::Sender<CoreEvent>,
    cache: &Arc<Mutex<Caches>>,
) -> bool {
    let (containers, error) = match exec(h, DOCKER_PS, Duration::from_secs(15)).await {
        Ok(out) => match parse_docker_ps(&out.stdout, out.exit) {
            Ok(list) => {
                cache.lock().docker.insert(host_id.to_string(), list.clone());
                (list, None)
            }
            Err(msg) => (Vec::new(), Some(msg)),
        },
        Err(e) => (cache.lock().docker.get(host_id).cloned().unwrap_or_default(), Some(e.to_string())),
    };
    let ok = error.is_none();
    let _ = events.send(CoreEvent::DockerList { host_id: host_id.to_string(), containers, error });
    ok
}

/// One streaming `docker stats` process; snapshots every 2 s.
async fn docker_stats_loop(lease: Lease, events: broadcast::Sender<CoreEvent>) {
    let host_id = lease.host_id().to_string();
    loop {
        let Ok(h) = lease.handle().await else {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        };
        if let Ok(mut rx) = exec_stream(&h, DOCKER_STATS, true).await {
            let mut lines = LineSplitter::default();
            let mut latest: HashMap<String, ContainerStats> = HashMap::new();
            let mut tick = tokio::time::interval(Duration::from_millis(STATS_EMIT_MS));
            loop {
                tokio::select! {
                    chunk = rx.recv() => match chunk {
                        Some(StreamChunk::Data(b)) => {
                            for line in lines.push(&b) {
                                if let Some(s) = parse_docker_stats_line(&line) {
                                    latest.insert(s.id.clone(), s);
                                }
                            }
                        }
                        _ => break,
                    },
                    _ = tick.tick() => {
                        if !latest.is_empty() {
                            let stats = latest.values().cloned().collect();
                            let _ = events.send(CoreEvent::DockerStats { host_id: host_id.clone(), stats });
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

// -------------------------------------------------------------------- logs

/// Follow a command's output (docker logs -f / tail -F) and emit batched lines.
async fn log_loop(lease: Lease, events: broadcast::Sender<CoreEvent>, stream: String, cmd: String) {
    let host_id = lease.host_id().to_string();
    let ended = |reason: String| {
        let _ = events.send(CoreEvent::LogEnded { host_id: host_id.clone(), stream: stream.clone(), reason });
    };
    let h = match lease.handle().await {
        Ok(h) => h,
        Err(e) => return ended(e.to_string()),
    };
    let mut rx = match exec_stream(&h, &cmd, true).await {
        Ok(rx) => rx,
        Err(e) => return ended(e.to_string()),
    };
    let mut lines = LineSplitter::default();
    let mut batch: Vec<String> = Vec::new();
    let mut tick = tokio::time::interval(Duration::from_millis(LOG_BATCH_MS));
    let flush = |batch: &mut Vec<String>| {
        if !batch.is_empty() {
            let _ = events.send(CoreEvent::LogLines {
                host_id: host_id.clone(),
                stream: stream.clone(),
                lines: std::mem::take(batch),
            });
        }
    };
    loop {
        tokio::select! {
            chunk = rx.recv() => match chunk {
                Some(StreamChunk::Data(b)) => {
                    batch.extend(lines.push(&b));
                    if batch.len() >= LOG_BATCH_MAX {
                        flush(&mut batch);
                    }
                }
                Some(StreamChunk::Exit(code)) => {
                    flush(&mut batch);
                    return ended(match code {
                        Some(0) | None => "stream ended".into(),
                        Some(c) => format!("stream ended (exit {c})"),
                    });
                }
                None => {
                    flush(&mut batch);
                    return ended("stream closed".into());
                }
            },
            _ = tick.tick() => flush(&mut batch),
        }
    }
}
