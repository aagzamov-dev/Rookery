import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Pause, Play, RefreshCw, Search, Skull, X } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { Process } from "../../ipc/bindings/Process";
import { askConfirm } from "../../stores/dialogs";
import { useHosts } from "../../stores/hosts";
import { useTabs } from "../../stores/tabs";
import { terminalRegistry } from "../server-tab/terminal/registry";

const EVERY_MS = 5_000;

const fmtElapsed = (s: number) => {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
};

/** Top processes. Refreshes every 5 s ONLY while visible (pause available). */
export function ProcessesView({ hostId, visible }: { hostId: string; visible: boolean }) {
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const [list, setList] = useState<Process[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [q, setQ] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const busy = useRef(false);

  const load = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setList(await api.processesList(hostId));
      setErr(null);
    } catch (e) {
      setErr(asCoreError(e).message);
    } finally {
      busy.current = false;
    }
  };

  useEffect(() => {
    if (!visible) return;
    void load();
    if (paused) return;
    const t = setInterval(() => void load(), EVERY_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, paused, hostId]);

  const kill = async (p: Process, force: boolean) => {
    const ok = await askConfirm({
      title: `${force ? "Force kill" : "Stop"} ${p.command} (PID ${p.pid})?`,
      body: `${force ? "SIGKILL ends it immediately (no cleanup)." : "SIGTERM asks it to exit cleanly."}${host?.env_label === "prod" ? " This is a PRODUCTION server." : ""}`,
      preview: `kill -${force ? "KILL" : "TERM"} ${p.pid}`,
      confirmLabel: force ? "Force kill" : "Stop process",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.processKill(hostId, p.pid, force);
      setNote(`Sent ${force ? "SIGKILL" : "SIGTERM"} to ${p.pid}`);
      void load();
    } catch (e) {
      const msg = asCoreError(e).message;
      if (/not permitted/i.test(msg)) {
        // Other users' processes need sudo: do it in a terminal where you type the password.
        const key = useTabs.getState().addTerminal(hostId, { title: `kill ${p.pid}` });
        if (key) {
          terminalRegistry.runCommand(key, `sudo kill -${force ? "KILL" : "TERM"} ${p.pid}`);
          setTimeout(() => terminalRegistry.focus(key), 50);
        }
      } else setNote(msg);
    }
  };

  const f = q.trim().toLowerCase();
  const rows = (list ?? []).filter((p) => !f || p.command.toLowerCase().includes(f) || p.user.toLowerCase().includes(f) || String(p.pid) === f);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg p-3">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
          <h2 className="m-0 text-sm font-semibold">Processes</h2>
          <span className="text-xs text-muted">top {list?.length ?? "…"} by CPU · {paused ? "paused" : "every 5 s while open"}</span>
          <label className="ml-auto flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-muted">
            <Search size={12} />
            <input aria-label="Filter processes" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} className="w-32 bg-transparent text-xs text-text outline-none" />
          </label>
          <button aria-label={paused ? "Resume" : "Pause"} title={paused ? "Resume" : "Pause"} onClick={() => setPaused(!paused)} className="grid h-7 w-7 place-items-center rounded-md border border-line text-muted hover:text-text">
            {paused ? <Play size={12} /> : <Pause size={12} />}
          </button>
          <button aria-label="Refresh" title="Refresh" onClick={() => void load()} className="grid h-7 w-7 place-items-center rounded-md border border-line text-muted hover:text-text">
            <RefreshCw size={12} />
          </button>
        </div>
        {err && <div className="px-4 py-3 text-xs text-[#FFA8A8]">{err}</div>}
        {note && (
          <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-muted">
            <span className="flex-1">{note}</span>
            <button aria-label="Dismiss" onClick={() => setNote(null)}>
              <X size={12} />
            </button>
          </div>
        )}
        <div className="grid grid-cols-[70px_110px_64px_64px_80px_minmax(0,1fr)_80px] gap-x-3 px-3.5 py-2 text-[11px] tracking-wider text-muted uppercase">
          <span>PID</span>
          <span>User</span>
          <span className="text-right">CPU</span>
          <span className="text-right">Mem</span>
          <span className="text-right">Running</span>
          <span>Command</span>
          <span />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.map((p) => (
            <div key={p.pid} className="group/p grid h-9 grid-cols-[70px_110px_64px_64px_80px_minmax(0,1fr)_80px] items-center gap-x-3 border-b border-[#303A4E] px-3.5 hover:bg-panel2">
              <span className="font-mono text-xs">{p.pid}</span>
              <span className="truncate text-xs text-muted">{p.user}</span>
              <span className={clsx("text-right font-mono text-xs", p.cpu > 80 ? "text-[#FFA8A8]" : p.cpu > 40 ? "text-[#F7CB6A]" : "")}>{p.cpu.toFixed(1)}%</span>
              <span className="text-right font-mono text-xs">{p.mem.toFixed(1)}%</span>
              <span className="text-right text-xs text-muted">{fmtElapsed(p.elapsed_s)}</span>
              <span className="truncate font-mono text-xs">{p.command}</span>
              <span className="invisible flex justify-end gap-0.5 group-hover/p:visible">
                <button aria-label="Stop (SIGTERM)" title="Stop (SIGTERM)" onClick={() => void kill(p, false)} className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-line hover:text-text">
                  <X size={13} />
                </button>
                <button aria-label="Force kill (SIGKILL)" title="Force kill (SIGKILL)" onClick={() => void kill(p, true)} className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-line hover:text-[#FFA8A8]">
                  <Skull size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
