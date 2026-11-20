import { create } from "zustand";
import type { Container } from "../ipc/bindings/Container";
import type { ContainerStats } from "../ipc/bindings/ContainerStats";
import type { DockerImage } from "../ipc/bindings/DockerImage";
import type { ImageExportJob } from "../ipc/bindings/ImageExportJob";
import type { ImageImportJob } from "../ipc/bindings/ImageImportJob";
import type { LogExportJob } from "../ipc/bindings/LogExportJob";
import type { SudoState } from "../ipc/bindings/SudoState";
import { api, asCoreError } from "../ipc/api";

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

export interface HostImages {
  images: DockerImage[];
  error: string | null;
  /** ms epoch of the last list from the server; null = never loaded */
  at: number | null;
  loading: boolean;
}

interface ImagesState {
  byHost: Record<string, HostImages>;
  /** Read the images (on first open, after delete / prune, on refresh). The newest request wins. */
  load: (hostId: string) => Promise<void>;
  forget: (hostId: string) => void;
}

const imageRequests: Record<string, number> = {};

/** Docker images per server: loaded when the Images tab is first opened, not kept live. */
export const useDockerImages = create<ImagesState>((set, get) => ({
  byHost: {},
  load: async (hostId) => {
    const seq = (imageRequests[hostId] ?? 0) + 1;
    imageRequests[hostId] = seq;
    const prev = get().byHost[hostId] ?? { images: [], error: null, at: null, loading: false };
    set((s) => ({ byHost: { ...s.byHost, [hostId]: { ...prev, loading: true } } }));
    let next: HostImages;
    try {
      next = { images: await api.dockerImages(hostId), error: null, at: Date.now(), loading: false };
    } catch (e) {
      // Keep the last good list when a refresh fails.
      next = { ...prev, error: asCoreError(e).message, at: Date.now(), loading: false };
    }
    if (imageRequests[hostId] === seq) set((s) => ({ byHost: { ...s.byHost, [hostId]: next } }));
  },
  forget: (hostId) =>
    set((s) => {
      const byHost = { ...s.byHost };
      delete byHost[hostId];
      return { byHost };
    }),
}));

interface ImageExportsState {
  jobs: Record<string, ImageExportJob>;
  received: (job: ImageExportJob) => void;
  dismiss: (id: string) => void;
}

/** "Download images" jobs, from `image_export` events. */
export const useImageExports = create<ImageExportsState>((set) => ({
  jobs: {},
  received: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
  dismiss: (id) =>
    set((s) => {
      const jobs = { ...s.jobs };
      delete jobs[id];
      return { jobs };
    }),
}));

interface ImageImportsState {
  jobs: Record<string, ImageImportJob>;
  /** Per server: what the last finished import loaded, so the list shows it first. */
  recent: Record<string, string[]>;
  received: (job: ImageImportJob) => void;
  dismiss: (id: string) => void;
}

/** An image import is running on some server (an update restart would cut it off). */
export const anyImageImportRunning = (jobs: Record<string, ImageImportJob>): boolean => Object.values(jobs).some((j) => j.state === "running");

/** "Import images" jobs, from `image_import` events. */
export const useImageImports = create<ImageImportsState>((set, get) => ({
  jobs: {},
  recent: {},
  received: (job) => {
    const first = get().jobs[job.id]?.state !== job.state && job.state !== "running";
    set((s) => ({
      jobs: { ...s.jobs, [job.id]: job },
      recent: first && job.loaded.length > 0 ? { ...s.recent, [job.host_id]: job.loaded } : s.recent,
    }));
    // The images list is read again once, when the job ends: imported images show up (a cancelled
    // or failed load may also have added some). A list that was never opened loads on first open.
    if (first && useDockerImages.getState().byHost[job.host_id]) void useDockerImages.getState().load(job.host_id);
  },
  dismiss: (id) =>
    set((s) => {
      const jobs = { ...s.jobs };
      const host = jobs[id]?.host_id;
      delete jobs[id];
      const recent = { ...s.recent };
      if (host && !Object.values(jobs).some((j) => j.host_id === host && j.loaded.length > 0)) delete recent[host];
      return { jobs, recent };
    }),
}));
