// Typed wrappers for Tauri commands (crates/rookery-tauri/src/commands.rs).
// Tauri converts snake_case Rust argument names to camelCase on the JS side.
import { invoke } from "@tauri-apps/api/core";
import type { BackupInfo } from "./bindings/BackupInfo";
import type { BackupStatus } from "./bindings/BackupStatus";
import type { EffectiveRefresh } from "./bindings/EffectiveRefresh";
import type { ImportMode } from "./bindings/ImportMode";
import type { MergeSummary } from "./bindings/MergeSummary";
import type { RefreshSetting } from "./bindings/RefreshSetting";
import type { Snapshot } from "./bindings/Snapshot";
import type { SyncScope } from "./bindings/SyncScope";
import type { SyncSettings } from "./bindings/SyncSettings";
import type { SyncStatus } from "./bindings/SyncStatus";
import type { Group } from "./bindings/Group";
import type { Host } from "./bindings/Host";
import type { Identity } from "./bindings/Identity";
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

export const api = {
  // vault
  vaultStatus: () => invoke<VaultStatus>("vault_status"),
  vaultCreate: (master: string) => invoke<VaultStatus>("vault_create", { master }),
  vaultUnlockMaster: (master: string) => invoke<VaultStatus>("vault_unlock_master", { master }),
  vaultUnlockPin: (pin: string) => invoke<VaultStatus>("vault_unlock_pin", { pin }),
  vaultSetPin: (pin: string) => invoke<VaultStatus>("vault_set_pin", { pin }),
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
  syncWindowVisible: (visible: boolean) => invoke<void>("sync_window_visible", { visible }),

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

  // clipboard
  clipboardWrite: (text: string) => invoke<void>("clipboard_write", { text }),
  clipboardRead: () => invoke<string>("clipboard_read"),

  // known hosts
  knownHostsList: () => invoke<KnownHost[]>("known_hosts_list"),
  knownHostForget: (hostId: string) => invoke<void>("known_host_forget", { hostId }),

  // local terminals
  localShells: () => invoke<LocalShell[]>("local_shells"),
  localTermOpen: (shellId: string, cols: number, rows: number) => invoke<string>("local_term_open", { shellId, cols, rows }),
  localTermWrite: (termId: string, data: string) => invoke<void>("local_term_write", { termId, data }),
  localTermResize: (termId: string, cols: number, rows: number) => invoke<void>("local_term_resize", { termId, cols, rows }),
  localTermClose: (termId: string) => invoke<void>("local_term_close", { termId }),

  // processes, sudo
  processesList: (hostId: string) => invoke<Process[]>("processes_list", { hostId }),
  processKill: (hostId: string, pid: number, force: boolean) => invoke<void>("process_kill", { hostId, pid, force }),
  termSudoFill: (termId: string) => invoke<void>("term_sudo_fill", { termId }),

  // import / export (paths come from file dialogs)
  fileReadText: (path: string) => invoke<string>("file_read_text", { path }),
  fileWriteText: (path: string, content: string) => invoke<void>("file_write_text", { path, content }),

  // sessions
  frontendReady: () => invoke<void>("frontend_ready"),
  sessionAttach: (hostId: string) => invoke<string>("session_attach", { hostId }),
  sessionDetach: (attachId: string) => invoke<void>("session_detach", { attachId }),
  sessionInfo: (hostId: string) => invoke<SessionInfo>("session_info", { hostId }),
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
  unsubscribe: (subId: string) => invoke<void>("unsubscribe", { subId }),

  // files (SFTP)
  sftpHome: (hostId: string) => invoke<string>("sftp_home", { hostId }),
  sftpList: (hostId: string, path: string) => invoke<FileEntry[]>("sftp_list", { hostId, path }),
  sftpMkdir: (hostId: string, path: string) => invoke<void>("sftp_mkdir", { hostId, path }),
  sftpRename: (hostId: string, from: string, to: string) => invoke<void>("sftp_rename", { hostId, from, to }),
  sftpDelete: (hostId: string, path: string, isDir: boolean, recursive: boolean) =>
    invoke<void>("sftp_delete", { hostId, path, isDir, recursive }),
  sftpUpload: (hostId: string, localPaths: string[], remoteDir: string) =>
    invoke<string[]>("sftp_upload", { hostId, localPaths, remoteDir }),
  sftpDownload: (hostId: string, remote: string, local: string) => invoke<string>("sftp_download", { hostId, remote, local }),
  sftpClose: (hostId: string) => invoke<void>("sftp_close", { hostId }),
  transferCancel: (id: string) => invoke<void>("transfer_cancel", { id }),
  editOpen: (hostId: string, remote: string) => invoke<string>("edit_open", { hostId, remote }),
  editUpload: (hostId: string, remote: string, force: boolean) => invoke<void>("edit_upload", { hostId, remote, force }),
  editStop: (hostId: string, remote: string) => invoke<void>("edit_stop", { hostId, remote }),

  // docker, services, shell
  dockerAction: (hostId: string, container: string, action: "start" | "stop" | "restart" | "kill" | "remove") =>
    invoke<void>("docker_action", { hostId, container, action }),
  servicesList: (hostId: string) => invoke<Service[]>("services_list", { hostId }),
  shellIntegrationInstall: (hostId: string) => invoke<number>("shell_integration_install", { hostId }),

  // snippets
  snippetsList: () => invoke<Snippet[]>("snippets_list"),
  snippetSave: (snippet: Snippet) => invoke<Snippet>("snippet_save", { snippet }),
  snippetDelete: (id: string) => invoke<void>("snippet_delete", { id }),

  // UI settings (only `ui.*` keys)
  settingGet: <T>(key: string) => invoke<T | null>("setting_get", { key }),
  settingSet: (key: string, value: unknown) => invoke<void>("setting_set", { key, value }),
  debugActiveSubscriptions: () => invoke<[string, string, number][]>("debug_active_subscriptions"),
};
