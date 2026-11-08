// Recently opened files and folders per server, on this device only (paths, never contents).
import { create } from "zustand";

const KEY = "ui.recent.v1";
const FILES_MAX = 30;
const FOLDERS_MAX = 20;

interface Recent {
  files: Record<string, string[]>;
  folders: Record<string, string[]>;
  addFile: (hostId: string, path: string) => void;
  addFolder: (hostId: string, path: string) => void;
  /** After a rename or delete: `to: null` drops the path and everything inside it. */
  move: (hostId: string, from: string, to: string | null) => void;
}

function load(): Pick<Recent, "files" | "folders"> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Recent> | null;
    return { files: v?.files ?? {}, folders: v?.folders ?? {} };
  } catch {
    return { files: {}, folders: {} };
  }
}

function save(v: Pick<Recent, "files" | "folders">) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ files: v.files, folders: v.folders }));
  } catch {
    /* storage full or blocked: recent lists are only a convenience */
  }
}

const front = (list: string[] | undefined, path: string, max: number) => [path, ...(list ?? []).filter((p) => p !== path)].slice(0, max);
const within = (p: string, base: string) => p === base || p.startsWith(`${base.replace(/\/+$/, "")}/`);

export const useRecent = create<Recent>((set, get) => ({
  ...load(),
  addFile: (hostId, path) => {
    if (get().files[hostId]?.[0] === path) return;
    set((s) => ({ files: { ...s.files, [hostId]: front(s.files[hostId], path, FILES_MAX) } }));
    save(get());
  },
  addFolder: (hostId, path) => {
    if (get().folders[hostId]?.[0] === path) return;
    set((s) => ({ folders: { ...s.folders, [hostId]: front(s.folders[hostId], path, FOLDERS_MAX) } }));
    save(get());
  },
  move: (hostId, from, to) => {
    const fix = (list: string[] | undefined) => (list ?? []).flatMap((p) => (!within(p, from) ? [p] : to === null ? [] : [to + p.slice(from.length)]));
    set((s) => ({ files: { ...s.files, [hostId]: fix(s.files[hostId]) }, folders: { ...s.folders, [hostId]: fix(s.folders[hostId]) } }));
    save(get());
  },
}));
