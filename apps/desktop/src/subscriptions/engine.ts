// Visibility → subscriptions (docs/01-ARCHITECTURE.md §5.3).
//
// `desiredSubscriptions` is a pure function of UI state; the reconciler diffs it
// against what is running and calls subscribe/unsubscribe. Hidden things are
// unsubscribed but their data stays in the stores.
import { api } from "../ipc/api";
import type { SessionState } from "../ipc/bindings/SessionState";
import { useMetrics } from "../stores/metrics";
import type { ServerViews, Tab } from "../stores/tabs";

export type Source = "metrics";
export const key = (hostId: string, source: Source) => `${hostId}|${source}`;
export const parseKey = (k: string) => {
  const i = k.lastIndexOf("|");
  return { hostId: k.slice(0, i), source: k.slice(i + 1) as Source };
};

export interface EngineInput {
  tabs: Tab[];
  activeTabId: string | null;
  views: Record<string, ServerViews>;
  sessionStates: Record<string, SessionState | undefined>;
  windowActive: boolean;
  unlocked: boolean;
}

/** What should be running right now. Nothing for hidden tabs, hidden windows or a locked app. */
export function desiredSubscriptions(s: EngineInput): Set<string> {
  const out = new Set<string>();
  if (!s.unlocked || !s.windowActive) return out;
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (!tab || tab.kind !== "server") return out;
  if (s.sessionStates[tab.hostId] !== "connected") return out;
  // Stats bar (and Overview charts) for the ACTIVE server tab only.
  out.add(key(tab.hostId, "metrics"));
  // v0.3+: per-view sources go here, e.g. docker view visible → docker.list + docker.stats.
  return out;
}

type Slot = { state: "pending" } | { state: "live"; subId: string };

export class Reconciler {
  private current = new Map<string, Slot>();
  private wanted = new Set<string>();

  constructor(
    private readonly sub: typeof api.subscribe = api.subscribe,
    private readonly unsub: typeof api.unsubscribe = api.unsubscribe,
  ) {}

  apply(desired: Set<string>) {
    this.wanted = new Set(desired);

    for (const k of desired) {
      if (this.current.has(k)) continue;
      this.current.set(k, { state: "pending" });
      const { hostId, source } = parseKey(k);
      this.sub(hostId, source)
        .then((r) => {
          if (!this.wanted.has(k)) {
            // Became hidden while we were subscribing.
            this.current.delete(k);
            void this.unsub(r.sub_id);
            return;
          }
          this.current.set(k, { state: "live", subId: r.sub_id });
          if (r.cached) useMetrics.getState().setCached(hostId, r.cached);
        })
        .catch((e) => {
          this.current.delete(k);
          useMetrics.getState().setError(hostId, String((e as { message?: string })?.message ?? e));
        });
    }

    for (const [k, slot] of [...this.current]) {
      if (desired.has(k)) continue;
      if (slot.state === "live") {
        this.current.delete(k);
        void this.unsub(slot.subId);
      }
      // pending: handled when the subscribe resolves (wanted check above)
    }
  }

  snapshot(): string[] {
    return [...this.current.keys()].sort();
  }
}
