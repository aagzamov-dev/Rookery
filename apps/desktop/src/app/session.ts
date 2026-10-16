// Session restore (docs/03 §1.5): tabs come back on start WITHOUT connecting.
// A restored server tab shows "Not connected — Connect" until you click it (or connects
// right away if "Connect restored tabs automatically" is on).
import { useEffect } from "react";
import { api } from "../ipc/api";
import { useHosts } from "../stores/hosts";
import { useKeys } from "../stores/keys";
import { useSql } from "../stores/sql";
import { useTabs, type ServerViews, type Tab } from "../stores/tabs";
import { tabForSave } from "../features/sql/url";

const KEY = "ui.session";

interface Saved {
  tabs: Tab[];
  activeTabId: string | null;
  views: Record<string, Pick<ServerViews, "active"> & { terminals: { title: string; cwd?: string }[] }>;
}

let restored = false;

export async function restoreSession() {
  if (restored) return;
  restored = true;
  if (!useKeys.getState().app.restoreTabs || useTabs.getState().tabs.length > 0) return;
  const saved = await api.settingGet<Saved>(KEY).catch(() => null);
  if (!saved?.tabs?.length) return;
  if (!useHosts.getState().loaded) await useHosts.getState().load();
  if (!useSql.getState().connsLoaded) await useSql.getState().loadConns().catch(() => {});
  const hosts = useHosts.getState().hosts;
  const conns = useSql.getState().conns;
  const tabs = saved.tabs
    .filter((t) => t.kind !== "server" || hosts.some((h) => h.id === t.hostId))
    .filter((t) => t.kind !== "db" || t.target.kind === "url" || conns.some((c) => c.id === (t.target as { id: string }).id))
    .map(tabForSave);
  const views: Record<string, ServerViews> = {};
  const deferred: Record<string, boolean> = {};
  const auto = useKeys.getState().app.autoConnectRestored;
  let n = 0;
  for (const t of tabs) {
    // Database tabs come back disconnected too; they connect on first click.
    if (t.kind === "db" && !auto) deferred[t.id] = true;
    if (t.kind !== "server") continue;
    const v = saved.views[t.hostId];
    const terminals = (v?.terminals?.length ? v.terminals : [{ title: "shell 1" }]).map((x) => ({ key: `r${Date.now().toString(36)}${n++}`, title: x.title, cwd: x.cwd }));
    const active = v?.active === "settings" ? "terminal" : (v?.active ?? "terminal");
    views[t.hostId] = { active, opened: [active, "terminal"].filter((x, i, a) => a.indexOf(x) === i) as ServerViews["opened"], terminals, activeTerminal: terminals[0]?.key ?? null, termCounter: terminals.length };
    if (!auto) deferred[t.hostId] = true;
  }
  const activeTabId = tabs.some((t) => t.id === saved.activeTabId) ? saved.activeTabId : (tabs[0]?.id ?? null);
  useTabs.getState().restore({ tabs, activeTabId, views, deferred });
}

/** Save the open tabs (debounced) whenever they change. */
export function useSessionPersistence() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = useTabs.subscribe((s, p) => {
      if (s.tabs === p.tabs && s.activeTabId === p.activeTabId && s.views === p.views) return;
      if (!restored) return; // don't overwrite the saved session before it was restored
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const views: Saved["views"] = {};
        for (const [id, v] of Object.entries(s.views)) {
          views[id] = {
            active: v.active,
            // Container shells are not restored (the container may be gone).
            terminals: v.terminals.filter((t) => !t.container).map((t) => ({ title: t.title, cwd: t.cwd })),
          };
        }
        void api.settingSet(KEY, { tabs: s.tabs.map(tabForSave), activeTabId: s.activeTabId, views } satisfies Saved);
      }, 800);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
