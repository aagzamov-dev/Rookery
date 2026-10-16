//! Events pushed from the core to the UI shell.

use serde::Serialize;
use ts_rs::TS;

use crate::model::{BackupStatus, Container, ContainerStats, MergeSummary, MetricsSample, SessionInfo, Snapshot, SyncState, SyncSummary, Transfer};

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
    /// Full container list (after subscribe and after every docker event).
    DockerList { host_id: String, containers: Vec<Container>, error: Option<String> },
    /// Live CPU / memory per running container (only while the Docker view is visible).
    DockerStats { host_id: String, stats: Vec<ContainerStats> },
    /// New lines of a followed log. `stream` = "docker:<container>" or "file:<path>".
    LogLines { host_id: String, stream: String, lines: Vec<String> },
    /// A followed log ended (container removed, file missing…).
    LogEnded { host_id: String, stream: String, reason: String },
    /// Upload / download progress.
    Transfer { transfer: Transfer },
    /// "Edit locally" sync result. `state` = uploaded | conflict | error.
    EditSync { host_id: String, remote: String, state: String, message: Option<String> },
    /// Dashboard sync: one host changed state. `snapshot` is set once it finished.
    SyncProgress { job_id: String, host_id: String, state: SyncState, snapshot: Option<Snapshot> },
    /// A sync run finished. `auto` = started by the scheduler, not by the user.
    SyncDone { job_id: String, auto: bool, summary: SyncSummary },
    /// Backup / device sync state changed.
    BackupStatus { status: BackupStatus },
    /// Data arrived from another device or a backup: reload hosts, snippets, settings.
    DataChanged { summary: MergeSummary },
    VaultLocked,
    VaultUnlocked,
}
