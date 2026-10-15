// Dashboard sync: snapshots mirror (from SQLite), live progress, switches and settings.
// Opening the Dashboard reads the DB only — no network until Sync or auto-sync.
import { create } from "zustand";
import { api } from "../ipc/api";
import type { Collect } from "../ipc/bindings/Collect";
import type { Group } from "../ipc/bindings/Group";
import type { Host } from "../ipc/bindings/Host";
import type { RefreshMode } from "../ipc/bindings/RefreshMode";
import type { RefreshSetting } from "../ipc/bindings/RefreshSetting";
import type { Snapshot } from "../ipc/bindings/Snapshot";
import type { SyncScope } from "../ipc/bindings/SyncScope";
import type { SyncSettings } from "../ipc/bindings/SyncSettings";
import type { SyncState } from "../ipc/bindings/SyncState";
import type { SyncSummary } from "../ipc/bindings/SyncSummary";
import { useHosts } from "./hosts";

export const UNGROUPED = "ungrouped";
/** Dashboard tab: "all", a top-level group id, or "ungrouped". */
export type DashTab = string;

export interface AttentionThresholds {
  cpu: number;
  ram: number;
  disk: number;
  /** Failed for longer than this (minutes) counts as offline. */
  offlineMin: number;
}
export const DEFAULT_THRESHOLDS: AttentionThresholds = { cpu: 85, ram: 90, disk: 80, offlineMin: 60 };

export const INTERVALS: { s: number; label: string; short: string }[] = [
  { s: 30, label: "30 sec", short: "30s" },
  { s: 60, label: "1 min", short: "1m" },
  { s: 300, label: "5 min", short: "5m" },
  { s: 900, label: "15 min", short: "15m" },
];
export const intervalShort = (s: number) => INTERVALS.find((i) => i.s === s)?.short ?? (s % 60 === 0 ? `${s / 60}m` : `${s}s`);

interface SyncStore {
  loaded: boolean;
  snapshots: Record<string, Snapshot>;
  /** Live per-host state while a run is in flight (queued / running). */
  live: Record<string, SyncState>;
  /** Runs in flight (any source), for Cancel. */
  jobs: string[];
  lastDone: { summary: SyncSummary; at: number; auto: boolean } | null;
  settings: SyncSettings;
  global: RefreshSetting;
  tab: DashTab;
  thresholds: AttentionThresholds;
  load: () => Promise<void>;
  run: (scope: SyncScope) => Promise<void>;
  cancelAll: () => void;
  setAuto: (groupIds: string[], on: boolean) => Promise<void>;
  setSettings: (patch: Partial<SyncSettings>) => Promise<void>;
  setGlobal: (patch: Partial<RefreshSetting>) => Promise<void>;
  setTab: (tab: DashTab) => void;
  setThresholds: (t: AttentionThresholds) => Promise<void>;
  onProgress: (jobId: string, hostId: string, state: SyncState, snapshot: Snapshot | null) => void;
  onDone: (jobId: string, auto: boolean, summary: SyncSummary) => void;
}

const DEFAULT_SETTINGS: SyncSettings = { paused: false, concurrency: 3, run_when_hidden: false, ungrouped_auto: false };
const DEFAULT_GLOBAL: RefreshSetting = { mode: "auto", interval_s: 300, collect: "basic_docker", desktop: true, mobile: true, wifi_only: true };

export const useSync = create<SyncStore>((set, get) => ({
  loaded: false,
  snapshots: {},
  live: {},
  jobs: [],
  lastDone: null,
  settings: DEFAULT_SETTINGS,
  global: DEFAULT_GLOBAL,
  tab: "all",
  thresholds: DEFAULT_THRESHOLDS,

  load: async () => {
    const [snaps, status, tab, thresholds] = await Promise.all([
      api.snapshotsList(),
      api.syncStatus(),
      api.settingGet<string>("ui.dashboard.tab").catch(() => null),
      api.settingGet<AttentionThresholds>("ui.dashboard.attention").catch(() => null),
    ]);
    const live: Record<string, SyncState> = {};
    for (const id of status.running) live[id] = "running";
    set({
      loaded: true,
      snapshots: Object.fromEntries(snaps.map((s) => [s.host_id, s])),
      live,
      settings: status.settings,
      global: status.global,
      tab: tab ?? "all",
      thresholds: { ...DEFAULT_THRESHOLDS, ...(thresholds ?? {}) },
    });
  },

  run: async (scope) => {
    await api.syncRun(scope);
  },

  cancelAll: () => {
    for (const id of get().jobs) void api.syncCancel(id);
  },

  setAuto: async (groupIds, on) => {
    await api.syncSetAuto(groupIds, on);
    if (groupIds.includes(UNGROUPED)) set((s) => ({ settings: { ...s.settings, ungrouped_auto: on } }));
    await useHosts.getState().load();
  },

  setSettings: async (patch) => {
    const settings = await api.syncSettingsSet({ ...get().settings, ...patch });
    set({ settings });
  },

  setGlobal: async (patch) => {
    const global = await api.refreshGlobalSet({ ...get().global, ...patch });
    set({ global });
  },

  setTab: (tab) => {
    set({ tab });
    void api.settingSet("ui.dashboard.tab", tab).catch(() => {});
  },

  setThresholds: async (t) => {
    set({ thresholds: t });
    await api.settingSet("ui.dashboard.attention", t);
  },

  onProgress: (jobId, hostId, state, snapshot) =>
    set((s) => {
      const live = { ...s.live };
      if (state === "queued" || state === "running") live[hostId] = state;
      else delete live[hostId];
      const snapshots = snapshot ? { ...s.snapshots, [hostId]: snapshot } : s.snapshots;
      const jobs = s.jobs.includes(jobId) ? s.jobs : [...s.jobs, jobId];
      return { live, snapshots, jobs };
    }),

  onDone: (jobId, auto, summary) =>
    set((s) => ({ jobs: s.jobs.filter((j) => j !== jobId), lastDone: { summary, at: Date.now(), auto } })),
}));

// ---------------------------------------------------------------- pure helpers

/** Group id plus all sub-group ids. */
export function subtree(groups: Group[], root: string): Set<string> {
  const out = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const g of groups)
      if (g.parent_id && out.has(g.parent_id) && !out.has(g.id)) {
        out.add(g.id);
        grew = true;
      }
  }
  return out;
}

export function hostsInTab(tab: DashTab, hosts: Host[], groups: Group[]): Host[] {
  if (tab === "all") return hosts;
  const known = new Set(groups.map((g) => g.id));
  if (tab === UNGROUPED) return hosts.filter((h) => !h.group_id || !known.has(h.group_id));
  const tree = subtree(groups, tab);
  return hosts.filter((h) => h.group_id && tree.has(h.group_id));
}

/** Group ids the Auto-sync switch of a tab writes to. */
export function switchTargets(tab: DashTab, groups: Group[], hasUngrouped: boolean): string[] {
  if (tab === "all") return [...groups.map((g) => g.id), ...(hasUngrouped ? [UNGROUPED] : [])];
  if (tab === UNGROUPED) return [UNGROUPED];
  return [...subtree(groups, tab)];
}

export interface Effective {
  mode: Exclude<RefreshMode, "inherit">;
  interval_s: number;
  collect: Collect;
  /** "global" | "group" | "host" — where the mode came from. */
  source: "global" | "group" | "host";
}

/** Mirror of the Rust resolution: host → group → parent groups → global (docs/04 §4.1). */
export function effectiveRefresh(host: Host, groups: Group[], global: RefreshSetting): Effective {
  const chain: { s: RefreshSetting; src: Effective["source"] }[] = [{ s: host.refresh, src: "host" }];
  const byId = new Map(groups.map((g) => [g.id, g]));
  let gid = host.group_id;
  for (let guard = 0; gid && guard < 32; guard++) {
    const g = byId.get(gid);
    if (!g) break;
    chain.push({ s: g.refresh, src: "group" });
    gid = g.parent_id;
  }
  chain.push({ s: global, src: "global" });
  const m = chain.find((c) => c.s.mode !== "inherit");
  return {
    mode: (m?.s.mode ?? "auto") as Effective["mode"],
    interval_s: chain.find((c) => c.s.interval_s != null)?.s.interval_s ?? 300,
    collect: chain.find((c) => c.s.collect != null)?.s.collect ?? "basic_docker",
    source: m?.src ?? "global",
  };
}

/** Is the Auto-sync switch on for this host's group? */
export function switchOn(host: Host, groups: Group[], settings: SyncSettings): boolean {
  const g = host.group_id ? groups.find((x) => x.id === host.group_id) : undefined;
  return g ? g.auto_sync_enabled : settings.ungrouped_auto;
}

export type AttentionKind = "cpu" | "ram" | "disk" | "offline" | "container" | "service" | "locked";
export interface Attention {
  hostId: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  severity: "bad" | "warn";
  /** Server view to open on click. */
  view: "overview" | "docker" | "services";
}

/** Derived from the latest snapshots only (docs/03 §8.4). */
export function needsAttention(hosts: Host[], snapshots: Record<string, Snapshot>, t: AttentionThresholds, now = Date.now()): Attention[] {
  const out: Attention[] = [];
  for (const h of hosts) {
    const s = snapshots[h.id];
    if (!s) continue;
    const add = (a: Omit<Attention, "hostId">) => out.push({ hostId: h.id, ...a });
    if (s.state === "failed") {
      const since = s.last_ok_at ?? null;
      const minutes = since ? Math.round((now - since) / 60000) : null;
      if (since == null || minutes! >= t.offlineMin)
        add({
          kind: "offline",
          severity: "bad",
          view: "overview",
          title: `${h.name} unreachable`,
          detail: since == null ? (s.error ?? "never synced successfully") : `last seen ${ago(since, now)} · ${s.error ?? ""}`.trim(),
        });
    }
    if (s.state === "locked") add({ kind: "locked", severity: "warn", view: "overview", title: `${h.name} locked`, detail: s.error ?? "needs a secret" });
    const m = s.metrics;
    if (m) {
      if (m.cpu_pct != null && m.cpu_pct > t.cpu && s.prev_cpu_pct != null && s.prev_cpu_pct > t.cpu)
        add({ kind: "cpu", severity: "bad", view: "overview", title: `${h.name} CPU ${Math.round(m.cpu_pct)}%`, detail: `above ${t.cpu}% for two syncs` });
      const ram = m.ram_total_bytes ? (100 * m.ram_used_bytes) / m.ram_total_bytes : 0;
      if (ram > t.ram) add({ kind: "ram", severity: "warn", view: "overview", title: `${h.name} memory ${Math.round(ram)}%`, detail: `above ${t.ram}%` });
      if (m.disk_pct > t.disk)
        add({ kind: "disk", severity: m.disk_pct > 95 ? "bad" : "warn", view: "overview", title: `${h.name} disk ${Math.round(m.disk_pct)}%`, detail: `/ is above ${t.disk}%` });
    }
    const d = s.docker;
    if (d && !d.error) {
      for (const c of d.restarting) add({ kind: "container", severity: "bad", view: "docker", title: `${c} restarting`, detail: h.name });
      for (const c of d.unhealthy) add({ kind: "container", severity: "warn", view: "docker", title: `${c} unhealthy`, detail: h.name });
    }
    for (const u of s.failed_services ?? []) add({ kind: "service", severity: "bad", view: "services", title: `${u} failed`, detail: h.name });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "bad" ? -1 : 1));
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Card age: fresh < 15 min, stale < 2 h, old after. */
export function ageClass(ts: number | null, now = Date.now()): "fresh" | "stale" | "old" | "never" {
  if (ts == null) return "never";
  const min = (now - ts) / 60000;
  return min < 15 ? "fresh" : min < 120 ? "stale" : "old";
}
