// Typed wrappers for Tauri commands (crates/rookery-tauri/src/commands.rs).
// Tauri converts snake_case Rust argument names to camelCase on the JS side.
import { askConfirm } from "../stores/dialogs";
import { COMPUTER_ID } from "../features/local/target";
import { invoke } from "@tauri-apps/api/core";
import type { CoreEvent } from "./bindings/CoreEvent";
import type { Transfer } from "./bindings/Transfer";
import type { BackupInfo } from "./bindings/BackupInfo";
import type { BackupStatus } from "./bindings/BackupStatus";
import type { EffectiveRefresh } from "./bindings/EffectiveRefresh";
import type { ImportMode } from "./bindings/ImportMode";
import type { ImportedHost } from "./bindings/ImportedHost";
import type { MergeSummary } from "./bindings/MergeSummary";
import type { RefreshSetting } from "./bindings/RefreshSetting";
import type { Snapshot } from "./bindings/Snapshot";
import type { SyncScope } from "./bindings/SyncScope";
import type { SyncSettings } from "./bindings/SyncSettings";
import type { SyncStatus } from "./bindings/SyncStatus";
import type { Group } from "./bindings/Group";
import type { Host } from "./bindings/Host";
import type { Identity } from "./bindings/Identity";
import type { SearchRequest } from "./bindings/SearchRequest";
import type { SearchResult } from "./bindings/SearchResult";
import type { GitCommit } from "./bindings/GitCommit";
import type { BlameLine } from "./bindings/BlameLine";
import type { PathUsage } from "./bindings/PathUsage";
import type { FileEntry } from "./bindings/FileEntry";
import type { KnownHost } from "./bindings/KnownHost";
import type { LocalShell } from "./bindings/LocalShell";
import type { Process } from "./bindings/Process";
import type { Service } from "./bindings/Service";
import type { SessionInfo } from "./bindings/SessionInfo";
import type { SubParams } from "./bindings/SubParams";
import type { Snippet } from "./bindings/Snippet";
import type { TermOpen } from "./bindings/TermOpen";
import type { VaultStatus } from "./bindings/VaultStatus";
import type { DbConnection } from "./bindings/DbConnection";
import type { SchemaTree } from "./bindings/SchemaTree";
import type { EnvSource } from "./bindings/EnvSource";
import type { LocalDb } from "./bindings/LocalDb";
import type { SqlHistoryEntry } from "./bindings/SqlHistoryEntry";
import type { SqlPrefill } from "./bindings/SqlPrefill";
import type { SqlOpened } from "./bindings/SqlOpened";
import type { SqlRunOpts } from "./bindings/SqlRunOpts";
import type { SqlTarget } from "./bindings/SqlTarget";
import type { SqlTestResult } from "./bindings/SqlTestResult";
import type { TableDetail } from "./bindings/TableDetail";
import type { TableQuery } from "./bindings/TableQuery";
import type { TableCellUpdate } from "./bindings/TableCellUpdate";
import type { TableRowsStarted } from "./bindings/TableRowsStarted";
import type { TxAction } from "./bindings/TxAction";
import type { EditorBackup } from "./bindings/EditorBackup";
import type { EditorFile } from "./bindings/EditorFile";
import type { Eol } from "./bindings/Eol";
import type { FileStamp } from "./bindings/FileStamp";
import type { FileVersion } from "./bindings/FileVersion";
import type { SaveMode } from "./bindings/SaveMode";
import type { SaveOutcome } from "./bindings/SaveOutcome";
import type { GitStatus } from "./bindings/GitStatus";
import type { GitFile } from "./bindings/GitFile";
import type { GitDiff } from "./bindings/GitDiff";
import type { GitAction } from "./bindings/GitAction";
import type { PinCredential } from "./bindings/PinCredential";

import type { DatabaseFileInfo } from "./bindings/DatabaseFileInfo";
import type { LogExportRequest } from "./bindings/LogExportRequest";
import type { SudoState } from "./bindings/SudoState";
import type { DatabaseBackup } from "./bindings/DatabaseBackup";
import type { DatabaseOperation } from "./bindings/DatabaseOperation";
import type { DatabaseJob } from "./bindings/DatabaseJob";

export type CoreErrorKind =
  | "db" | "io" | "json"
  | "vault_locked" | "vault_not_initialised" | "wrong_password" | "wrong_pin"
  | "pin_disabled" | "pin_not_set" | "pin_cooldown" | "keychain" | "crypto"
  | "ssh" | "auth_failed" | "host_key_changed" | "unknown_host_key" | "secret_required"
  | "not_found" | "other";

export interface CoreError {
  kind: CoreErrorKind;
  message: string;
  attempts_left: number | null;
  cooldown_s: number | null;
  fingerprint: string | null;
}

export function asCoreError(e: unknown): CoreError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) return e as CoreError;
  return { kind: "other", message: String(e), attempts_left: null, cooldown_s: null, fingerprint: null };
}

/** Secret update: undefined = keep, "" = delete, value = set. */
export interface IdentitySecrets {
  password?: string;
  key?: string;
  passphrase?: string;
  sudo?: string;
}

export type ArchiveMode = "zip" | "unzip" | "targz" | "untargz";

async function remoteChange<T>(command: string, args: Record<string, unknown>, preview: string, confirmed = false, alwaysConfirm = false): Promise<T> {
  const hosts = args.hostId === COMPUTER_ID ? [] : await invoke<Host[]>("hosts_list");
  const host = hosts.find((h) => h.id === args.hostId);
  if ((host?.env_label === "prod" || alwaysConfirm) && !confirmed) {
    confirmed = await askConfirm({ title: host?.env_label === "prod" ? `Change PRODUCTION server ${host.name}?` : "Overwrite server copy?", body: "Review this change before applying it to the server.", preview, confirmLabel: "Apply change", danger: true });
    if (!confirmed) throw new Error("Change cancelled.");
  }
  return invoke<T>(command, { ...args, confirmed });
}

export const api = {
  gitStatus: (hostId: string, folder: string) => invoke<GitStatus>("git_status", { hostId, folder }),
  gitDiscover: (hostId: string, folder: string) => invoke<string[]>("git_discover", { hostId, folder }),
  gitDiff: (hostId: string, folder: string, file: GitFile, staged: boolean) => invoke<GitDiff>("git_diff", { hostId, folder, file, staged }),
  gitAction: (hostId: string, folder: string, action: GitAction, confirmed: boolean) => invoke<string>("git_action", { hostId, folder, action, confirmed }),
  gitLocate: (hostId: string, file: string) => invoke<[string, string]>("git_locate", { hostId, file }),
  gitHistory: (hostId: string, folder: string, path: string) => invoke<GitCommit[]>("git_history", { hostId, folder, path }),
  gitFileAt: (hostId: string, folder: string, commit: string, path: string) => invoke<GitDiff>("git_file_at", { hostId, folder, commit, path }),
  gitBlame: (hostId: string, folder: string, path: string) => invoke<BlameLine[]>("git_blame", { hostId, folder, path }),
  // vault
  vaultStatus: () => invoke<VaultStatus>("vault_status"),
  vaultCreate: (master: string) => invoke<VaultStatus>("vault_create", { master }),
  vaultUnlockMaster: (master: string) => invoke<VaultStatus>("vault_unlock_master", { master }),
  vaultUnlockPin: (pin: string) => invoke<VaultStatus>("vault_unlock_pin", { pin }),
  vaultSetPin: (pin: string) => invoke<VaultStatus>("vault_set_pin", { pin }),
  vaultChangePin: (pin: string, credential: PinCredential) => invoke<VaultStatus>("vault_change_pin", { pin, credential }),
  vaultLock: (closeSessions = false) => invoke<VaultStatus>("vault_lock", { closeSessions }),

  // groups / hosts / identities
  groupsList: () => invoke<Group[]>("groups_list"),
  groupSave: (group: Group) => invoke<Group>("group_save", { group }),
  groupDelete: (id: string) => invoke<void>("group_delete", { id }),
  hostsList: () => invoke<Host[]>("hosts_list"),
  hostSave: (host: Host) => invoke<Host>("host_save", { host }),
  hostDelete: (id: string) => invoke<void>("host_delete", { id }),
  hostTrustKey: (hostId: string, fingerprint: string) => invoke<void>("host_trust_key", { hostId, fingerprint }),
  identitiesList: () => invoke<Identity[]>("identities_list"),
  identitySave: (identity: Identity, s: IdentitySecrets = {}) =>
    invoke<Identity>("identity_save", {
      identity,
      password: s.password ?? null,
      key: s.key ?? null,
      passphrase: s.passphrase ?? null,
      sudo: s.sudo ?? null,
    }),
  identityDelete: (id: string) => invoke<void>("identity_delete", { id }),
  refreshEffective: (hostId: string) => invoke<EffectiveRefresh>("refresh_effective", { hostId }),

  // dashboard sync
  snapshotsList: () => invoke<Snapshot[]>("snapshots_list"),
  syncStatus: () => invoke<SyncStatus>("sync_status"),
  syncRun: (scope: SyncScope) => invoke<string>("sync_run", { scope }),
  syncCancel: (jobId: string) => invoke<void>("sync_cancel", { jobId }),
  syncSettingsSet: (settings: SyncSettings) => invoke<SyncSettings>("sync_settings_set", { settings }),
  refreshGlobalSet: (setting: RefreshSetting) => invoke<RefreshSetting>("refresh_global_set", { setting }),
  syncSetAuto: (groupIds: string[], on: boolean) => invoke<void>("sync_set_auto", { groupIds, on }),
  syncWindowVisible: (visible: boolean, hostId: string | null = null) => invoke<void>("sync_window_visible", { visible, hostId }),

  // backup & device sync (passwords go to the vault in Rust and never come back)
  backupStatus: () => invoke<BackupStatus>("backup_status"),
  backupSetConfig: (folder: string | null, auto: boolean, deviceName: string) =>
    invoke<BackupStatus>("backup_set_config", { folder, auto, deviceName }),
  backupSetPassword: (password: string) => invoke<void>("backup_set_password", { password }),
  backupSyncNow: () => invoke<BackupStatus>("backup_sync_now"),
  backupExport: (path: string, password: string | null) => invoke<void>("backup_export", { path, password }),
  backupInspect: (path: string, password: string | null) => invoke<BackupInfo>("backup_inspect", { path, password }),
  backupImport: (path: string, password: string | null, mode: ImportMode) => invoke<MergeSummary>("backup_import", { path, password, mode }),
  fileCopyToClipboard: (path: string) => invoke<void>("file_copy_to_clipboard", { path }),

  // session logs, global hotkey
  logsDir: () => invoke<string>("logs_dir"),
  logsCleanup: (days: number) => invoke<number>("logs_cleanup", { days }),
  globalHotkeySet: (chord: string | null) => invoke<void>("global_hotkey_set", { chord }),

  // importers: ~/.ssh/config, MobaXterm, PuTTY
  importPreview: (source: "ssh_config" | "mobaxterm" | "putty", path: string | null) => invoke<ImportedHost[]>("import_preview", { source, path }),
  importApply: (hosts: ImportedHost[], group: string | null) => invoke<number>("import_apply", { hosts, group }),

  // clipboard
  /** The login's password after checking the master password again; `identityId` null = only check it. */
  identityRevealPassword: (identityId: string | null, master: string) => invoke<string | null>("identity_reveal_password", { identityId, master }),
  clipboardWrite: (text: string) => invoke<void>("clipboard_write", { text }),
  clipboardRead: () => invoke<string>("clipboard_read"),

  // known hosts
  knownHostsList: () => invoke<KnownHost[]>("known_hosts_list"),
  knownHostForget: (hostId: string) => invoke<void>("known_host_forget", { hostId }),

  // local terminals
  localShells: () => invoke<LocalShell[]>("local_shells"),
  localTermOpen: (shellId: string, cols: number, rows: number, cwd?: string, container?: string) => invoke<string>("local_term_open", { shellId, cols, rows, cwd: cwd ?? null, container: container ?? null }),
  localTermWrite: (termId: string, data: string) => invoke<void>("local_term_write", { termId, data }),
  localTermResize: (termId: string, cols: number, rows: number) => invoke<void>("local_term_resize", { termId, cols, rows }),
  localTermClose: (termId: string) => invoke<void>("local_term_close", { termId }),

  // processes, sudo
  processesList: (hostId: string) => invoke<Process[]>("processes_list", { hostId }),
  processKill: (hostId: string, pid: number, force: boolean, confirmed = false) => remoteChange<void>("process_kill", { hostId, pid, force }, `kill -${force ? "KILL" : "TERM"} ${pid}`, confirmed),
  termSudoFill: (termId: string) => invoke<void>("term_sudo_fill", { termId }),
  /** Fills a `[sudo]` prompt only when auto sudo is on for the server; false = not filled. */
  termSudoAuto: (termId: string) => invoke<boolean>("term_sudo_auto", { termId }),
  sudoState: (hostId: string) => invoke<SudoState>("sudo_state", { hostId }),
  /** password: typed now (this app session only, or saved to the login with `save`). */
  sudoSet: (hostId: string, enabled: boolean, password?: string, save = false) =>
    invoke<SudoState>("sudo_set", { hostId, enabled, password: password || null, save }),

  // import / export (paths come from file dialogs)
  fileReadText: (path: string) => invoke<string>("file_read_text", { path }),
  fileWriteText: (path: string, content: string) => invoke<void>("file_write_text", { path, content }),

  // sessions
  frontendReady: () => invoke<void>("frontend_ready"),
  sessionAttach: (hostId: string) => invoke<string>("session_attach", { hostId }),
  sessionDetach: (attachId: string) => invoke<void>("session_detach", { attachId }),
  sessionInfo: (hostId: string) => invoke<SessionInfo>("session_info", { hostId }),
  transferStatus: () => invoke<Transfer[]>("transfer_status"),
  sessionsAll: () => invoke<SessionInfo[]>("sessions_all"),

  // terminals
  termOpen: (req: TermOpen) => invoke<string>("term_open", { req }),
  termWrite: (termId: string, data: string) => invoke<void>("term_write", { termId, data }),
  termResize: (termId: string, cols: number, rows: number) => invoke<void>("term_resize", { termId, cols, rows }),
  termClose: (termId: string) => invoke<void>("term_close", { termId }),

  // subscriptions
  subscribe: (hostId: string, source: string, params?: Partial<SubParams>) =>
    invoke<{ sub_id: string; cached: unknown }>("subscribe", {
      hostId,
      source,
      params: params ? { interval_ms: null, container: null, path: null, since: null, ...params } : null,
    }),
  logHistory: (hostId: string, source: "docker" | "file", target: string, since: string, until: string) => invoke<string[]>("log_history", { hostId, source, target, since, until }),
  unsubscribe: (subId: string) => invoke<void>("unsubscribe", { subId }),

  // files (SFTP)
  sftpHome: (hostId: string) => invoke<string>("sftp_home", { hostId }),

  // editor (docs/08): content goes webview → Rust → server only; never logged
  editorOpen: (hostId: string, path: string) => invoke<EditorFile>("editor_open", { hostId, path }),
  editorOpenSudo: (hostId: string, path: string) => invoke<EditorFile>("editor_open_sudo", { hostId, path }),
  editorStat: (hostId: string, path: string) => invoke<FileStamp>("editor_stat", { hostId, path }),
  editorSave: (hostId: string, path: string, content: string, eol: Eol, bom: boolean, base: FileVersion, mode: SaveMode, confirmed = false) =>
    invoke<SaveOutcome>("editor_save", { hostId, path, content, eol, bom, base, mode, confirmed }),
  editorBackups: (hostId: string, path: string) => invoke<EditorBackup[]>("editor_backups", { hostId, path }),
  editorBackupRead: (hostId: string, path: string, id: string) => invoke<string>("editor_backup_read", { hostId, path, id }),

  sftpList: (hostId: string, path: string) => invoke<FileEntry[]>("sftp_list", { hostId, path }),
  sftpMkdir: (hostId: string, path: string) => remoteChange<void>("sftp_mkdir", { hostId, path }, `Create folder ${path}`),
  sftpCreateFile: (hostId: string, path: string) => remoteChange<void>("sftp_create_file", { hostId, path }, `Create file ${path}`),
  sftpDuplicate: (hostId: string, from: string, to: string) => remoteChange<void>("sftp_duplicate", { hostId, from, to }, `Duplicate ${from} → ${to}`),
  sftpArchive: (hostId: string, path: string, name: string, mode: ArchiveMode, job: string) =>
    remoteChange<void>("sftp_archive", { hostId, path, name, mode, job }, `${mode === "unzip" || mode === "untargz" ? "Extract" : "Archive"} ${path} → ${name}`),
  sftpArchiveCancel: (job: string) => invoke<void>("sftp_archive_cancel", { job }),
  sftpUsage: (hostId: string, path: string) => invoke<PathUsage>("sftp_usage", { hostId, path }),
  sftpChmod: (hostId: string, path: string, mode: number) => remoteChange<void>("sftp_chmod", { hostId, path, mode }, `chmod ${mode.toString(8).padStart(3, "0")} ${path}`),
  sftpOwner: (hostId: string, path: string) => invoke<[string, string]>("sftp_owner", { hostId, path }),
  searchRun: (request: SearchRequest) => invoke<SearchResult>("search_run", { request }),
  searchCancel: (hostId: string, slot: string) => invoke<void>("search_cancel", { hostId, slot }),
  sftpRename: (hostId: string, from: string, to: string) => remoteChange<void>("sftp_rename", { hostId, from, to }, `Rename ${from} → ${to}`),
  sftpDelete: (hostId: string, path: string, isDir: boolean, recursive: boolean, confirmed = false) =>
    remoteChange<void>("sftp_delete", { hostId, path, isDir, recursive }, `Delete ${path}`, confirmed),
  sftpUpload: (hostId: string, localPaths: string[], remoteDir: string) =>
    remoteChange<string[]>("sftp_upload", { hostId, localPaths, remoteDir }, `Upload ${localPaths.join(", ")} → ${remoteDir}`),
  sftpDownload: (hostId: string, remote: string, local: string) => invoke<string>("sftp_download", { hostId, remote, local }),
  sftpClose: (hostId: string) => invoke<void>("sftp_close", { hostId }),
  transferCancel: (id: string) => invoke<void>("transfer_cancel", { id }),
  editOpen: (hostId: string, remote: string) => invoke<string>("edit_open", { hostId, remote }),
  editUpload: (hostId: string, remote: string, force: boolean) => remoteChange<void>("edit_upload", { hostId, remote, force }, `${force ? "Overwrite" : "Upload local changes to"} ${remote}`, false, force),
  editStop: (hostId: string, remote: string) => invoke<void>("edit_stop", { hostId, remote }),

  // docker, services, shell
  dockerAction: (hostId: string, container: string, action: "start" | "stop" | "restart" | "kill" | "remove", confirmed = false) =>
    remoteChange<void>("docker_action", { hostId, container, action }, `docker ${action} ${container}`, confirmed),
  /** Download logs as one zip; progress comes as `log_export` events. Returns the job id. */
  dockerLogsExport: (req: LogExportRequest) => invoke<string>("docker_logs_export", { req }),
  dockerLogsExportCancel: (jobId: string) => invoke<void>("docker_logs_export_cancel", { jobId }),
  servicesList: (hostId: string) => invoke<Service[]>("services_list", { hostId }),
  shellIntegrationInstall: (hostId: string, confirmed = false) => remoteChange<number>("shell_integration_install", { hostId }, "Update ~/.bashrc and ~/.zshrc", confirmed),

  // snippets
  snippetsList: () => invoke<Snippet[]>("snippets_list"),
  snippetSave: (snippet: Snippet) => invoke<Snippet>("snippet_save", { snippet }),
  snippetDelete: (id: string) => invoke<void>("snippet_delete", { id }),

  // SQL connections (passwords go to the vault in Rust and never come back)
  sqlConnsList: () => invoke<DbConnection[]>("sql_conns_list"),
  /** password: undefined = keep, "" = delete, value = set. */
  /** `passwordRef` (from `sqlEnvImport`) = use the password read from a .env. */
  sqlConnSave: (conn: DbConnection, password?: string, passwordRef?: string) =>
    invoke<DbConnection>("sql_conn_save", { conn, password: password ?? null, passwordRef: passwordRef ?? null }),
  sqlConnDelete: (id: string) => invoke<void>("sql_conn_delete", { id }),
  sqlTest: (conn: DbConnection, password?: string, passwordRef?: string) =>
    invoke<SqlTestResult>("sql_test", { conn, password: password || null, passwordRef: passwordRef ?? null }),
  /** Find databases on this PC: probe of 127.0.0.1 + local `docker ps`. */
  sqlDetectLocal: () => invoke<LocalDb[]>("sql_detect_local"),
  /** Laravel .env → prefill; DB_PASSWORD stays in Rust (`password_ref`). */
  sqlEnvImport: (source: EnvSource) => invoke<SqlPrefill>("sql_env_import", { source }),
  databaseFileInfo: (sessionId: string, includeTables = false) => invoke<DatabaseFileInfo>("database_file_info", { sessionId, includeTables }),
  databaseBackups: (sessionId: string) => invoke<DatabaseBackup[]>("database_backups", { sessionId }),
  databaseFileStart: (sessionId: string, operation: DatabaseOperation, confirmed = false) => invoke<string>("database_file_start", { sessionId, operation, confirmed }),
  databaseFileStatus: () => invoke<DatabaseJob[]>("database_file_status"),
  databaseFileCancel: (jobId: string) => invoke<void>("database_file_cancel", { jobId }),
  sqlOpen: (target: SqlTarget) => invoke<SqlOpened>("sql_open", { target }),
  sqlSessionStates: () => invoke<CoreEvent[]>("sql_session_states"),
  sqlActiveQueries: () => invoke<string[]>("sql_active_queries"),
  sqlReconnect: (sessionId: string) => invoke<void>("sql_reconnect", { sessionId }),
  sqlClose: (sessionId: string) => invoke<void>("sql_close", { sessionId }),
  sqlSchema: (sessionId: string, system = false) => invoke<SchemaTree>("sql_schema", { sessionId, system }),
  sqlUse: (sessionId: string, database: string) => invoke<void>("sql_use", { sessionId, database }),
  // table browser (Structure / Data tabs); filters become SQL in Rust, safely quoted
  sqlTableDetail: (sessionId: string, schema: string, table: string) => invoke<TableDetail>("sql_table_detail", { sessionId, schema, table }),
  sqlTableRows: (sessionId: string, query: TableQuery) => invoke<TableRowsStarted>("sql_table_rows", { sessionId, query }),
  sqlTableCount: (sessionId: string, query: TableQuery) => invoke<number>("sql_table_count", { sessionId, query }),
  sqlTableUpdateCell: (sessionId: string, update: TableCellUpdate) => invoke<void>("sql_table_update_cell", { sessionId, update }),
  /** Returns the query id; rows arrive as `sql_result` events. */
  sqlRun: (sessionId: string, sql: string, opts: SqlRunOpts = { row_limit: null }) => invoke<string>("sql_run", { sessionId, sql, opts }),
  sqlCancel: (queryId: string) => invoke<void>("sql_cancel", { queryId }),
  sqlTx: (sessionId: string, action: TxAction) => invoke<void>("sql_tx", { sessionId, action }),
  sqlAllowWrites: (sessionId: string, minutes: number) => invoke<void>("sql_allow_writes", { sessionId, minutes }),
  sqlSetEditMode: (sessionId: string, enabled: boolean) => invoke<void>("sql_set_edit_mode", { sessionId, enabled }),
  /** Docker → Open in SQL: one `docker inspect` → prefill (never a password). */
  sqlDockerInspect: (hostId: string, container: string) => invoke<SqlPrefill>("sql_docker_inspect", { hostId, container }),
  /** Newest first; local only, SQL text without results. */
  sqlHistory: (connKey: string, limit = 200) => invoke<SqlHistoryEntry[]>("sql_history", { connKey, limit }),
  sqlHistoryClear: (connKey: string) => invoke<void>("sql_history_clear", { connKey }),
  // UI settings (only `ui.*` keys)
  settingGet: <T>(key: string) => invoke<T | null>("setting_get", { key }),
  settingSet: (key: string, value: unknown) => invoke<void>("setting_set", { key, value }),
  debugActiveSubscriptions: () => invoke<[string, string, number][]>("debug_active_subscriptions"),
};
