// Running / failed ZIP and tar.gz jobs of one server, with Cancel. Shown in Files and the Editor tree.
import { Loader2, X } from "lucide-react";
import { api } from "../../ipc/api";
import { useArchiveJobs } from "./fileActions";

export function ArchiveJobs({ hostId }: { hostId: string }) {
  const all = useArchiveJobs((s) => s.jobs);
  const jobs = all.filter((j) => j.hostId === hostId);
  if (!jobs.length) return null;
  return (
    <div className="flex flex-none flex-col gap-1 border-t border-line px-3 py-1.5 text-xs">
      {jobs.map((j) =>
        j.state === "running" ? (
          <div key={j.id} role="status" className="flex items-center gap-2 text-muted">
            <Loader2 size={12} className="flex-none animate-spin" />
            <span className="min-w-0 flex-1 truncate" title={j.label}>
              {j.label}
            </span>
            <button onClick={() => void api.sftpArchiveCancel(j.id)} className="flex-none text-accent hover:underline">
              Cancel
            </button>
          </div>
        ) : (
          <div key={j.id} role="alert" className="flex items-start gap-2 text-[#FFA8A8]">
            <span className="min-w-0 flex-1 break-words">
              {j.label}: {j.error}
            </span>
            <button aria-label="Dismiss" onClick={() => useArchiveJobs.getState().drop(j.id)} className="grid h-5 w-5 flex-none place-items-center rounded text-muted hover:text-text">
              <X size={12} />
            </button>
          </div>
        ),
      )}
    </div>
  );
}
