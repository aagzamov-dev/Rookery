// Typed wrappers for Tauri commands (crates/rook-tauri/src/commands.rs).
// Tauri converts snake_case Rust argument names to camelCase on the JS side.
import { invoke } from "@tauri-apps/api/core";
import type { EffectiveRefresh } from "./bindings/EffectiveRefresh";
import type { Group } from "./bindings/Group";
import type { Host } from "./bindings/Host";
import type { Identity } from "./bindings/Identity";
import type { MetricsSample } from "./bindings/MetricsSample";
import type { SessionInfo } from "./bindings/SessionInfo";
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

  // sessions
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
  subscribe: (hostId: string, source: string, intervalMs?: number) =>
    invoke<{ sub_id: string; cached: MetricsSample | null }>("subscribe", {
      hostId,
      source,
      intervalMs: intervalMs ?? null,
    }),
  unsubscribe: (subId: string) => invoke<void>("unsubscribe", { subId }),
  debugActiveSubscriptions: () => invoke<[string, string, number][]>("debug_active_subscriptions"),
};
