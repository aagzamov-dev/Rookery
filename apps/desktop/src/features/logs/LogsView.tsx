import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { FileText, Plus, X } from "lucide-react";
import { api } from "../../ipc/api";
import { useHosts } from "../../stores/hosts";
import { streamKey, useLogs } from "../../stores/logs";
import { LogViewer } from "./LogViewer";

const SAVED_KEY = "ui.logFiles";

/** Follow any log file with `tail -F` — only while this view is visible. */
export function LogsView({ hostId }: { hostId: string }) {
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const target = useLogs((s) => s.fileTarget[hostId] ?? null);
  const setTarget = useLogs((s) => s.setFileTarget);
  const stream = useLogs((s) => (target ? s.streams[streamKey(hostId, `file:${target}`)] : undefined));
  const clear = useLogs((s) => s.clear);
  const [custom, setCustom] = useState("");
  const [saved, setSaved] = useSavedFiles(hostId);

  const presets = useMemo(() => {
    const list: string[] = [];
    if (host?.start_folder) list.push(`${host.start_folder.replace(/\/+$/, "")}/storage/logs/laravel.log`);
    list.push("/var/log/syslog", "/var/log/nginx/error.log", "/var/log/nginx/access.log", "/var/log/auth.log");
    return list;
  }, [host?.start_folder]);

  const pick = (p: string) => setTarget(hostId, p);

  return (
    <div className="flex h-full min-h-0 gap-3 bg-bg p-3">
      <aside className="flex w-[280px] flex-none flex-col gap-3 rounded-xl border border-line bg-panel p-3">
        <h2 className="m-0 text-sm font-semibold">Log files</h2>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const p = custom.trim();
            if (!p.startsWith("/")) return;
            if (!saved.includes(p)) setSaved([...saved, p]);
            pick(p);
            setCustom("");
          }}
        >
          <input
            aria-label="Log file path"
            placeholder="/path/to/file.log"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 font-mono text-xs outline-none focus:border-accent-line"
          />
          <button aria-label="Follow this file" title="Follow" className="grid h-8 w-8 place-items-center rounded-md bg-accent text-bg">
            <Plus size={14} />
          </button>
        </form>
        {saved.length > 0 && <List title="Saved" items={saved} current={target} onPick={pick} onRemove={(p) => setSaved(saved.filter((x) => x !== p))} />}
        <List title="Common" items={presets.filter((p) => !saved.includes(p))} current={target} onPick={pick} />
        <p className="m-0 mt-auto text-[11px] leading-relaxed text-muted">Lines stream with tail -F while this view is open and stop when you leave it.</p>
      </aside>
      <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-line">
        {target ? (
          <LogViewer
            title={<span className="font-mono text-xs font-normal text-accent">{target}</span>}
            lines={stream?.lines ?? []}
            ended={stream?.ended ?? null}
            live
            onClear={() => clear(hostId, `file:${target}`)}
            actions={
              <button aria-label="Stop following" title="Stop following" onClick={() => setTarget(hostId, null)} className="grid h-7 w-7 place-items-center rounded-md border border-line text-muted hover:text-text">
                <X size={13} />
              </button>
            }
          />
        ) : (
          <div className="grid h-full place-items-center bg-term text-muted">Pick a log file to follow.</div>
        )}
      </div>
    </div>
  );
}

function List({ title, items, current, onPick, onRemove }: { title: string; items: string[]; current: string | null; onPick: (p: string) => void; onRemove?: (p: string) => void }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="px-1 text-[11px] tracking-wider text-muted uppercase">{title}</span>
      {items.map((p) => (
        <div key={p} className={clsx("group/l flex items-center gap-2 rounded-md px-2 py-1.5", current === p ? "bg-accent-bg" : "hover:bg-panel2")}>
          <FileText size={13} className="flex-none text-muted" />
          <button onClick={() => onPick(p)} className="min-w-0 flex-1 truncate text-left font-mono text-xs" title={p}>
            {p}
          </button>
          {onRemove && (
            <button aria-label={`Remove ${p}`} onClick={() => onRemove(p)} className="invisible text-muted group-hover/l:visible hover:text-text">
              <X size={11} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Saved log paths per host, persisted in the local DB (`ui.logFiles`). */
function useSavedFiles(hostId: string): [string[], (v: string[]) => void] {
  const [all, setAll] = useState<Record<string, string[]> | null>(null);
  useEffect(() => {
    void api.settingGet<Record<string, string[]>>(SAVED_KEY).then((v) => setAll(v ?? {}));
  }, []);
  const list = all?.[hostId] ?? [];
  const set = (v: string[]) => {
    const next = { ...(all ?? {}), [hostId]: v };
    setAll(next);
    void api.settingSet(SAVED_KEY, next);
  };
  return [list, set];
}
