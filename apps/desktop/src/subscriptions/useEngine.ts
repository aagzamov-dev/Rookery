import { useEffect } from "react";
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
    const run = () => {
      const t = useTabs.getState();
      const sessions = useSessions.getState().byHost;
      const sessionStates: Record<string, SessionState | undefined> = {};
      for (const [id, info] of Object.entries(sessions)) sessionStates[id] = info.state;
      const dockerSelected: Record<string, string | null> = {};
      for (const [id, d] of Object.entries(useDocker.getState().byHost)) dockerSelected[id] = d.selected;
      r.apply(
        desiredSubscriptions({
          tabs: t.tabs,
          activeTabId: t.activeTabId,
          views: t.views,
          sessionStates,
          windowActive: useUi.getState().windowActive,
          unlocked: !!useVault.getState().status?.unlocked,
          dockerSelected,
          fileTarget: useLogs.getState().fileTarget,
        }),
      );
    };
    run();
    const offs = [
      useTabs.subscribe(run),
      useSessions.subscribe(run),
      useUi.subscribe(run),
      useVault.subscribe(run),
      // Only the selection matters here; ignore stats/list updates.
      useDocker.subscribe((s, p) => {
        if (Object.keys(s.byHost).some((h) => s.byHost[h]?.selected !== p.byHost[h]?.selected)) run();
      }),
      useLogs.subscribe((s, p) => {
        if (s.fileTarget !== p.fileTarget) run();
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      r.apply(new Set());
    };
  }, []);
}
