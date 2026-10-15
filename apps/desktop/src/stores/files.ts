// SFTP browsing state per server tab. Listings are cached; re-showing within FRESH_MS never re-lists.
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

const empty = (): HostFiles => ({
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
  state: "open" | "uploaded" | "conflict" | "error";
  message: string | null;
  at: number;
}

interface FilesState {
  byHost: Record<string, HostFiles>;
  transfers: Record<string, Transfer>;
  edits: Record<string, EditState>;
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

  patch: (hostId, p) => set((s) => ({ byHost: { ...s.byHost, [hostId]: { ...(s.byHost[hostId] ?? empty()), ...p } } })),

  open: async (hostId, path, force = false) => {
    const st = get().byHost[hostId] ?? empty();
    let target = path ?? st.path;
    try {
      if (!target) {
        const home = st.home ?? (await api.sftpHome(hostId));
        get().patch(hostId, { home });
        target = home;
      }
      const cached = st.listings[target];
      get().patch(hostId, { path: target, error: null });
      if (cached && !force && Date.now() - cached.at < FRESH_MS) return;
      get().patch(hostId, { loading: true });
      const entries = await api.sftpList(hostId, target);
      const cur = get().byHost[hostId] ?? empty();
      get().patch(hostId, { loading: false, listings: { ...cur.listings, [target]: { entries, at: Date.now() } } });
    } catch (e) {
      get().patch(hostId, { loading: false, error: asCoreError(e).message });
    }
  },

  refresh: async (hostId) => get().open(hostId, get().byHost[hostId]?.path ?? null, true),

  setTerminalCwd: (hostId, cwd) => {
    const st = get().byHost[hostId] ?? empty();
    if (st.terminalCwd === cwd) return;
    get().patch(hostId, { terminalCwd: cwd });
    // Follow only if the files UI has been opened (never triggers SFTP on its own).
    if (st.follow && st.path !== null && st.path !== cwd) void get().open(hostId, cwd);
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
      const byHost = { ...s.byHost };
      delete byHost[hostId];
      return {
        byHost,
        edits: Object.fromEntries(Object.entries(s.edits).filter(([, e]) => e.hostId !== hostId)),
      };
    }),
}));

export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
}

export function parentPath(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}
