// SFTP browsing state per server tab. Listings are cached; re-showing within FRESH_MS never re-lists.
import { normalizeLocalPath } from "../features/local/target";
import { create } from "zustand";
import { api, asCoreError } from "../ipc/api";
import type { FileEntry } from "../ipc/bindings/FileEntry";
import type { Transfer } from "../ipc/bindings/Transfer";

export const FRESH_MS = 60_000;

interface Listing {
  entries: FileEntry[];
  at: number;
}

export interface HostFiles {
  visible: boolean;
  visibleViews: Partial<Record<"panel" | "full", boolean>>;
  path: string | null;
  home: string | null;
  listings: Record<string, Listing>;
  loading: boolean;
  error: string | null;
  showHidden: boolean;
  /** Side panel next to the terminal is open. */
  panelOpen: boolean;
  /** Panel follows the terminal's folder (needs shell integration / OSC 7). */
  follow: boolean;
  /** Last folder reported by any terminal of this server (OSC 7). */
  terminalCwd: string | null;
}

const requests = new Map<string, number>();

const empty = (): HostFiles => ({
  visible: false,
  visibleViews: {},
  path: null,
  home: null,
  listings: {},
  loading: false,
  error: null,
  showHidden: false,
  panelOpen: false,
  follow: true,
  terminalCwd: null,
});

export interface EditState {
  hostId: string;
  remote: string;
  local: string;
  state: "open" | "pending" | "uploaded" | "conflict" | "error";
  message: string | null;
  at: number;
}

interface FilesState {
  byHost: Record<string, HostFiles>;
  transfers: Record<string, Transfer>;
  edits: Record<string, EditState>;
  setVisible: (hostId: string, variant: "panel" | "full", visible: boolean) => void;
  patch: (hostId: string, p: Partial<HostFiles>) => void;
  /** Open `path` (or home). Uses the cache unless `force` or stale. */
  open: (hostId: string, path?: string | null, force?: boolean) => Promise<void>;
  refresh: (hostId: string) => Promise<void>;
  setTerminalCwd: (hostId: string, cwd: string) => void;
  setTransfer: (t: Transfer) => void;
  dismissTransfer: (id: string) => void;
  setEdit: (e: EditState) => void;
  dismissEdit: (key: string) => void;
  forget: (hostId: string) => void;
}

export const editKey = (hostId: string, remote: string) => `${hostId}|${remote}`;

export const useFiles = create<FilesState>((set, get) => ({
  byHost: {},
  transfers: {},
  edits: {},

  setVisible: (hostId, variant, visible) => {
    const visibleViews = { ...get().byHost[hostId]?.visibleViews, [variant]: visible };
    get().patch(hostId, { visibleViews, visible: Object.values(visibleViews).some(Boolean) });
  },

  patch: (hostId, p) => set((s) => ({ byHost: { ...s.byHost, [hostId]: { ...(s.byHost[hostId] ?? empty()), ...p } } })),

  open: async (hostId, path, force = false) => {
    const request = (requests.get(hostId) ?? 0) + 1;
    requests.set(hostId, request);
    const st = get().byHost[hostId] ?? empty();
    let target = path ?? st.path;
    try {
      if (!target) {
        const home = st.home ?? (await api.sftpHome(hostId));
        if (requests.get(hostId) !== request || (st.visible && !get().byHost[hostId]?.visible)) return;
        get().patch(hostId, { home });
        target = home;
      }
      const cached = st.listings[target];
      get().patch(hostId, { path: target, error: null, loading: false });
      if (cached && !force && Date.now() - cached.at < FRESH_MS) return;
      get().patch(hostId, { loading: true });
      const entries = await api.sftpList(hostId, target);
      if (requests.get(hostId) !== request) return;
      const cur = get().byHost[hostId] ?? empty();
      get().patch(hostId, { loading: false, listings: Object.fromEntries(Object.entries({ ...cur.listings, [target]: { entries, at: Date.now() } }).sort((a, b) => b[1].at - a[1].at).slice(0, 20)) });
    } catch (e) {
      if (requests.get(hostId) !== request) return;
      get().patch(hostId, { loading: false, error: asCoreError(e).message });
    }
  },

  refresh: async (hostId) => get().open(hostId, get().byHost[hostId]?.path ?? null, true),

  setTerminalCwd: (hostId, cwd) => {
    const st = get().byHost[hostId] ?? empty();
    if (st.terminalCwd === cwd) return;
    get().patch(hostId, { terminalCwd: cwd });
    // Follow only if the files UI has been opened (never triggers SFTP on its own).
    if (st.visible && st.follow && st.path !== null && st.path !== cwd) void get().open(hostId, cwd);
  },

  setTransfer: (t) => set((s) => ({ transfers: { ...s.transfers, [t.id]: t } })),
  dismissTransfer: (id) =>
    set((s) => {
      const transfers = { ...s.transfers };
      delete transfers[id];
      return { transfers };
    }),
  setEdit: (e) => set((s) => ({ edits: { ...s.edits, [editKey(e.hostId, e.remote)]: e } })),
  dismissEdit: (key) =>
    set((s) => {
      const edits = { ...s.edits };
      delete edits[key];
      return { edits };
    }),
  forget: (hostId) =>
    set((s) => {
      requests.set(hostId, (requests.get(hostId) ?? 0) + 1);
      const byHost = { ...s.byHost };
      delete byHost[hostId];
      return {
        byHost,
        edits: Object.fromEntries(Object.entries(s.edits).filter(([, e]) => e.hostId !== hostId)),
      };
    }),
}));

export function pathRoot(path: string): string {
  const normalized = normalizeLocalPath(path);
  if (/^[A-Za-z]:\//.test(normalized)) return normalized.slice(0, 3);
  const unc = /^\/\/[^/]+\/[^/]+(?:\/|$)/.exec(normalized);
  return unc ? `${unc[0].replace(/\/+$/, "")}/` : "/";
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function parentPath(path: string): string {
  const p = normalizeLocalPath(path);
  const root = pathRoot(p);
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i < root.length ? root : t.slice(0, i);
}
