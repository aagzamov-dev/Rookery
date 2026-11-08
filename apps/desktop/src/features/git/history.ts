// Which file's Git history / blame is shown (the dialog itself loads lazily).
import { lazy, Suspense, createElement } from "react";
import { create } from "zustand";
import { api } from "../../ipc/api";

export type HistoryTab = "history" | "blame";
export interface HistoryTarget {
  hostId: string;
  /** Repository root. */
  root: string;
  /** File path relative to the root. */
  path: string;
  tab: HistoryTab;
}

export const useGitHistory = create<{ target: HistoryTarget | null; show: (t: HistoryTarget) => void; close: () => void }>((set) => ({
  target: null,
  show: (target) => set({ target }),
  close: () => set({ target: null }),
}));

/** Open history/blame for an absolute file path (finds its repository first). */
export async function showFileHistory(hostId: string, file: string, tab: HistoryTab): Promise<void> {
  const [root, path] = await api.gitLocate(hostId, file);
  useGitHistory.getState().show({ hostId, root, path, tab });
}

const Dialog = lazy(() => import("./HistoryDialog"));

export function GitHistoryHost() {
  const open = useGitHistory((s) => !!s.target);
  return open ? createElement(Suspense, { fallback: null }, createElement(Dialog)) : null;
}
