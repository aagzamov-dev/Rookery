// Backup files and device sync. Passwords and secrets stay in Rust; this store only
// mirrors status and triggers actions.
import { create } from "zustand";
import { api } from "../ipc/api";
import type { BackupStatus } from "../ipc/bindings/BackupStatus";
import type { MergeSummary } from "../ipc/bindings/MergeSummary";
import { useHosts } from "./hosts";
import { useKeys } from "./keys";
import { useSnippets } from "./snippets";
import { useSql } from "./sql";
import { useSync } from "./sync";

interface BackupStore {
  status: BackupStatus | null;
  /** Last "data arrived" notice, shown briefly in the title bar. */
  notice: { summary: MergeSummary; at: number } | null;
  load: () => Promise<void>;
  setStatus: (s: BackupStatus) => void;
  clearNotice: () => void;
}

export const useBackup = create<BackupStore>((set) => ({
  status: null,
  notice: null,
  load: async () => set({ status: await api.backupStatus() }),
  setStatus: (status) => set({ status }),
  clearNotice: () => set({ notice: null }),
}));

/** Another device's changes (or an imported backup) landed in the DB: reload what the UI shows. */
export async function onDataChanged(summary: MergeSummary) {
  useBackup.setState({ notice: { summary, at: Date.now() } });
  await Promise.all([
    useHosts.getState().load(),
    useSnippets.getState().load(),
    useKeys.getState().load(),
    useSync.getState().load(),
    useSql.getState().loadConns().catch(() => {}),
  ]);
}

export function summaryText(s: MergeSummary): string {
  const parts = [s.added && `${s.added} added`, s.updated && `${s.updated} updated`, s.deleted && `${s.deleted} deleted`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "nothing new";
}

/** "Backup 2026-10-16.rookerybackup" */
export function backupFileName(device: string, now = new Date()): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const safe = device.replace(/[^\w .-]+/g, "").trim() || "Rookery";
  return `Rookery backup ${safe} ${d}.rookerybackup`;
}
