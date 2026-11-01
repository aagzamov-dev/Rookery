import { create } from "zustand";
import type { DatabaseJob } from "../ipc/bindings/DatabaseJob";
import { useNotifications } from "./notifications";

export const terminalDatabaseJob = (job: DatabaseJob) => ["done", "failed", "cancelled"].includes(job.state);
const notified = new Set<string>();
export const useDatabaseFiles = create<{
  jobs: Record<string, DatabaseJob>;
  dismissed: Record<string, boolean>;
  dismiss: (id: string) => void;
  received: (job: DatabaseJob, live?: boolean) => void;
}>((set, get) => ({
  jobs: {}, dismissed: {},
  dismiss: (id) => {
    const job = get().jobs[id];
    if (job && terminalDatabaseJob(job)) set((state) => ({ dismissed: { ...state.dismissed, [id]: true } }));
  },
  received: (job, live = false) => {
    const previous = get().jobs[job.id];
    if (previous && terminalDatabaseJob(previous) && !terminalDatabaseJob(job)) return;
    set((state) => {
      const all = { ...state.jobs, [job.id]: job };
      const terminal = Object.values(all).filter(terminalDatabaseJob).slice(-20);
      const retained = new Set(terminal.map((entry) => entry.id));
      const jobs = Object.fromEntries(Object.entries(all).filter(([id, entry]) => !terminalDatabaseJob(entry) || retained.has(id)));
      return { jobs, dismissed: Object.fromEntries(Object.entries(state.dismissed).filter(([id]) => id in jobs)) };
    });
    if (!live && previous?.state !== "running" && terminalDatabaseJob(job)) notified.add(job.id);
    if (notified.size > 1000) notified.delete(notified.values().next().value!);
    if ((live || previous?.state === "running") && terminalDatabaseJob(job) && !notified.has(job.id)) {
      notified.add(job.id);
      useNotifications.getState().add(`Database operation ${job.state === "done" ? "completed" : job.state}`, "Open the database operation for details.", `database-job:${job.id}`);
    }
  },
}));
