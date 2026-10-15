//! Subscriptions (docs/01-ARCHITECTURE.md §4.3).
//!
//! The UI subscribes to a data source only while it is visible. The first subscription
//! for (host, source) starts the collector; the last unsubscribe stops it. The latest
//! value is cached so re-showing a view renders instantly before the next tick.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::collectors::{parse_metrics, RawCounters, METRICS_SCRIPT};
use crate::model::MetricsSample;
use crate::ssh::{exec, ConnectionManager, Lease};
use crate::{new_id, now_ms, CoreEvent, Error, Result};

pub const METRICS_DEFAULT_MS: u32 = 3_000;
pub const METRICS_MIN_MS: u32 = 1_000;

type Key = (String, String); // (host_id, source)

struct Running {
    refs: u32,
    task: JoinHandle<()>,
}

pub struct Subscriptions {
    conns: Arc<ConnectionManager>,
    events: broadcast::Sender<CoreEvent>,
    running: tokio::sync::Mutex<HashMap<Key, Running>>,
    subs: Mutex<HashMap<String, Key>>,
    last_metrics: Arc<Mutex<HashMap<String, MetricsSample>>>,
}

impl Subscriptions {
    pub fn new(conns: Arc<ConnectionManager>, events: broadcast::Sender<CoreEvent>) -> Self {
        Self {
            conns,
            events,
            running: Default::default(),
            subs: Default::default(),
            last_metrics: Default::default(),
        }
    }

    /// Returns the subscription id and the cached last value (if any).
    pub async fn subscribe(
        &self,
        host_id: &str,
        source: &str,
        interval_ms: Option<u32>,
    ) -> Result<(String, Option<MetricsSample>)> {
        if source != "metrics" {
            return Err(Error::Other(format!("unknown source '{source}' (v0.1 supports: metrics)")));
        }
        let key: Key = (host_id.to_string(), source.to_string());
        {
            let mut running = self.running.lock().await;
            if let Some(r) = running.get_mut(&key) {
                r.refs += 1;
            } else {
                let lease = self.conns.acquire(host_id).await?;
                let interval = interval_ms.unwrap_or(METRICS_DEFAULT_MS).max(METRICS_MIN_MS);
                let task = tokio::spawn(metrics_loop(
                    lease,
                    Duration::from_millis(interval as u64),
                    self.events.clone(),
                    self.last_metrics.clone(),
                ));
                running.insert(key.clone(), Running { refs: 1, task });
            }
        }
        let sub_id = new_id();
        self.subs.lock().insert(sub_id.clone(), key);
        Ok((sub_id, self.last_metrics.lock().get(host_id).cloned()))
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
                r.task.abort(); // drops the lease inside the task
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
        self.last_metrics.lock().get(host_id).cloned()
    }

    pub async fn active(&self) -> Vec<(String, String, u32)> {
        self.running.lock().await.iter().map(|((h, s), r)| (h.clone(), s.clone(), r.refs)).collect()
    }
}

async fn metrics_loop(
    lease: Lease,
    every: Duration,
    events: broadcast::Sender<CoreEvent>,
    cache: Arc<Mutex<HashMap<String, MetricsSample>>>,
) {
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
                    cache.lock().insert(host_id.clone(), sample.clone());
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
