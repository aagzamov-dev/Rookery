import { create } from "zustand";
import { api, asCoreError } from "../ipc/api";
import type { GitStatus } from "../ipc/bindings/GitStatus";

interface GitFolders {
  folders: string[];
  selected: string | null;
  initialized: boolean;
}

export interface GitCache {
  status?: GitStatus;
  at?: number;
  loading: boolean;
  error?: string;
  revision?: number;
  loadedRevision?: number;
  attemptedRevision?: number;
  version?: number;
}

export const GIT_FRESH_MS = 30_000;
export const gitNeedsRefresh = (cached: GitCache | undefined, shown: boolean, now = Date.now()): boolean => {
  if (cached?.loading) return false;
  if (!cached) return true;
  if ((cached.revision ?? 0) !== (cached.loadedRevision ?? 0) && cached.attemptedRevision !== (cached.revision ?? 0)) return true;
  return shown && (!cached.at || now - cached.at >= GIT_FRESH_MS);
};

interface GitState {
  byHost: Record<string, GitFolders>;
  cache: Record<string, GitCache>;
  load: (hostId: string, startFolder: string | null) => Promise<void>;
  initialize: (hostId: string, startFolder: string | null, visible: () => boolean) => Promise<void>;
  select: (hostId: string, folder: string) => void;
  remove: (hostId: string, folder: string) => void;
  refresh: (hostId: string, folder: string) => Promise<void>;
  invalidate: (hostId: string, path?: string) => void;
}

export const gitKey = (hostId: string, folder: string) => JSON.stringify([hostId, folder]);
const settingKey = (hostId: string) => `ui.git.folders.${hostId}`;
const loads = new Map<string, Promise<void>>();
const initializations = new Map<string, Promise<void>>();

function persist(hostId: string, folders: GitFolders) {
  void api.settingSet(settingKey(hostId), folders).catch(() => {});
}

export const useGit = create<GitState>((set, get) => ({
  byHost: {},
  cache: {},
  async load(hostId) {
    if (get().byHost[hostId]) return;
    const pending = loads.get(hostId);
    if (pending) return pending;
    const work = (async () => {
      const saved = await api.settingGet<Partial<GitFolders>>(settingKey(hostId));
      if (get().byHost[hostId]) return;
      const folders = Array.isArray(saved?.folders) ? saved.folders.filter((path): path is string => typeof path === "string" && path.length > 0) : [];
      const value: GitFolders = { folders: [...new Set(folders)], selected: saved?.selected && folders.includes(saved.selected) ? saved.selected : folders[0] ?? null, initialized: saved?.initialized === true };
      set((s) => ({ byHost: { ...s.byHost, [hostId]: value } }));
    })();
    loads.set(hostId, work);
    try { await work; } finally { loads.delete(hostId); }
  },
  async initialize(hostId, startFolder, visible) {
    if (!visible() || get().byHost[hostId]?.initialized) return;
    const pending = initializations.get(hostId);
    if (pending) return pending;
    const work = (async () => {
      const current = get().byHost[hostId];
      if (!current || !visible()) return;
      const marked = { ...current, initialized: true };
      set((s) => ({ byHost: { ...s.byHost, [hostId]: marked } }));
      await api.settingSet(settingKey(hostId), marked);
      if (!visible()) {
        const deferred = { ...get().byHost[hostId], initialized: false };
        set((s) => ({ byHost: { ...s.byHost, [hostId]: deferred } }));
        await api.settingSet(settingKey(hostId), deferred);
        return;
      }
      if (!startFolder?.trim()) return;
      const discovered = await api.gitDiscover(hostId, startFolder.trim());
      const latest = get().byHost[hostId];
      const configured = startFolder.trim();
      const savedFolders = discovered.length ? latest.folders.filter((path) => path !== configured) : latest.folders;
      const value = { ...latest, folders: [...new Set([...savedFolders, ...discovered])], selected: !latest.selected || latest.selected === configured && discovered.length ? discovered[0] ?? null : latest.selected };
      set((s) => ({ byHost: { ...s.byHost, [hostId]: value } }));
      await api.settingSet(settingKey(hostId), value);
    })();
    initializations.set(hostId, work);
    try { await work; } finally { initializations.delete(hostId); }
  },
  select(hostId, folder) {
    const current = get().byHost[hostId] ?? { folders: [], selected: null, initialized: true };
    const value = { ...current, folders: current.folders.includes(folder) ? current.folders : [...current.folders, folder], selected: folder, initialized: true };
    set((s) => ({ byHost: { ...s.byHost, [hostId]: value } }));
    persist(hostId, value);
  },
  remove(hostId, folder) {
    const current = get().byHost[hostId];
    if (!current) return;
    const folders = current.folders.filter((path) => path !== folder);
    const value = { ...current, folders, selected: current.selected === folder ? folders[0] ?? null : current.selected };
    const cache = { ...get().cache };
    delete cache[gitKey(hostId, folder)];
    set((s) => ({ byHost: { ...s.byHost, [hostId]: value }, cache }));
    persist(hostId, value);
  },
  async refresh(hostId, folder) {
    const key = gitKey(hostId, folder);
    if (get().cache[key]?.loading) return;
    const before = get().cache;
    const revision = get().cache[key]?.revision ?? 0;
    set((s) => ({ cache: { ...s.cache, [key]: { ...s.cache[key], loading: true, error: undefined, attemptedRevision: revision } } }));
    try {
      const status = await api.gitStatus(hostId, folder);
      const canonicalKey = gitKey(hostId, status.root);
      set((s) => {
        const latest = s.cache[key];
        const canonical = s.cache[canonicalKey];
        const keepCanonical = canonicalKey !== key && canonical?.status && ((canonical.version ?? 0) !== (before[canonicalKey]?.version ?? 0) || (canonical.revision ?? 0) !== (before[canonicalKey]?.revision ?? 0));
        const mergedRevision = Math.max(latest?.revision ?? revision, canonical?.revision ?? 0);
        const pending = (latest?.revision ?? revision) !== revision;
        const checked = pending ? mergedRevision - 1 : mergedRevision;
        const cache = { ...s.cache, [canonicalKey]: keepCanonical ? canonical : { status, at: Date.now(), loading: false, revision: mergedRevision, loadedRevision: checked, attemptedRevision: checked, version: Math.max(latest?.version ?? 0, canonical?.version ?? 0) + 1 } };
        if (canonicalKey !== key) delete cache[key];
        const config = s.byHost[hostId];
        if (!config || status.root === folder) return { cache };
        const value = { ...config, folders: [...new Set(config.folders.map((path) => path === folder ? status.root : path))], selected: config.selected === folder ? status.root : config.selected };
        persist(hostId, value);
        return { cache, byHost: { ...s.byHost, [hostId]: value } };
      });
    } catch (cause) {
      set((s) => ({ cache: { ...s.cache, [key]: { ...s.cache[key], loading: false, error: asCoreError(cause).message } } }));
    }
  },
  invalidate(hostId, path) {
    const prefix = `[${JSON.stringify(hostId)},`;
    set((state) => {
      const cache = { ...state.cache };
      let changed = false;
      for (const [key, value] of Object.entries(cache)) {
        if (!key.startsWith(prefix)) continue;
        const root = value.status?.root ?? (JSON.parse(key) as [string, string])[1];
        if (path && value.status && path !== root && !path.startsWith(`${root}/`)) continue;
        cache[key] = { ...value, revision: (value.revision ?? 0) + 1 };
        changed = true;
      }
      return changed ? { cache } : state;
    });
  },
}));
