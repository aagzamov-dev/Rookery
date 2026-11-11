import { create } from "zustand";
import type { Container } from "../ipc/bindings/Container";
import type { ContainerStats } from "../ipc/bindings/ContainerStats";
import type { LogExportJob } from "../ipc/bindings/LogExportJob";
import type { SudoState } from "../ipc/bindings/SudoState";
import { api } from "../ipc/api";

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
  const all = Object.values(d.stats);
  // Match by id first: a recreated container keeps its name, and a stale entry for the
  // old one must not show its frozen numbers.
  return d.stats[c.id] ?? all.find((s) => c.id.startsWith(s.id)) ?? all.find((s) => s.name === c.name);
}

export function isProblem(c: Container): boolean {
  return c.state === "restarting" || c.state === "dead" || c.health === "unhealthy" || (c.state === "exited" && !/Exited \(0\)/.test(c.status));
}

interface SudoStore {
  /** Auto sudo per server, as last read from the core. */
  byHost: Record<string, SudoState>;
  load: (hostId: string) => Promise<SudoState | null>;
  set: (hostId: string, enabled: boolean, password?: string, save?: boolean) => Promise<SudoState>;
  clear: () => void;
}

/** Auto sudo: Docker runs as `sudo docker` and terminals fill `[sudo]` prompts (per server). */
export const useDockerSudo = create<SudoStore>((set) => ({
  byHost: {},
  load: async (hostId) => {
    try {
      const st = await api.sudoState(hostId);
      set((s) => ({ byHost: { ...s.byHost, [hostId]: st } }));
      return st;
    } catch {
      return null;
    }
  },
  set: async (hostId, enabled, password, save = false) => {
    const st = await api.sudoSet(hostId, enabled, password, save);
    set((s) => ({ byHost: { ...s.byHost, [hostId]: st } }));
    return st;
  },
  clear: () => set({ byHost: {} }),
}));

/** `docker` to type into a terminal: with auto sudo, `sudo docker` with the prompt the terminal fills. */
export async function dockerCli(hostId: string): Promise<string> {
  const st = useDockerSudo.getState().byHost[hostId] ?? (await useDockerSudo.getState().load(hostId));
  return st?.enabled ? "sudo -p '[sudo] password for %u: ' docker" : "docker";
}

interface LogExportsState {
  jobs: Record<string, LogExportJob>;
  received: (job: LogExportJob) => void;
  dismiss: (id: string) => void;
}

/** "Download logs" jobs, from `log_export` events. */
export const useLogExports = create<LogExportsState>((set) => ({
  jobs: {},
  received: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
  dismiss: (id) =>
    set((s) => {
      const jobs = { ...s.jobs };
      delete jobs[id];
      return { jobs };
    }),
}));
