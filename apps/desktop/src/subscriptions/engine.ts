// Visibility → subscriptions (docs/01-ARCHITECTURE.md §5.3).
//
// `desiredSubscriptions` is a pure function of UI state; the reconciler diffs it
// against what is running and calls subscribe/unsubscribe. Hidden things are
// unsubscribed but their data stays in the stores (and re-shows instantly).
import { api } from "../ipc/api";
import type { Container } from "../ipc/bindings/Container";
import type { MetricsSample } from "../ipc/bindings/MetricsSample";
import type { SessionState } from "../ipc/bindings/SessionState";
import type { SubParams } from "../ipc/bindings/SubParams";
import { useDocker } from "../stores/docker";
import { useLogs, streamKey } from "../stores/logs";
import { useMetrics } from "../stores/metrics";
import type { ServerViews, Tab } from "../stores/tabs";

export type Source = "metrics" | "docker" | "docker.stats" | "docker.logs" | "file.tail";

export const key = (hostId: string, source: Source, param = "") => `${hostId}|${source}|${param}`;

export function parseKey(k: string): { hostId: string; source: Source; param: string } {
  const a = k.indexOf("|");
  const b = k.indexOf("|", a + 1);
  return { hostId: k.slice(0, a), source: k.slice(a + 1, b) as Source, param: k.slice(b + 1) };
}

export interface EngineInput {
  tabs: Tab[];
  activeTabId: string | null;
  views: Record<string, ServerViews>;
  sessionStates: Record<string, SessionState | undefined>;
  windowActive: boolean;
  unlocked: boolean;
  /** Container whose logs panel is open, per host. */
  dockerSelected: Record<string, string | null>;
  /** Log file followed in the Logs view, per host. */
  fileTarget: Record<string, string | null>;
}

/** What should be running right now. Nothing for hidden tabs or views, a hidden window, or a locked app. */
export function desiredSubscriptions(s: EngineInput): Set<string> {
  const out = new Set<string>();
  if (!s.unlocked || !s.windowActive) return out;
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (!tab || tab.kind !== "server") return out;
  const h = tab.hostId;
  if (s.sessionStates[h] !== "connected") return out;

  // Stats bar (and Overview charts) for the ACTIVE server tab only.
  out.add(key(h, "metrics"));

  const view = s.views[h]?.active;
  if (view === "docker") {
    out.add(key(h, "docker"));
    out.add(key(h, "docker.stats"));
    const sel = s.dockerSelected[h];
    if (sel) out.add(key(h, "docker.logs", sel));
  }
  if (view === "logs" && s.fileTarget[h]) out.add(key(h, "file.tail", s.fileTarget[h]!));
  return out;
}

type Slot = { state: "pending" } | { state: "live"; subId: string };

export interface ReconcilerHooks {
  paramsFor: (hostId: string, source: Source, param: string) => Partial<SubParams> | undefined;
  onCached: (hostId: string, source: Source, cached: unknown) => void;
  onError: (hostId: string, source: Source, param: string, message: string) => void;
}

export const defaultHooks: ReconcilerHooks = {
  paramsFor: (hostId, source, param) => {
    if (source === "docker.logs") {
      const lastTs = useLogs.getState().streams[streamKey(hostId, `docker:${param}`)]?.lastTs ?? null;
      return { container: param, since: lastTs };
    }
    if (source === "file.tail") return { path: param };
    return undefined;
  },
  onCached: (hostId, source, cached) => {
    if (!cached) return;
    if (source === "metrics") useMetrics.getState().setCached(hostId, cached as MetricsSample);
    if (source === "docker" && !useDocker.getState().byHost[hostId]?.at) useDocker.getState().setList(hostId, cached as Container[], null);
  },
  onError: (hostId, source, param, message) => {
    if (source === "docker.logs") useLogs.getState().end(hostId, `docker:${param}`, message);
    else if (source === "file.tail") useLogs.getState().end(hostId, `file:${param}`, message);
    else if (source === "docker") useDocker.getState().setList(hostId, [], message);
    else useMetrics.getState().setError(hostId, message);
  },
};

export class Reconciler {
  private current = new Map<string, Slot>();
  private wanted = new Set<string>();

  constructor(
    private readonly sub: typeof api.subscribe = api.subscribe,
    private readonly unsub: typeof api.unsubscribe = api.unsubscribe,
    private readonly hooks: ReconcilerHooks = defaultHooks,
  ) {}

  apply(desired: Set<string>) {
    this.wanted = new Set(desired);

    for (const k of desired) {
      if (this.current.has(k)) continue;
      this.current.set(k, { state: "pending" });
      const { hostId, source, param } = parseKey(k);
      this.sub(hostId, source, this.hooks.paramsFor(hostId, source, param))
        .then((r) => {
          if (!this.wanted.has(k)) {
            // Became hidden while we were subscribing.
            this.current.delete(k);
            void this.unsub(r.sub_id);
            return;
          }
          this.current.set(k, { state: "live", subId: r.sub_id });
          this.hooks.onCached(hostId, source, r.cached);
        })
        .catch((e) => {
          this.current.delete(k);
          this.hooks.onError(hostId, source, param, String((e as { message?: string })?.message ?? e));
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
