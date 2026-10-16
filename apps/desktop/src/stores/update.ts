// Self-update (06-AUTO-UPDATE.md): read latest.json from GitHub Releases, verify the
// signature (done by the plugin with the public key in tauri.conf.json), install, restart.
import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api } from "../ipc/api";
import { useFiles } from "./files";
import { useTabs } from "./tabs";

export const RELEASES_URL = "https://github.com/aagzamov-dev/server-managment/releases";
const PREFS_KEY = "ui.update";
const DAY = 24 * 60 * 60 * 1000;

interface UpdatePrefs {
  /** Check once a day when the app starts. */
  auto: boolean;
  /** "Skip this version". */
  skipped: string | null;
  lastCheck: number;
  /** Version that last ran — shows "Updated to x" once after an update. */
  lastVersion: string | null;
}
const DEFAULT_PREFS: UpdatePrefs = { auto: true, skipped: null, lastCheck: 0, lastVersion: null };

type Phase = "idle" | "checking" | "none" | "available" | "downloading" | "installing" | "error";

interface UpdateStore {
  current: string;
  prefs: UpdatePrefs;
  phase: Phase;
  available: { version: string; notes: string; date: string | null } | null;
  progress: { done: number; total: number | null } | null;
  error: string | null;
  /** Banner hidden for this session ("Later"). */
  dismissed: boolean;
  /** Shown once after an update. */
  justUpdated: string | null;
  init: () => Promise<void>;
  checkNow: (manual?: boolean) => Promise<void>;
  install: () => Promise<void>;
  later: () => void;
  skip: () => Promise<void>;
  setAuto: (on: boolean) => Promise<void>;
  clearJustUpdated: () => void;
}

let pending: Update | null = null;

const savePrefs = (p: UpdatePrefs) => api.settingSet(PREFS_KEY, p).catch(() => {});

export const useUpdate = create<UpdateStore>((set, get) => ({
  current: "",
  prefs: DEFAULT_PREFS,
  phase: "idle",
  available: null,
  progress: null,
  error: null,
  dismissed: false,
  justUpdated: null,

  init: async () => {
    const [current, stored] = await Promise.all([getVersion(), api.settingGet<UpdatePrefs>(PREFS_KEY).catch(() => null)]);
    const prefs = { ...DEFAULT_PREFS, ...(stored ?? {}) };
    const justUpdated = prefs.lastVersion && prefs.lastVersion !== current ? current : null;
    prefs.lastVersion = current;
    set({ current, prefs, justUpdated });
    void savePrefs(prefs);
    // The only request Rookery makes on its own; off with one switch.
    if (prefs.auto && Date.now() - prefs.lastCheck > DAY) void get().checkNow(false);
  },

  checkNow: async (manual = true) => {
    if (get().phase === "checking" || get().phase === "downloading") return;
    set({ phase: "checking", error: null });
    try {
      const u = await check({ timeout: 15_000 });
      const prefs = { ...get().prefs, lastCheck: Date.now() };
      set({ prefs });
      void savePrefs(prefs);
      if (!u) {
        pending = null;
        set({ phase: "none", available: null });
        return;
      }
      pending = u;
      const skipped = !manual && prefs.skipped === u.version;
      set({
        phase: "available",
        available: { version: u.version, notes: u.body ?? "", date: u.date ?? null },
        dismissed: skipped,
      });
    } catch (e) {
      // Offline or no release yet: quiet on automatic checks.
      set({ phase: manual ? "error" : "idle", error: manual ? String(e) : null });
    }
  },

  install: async () => {
    if (!pending) return;
    set({ phase: "downloading", progress: { done: 0, total: null }, error: null });
    try {
      await pending.downloadAndInstall((ev) => {
        if (ev.event === "Started") set({ progress: { done: 0, total: ev.data.contentLength ?? null } });
        else if (ev.event === "Progress") set((s) => ({ progress: { done: (s.progress?.done ?? 0) + ev.data.chunkLength, total: s.progress?.total ?? null } }));
        else if (ev.event === "Finished") set({ phase: "installing" });
      });
      // Windows: the installer closes the app and starts the new one. macOS: restart here.
      await relaunch();
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  },

  later: () => set({ dismissed: true }),

  skip: async () => {
    const v = get().available?.version ?? null;
    const prefs = { ...get().prefs, skipped: v };
    set({ prefs, dismissed: true });
    await savePrefs(prefs);
  },

  setAuto: async (on) => {
    const prefs = { ...get().prefs, auto: on };
    set({ prefs });
    await savePrefs(prefs);
  },

  clearJustUpdated: () => set({ justUpdated: null }),
}));

/** Work that an update would close: terminals and running transfers. */
export function openWork(): { terminals: number; transfers: number } {
  const t = useTabs.getState();
  const terminals = t.tabs.reduce((n, x) => n + (x.kind === "server" ? (t.views[x.hostId]?.terminals.length ?? 0) : x.kind === "local" ? 1 : 0), 0);
  const transfers = Object.values(useFiles.getState().transfers).filter((x) => x.state === "running").length;
  return { terminals, transfers };
}
