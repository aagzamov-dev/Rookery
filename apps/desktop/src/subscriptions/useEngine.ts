import { api } from "../ipc/api";
import { useEffect } from "react";
import { useKeys } from "../stores/keys";
import { useDocker } from "../stores/docker";
import { useLogs } from "../stores/logs";
import { useSessions } from "../stores/sessions";
import { useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";
import { useVault } from "../stores/vault";
import { desiredSubscriptions, Reconciler } from "./engine";
import type { SessionState } from "../ipc/bindings/SessionState";

/** Keeps running collectors in sync with what is visible. Mount once in the shell. */
export function useSubscriptionEngine() {
  useEffect(() => {
    const r = new Reconciler();
    let syncHost: string | null | undefined;
    const run = () => {
      const t = useTabs.getState();
      const sessions = useSessions.getState().byHost;
      const sessionStates: Record<string, SessionState | undefined> = {};
      for (const [id, info] of Object.entries(sessions)) sessionStates[id] = info.state;
      const activeTab = t.tabs.find((tab) => tab.id === t.activeTabId);
      const host = useUi.getState().windowActive && useVault.getState().status?.unlocked && activeTab?.kind === "server" && sessionStates[activeTab.hostId] === "connected" && t.views[activeTab.hostId]?.active === "overview" && useKeys.getState().loaded && useKeys.getState().app.metricsIntervalMs > 0 ? activeTab.hostId : null;
      if (syncHost !== host) {
        syncHost = host;
        void api.syncWindowVisible(host !== null, host).catch(() => {});
      }
      const dockerSelected: Record<string, string | null> = {};
      for (const [id, d] of Object.entries(useDocker.getState().byHost)) dockerSelected[id] = d.selected;
      r.apply(
        desiredSubscriptions({
          tabs: t.tabs,
          activeTabId: t.activeTabId,
          views: t.views,
          sessionStates,
          windowActive: useUi.getState().windowActive,
          unlocked: !!useVault.getState().status?.unlocked && useKeys.getState().loaded,
          metricsIntervalMs: useKeys.getState().app.metricsIntervalMs,
          computerEnabled: useKeys.getState().app.showThisComputer,
          computerDeferred: !!t.deferred["__computer__"],
          dockerBlocked: Object.fromEntries(Object.entries(useDocker.getState().byHost).map(([id, d]) => [id, !!d.error])),
          dockerReady: Object.fromEntries(Object.entries(useDocker.getState().byHost).map(([id, d]) => [id, d.at !== null && !d.error])),
          dockerSelected,
          fileTarget: useLogs.getState().fileTarget,
          pausedLogs: useLogs.getState().paused,
        }),
      );
    };
    run();
    const offs = [
      useTabs.subscribe(run),
      useKeys.subscribe((s, p) => { if (s.loaded !== p.loaded || s.app.metricsIntervalMs !== p.app.metricsIntervalMs || s.app.showThisComputer !== p.app.showThisComputer) run(); }),
      useSessions.subscribe(run),
      useUi.subscribe(run),
      useVault.subscribe(run),
      // Only the selection matters here; ignore stats/list updates.
      useDocker.subscribe((s, p) => {
        if ([...new Set([...Object.keys(s.byHost), ...Object.keys(p.byHost)])].some((h) => s.byHost[h]?.selected !== p.byHost[h]?.selected || s.byHost[h]?.error !== p.byHost[h]?.error || s.byHost[h]?.at !== p.byHost[h]?.at)) run();
      }),
      useLogs.subscribe((s, p) => {
        if (s.fileTarget !== p.fileTarget || s.paused !== p.paused) run();
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      r.apply(new Set());
    };
  }, []);
}
