//! Events pushed from the core to the UI shell.

use serde::Serialize;
use ts_rs::TS;

use crate::model::{MetricsSample, SessionInfo};

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CoreEvent {
    /// Session state changed for a host.
    Session { info: SessionInfo },
    /// Terminal output; `data` is base64 to keep the IPC payload compact.
    TermData { term_id: String, data: String },
    /// Terminal channel closed.
    TermExit { term_id: String, code: Option<u32>, reason: Option<String> },
    /// New metrics sample for a host (only while subscribed).
    Metrics { host_id: String, sample: MetricsSample },
    /// Collector failed (subscription stays alive and retries).
    CollectorError { host_id: String, source: String, message: String },
    VaultLocked,
    VaultUnlocked,
}
