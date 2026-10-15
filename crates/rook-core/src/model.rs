//! Shared data types. Every type here is exported to TypeScript with `ts-rs`
//! (run `cargo test -p rook-core` to regenerate `apps/desktop/src/ipc/bindings`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Hosts, groups, identities
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum EnvLabel {
    #[default]
    None,
    Prod,
    Staging,
    Dev,
    Lab,
    Client,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum StartView {
    #[default]
    Terminal,
    Overview,
    Docker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum RefreshMode {
    #[default]
    Inherit,
    Auto,
    Manual,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum Collect {
    #[default]
    Basic,
    BasicDocker,
    Everything,
}

/// Background-refresh setting. Same shape at global, group and host level;
/// `None` fields mean "inherit from the level above".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct RefreshSetting {
    #[serde(default)]
    pub mode: RefreshMode,
    #[serde(default)]
    pub interval_s: Option<u32>,
    #[serde(default)]
    pub collect: Option<Collect>,
    #[serde(default)]
    pub desktop: Option<bool>,
    #[serde(default)]
    pub mobile: Option<bool>,
    #[serde(default)]
    pub wifi_only: Option<bool>,
}

/// Fully resolved setting (no `inherit`, no `None`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct EffectiveRefresh {
    pub mode: RefreshMode,
    pub interval_s: u32,
    pub collect: Collect,
    pub desktop: bool,
    pub mobile: bool,
    pub wifi_only: bool,
    /// Where the mode came from: "global" | "group:<id>" | "host".
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct Group {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub color: String,
    #[ts(type = "number")]
    pub sort: i64,
    pub identity_id: Option<String>,
    pub jump_host_id: Option<String>,
    pub theme: Option<String>,
    pub start_folder: Option<String>,
    #[serde(default)]
    pub refresh: RefreshSetting,
    #[serde(default)]
    pub auto_sync_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct Host {
    pub id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub address: String,
    pub port: u16,
    #[serde(default)]
    pub env_label: EnvLabel,
    #[serde(default)]
    pub tags: Vec<String>,
    pub identity_id: Option<String>,
    pub jump_host_id: Option<String>,
    pub theme: Option<String>,
    #[serde(default)]
    pub start_view: StartView,
    pub start_folder: Option<String>,
    #[serde(default = "default_true")]
    pub auto_reconnect: bool,
    #[serde(default = "default_keepalive")]
    pub keepalive_s: u32,
    #[serde(default)]
    pub log_session: bool,
    #[serde(default)]
    pub refresh: RefreshSetting,
    #[serde(default)]
    #[ts(type = "number")]
    pub sort: i64,
    #[serde(default)]
    #[ts(type = "number")]
    pub created_at: i64,
    #[serde(default)]
    #[ts(type = "number")]
    pub updated_at: i64,
}

fn default_true() -> bool {
    true
}
fn default_keepalive() -> u32 {
    30
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    #[default]
    Password,
    KeyFile,
    KeyInVault,
    Agent,
}

/// A reusable login. Secrets live in the vault under deterministic ids:
/// `identity:<id>:password`, `identity:<id>:key`, `identity:<id>:passphrase`, `identity:<id>:sudo`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub username: String,
    #[serde(default)]
    pub auth: AuthKind,
    pub key_path: Option<String>,
    /// Read-only flags computed from the vault; ignored on save.
    #[serde(default)]
    pub has_password: bool,
    #[serde(default)]
    pub has_key: bool,
    #[serde(default)]
    pub has_passphrase: bool,
    #[serde(default)]
    pub has_sudo: bool,
}

impl Identity {
    pub fn secret_id(&self, kind: &str) -> String {
        format!("identity:{}:{}", self.id, kind)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct KnownHost {
    pub host_id: String,
    pub key_type: String,
    pub fingerprint: String,
    #[ts(type = "number")]
    pub first_seen: i64,
    #[ts(type = "number")]
    pub last_seen: i64,
}

// ---------------------------------------------------------------------------
// Sessions, terminals, metrics
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    #[default]
    Idle,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SessionInfo {
    pub host_id: String,
    pub state: SessionState,
    pub latency_ms: Option<u32>,
    pub error: Option<String>,
    pub leases: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct TermOpen {
    pub host_id: String,
    pub cols: u16,
    pub rows: u16,
    /// Optional working directory (`cd` is sent after the shell starts).
    pub cwd: Option<String>,
    /// If set, the terminal runs `docker exec -it <container> sh|bash`.
    pub container: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct MetricsSample {
    #[ts(type = "number")]
    pub ts_ms: i64,
    /// `None` on the first sample (needs two reads of /proc/stat).
    pub cpu_pct: Option<f32>,
    #[ts(type = "number")]
    pub ram_used_bytes: u64,
    #[ts(type = "number")]
    pub ram_total_bytes: u64,
    pub disk_pct: f32,
    #[ts(type = "number")]
    pub disk_used_bytes: u64,
    #[ts(type = "number")]
    pub disk_total_bytes: u64,
    pub load1: f32,
    pub load5: f32,
    pub load15: f32,
    #[ts(type = "number")]
    pub uptime_s: u64,
    #[ts(type = "number | null")]
    pub net_rx_bps: Option<u64>,
    #[ts(type = "number | null")]
    pub net_tx_bps: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct Snapshot {
    pub host_id: String,
    #[ts(type = "number")]
    pub taken_at: i64,
    pub ok: bool,
    pub error: Option<String>,
    pub metrics: Option<MetricsSample>,
    pub docker_json: Option<String>,
}

// ---------------------------------------------------------------------------
// Vault status (never contains secrets)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct VaultStatus {
    pub initialised: bool,
    pub unlocked: bool,
    pub pin_set: bool,
    pub pin_disabled: bool,
    pub pin_length: Option<u8>,
    pub pin_attempts_left: Option<u32>,
}

