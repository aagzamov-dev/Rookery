import { useMemo } from "react";
import clsx from "clsx";
import { AlertTriangle, Check, Download, Upload, X } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { api, asCoreError } from "../../ipc/api";
import { editKey, useFiles } from "../../stores/files";
import { bytes } from "../../ui/format";

/** Uploads/downloads in progress plus "edit locally" sync results for one server. */
export function TransfersStrip({ hostId }: { hostId: string }) {
  const transfers = useFiles((s) => s.transfers);
  const edits = useFiles((s) => s.edits);
  const dismissTransfer = useFiles((s) => s.dismissTransfer);
  const dismissEdit = useFiles((s) => s.dismissEdit);
  const setEdit = useFiles((s) => s.setEdit);

  const mine = useMemo(() => Object.values(transfers).filter((t) => t.host_id === hostId), [transfers, hostId]);
  const myEdits = useMemo(() => Object.values(edits).filter((e) => e.hostId === hostId && e.state !== "open"), [edits, hostId]);
  if (mine.length === 0 && myEdits.length === 0) return null;

  return (
    <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto border-t border-line bg-panel px-3 py-2">
      {myEdits.map((e) => {
        const name = e.remote.split("/").pop();
        const k = editKey(e.hostId, e.remote);
        return (
          <div key={k} className={clsx("flex items-center gap-2 text-xs", e.state === "uploaded" ? "text-muted" : "text-[#F7CB6A]")}>
            {e.state === "uploaded" ? <Check size={13} className="text-ok" /> : <AlertTriangle size={13} />}
            <span className="min-w-0 flex-1 truncate">
              {e.state === "uploaded" && `Saved ${name} to the server`}
              {e.state === "conflict" && `${name} changed on the server since you opened it`}
              {e.state === "error" && `${name}: ${e.message}`}
            </span>
            {e.state === "conflict" && (
              <>
                <button
                  className="text-[#FFA8A8]"
                  onClick={() =>
                    void api.editUpload(e.hostId, e.remote, true).catch((x) => setEdit({ ...e, state: "error", message: asCoreError(x).message }))
                  }
                >
                  Overwrite server copy
                </button>
                <button
                  className="text-accent"
                  onClick={async () => {
                    const local = await api.editOpen(e.hostId, e.remote);
                    setEdit({ ...e, local, state: "open", message: null });
                    await openPath(local);
                  }}
                >
                  Reopen server copy
                </button>
              </>
            )}
            <button aria-label="Dismiss" onClick={() => dismissEdit(k)} className="text-muted hover:text-text">
              <X size={12} />
            </button>
          </div>
        );
      })}
      {mine.map((t) => {
        const pct = t.total ? Math.min(100, (100 * t.bytes) / t.total) : t.state === "done" ? 100 : 0;
        return (
          <div key={t.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs">
              {t.upload ? <Upload size={12} className="text-muted" /> : <Download size={12} className="text-muted" />}
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <span className={clsx(t.state === "failed" ? "text-[#FFA8A8]" : "text-muted")}>
                {t.state === "running" && `${bytes(t.bytes)} / ${bytes(t.total)}`}
                {t.state === "done" && "Done"}
                {t.state === "failed" && (t.error ?? "Failed")}
                {t.state === "cancelled" && "Cancelled"}
              </span>
              <button
                aria-label={t.state === "running" ? "Cancel" : "Dismiss"}
                onClick={() => {
                  if (t.state === "running") void api.transferCancel(t.id);
                  dismissTransfer(t.id);
                }}
                className="text-muted hover:text-text"
              >
                <X size={12} />
              </button>
            </div>
            {t.state === "running" && (
              <div className="h-1 rounded bg-line">
                <div className="h-1 rounded bg-accent transition-[width]" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
