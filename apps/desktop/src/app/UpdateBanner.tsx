import { useState } from "react";
import { ArrowUpCircle, PartyPopper, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { askConfirm } from "../stores/dialogs";
import { openWork, RELEASES_URL, useUpdate } from "../stores/update";
import { Button } from "../ui/primitives";

/** "Update available" strip under the title bar, and "Updated to x" once after an update. */
export function UpdateBanner() {
  const u = useUpdate();
  const [notes, setNotes] = useState(false);

  if (u.justUpdated) {
    return (
      <div className="flex items-center gap-3 border-b border-line bg-[#1e3d33] px-4 py-1.5 text-[13px] text-[#CFF5E2]">
        <PartyPopper size={14} />
        <span className="flex-1">Rookery was updated to {u.justUpdated}.</span>
        <button className="text-xs underline" onClick={() => void openUrl(`${RELEASES_URL}/tag/v${u.justUpdated}`)}>
          What's new
        </button>
        <button aria-label="Dismiss" onClick={() => u.clearJustUpdated()}>
          <X size={13} />
        </button>
      </div>
    );
  }

  const busy = u.phase === "downloading" || u.phase === "installing";
  if (!u.available || (u.dismissed && !busy)) return null;
  const pct = u.progress?.total ? Math.round((100 * u.progress.done) / u.progress.total) : null;

  const start = async () => {
    const w = openWork();
    if (w.terminals + w.transfers > 0) {
      const parts = [w.terminals && `${w.terminals} terminal${w.terminals === 1 ? "" : "s"}`, w.transfers && `${w.transfers} file transfer${w.transfers === 1 ? "" : "s"}`].filter(Boolean);
      const ok = await askConfirm({
        title: `Update to ${u.available!.version} now?`,
        body: `Rookery restarts to update: ${parts.join(" and ")} will close. Your servers and data are kept.`,
        confirmLabel: "Update and restart",
      });
      if (!ok) return;
    }
    void u.install();
  };

  return (
    <div className="flex flex-col border-b border-line bg-accent-bg text-[13px]">
      <div className="flex flex-wrap items-center gap-3 px-4 py-1.5">
        <ArrowUpCircle size={14} className="text-accent" />
        <span className="flex-1">
          {u.phase === "installing"
            ? `Installing Rookery ${u.available.version}… the app restarts in a moment.`
            : u.phase === "downloading"
              ? `Downloading Rookery ${u.available.version}${pct != null ? ` · ${pct}%` : "…"}`
              : u.phase === "error"
                ? `Update failed: ${u.error}`
                : `Rookery ${u.available.version} is available (you have ${u.current}).`}
        </span>
        {!busy && (
          <>
            {u.available.notes && (
              <button className="text-xs underline" onClick={() => setNotes(!notes)}>
                {notes ? "Hide" : "What's new"}
              </button>
            )}
            <Button variant="primary" className="h-7" onClick={() => void start()}>
              {u.phase === "error" ? "Try again" : "Update"}
            </Button>
            <Button variant="ghost" className="h-7" onClick={() => u.later()}>
              Later
            </Button>
            <Button variant="ghost" className="h-7" onClick={() => void u.skip()} title="Don't remind me about this version">
              Skip
            </Button>
          </>
        )}
      </div>
      {notes && !busy && <pre className="m-0 max-h-48 overflow-auto px-10 pb-3 font-sans text-xs leading-relaxed whitespace-pre-wrap text-muted">{u.available.notes}</pre>}
      {u.phase === "downloading" && pct != null && (
        <div className="h-0.5 bg-line">
          <div className="h-0.5 bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
