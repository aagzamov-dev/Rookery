//! Shared data types. Every type here is exported to TypeScript with `ts-rs`
//! (run `cargo test -p rookery-core` to regenerate `apps/desktop/src/ipc/bindings`).

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
    /// Version time for device sync (ms).
    #[serde(default)]
    #[ts(type = "number")]
    pub updated_at: i64,
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
    /// Version time for device sync (ms).
    #[serde(default)]
    #[ts(type = "number")]
    pub updated_at: i64,
}

impl Identity {
    pub fn secret_id(&self, kind: &str) -> String {
        format!("identity:{}:{}", self.id, kind)
    }
}

// ---------------------------------------------------------------- SQL connections (v0.7)

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum DbEngine {
    #[default]
    Postgres,
    /// MySQL and MariaDB.
    Mysql,
}

impl DbEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            DbEngine::Postgres => "postgres",
            DbEngine::Mysql => "mysql",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum DbVia {
    /// The driver connects to `address:port` itself.
    #[default]
    Direct,
    /// Through the saved server `host_id` (SSH loopback forward).
    Ssh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub enum SslMode {
    #[serde(rename = "disable")]
    Disable,
    /// TLS when the server offers it, certificate not checked.
    #[default]
    #[serde(rename = "prefer")]
    Prefer,
    /// TLS always, certificate not checked.
    #[serde(rename = "require")]
    Require,
    /// TLS always, certificate and host name checked (system roots + optional CA file).
    #[serde(rename = "verify-full")]
    VerifyFull,
}

/// A saved database connection. The password lives in the vault (`dbconn:<id>:password`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct DbConnection {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub engine: DbEngine,
    #[serde(default)]
    pub via: DbVia,
    /// The server to go through when `via = ssh`.
    pub host_id: Option<String>,
    /// Database host, as seen from this PC (direct) or from the server (ssh).
    pub address: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// Default database (MySQL) / database (Postgres).
    pub database: Option<String>,
    #[serde(default)]
    pub ssl_mode: SslMode,
    pub ca_path: Option<String>,
    #[serde(default)]
    pub env_label: EnvLabel,
    pub group_id: Option<String>,
    /// Open read-only (always on for PROD, whatever this says).
    #[serde(default)]
    pub read_only: bool,
    #[serde(default = "default_row_limit")]
    pub row_limit: u32,
    #[serde(default = "default_timeout_s")]
    pub timeout_s: u32,
    #[serde(default)]
    #[ts(type = "number")]
    pub sort: i64,
    #[serde(default)]
    #[ts(type = "number")]
    pub created_at: i64,
    #[serde(default)]
    #[ts(type = "number")]
    pub updated_at: i64,
    /// Read-only flag computed from the vault; ignored on save.
    #[serde(default)]
    pub has_password: bool,
}

fn default_row_limit() -> u32 {
    500
}
fn default_timeout_s() -> u32 {
    30
}

impl DbConnection {
    pub fn secret_id(&self) -> String {
        db_secret_id(&self.id)
    }

    /// PROD connections always open read-only.
    pub fn opens_read_only(&self) -> bool {
        self.read_only || self.env_label == EnvLabel::Prod
    }
}

pub fn db_secret_id(conn_id: &str) -> String {
    format!("dbconn:{conn_id}:password")
}

/// One run in a connection's query history (local only, never synced, no result data).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SqlHistoryEntry {
    #[ts(type = "number")]
    pub id: i64,
    /// `db_connections.id`, `host:<host_id>:<engine>:<port>` (server view) or `url:<url without password>`.
    pub conn_key: String,
    pub sql: String,
    #[ts(type = "number")]
    pub ran_at: i64,
    pub ok: bool,
    /// Rows returned (or affected) by the last statement.
    #[ts(type = "number | null")]
    pub rows: Option<i64>,
    #[ts(type = "number | null")]
    pub elapsed_ms: Option<i64>,
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
    /// Write the output to a session log file (logs/<host>/<time>.log).
    #[serde(default)]
    pub log: bool,
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

// ---------------------------------------------------------------------------
// Dashboard sync (docs/04 §4)
// ---------------------------------------------------------------------------

/// Per-host sync state. Snapshots store only `ok | failed | locked`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    Queued,
    Running,
    #[default]
    Ok,
    Failed,
    /// Needs a secret that is not in the vault; a sync never prompts.
    Locked,
    /// Not collected (mode Never, or already syncing).
    Skipped,
}

impl SyncState {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncState::Queued => "queued",
            SyncState::Running => "running",
            SyncState::Ok => "ok",
            SyncState::Failed => "failed",
            SyncState::Locked => "locked",
            SyncState::Skipped => "skipped",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "failed" => SyncState::Failed,
            "locked" => SyncState::Locked,
            _ => SyncState::Ok,
        }
    }
}

/// Containers at the time of the last sync (from one `docker ps` + `docker stats --no-stream`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct DockerSummary {
    pub total: u32,
    pub running: u32,
    pub exited: u32,
    pub unhealthy: Vec<String>,
    pub restarting: Vec<String>,
    /// Busiest running containers (max 5).
    pub top: Vec<ContainerStats>,
    /// Docker missing / no permission: shown instead of numbers.
    pub error: Option<String>,
}

/// Last known state of a server, as the Dashboard shows it. Lives in `server_snapshots`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct Snapshot {
    pub host_id: String,
    /// Last attempt, successful or not.
    #[ts(type = "number")]
    pub taken_at: i64,
    pub state: SyncState,
    pub error: Option<String>,
    /// Last successful sync. Metrics / os / docker below are from then (kept on failure).
    #[ts(type = "number | null")]
    pub last_ok_at: Option<i64>,
    pub metrics: Option<MetricsSample>,
    /// CPU of the previous successful sync ("high for two syncs in a row").
    pub prev_cpu_pct: Option<f32>,
    pub os: Option<String>,
    pub docker: Option<DockerSummary>,
    /// Failed systemd units (collect = everything).
    pub failed_services: Option<Vec<String>>,
    pub duration_ms: Option<u32>,
}

/// What a sync run covers. `Group` includes sub-groups; id `"ungrouped"` = hosts without a group.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncScope {
    All,
    Group { id: String },
    Host { id: String },
    Hosts { ids: Vec<String> },
}

pub const UNGROUPED: &str = "ungrouped";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SyncSettings {
    /// Master pause: nothing syncs automatically (Sync now still works).
    #[serde(default)]
    pub paused: bool,
    /// Servers collected at the same time (1–6).
    #[serde(default = "default_concurrency")]
    pub concurrency: u8,
    /// Keep auto-sync running while the window is minimised / hidden.
    #[serde(default)]
    pub run_when_hidden: bool,
    /// Auto-sync switch for hosts that are in no group.
    #[serde(default)]
    pub ungrouped_auto: bool,
}

fn default_concurrency() -> u8 {
    3
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self { paused: false, concurrency: 3, run_when_hidden: false, ungrouped_auto: false }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SyncSummary {
    pub ok: u32,
    pub failed: u32,
    pub locked: u32,
    pub skipped: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SyncStatus {
    pub settings: SyncSettings,
    /// Global refresh defaults (mode / interval / what to collect).
    pub global: RefreshSetting,
    /// Hosts being collected right now.
    pub running: Vec<String>,
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

// ---------------------------------------------------------------------------
// Snippets (docs/03-DESKTOP-FEATURES.md §6)
// ---------------------------------------------------------------------------

/// What a snippet holds. SQL snippets live in the SQL tab only: terminals, the palette,
/// aliases and hotkeys never run them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum SnippetKind {
    #[default]
    Shell,
    Sql,
}

/// Which servers a snippet shows on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum SnippetScope {
    #[default]
    All,
    /// `scope_value` = tag name
    Tag,
    /// `scope_value` = group id (includes child groups)
    Group,
    /// `scope_value` = host id
    Host,
    /// Runs inside containers; `scope_value` = container name pattern (`*` wildcard) or compose service.
    Container,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    /// Type the command and press Enter.
    #[default]
    Run,
    /// Type the command; the user presses Enter.
    Paste,
    /// Open a new terminal on the server and run it there.
    NewTerminal,
}

/// A `${name}` placeholder in the command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SnippetVar {
    pub name: String,
    #[serde(default)]
    pub default: Option<String>,
    /// Ask every run (prefilled with `default`). If false, `default` is used silently.
    #[serde(default = "default_true")]
    pub ask: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    /// Short name typed in the palette or before Tab in the terminal, e.g. `paserve`.
    pub alias: Option<String>,
    pub command: String,
    #[serde(default)]
    pub vars: Vec<SnippetVar>,
    #[serde(default)]
    pub scope: SnippetScope,
    pub scope_value: Option<String>,
    #[serde(default)]
    pub run_mode: RunMode,
    /// Keyboard chord, e.g. `Ctrl+Shift+S`.
    pub hotkey: Option<String>,
    /// Ask for confirmation before running on a PROD server.
    #[serde(default = "default_true")]
    pub ask_prod: bool,
    pub pack: Option<String>,
    /// Workflow: when not empty, these steps run in order instead of `command`.
    #[serde(default)]
    pub steps: Vec<String>,
    /// Workflow: keep going when a step fails (otherwise stop at the first failure).
    #[serde(default)]
    pub continue_on_error: bool,
    /// shell (terminals) or sql (the SQL tab only).
    #[serde(default)]
    pub kind: SnippetKind,
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

// ---------------------------------------------------------------------------
// Docker, services (docs/03 §5)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    /// running | exited | restarting | paused | created | dead
    pub state: String,
    /// Human text from Docker, e.g. "Up 3 hours (healthy)".
    pub status: String,
    pub ports: String,
    /// healthy | unhealthy | starting
    pub health: Option<String>,
    /// `com.docker.compose.project` label
    pub project: Option<String>,
    /// `com.docker.compose.service` label
    pub service: Option<String>,
    pub created: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ContainerStats {
    pub id: String,
    pub name: String,
    pub cpu_pct: f32,
    pub mem_pct: f32,
    /// e.g. "412MiB / 7.6GiB"
    pub mem_usage: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct Service {
    pub name: String,
    pub load: String,
    /// active | inactive | failed | activating
    pub active: String,
    /// running | exited | dead | …
    pub sub: String,
    pub description: String,
}

// ---------------------------------------------------------------------------
// Files (SFTP)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Dir,
    File,
    Link,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    #[ts(type = "number")]
    pub size: u64,
    /// Seconds since epoch.
    #[ts(type = "number")]
    pub mtime: i64,
    pub mode: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum TransferState {
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct Transfer {
    pub id: String,
    pub host_id: String,
    pub name: String,
    pub upload: bool,
    pub remote: String,
    #[ts(type = "number")]
    pub bytes: u64,
    #[ts(type = "number")]
    pub total: u64,
    pub state: TransferState,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct Process {
    pub pid: u32,
    pub user: String,
    pub cpu: f32,
    pub mem: f32,
    #[ts(type = "number")]
    pub elapsed_s: u64,
    pub command: String,
}

/// A shell available on this computer for local terminal tabs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct LocalShell {
    pub id: String,
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
}

/// Options for `subscribe` beyond host + source.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SubParams {
    #[serde(default)]
    pub interval_ms: Option<u32>,
    /// docker.logs: container id or name
    #[serde(default)]
    pub container: Option<String>,
    /// file.tail: absolute path
    #[serde(default)]
    pub path: Option<String>,
    /// docker.logs: RFC 3339 timestamp to resume from (gap fill after the view was hidden)
    #[serde(default)]
    pub since: Option<String>,
}


// ---------------------------------------------------------------------------
// Backup & device sync (docs/04 §5)
// ---------------------------------------------------------------------------

/// A deletion remembered so it reaches other devices. `kind` = group | host | identity | snippet | known_host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct Tombstone {
    pub kind: String,
    pub id: String,
    #[ts(type = "number")]
    pub deleted_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingRecord {
    pub key: String,
    pub value: serde_json::Value,
    pub updated_at: i64,
}

/// Per-device backup / sync configuration (`backup.config`, never leaves this device).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct BackupConfig {
    pub device_id: String,
    pub device_name: String,
    /// Sync folder (e.g. inside Google Drive / OneDrive / Dropbox). None = sync off.
    pub folder: Option<String>,
    /// Sync on start, after changes, and when another device wrote.
    pub auto: bool,
}

/// What a merge changed on this device.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct MergeSummary {
    pub added: u32,
    pub updated: u32,
    pub deleted: u32,
    /// Human notes, e.g. alias conflicts that were resolved.
    pub notes: Vec<String>,
}

impl MergeSummary {
    pub fn changed(&self) -> bool {
        self.added + self.updated + self.deleted > 0
    }
}

/// Another device seen in the sync folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SyncPeer {
    pub device_id: String,
    pub device_name: String,
    /// When that device last wrote its file.
    #[ts(type = "number")]
    pub written_at: i64,
    /// File could not be opened (other password, damaged…).
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct BackupStatus {
    pub config: BackupConfig,
    /// A sync password is saved in this device's vault.
    pub has_password: bool,
    pub syncing: bool,
    #[ts(type = "number | null")]
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_summary: Option<MergeSummary>,
    pub peers: Vec<SyncPeer>,
}

/// Shown before importing a backup file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct BackupInfo {
    pub device_name: String,
    #[ts(type = "number")]
    pub created_at: i64,
    pub hosts: u32,
    pub groups: u32,
    pub identities: u32,
    pub snippets: u32,
    #[serde(default)]
    pub db_connections: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum ImportMode {
    /// Newest wins per item; nothing on this device is lost unless it was deleted elsewhere later.
    Merge,
    /// This device becomes exactly the backup.
    Replace,
}
