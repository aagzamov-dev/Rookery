// Open SQL editors by key, so shortcuts (Mod+Enter, Mod+., …) reach the right one.
// Keys: `host:<hostId>` for a server tab's Database view, the tab id for database tabs.
import { useTabs } from "../../stores/tabs";

export interface SqlHandle {
  run: (mode: "current" | "all") => void;
  cancel: () => void;
  toggleTree: () => void;
}

const handles = new Map<string, SqlHandle>();

export const sqlKeyForHost = (hostId: string) => `host:${hostId}`;

export const sqlRegistry = {
  register(key: string, h: SqlHandle): () => void {
    handles.set(key, h);
    return () => {
      if (handles.get(key) === h) handles.delete(key);
    };
  },

  get: (key: string) => handles.get(key),

  /** The SQL editor a shortcut applies to: the focused one, else the visible one. */
  activeKey(): string | null {
    const el = document.activeElement?.closest?.("[data-sql-key]");
    const focused = el?.getAttribute("data-sql-key");
    if (focused && handles.has(focused)) return focused;
    const { tabs, activeTabId, views } = useTabs.getState();
    const t = tabs.find((x) => x.id === activeTabId);
    if (!t) return null;
    let key: string | null = null;
    if (t.kind === "server" && views[t.hostId]?.active === "database") key = sqlKeyForHost(t.hostId);
    else if ((t as { kind: string }).kind === "db") key = t.id;
    return key && handles.has(key) ? key : null;
  },
};
