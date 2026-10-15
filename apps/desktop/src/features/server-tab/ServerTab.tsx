import { useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";
import { AlertTriangle, Loader2, Plus, ShieldAlert, ShieldQuestion, Terminal as TermIcon, X } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { Host } from "../../ipc/bindings/Host";
import { useHosts } from "../../stores/hosts";
import { useMetrics } from "../../stores/metrics";
import { useSessions } from "../../stores/sessions";
import { useTabs, type View } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { Button } from "../../ui/primitives";
import { bytes, pct, rate, uptime } from "../../ui/format";
import { TerminalPane } from "./terminal/TerminalPane";
import { terminalRegistry } from "./terminal/registry";

const VIEWS: { id: View; label: string; ready: boolean }[] = [
  { id: "overview", label: "Overview", ready: true },
  { id: "terminal", label: "Terminal", ready: true },
  { id: "files", label: "Files", ready: false },
  { id: "docker", label: "Docker", ready: false },
  { id: "services", label: "Services", ready: false },
  { id: "logs", label: "Logs", ready: false },
  { id: "settings", label: "Settings", ready: true },
];

interface Props {
  hostId: string;
  active: boolean;
  onEditHost: (h: Host) => void;
}

/**
 * One tab per server. Views mount on first open and then stay mounted (hidden),
 * so terminals, scroll and inputs survive switching views or tabs.
 */
export function ServerTab({ hostId, active, onEditHost }: Props) {
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const views = useTabs((s) => s.views[hostId]);
  const setView = useTabs((s) => s.setView);
  const info = useSessions((s) => s.byHost[hostId]);
  const attach = useSessions((s) => s.attach);
  const [everConnected, setEverConnected] = useState(false);

  // Connect when the tab is shown for the first time (not before).
  useEffect(() => {
    if (active) void attach(hostId);
  }, [active, hostId, attach]);

  useEffect(() => {
    if (info?.state === "connected") setEverConnected(true);
  }, [info?.state]);

  if (!views) return null;
  const show = (v: View) => active && views.active === v;

  return (
    <div className="absolute inset-0 flex-col" style={{ display: active ? "flex" : "none" }}>
      <ViewBar hostId={hostId} current={views.active} onSelect={(v) => (v === "settings" && host ? onEditHost(host) : setView(hostId, v))} />
      <ConnectionBanner hostId={hostId} host={host} onEditHost={onEditHost} />
      <div className="relative min-h-0 flex-1 bg-term">
        {views.opened.includes("terminal") && everConnected && <TerminalView hostId={hostId} visible={show("terminal")} />}
        {views.opened.includes("terminal") && !everConnected && show("terminal") && <Waiting />}
        {views.opened.includes("overview") && show("overview") && <OverviewView hostId={hostId} />}
        {VIEWS.filter((v) => !v.ready).map((v) => views.opened.includes(v.id) && show(v.id) && <ComingSoon key={v.id} view={v.label} />)}
      </div>
      <StatsBar hostId={hostId} />
    </div>
  );
}

function ViewBar({ hostId, current, onSelect }: { hostId: string; current: View; onSelect: (v: View) => void }) {
  const views = useTabs((s) => s.views[hostId]);
  const addTerminal = useTabs((s) => s.addTerminal);
  const closeTerminal = useTabs((s) => s.closeTerminal);
  const setActiveTerminal = useTabs((s) => s.setActiveTerminal);
  return (
    <div role="tablist" aria-label="Server views" className="flex min-h-[42px] flex-wrap items-center gap-0.5 border-b border-line bg-term px-2.5">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          role="tab"
          aria-selected={current === v.id}
          onClick={() => onSelect(v.id)}
          className={clsx(
            "flex h-7 items-center gap-1.5 rounded-md px-3",
            current === v.id ? "bg-panel2 font-medium text-text" : "text-muted hover:text-text",
          )}
        >
          {v.id === "terminal" && <TermIcon size={13} />}
          {v.label}
          {v.id === "terminal" && views && views.terminals.length > 0 && <span className="font-normal text-muted">{views.terminals.length}</span>}
        </button>
      ))}
      {current === "terminal" && views && (
        <div className="ml-auto flex items-center gap-0.5 rounded-[7px] border border-line p-0.5">
          {views.terminals.map((t) => (
            <span key={t.key} className={clsx("group/s flex h-6 items-center rounded-[5px] font-mono text-[11px]", views.activeTerminal === t.key ? "bg-panel2 text-text" : "text-muted")}>
              <button className="pl-2.5 pr-1" onClick={() => setActiveTerminal(hostId, t.key)}>
                {t.title}
              </button>
              <button
                aria-label={`Close ${t.title}`}
                className="grid h-5 w-5 place-items-center rounded opacity-0 group-hover/s:opacity-100 hover:text-text"
                onClick={() => {
                  terminalRegistry.dispose(t.key);
                  closeTerminal(hostId, t.key);
                }}
              >
                <X size={10} />
              </button>
            </span>
          ))}
          <button aria-label="New terminal on this server" title="New terminal" onClick={() => addTerminal(hostId)} className="grid h-6 w-6 place-items-center rounded-[5px] text-muted hover:text-text">
            <Plus size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

function TerminalView({ hostId, visible }: { hostId: string; visible: boolean }) {
  const views = useTabs((s) => s.views[hostId]);
  if (!views) return null;
  return (
    <div className="absolute inset-0" style={{ display: visible ? "block" : "none" }}>
      {views.terminals.map((t) => (
        <TerminalPane key={t.key} termKey={t.key} hostId={hostId} visible={visible && views.activeTerminal === t.key} opts={{ cwd: t.cwd, container: t.container }} />
      ))}
      {views.terminals.length === 0 && (
        <div className="grid h-full place-items-center text-muted">No terminals. Use + to open one.</div>
      )}
    </div>
  );
}

function ConnectionBanner({ hostId, host, onEditHost }: { hostId: string; host?: Host; onEditHost: (h: Host) => void }) {
  const info = useSessions((s) => s.byHost[hostId]);
  const err = useSessions((s) => s.errors[hostId]);
  const attaching = useSessions((s) => s.attaching[hostId]);
  const attach = useSessions((s) => s.attach);
  const detach = useSessions((s) => s.detach);
  const clearError = useSessions((s) => s.clearError);
  const [busy, setBusy] = useState(false);
  const [trustErr, setTrustErr] = useState<string | null>(null);

  const retry = async () => {
    clearError(hostId);
    await detach(hostId);
    await attach(hostId);
  };

  if (err?.kind === "unknown_host_key" || err?.kind === "host_key_changed") {
    const changed = err.kind === "host_key_changed";
    return (
      <Banner tone={changed ? "bad" : "info"} icon={changed ? <ShieldAlert size={16} /> : <ShieldQuestion size={16} />}>
        <div className="flex flex-1 flex-col gap-1">
          <strong>{changed ? "The server's host key CHANGED" : `First connection to ${host?.name ?? "this host"}`}</strong>
          <span className="text-muted">
            {changed
              ? "This can mean the server was reinstalled — or that someone is intercepting the connection. Only continue if you know why."
              : "Check this fingerprint matches the server before trusting it:"}
          </span>
          <code className="font-mono text-xs text-text">{err.fingerprint}</code>
          {trustErr && <span className="text-prod-fg">{trustErr}</span>}
        </div>
        <Button
          variant={changed ? "danger" : "primary"}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.hostTrustKey(hostId, err.fingerprint!);
              setTrustErr(null);
              await retry();
            } catch (e) {
              setTrustErr(asCoreError(e).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {changed ? "I replaced the server — trust new key" : "Trust and connect"}
        </Button>
      </Banner>
    );
  }

  if (err) {
    return (
      <Banner tone="bad" icon={<AlertTriangle size={16} />}>
        <span className="flex-1">{err.message}</span>
        {host && (err.kind === "secret_required" || err.kind === "auth_failed") && (
          <Button onClick={() => onEditHost(host)}>Edit login</Button>
        )}
        <Button onClick={retry}>Retry</Button>
      </Banner>
    );
  }

  if (attaching || info?.state === "connecting") {
    return (
      <Banner tone="info" icon={<Loader2 size={16} className="animate-spin" />}>
        <span>Connecting to {host?.address ?? "host"}…</span>
      </Banner>
    );
  }
  if (info?.state === "reconnecting") {
    return (
      <Banner tone="warn" icon={<Loader2 size={16} className="animate-spin" />}>
        <span>Connection lost — reconnecting… {info.error ? `(${info.error})` : ""}</span>
      </Banner>
    );
  }
  if (info?.state === "error") {
    return (
      <Banner tone="bad" icon={<AlertTriangle size={16} />}>
        <span className="flex-1">{info.error ?? "Disconnected"}</span>
        <Button onClick={retry}>Reconnect</Button>
      </Banner>
    );
  }
  return null;
}

function Banner({ tone, icon, children }: { tone: "info" | "warn" | "bad"; icon: ReactNode; children: ReactNode }) {
  return (
    <div
      className={clsx(
        "flex items-center gap-3 border-b px-4 py-2.5",
        tone === "info" && "border-accent-line bg-[#22304A]",
        tone === "warn" && "border-[#6A5828] bg-[#2F2A1E]",
        tone === "bad" && "border-[#5A2D33] bg-[#33232A]",
      )}
    >
      <span className={clsx(tone === "info" && "text-accent", tone === "warn" && "text-warn", tone === "bad" && "text-bad")}>{icon}</span>
      {children}
    </div>
  );
}

function Waiting() {
  return <div className="grid h-full place-items-center text-muted">The terminal opens once connected.</div>;
}

function ComingSoon({ view }: { view: string }) {
  return (
    <div className="grid h-full place-items-center bg-bg">
      <div className="max-w-sm text-center text-muted">
        <h3 className="m-0 mb-2 text-sm font-semibold text-text">{view}</h3>
        This view arrives in v0.3. It will load only when you open it, and pause when hidden.
      </div>
    </div>
  );
}

function OverviewView({ hostId }: { hostId: string }) {
  const m = useMetrics((s) => s.byHost[hostId]);
  const last = m?.last;
  const cpu = (m?.history ?? []).map((s) => s.cpu_pct ?? 0);
  const ramPct = last && last.ram_total_bytes ? (100 * last.ram_used_bytes) / last.ram_total_bytes : null;
  return (
    <div className="absolute inset-0 overflow-auto bg-bg p-5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <Card label="CPU" value={pct(last?.cpu_pct)} sub={`load ${last?.load1.toFixed(2) ?? "—"}`} pct={last?.cpu_pct ?? 0}>
          <Spark values={cpu} />
        </Card>
        <Card label="Memory" value={bytes(last?.ram_used_bytes)} sub={`of ${bytes(last?.ram_total_bytes)}`} pct={ramPct ?? 0} />
        <Card label="Disk /" value={pct(last?.disk_pct)} sub={`${bytes(last?.disk_used_bytes)} of ${bytes(last?.disk_total_bytes)}`} pct={last?.disk_pct ?? 0} />
        <Card label="Network" value={`↓ ${rate(last?.net_rx_bps)}`} sub={`↑ ${rate(last?.net_tx_bps)}`} pct={0} />
        <Card label="Uptime" value={uptime(last?.uptime_s)} sub={`load ${last ? `${last.load1} · ${last.load5} · ${last.load15}` : "—"}`} pct={0} />
      </div>
      <p className="mt-4 text-xs text-muted">Charts use the same 3-second sample as the stats bar — no extra load on the server. History: last 15 minutes while this tab is open.</p>
    </div>
  );
}

function Card({ label, value, sub, pct: p, children }: { label: string; value: string; sub: string; pct: number; children?: ReactNode }) {
  const color = p > 85 ? "bg-bad" : p > 75 ? "bg-warn" : "bg-accent";
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4">
      <div className="flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span>{sub}</span>
      </div>
      <div className="font-mono text-[22px]">{value}</div>
      {p > 0 && (
        <div className="h-1 rounded bg-line">
          <div className={clsx("h-1 rounded", color)} style={{ width: `${Math.min(100, p)}%` }} />
        </div>
      )}
      {children}
    </div>
  );
}

function Spark({ values, w = 200, h = 34 }: { values: number[]; w?: number; h?: number }) {
  if (values.length < 2) return <div style={{ height: h }} />;
  const pts = values.slice(-60);
  const step = w / (pts.length - 1);
  const d = pts.map((v, i) => `${(i * step).toFixed(1)},${(h - (Math.min(100, v) / 100) * h).toFixed(1)}`).join(" ");
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={d} fill="none" stroke="#8AB4FF" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function StatsBar({ hostId }: { hostId: string }) {
  const m = useMetrics((s) => s.byHost[hostId]);
  const info = useSessions((s) => s.byHost[hostId]);
  const windowActive = useUi((s) => s.windowActive);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const last = m?.last;
  const stale = !last || now - last.ts_ms > 30_000;
  const cpu = (m?.history ?? []).slice(-20).map((s) => s.cpu_pct ?? 0);
  const ram = last ? `${bytes(last.ram_used_bytes)} / ${bytes(last.ram_total_bytes)}` : "—";
  const live = info?.state === "connected" && windowActive && !stale;
  return (
    <footer className={clsx("flex min-h-8 flex-wrap items-center gap-5 border-t border-line bg-panel px-3.5 text-xs text-muted", stale && "opacity-70")}>
      <span className="flex items-center gap-2">
        CPU <b className="font-mono font-normal text-text">{pct(last?.cpu_pct)}</b>
        <span className="w-14">
          <Spark values={cpu} w={56} h={14} />
        </span>
      </span>
      <span>
        RAM <b className="font-mono font-normal text-text">{ram}</b>
      </span>
      <span>
        Disk <b className={clsx("font-mono font-normal", (last?.disk_pct ?? 0) > 75 ? "text-[#F7CB6A]" : "text-text")}>{pct(last?.disk_pct)}</b>
      </span>
      <span>
        Net <b className="font-mono font-normal text-text">↓ {rate(last?.net_rx_bps)} ↑ {rate(last?.net_tx_bps)}</b>
      </span>
      <span>
        Up <b className="font-mono font-normal text-text">{uptime(last?.uptime_s)}</b>
      </span>
      {m?.error && <span className="text-[#F7CB6A]">{m.error}</span>}
      <span className="ml-auto flex items-center gap-1.5">
        <span aria-hidden className={clsx("h-[7px] w-[7px] rounded-full", live ? "bg-ok" : "bg-[#6B7690]")} />
        {live ? "Live while this tab is open" : windowActive ? "Paused" : "Paused — window inactive"}
        {info?.latency_ms != null && ` · SSH ${info.latency_ms} ms`}
      </span>
    </footer>
  );
}
