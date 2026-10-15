import { create } from "zustand";
import type { Container } from "../ipc/bindings/Container";
import type { ContainerStats } from "../ipc/bindings/ContainerStats";

export interface HostDocker {
  containers: Container[];
  error: string | null;
  /** ms epoch of the last list from the server; null = never loaded */
  at: number | null;
  stats: Record<string, ContainerStats>;
  /** Container whose logs panel is open. */
  selected: string | null;
}

const empty = (): HostDocker => ({ containers: [], error: null, at: null, stats: {}, selected: null });

interface DockerState {
  byHost: Record<string, HostDocker>;
  setList: (hostId: string, containers: Container[], error: string | null) => void;
  setStats: (hostId: string, stats: ContainerStats[]) => void;
  select: (hostId: string, containerId: string | null) => void;
  forget: (hostId: string) => void;
}

export const useDocker = create<DockerState>((set) => ({
  byHost: {},
  setList: (hostId, containers, error) =>
    set((s) => {
      const prev = s.byHost[hostId] ?? empty();
      // Keep the last good list when the refresh failed (e.g. a timeout).
      const list = error && containers.length === 0 ? prev.containers : containers;
      // Close the logs panel only when its container is really gone.
      const selected = error || list.some((c) => c.id === prev.selected) ? prev.selected : null;
      return { byHost: { ...s.byHost, [hostId]: { ...prev, containers: list, error, at: Date.now(), selected } } };
    }),
  setStats: (hostId, stats) =>
    set((s) => {
      const prev = s.byHost[hostId] ?? empty();
      return { byHost: { ...s.byHost, [hostId]: { ...prev, stats: Object.fromEntries(stats.map((x) => [x.id, x])) } } };
    }),
  select: (hostId, containerId) =>
    set((s) => ({ byHost: { ...s.byHost, [hostId]: { ...(s.byHost[hostId] ?? empty()), selected: containerId } } })),
  forget: (hostId) =>
    set((s) => {
      const byHost = { ...s.byHost };
      delete byHost[hostId];
      return { byHost };
    }),
}));

/** Stats are keyed by full id; `docker stats` may report the short id. */
export function statsFor(d: HostDocker | undefined, c: Container): ContainerStats | undefined {
  if (!d) return undefined;
  return d.stats[c.id] ?? Object.values(d.stats).find((s) => c.id.startsWith(s.id) || s.name === c.name);
}

export function isProblem(c: Container): boolean {
  return c.state === "restarting" || c.state === "dead" || c.health === "unhealthy" || (c.state === "exited" && !/Exited \(0\)/.test(c.status));
}
