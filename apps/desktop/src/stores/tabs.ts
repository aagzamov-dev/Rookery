import { create } from "zustand";

export type View = "overview" | "terminal" | "files" | "docker" | "database" | "services" | "processes" | "logs" | "settings";
export type PageKind = "dashboard" | "snippets" | "hosts" | "tunnels" | "settings" | "shortcuts" | "backup";

/** What a database tab opens. Never holds a password (URL passwords stay in memory, see DbTab). */
export type DbTarget = { kind: "saved"; id: string } | { kind: "url"; url: string };

export type Tab =
  | { id: string; kind: "server"; hostId: string }
  | { id: string; kind: "page"; page: PageKind }
  | { id: string; kind: "local"; shellId: string; title: string }
  | { id: string; kind: "db"; target: DbTarget; title: string };

export interface TerminalSlot {
  key: string;
  title: string;
  container?: string;
  cwd?: string;
}

/** Per-server tab state. Views listed in `opened` stay mounted (hidden) after first open. */
export interface ServerViews {
  active: View;
  opened: View[];
  terminals: TerminalSlot[];
  activeTerminal: string | null;
  termCounter: number;
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  views: Record<string, ServerViews>;
  openServer: (hostId: string, startView?: View, cwd?: string | null) => void;
  openPage: (page: PageKind) => void;
  openLocal: (shellId: string, title: string) => string;
  /** Open a database tab; an open tab of the same saved connection is reused unless `newTab`. Returns the tab id. */
  openDb: (target: DbTarget, title: string, newTab?: boolean) => string;
  /** Restored server tabs wait for a click before connecting. */
  deferred: Record<string, boolean>;
  setDeferred: (hostId: string, v: boolean) => void;
  /** Replace everything (session restore). */
  restore: (s: { tabs: Tab[]; activeTabId: string | null; views: Record<string, ServerViews>; deferred: Record<string, boolean> }) => void;
  activate: (tabId: string) => void;
  close: (tabId: string) => void;
  /** Recently closed tabs (newest last) for "Reopen closed tab". */
  closed: Tab[];
  popClosed: () => Tab | undefined;
  move: (tabId: string, dir: -1 | 1) => void;
  setView: (hostId: string, view: View) => void;
  /** Returns the new terminal's key (null if the host has no open tab). */
  addTerminal: (hostId: string, opts?: { container?: string; cwd?: string; title?: string }) => string | null;
  closeTerminal: (hostId: string, key: string) => void;
  setActiveTerminal: (hostId: string, key: string) => void;
}

export const serverTabId = (hostId: string) => `server:${hostId}`;
export const pageTabId = (page: PageKind) => `page:${page}`;

let seq = 0;
const newKey = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  views: {},
  deferred: {},
  closed: [],

  popClosed: () => {
    const closed = get().closed.slice();
    const t = closed.pop();
    set({ closed });
    return t;
  },

  move: (tabId, dir) =>
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === tabId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.tabs.length) return s;
      const tabs = s.tabs.slice();
      [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
      return { tabs };
    }),

  setDeferred: (hostId, v) =>
    set((s) => {
      const deferred = { ...s.deferred };
      if (v) deferred[hostId] = true;
      else delete deferred[hostId];
      return { deferred };
    }),

  restore: ({ tabs, activeTabId, views, deferred }) => set({ tabs, activeTabId, views, deferred }),

  openLocal: (shellId, title) => {
    const id = `local:${newKey()}`;
    set((s) => ({ tabs: [...s.tabs, { id, kind: "local", shellId, title }], activeTabId: id }));
    return id;
  },

  openDb: (target, title, newTab = false) => {
    if (target.kind === "saved" && !newTab) {
      const existing = get().tabs.find((t) => t.kind === "db" && t.target.kind === "saved" && t.target.id === target.id);
      if (existing) {
        if (get().deferred[existing.id]) get().setDeferred(existing.id, false);
        set({ activeTabId: existing.id });
        return existing.id;
      }
    }
    const id = `db:${newKey()}`;
    set((s) => ({ tabs: [...s.tabs, { id, kind: "db", target, title }], activeTabId: id }));
    return id;
  },

  openServer: (hostId, startView = "terminal", cwd) => {
    const id = serverTabId(hostId);
    // Opening a server on purpose always connects (clears a restored tab's wait).
    if (get().deferred[hostId]) get().setDeferred(hostId, false);
    if (get().tabs.some((t) => t.id === id)) {
      set({ activeTabId: id });
      return;
    }
    const terminals: TerminalSlot[] =
      startView === "terminal" ? [{ key: newKey(), title: "shell 1", cwd: cwd ?? undefined }] : [];
    set((s) => ({
      tabs: [...s.tabs, { id, kind: "server", hostId }],
      activeTabId: id,
      views: {
        ...s.views,
        [hostId]: {
          active: startView,
          opened: [startView],
          terminals,
          activeTerminal: terminals[0]?.key ?? null,
          termCounter: terminals.length,
        },
      },
    }));
  },

  openPage: (page) => {
    const id = pageTabId(page);
    if (!get().tabs.some((t) => t.id === id)) {
      set((s) => ({ tabs: [...s.tabs, { id, kind: "page", page }] }));
    }
    set({ activeTabId: id });
  },

  activate: (tabId) => set({ activeTabId: tabId }),

  close: (tabId) => {
    const { tabs, activeTabId, views } = get();
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const tab = tabs[idx];
    const next = tabs.filter((t) => t.id !== tabId);
    const nextViews = { ...views };
    if (tab.kind === "server") delete nextViews[tab.hostId];
    const nextActive =
      activeTabId === tabId ? (next[idx] ?? next[idx - 1] ?? null)?.id ?? null : activeTabId;
    set({ tabs: next, views: nextViews, activeTabId: nextActive, closed: [...get().closed, tab].slice(-10) });
  },

  setView: (hostId, view) =>
    set((s) => {
      const v = s.views[hostId];
      if (!v) return s;
      const opened = v.opened.includes(view) ? v.opened : [...v.opened, view];
      let { terminals, activeTerminal, termCounter } = v;
      if (view === "terminal" && terminals.length === 0) {
        termCounter += 1;
        const slot = { key: newKey(), title: `shell ${termCounter}` };
        terminals = [slot];
        activeTerminal = slot.key;
      }
      return { views: { ...s.views, [hostId]: { ...v, active: view, opened, terminals, activeTerminal, termCounter } } };
    }),

  addTerminal: (hostId, opts) => {
    const v = get().views[hostId];
    if (!v) return null;
    const termCounter = v.termCounter + 1;
    const slot: TerminalSlot = {
      key: newKey(),
      title: opts?.title ?? opts?.container ?? `shell ${termCounter}`,
      container: opts?.container,
      cwd: opts?.cwd,
    };
    const opened: View[] = v.opened.includes("terminal") ? v.opened : [...v.opened, "terminal"];
    set((s) => ({
      views: {
        ...s.views,
        [hostId]: { ...v, active: "terminal", opened, terminals: [...v.terminals, slot], activeTerminal: slot.key, termCounter },
      },
    }));
    return slot.key;
  },

  closeTerminal: (hostId, key) =>
    set((s) => {
      const v = s.views[hostId];
      if (!v) return s;
      const terminals = v.terminals.filter((t) => t.key !== key);
      const activeTerminal = v.activeTerminal === key ? terminals[terminals.length - 1]?.key ?? null : v.activeTerminal;
      return { views: { ...s.views, [hostId]: { ...v, terminals, activeTerminal } } };
    }),

  setActiveTerminal: (hostId, key) =>
    set((s) => {
      const v = s.views[hostId];
      if (!v) return s;
      return { views: { ...s.views, [hostId]: { ...v, activeTerminal: key } } };
    }),
}));
