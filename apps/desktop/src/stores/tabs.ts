import { create } from "zustand";

export type View = "overview" | "terminal" | "files" | "docker" | "services" | "logs" | "settings";
export type PageKind = "dashboard" | "snippets" | "hosts" | "tunnels" | "settings";

export type Tab =
  | { id: string; kind: "server"; hostId: string }
  | { id: string; kind: "page"; page: PageKind };

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
  activate: (tabId: string) => void;
  close: (tabId: string) => void;
  setView: (hostId: string, view: View) => void;
  addTerminal: (hostId: string, opts?: { container?: string; cwd?: string }) => void;
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

  openServer: (hostId, startView = "terminal", cwd) => {
    const id = serverTabId(hostId);
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
    set({ tabs: next, views: nextViews, activeTabId: nextActive });
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

  addTerminal: (hostId, opts) =>
    set((s) => {
      const v = s.views[hostId];
      if (!v) return s;
      const termCounter = v.termCounter + 1;
      const slot: TerminalSlot = {
        key: newKey(),
        title: opts?.container ?? `shell ${termCounter}`,
        container: opts?.container,
        cwd: opts?.cwd,
      };
      const opened: View[] = v.opened.includes("terminal") ? v.opened : [...v.opened, "terminal"];
      return {
        views: {
          ...s.views,
          [hostId]: { ...v, active: "terminal", opened, terminals: [...v.terminals, slot], activeTerminal: slot.key, termCounter },
        },
      };
    }),

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
