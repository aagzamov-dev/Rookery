import { useEffect, useState } from "react";
import clsx from "clsx";
import { Loader2, Play, RefreshCw, RotateCw, ScrollText, Search, Square } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { Service } from "../../ipc/bindings/Service";
import { askConfirm } from "../../stores/dialogs";
import { useHosts } from "../../stores/hosts";
import { useTabs } from "../../stores/tabs";
import { terminalRegistry } from "../server-tab/terminal/registry";
import { shellQuote as sq } from "../files/quote";

const FRESH_MS = 30_000;
const cache = new Map<string, { list: Service[]; at: number }>();

/** Loads once when opened (and on Refresh); no background polling. */
export function ServicesView({ hostId, visible }: { hostId: string; visible: boolean }) {
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const [list, setList] = useState<Service[] | null>(cache.get(hostId)?.list ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"all" | "running" | "failed">("all");

  const load = async (force = false) => {
    const c = cache.get(hostId);
    if (!force && c && Date.now() - c.at < FRESH_MS) return setList(c.list);
    setLoading(true);
    setErr(null);
    try {
      const l = await api.servicesList(hostId);
      cache.set(hostId, { list: l, at: Date.now() });
      setList(l);
    } catch (e) {
      setErr(asCoreError(e).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, hostId]);

  // Actions run in a terminal so you type the sudo password yourself (never stored or sent silently).
  const inTerminal = async (cmd: string, title: string, confirmProd: boolean) => {
    if (confirmProd && host?.env_label === "prod") {
      const ok = await askConfirm({ title: `Run on PROD — ${host.name}?`, preview: cmd, confirmLabel: "Run", danger: true });
      if (!ok) return;
    }
    const key = useTabs.getState().addTerminal(hostId, { title });
    if (!key) return;
    terminalRegistry.runCommand(key, cmd);
    setTimeout(() => terminalRegistry.focus(key), 50);
    cache.delete(hostId);
  };

  const f = q.trim().toLowerCase();
  const rows = (list ?? []).filter(
    (s) =>
      (show === "all" || (show === "running" ? s.sub === "running" : s.active === "failed")) &&
      (!f || s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f)),
  );
  const failed = (list ?? []).filter((s) => s.active === "failed").length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg p-3">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
          <h2 className="m-0 text-sm font-semibold">Services</h2>
          <span className="text-xs text-muted">systemd · {list?.length ?? "…"} units</span>
          {(["all", "running", "failed"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setShow(k)}
              className={clsx("h-6 rounded-full px-2.5 text-xs", show === k ? "bg-accent-bg text-text" : "border border-line text-muted", k === "failed" && failed > 0 && show !== k && "text-[#FFA8A8]")}
            >
              {k === "all" ? "All" : k === "running" ? "Running" : `Failed ${failed}`}
            </button>
          ))}
          <label className="ml-auto flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-muted">
            <Search size={12} />
            <input aria-label="Filter services" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} className="w-32 bg-transparent text-xs text-text outline-none" />
          </label>
          <button aria-label="Refresh" title="Refresh" onClick={() => void load(true)} className="grid h-7 w-7 place-items-center rounded-md border border-line text-muted hover:text-text">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        {err && <div className="px-4 py-3 text-xs text-[#FFA8A8]">{err}</div>}
        {!list && !err && (
          <div className="flex items-center gap-2 px-4 py-4 text-muted">
            <Loader2 size={14} className="animate-spin" /> Loading services…
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.map((s) => (
            <div key={s.name} className="group/s grid h-10 grid-cols-[minmax(160px,1fr)_120px_minmax(0,2fr)_150px] items-center gap-x-3 border-b border-[#303A4E] px-3.5 hover:bg-panel2">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className={clsx("h-2 w-2 flex-none rounded-full", s.active === "failed" ? "bg-bad" : s.sub === "running" ? "bg-ok" : s.active === "activating" ? "bg-warn" : "bg-[#6B7690]")}
                />
                <span className="truncate font-medium">{s.name}</span>
              </span>
              <span className={clsx("text-xs", s.active === "failed" ? "text-[#FFA8A8]" : "text-muted")}>
                {s.active} · {s.sub}
              </span>
              <span className="truncate text-xs text-muted">{s.description}</span>
              <span className="invisible flex justify-end gap-0.5 group-hover/s:visible">
                <Btn label="Follow journal" onClick={() => void inTerminal(`journalctl -u ${sq(s.name)} -f -n 200`, `journal ${s.name}`, false)}>
                  <ScrollText size={14} />
                </Btn>
                <Btn label="Restart (asks for sudo in a terminal)" onClick={() => void inTerminal(`sudo systemctl restart ${sq(s.name)} && systemctl status ${sq(s.name)} --no-pager -n 5`, `restart ${s.name}`, true)}>
                  <RotateCw size={14} />
                </Btn>
                {s.sub === "running" ? (
                  <Btn label="Stop (asks for sudo in a terminal)" onClick={() => void inTerminal(`sudo systemctl stop ${sq(s.name)}`, `stop ${s.name}`, true)}>
                    <Square size={13} />
                  </Btn>
                ) : (
                  <Btn label="Start (asks for sudo in a terminal)" onClick={() => void inTerminal(`sudo systemctl start ${sq(s.name)} && systemctl status ${sq(s.name)} --no-pager -n 5`, `start ${s.name}`, true)}>
                    <Play size={13} />
                  </Btn>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Btn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className="grid h-[30px] w-[30px] place-items-center rounded-md text-muted hover:bg-line hover:text-text">
      {children}
    </button>
  );
}
