import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Box,
  Cpu,
  ExternalLink,
  HardDrive,
  LayoutGrid,
  Lock,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ServerOff,
  Wrench,
  X,
} from "lucide-react";
import type { Group } from "../../ipc/bindings/Group";
import type { Host } from "../../ipc/bindings/Host";
import type { Snapshot } from "../../ipc/bindings/Snapshot";
import { asCoreError } from "../../ipc/api";
import { shellHooks } from "../../keys/dispatcher";
import { useHosts } from "../../stores/hosts";
import {
  ago,
  ageClass,
  effectiveRefresh,
  hostsInTab,
  intervalShort,
  INTERVALS,
  needsAttention,
  switchOn,
  switchTargets,
  UNGROUPED,
  useSync,
  type Attention,
  type DashTab,
} from "../../stores/sync";
import { useTabs } from "../../stores/tabs";
import { useContextMenu, type MenuItem } from "../../ui/ContextMenu";
import { Button, EnvTag } from "../../ui/primitives";

/** Re-render every 30 s so "synced X ago" stays honest. */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const topLevel = (groups: Group[]) => {
  const ids = new Set(groups.map((g) => g.id));
  return groups.filter((g) => !g.parent_id || !ids.has(g.parent_id)).sort((a, b) => Number(a.sort - b.sort) || a.name.localeCompare(b.name));
};

/**
 * Renders from saved snapshots only. Opening it never connects; Sync / auto-sync do,
 * one short connection per server.
 */
export function DashboardPage() {
  const hosts = useHosts((s) => s.hosts);
  const groups = useHosts((s) => s.groups);
  const sync = useSync();
  const now = useNow();
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState<boolean | null>(null);
  const menu = useContextMenu();

  const knownGroups = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);
  const hasUngrouped = hosts.some((h) => !h.group_id || !knownGroups.has(h.group_id));
  const tabs = topLevel(groups);
  const tab: DashTab = sync.tab === "all" || sync.tab === UNGROUPED ? sync.tab : knownGroups.has(sync.tab) ? sync.tab : "all";
  const inScope = hostsInTab(tab, hosts, groups);
  const scopeName = tab === "all" ? "All servers" : tab === UNGROUPED ? "Ungrouped" : (groups.find((g) => g.id === tab)?.name ?? "");

  // Auto-sync switch for this scope: On / Off / Mixed (n of m).
  const targets = switchTargets(tab, groups, hasUngrouped);
  const isOn = (id: string) => (id === UNGROUPED ? sync.settings.ungrouped_auto : !!groups.find((g) => g.id === id)?.auto_sync_enabled);
  const onCount = targets.filter(isOn).length;
  const switchState: "on" | "off" | "mixed" = targets.length === 0 || onCount === 0 ? "off" : onCount === targets.length ? "on" : "mixed";

  const running = inScope.filter((h) => sync.live[h.id]).length;
  const stats = inScope.reduce(
    (a, h) => {
      const s = sync.snapshots[h.id];
      if (!s) a.never++;
      else if (s.state === "ok") a.ok++;
      else if (s.state === "locked") a.locked++;
      else a.failed++;
      return a;
    },
    { ok: 0, failed: 0, locked: 0, never: 0 },
  );
  const attention = needsAttention(inScope, sync.snapshots, sync.thresholds, now);

  const guard = (p: Promise<unknown>) => p.then(() => setError(null)).catch((e) => setError(asCoreError(e).message));
  const syncScope = (t: DashTab) => guard(sync.run(t === "all" ? { kind: "all" } : { kind: "group", id: t }));
  const syncHost = (id: string) => guard(sync.run({ kind: "host", id }));
  const setSwitch = (t: DashTab, on: boolean) => guard(sync.setAuto(switchTargets(t, groups, hasUngrouped), on));
  const setGroupInterval = (g: Group, interval_s: number | null) =>
    guard(useHosts.getState().saveGroup({ ...g, refresh: { ...g.refresh, interval_s } }));

  const tabMenu = (t: DashTab): MenuItem[] => {
    const g = groups.find((x) => x.id === t);
    const ts = switchTargets(t, groups, hasUngrouped);
    const allOn = ts.length > 0 && ts.every(isOn);
    const items: MenuItem[] = [
      { label: t === "all" ? "Sync all" : `Sync ${g?.name ?? "ungrouped"}`, icon: <RefreshCw size={13} />, onClick: () => void syncScope(t) },
      { label: allOn ? "Turn auto-sync off" : "Turn auto-sync on", icon: allOn ? <Pause size={13} /> : <Play size={13} />, onClick: () => (t === "all" ? setConfirmAll(!allOn) : void setSwitch(t, !allOn)) },
    ];
    if (g) {
      items.push({ kind: "separator" }, { kind: "label", label: "Interval" });
      items.push({ label: `Default (${intervalShort(sync.global.interval_s ?? 300)})`, checked: g.refresh.interval_s == null, onClick: () => void setGroupInterval(g, null) });
      for (const i of INTERVALS) items.push({ label: i.label, checked: g.refresh.interval_s === i.s, onClick: () => void setGroupInterval(g, i.s) });
      items.push({ kind: "separator" }, { label: "Edit group…", icon: <Pencil size={13} />, onClick: () => shellHooks.editGroup(g) });
    }
    return items;
  };

  const tabBtn = (id: DashTab, name: string, color: string, count: number) => {
    const ts = switchTargets(id, groups, hasUngrouped);
    const on = ts.filter(isOn).length;
    const g = groups.find((x) => x.id === id);
    const mark = id === "all" ? null : on === 0 ? null : on < ts.length ? "↻ some" : `↻ ${intervalShort(g?.refresh.interval_s ?? sync.global.interval_s ?? 300)}`;
    return (
      <button
        key={id}
        role="tab"
        aria-selected={tab === id}
        onClick={() => sync.setTab(id)}
        onContextMenu={menu.open(() => tabMenu(id))}
        className={clsx(
          "flex h-8 flex-none items-center gap-2 rounded-lg px-3 text-[13px]",
          tab === id ? "bg-accent-bg text-text" : "text-muted hover:bg-panel2 hover:text-text",
        )}
      >
        <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: color }} />
        {name}
        <span className="text-[11px] text-muted">{count}</span>
        {mark && <span className="rounded bg-[#1e3d33] px-1.5 text-[10px] text-[#86E0B6]">{mark}</span>}
      </button>
    );
  };

  const group = groups.find((g) => g.id === tab);

  return (
    <div className="flex min-h-full flex-col">
      {/* group tabs */}
      <div className="flex items-center gap-3 border-b border-line bg-panel px-5 pt-3 pb-2">
        <LayoutGrid size={16} className="flex-none text-accent" />
        <div role="tablist" aria-label="Dashboard scope" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabBtn("all", "All", "#6B7690", hosts.length)}
          {tabs.map((g) => tabBtn(g.id, g.name, g.color, hostsInTab(g.id, hosts, groups).length))}
          {hasUngrouped && tabBtn(UNGROUPED, "Ungrouped", "#6B7690", hostsInTab(UNGROUPED, hosts, groups).length)}
        </div>
      </div>

      {/* scope bar */}
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <div className="mr-auto flex min-w-0 flex-col">
          <h1 className="m-0 text-lg font-semibold">{scopeName}</h1>
          <span className="text-xs text-muted">
            {inScope.length} server{inScope.length === 1 ? "" : "s"}
            {stats.ok > 0 && ` · ${stats.ok} ok`}
            {stats.failed > 0 && ` · ${stats.failed} failed`}
            {stats.locked > 0 && ` · ${stats.locked} locked`}
            {stats.never > 0 && ` · ${stats.never} never synced`}
            {sync.lastDone && ` · last run ${ago(sync.lastDone.at, now)}${sync.lastDone.auto ? " (auto)" : ""}`}
          </span>
        </div>

        {sync.settings.paused && (
          <button onClick={() => void guard(sync.setSettings({ paused: false }))} className="flex h-8 items-center gap-1.5 rounded-full bg-[#44391A] px-3 text-xs text-[#F7CB6A]" title="Auto-sync is paused everywhere">
            <Pause size={12} /> Auto-sync paused · Resume
          </button>
        )}

        {running > 0 ? (
          <span className="flex items-center gap-2">
            <span className="flex h-8 items-center gap-2 rounded-md bg-accent-bg px-3 text-[13px]">
              <RefreshCw size={13} className="animate-spin text-accent" /> Syncing {inScope.length - running} of {inScope.length}…
            </span>
            <Button variant="ghost" className="px-2" title="Stop the queued servers" onClick={() => sync.cancelAll()}>
              <X size={14} />
            </Button>
          </span>
        ) : (
          <Button variant="primary" disabled={inScope.length === 0} onClick={() => void syncScope(tab)} title="One short connection per server; servers set to Never are skipped">
            <RefreshCw size={13} /> {tab === "all" ? "Sync all" : `Sync ${scopeName}`}
          </Button>
        )}

        <AutoSwitch
          state={switchState}
          onCount={onCount}
          total={targets.length}
          disabled={targets.length === 0}
          onToggle={() => (tab === "all" ? setConfirmAll(switchState !== "on") : void setSwitch(tab, switchState !== "on"))}
        />

        {(group || tab === UNGROUPED) && (
          <select
            aria-label="Auto-sync interval"
            className="h-8 rounded-md border border-line bg-bg px-2 text-[13px]"
            value={group ? String(group.refresh.interval_s ?? "") : String(sync.global.interval_s ?? 300)}
            onChange={(e) => {
              const v = e.target.value === "" ? null : Number(e.target.value);
              if (group) void setGroupInterval(group, v);
              else void guard(sync.setGlobal({ interval_s: v ?? 300 }));
            }}
          >
            {group && <option value="">Default ({intervalShort(sync.global.interval_s ?? 300)})</option>}
            {INTERVALS.map((i) => (
              <option key={i.s} value={i.s}>
                Every {i.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {confirmAll !== null && (
        <div className="mx-5 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-accent-line bg-accent-bg px-3 py-2 text-[13px]">
          <span className="flex-1">
            Turn auto-sync <b>{confirmAll ? "on" : "off"}</b> for every group ({targets.length})? Servers set to Never stay skipped. Intervals are kept.
          </span>
          <Button
            variant="primary"
            className="h-7"
            onClick={() => {
              void setSwitch("all", confirmAll);
              setConfirmAll(null);
            }}
          >
            Turn {confirmAll ? "on" : "off"} for all
          </Button>
          <Button variant="ghost" className="h-7" onClick={() => setConfirmAll(null)}>
            Cancel
          </Button>
        </div>
      )}

      {error && (
        <div className="mx-5 mb-3 flex items-center gap-2 rounded-lg border border-[#5A2D33] bg-[#33232A] px-3 py-2 text-xs text-prod-fg">
          <span className="flex-1">{error}</span>
          <button aria-label="Dismiss" onClick={() => setError(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-wrap items-start gap-4 px-5 pb-6">
        <div className="flex min-w-[300px] flex-[3] flex-col gap-3">
          {hosts.length === 0 ? (
            <Empty />
          ) : inScope.length === 0 ? (
            <p className="text-muted">No servers in this group.</p>
          ) : (
            <>
              {stats.never === inScope.length && running === 0 && (
                <p className="m-0 rounded-lg border border-line bg-panel px-3 py-2.5 text-xs leading-relaxed text-muted">
                  Nothing synced yet. <b className="text-text">Sync</b> fetches CPU, memory, disk and containers — one short connection per server, closed right after.
                  Turn <b className="text-text">Auto-sync</b> on to repeat it on an interval.
                </p>
              )}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
                {inScope.map((h) => (
                  <ServerCard key={h.id} host={h} now={now} onSync={() => void syncHost(h.id)} onMenu={menu.open} />
                ))}
              </div>
            </>
          )}
        </div>
        {inScope.length > 0 && <AttentionPanel items={attention} />}
      </div>
      {menu.node}
    </div>
  );
}

function AutoSwitch({ state, onCount, total, disabled, onToggle }: { state: "on" | "off" | "mixed"; onCount: number; total: number; disabled: boolean; onToggle: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={state === "mixed" ? "mixed" : state === "on"}
      disabled={disabled}
      onClick={onToggle}
      title={disabled ? "No groups yet" : "Sync on an interval while the app is open"}
      className="flex h-8 items-center gap-2 rounded-md border border-line px-2.5 text-[13px] disabled:opacity-40"
    >
      <span className="text-muted">Auto-sync</span>
      <span aria-hidden className={clsx("relative h-[18px] w-8 rounded-full transition-colors", state === "on" ? "bg-ok" : state === "mixed" ? "bg-warn" : "bg-line")}>
        <span
          className={clsx(
            "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all",
            state === "on" ? "left-[16px]" : state === "mixed" ? "left-[9px]" : "left-[2px]",
          )}
        />
      </span>
      <span className="min-w-[24px] text-xs">{state === "on" ? "On" : state === "off" ? "Off" : `Mixed ${onCount}/${total}`}</span>
    </button>
  );
}

function Bar({ label, value }: { label: string; value: number | null }) {
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  const color = v == null ? "bg-line" : v > 85 ? "bg-bad" : v > 70 ? "bg-warn" : "bg-accent";
  return (
    <div className="grid grid-cols-[34px_1fr_38px] items-center gap-2 text-xs">
      <span className="text-muted">{label}</span>
      <div className="h-1.5 rounded bg-line">
        <div className={clsx("h-1.5 rounded", color)} style={{ width: `${v ?? 0}%` }} />
      </div>
      <span className="text-right font-mono">{v == null ? "—" : `${Math.round(v)}%`}</span>
    </div>
  );
}

function ServerCard({
  host,
  now,
  onSync,
  onMenu,
}: {
  host: Host;
  now: number;
  onSync: () => void;
  onMenu: (items: MenuItem[] | (() => MenuItem[])) => (e: React.MouseEvent) => void;
}) {
  const snap: Snapshot | undefined = useSync((s) => s.snapshots[host.id]);
  const live = useSync((s) => s.live[host.id]);
  const settings = useSync((s) => s.settings);
  const global = useSync((s) => s.global);
  const groups = useHosts((s) => s.groups);
  const openServer = useTabs((s) => s.openServer);

  const eff = effectiveRefresh(host, groups, global);
  const auto = eff.mode === "auto" && switchOn(host, groups, settings);
  const m = snap?.metrics ?? null;
  const ram = m && m.ram_total_bytes ? (100 * m.ram_used_bytes) / m.ram_total_bytes : null;
  const age = ageClass(snap?.last_ok_at ?? null, now);
  const d = snap?.docker;

  const modePill =
    eff.mode === "never" ? "Never" : eff.mode === "manual" ? "Manual" : !auto ? "On demand" : `${eff.source === "host" ? "Own" : "Auto"} ${intervalShort(eff.interval_s)}`;

  let status: React.ReactNode;
  if (live === "running") status = <span className="flex items-center gap-1.5 text-accent"><RefreshCw size={11} className="animate-spin" /> Syncing…</span>;
  else if (live === "queued") status = <span className="text-muted">Queued…</span>;
  else if (!snap) status = <span className="text-muted">Never synced</span>;
  else if (snap.state === "locked") status = <span className="flex items-center gap-1.5 text-[#F7CB6A]" title={snap.error ?? ""}><Lock size={11} /> {snap.error ?? "Locked"}</span>;
  else if (snap.state === "failed")
    status = (
      <span className="truncate text-[#FF9C9C]" title={snap.error ?? ""}>
        Failed · {snap.error}
        {snap.last_ok_at ? ` · last ok ${ago(snap.last_ok_at, now)}` : ""}
      </span>
    );
  else status = <span className={age === "fresh" ? "text-muted" : "text-[#8A93A8]"}>Synced {ago(snap.taken_at, now)}</span>;

  const items: MenuItem[] = [
    { label: "Open", icon: <ExternalLink size={13} />, onClick: () => openServer(host.id) },
    { label: "Sync now", icon: <RefreshCw size={13} />, onClick: onSync, disabled: !!live },
    { label: "Open Docker", icon: <Box size={13} />, onClick: () => openServer(host.id, "docker") },
    { kind: "separator" },
    { label: "Edit server…", icon: <Pencil size={13} />, onClick: () => shellHooks.editHost(host) },
  ];

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openServer(host.id)}
      onKeyDown={(e) => e.key === "Enter" && openServer(host.id)}
      onContextMenu={onMenu(items)}
      className={clsx(
        "group flex cursor-pointer flex-col gap-2.5 rounded-xl border bg-panel p-4 text-left transition-opacity hover:border-accent-line",
        snap?.state === "failed" ? "border-[#5A2D33]" : "border-line",
        !live && (age === "stale" ? "opacity-85" : age === "old" ? "opacity-60 grayscale-[40%]" : ""),
      )}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={clsx(
            "h-2 w-2 flex-none rounded-full",
            !snap ? "bg-[#6B7690]" : snap.state === "ok" ? (age === "fresh" ? "bg-ok" : "bg-[#4E8F72]") : snap.state === "locked" ? "bg-warn" : "bg-bad",
          )}
        />
        <span className="truncate font-semibold">{host.name}</span>
        <EnvTag env={host.env_label} />
        <button
          aria-label={`Sync ${host.name}`}
          title={eff.mode === "never" ? "Sync now (this server is set to Never for group syncs)" : "Sync now"}
          disabled={!!live}
          onClick={(e) => {
            e.stopPropagation();
            onSync();
          }}
          className="ml-auto grid h-7 w-7 flex-none place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text disabled:opacity-40"
        >
          <RefreshCw size={13} className={clsx(live === "running" && "animate-spin")} />
        </button>
      </div>
      <span className="-mt-1.5 truncate font-mono text-xs text-muted">
        {host.address}
        {snap?.os ? ` · ${snap.os}` : ""}
      </span>
      <div className="flex flex-col gap-1.5">
        <Bar label="CPU" value={m?.cpu_pct ?? null} />
        <Bar label="RAM" value={ram} />
        <Bar label="Disk" value={m?.disk_pct ?? null} />
      </div>
      {d && (
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <Box size={12} />
          {d.error ? (
            <span className="truncate" title={d.error}>{d.error}</span>
          ) : (
            <>
              {d.running}/{d.total} running
              {d.restarting.length > 0 && <span className="text-[#FF9C9C]">· {d.restarting.length} restarting</span>}
              {d.unhealthy.length > 0 && <span className="text-[#F7CB6A]">· {d.unhealthy.length} unhealthy</span>}
            </>
          )}
        </span>
      )}
      {snap?.failed_services && snap.failed_services.length > 0 && (
        <span className="flex items-center gap-1.5 text-xs text-[#FF9C9C]">
          <Wrench size={12} /> {snap.failed_services.length} failed service{snap.failed_services.length === 1 ? "" : "s"}
        </span>
      )}
      <div className="mt-auto flex items-center gap-2 border-t border-[#303A4E] pt-2 text-xs">
        <span className="min-w-0 flex-1 truncate">{status}</span>
        <span
          className={clsx("flex-none rounded-full px-2 py-0.5 text-[11px]", auto ? "bg-[#1e3d33] text-[#86E0B6]" : "bg-panel2 text-muted")}
          title={`Mode from ${eff.source === "host" ? "this server" : eff.source === "group" ? "its group" : "Settings"}`}
        >
          {modePill}
        </span>
      </div>
    </div>
  );
}

function AttentionPanel({ items }: { items: Attention[] }) {
  const openServer = useTabs((s) => s.openServer);
  const hosts = useHosts((s) => s.hosts);
  const icon = (a: Attention) =>
    a.kind === "offline" ? <ServerOff size={14} /> : a.kind === "locked" ? <Lock size={14} /> : a.kind === "container" ? <Box size={14} /> : a.kind === "disk" ? <HardDrive size={14} /> : a.kind === "service" ? <Wrench size={14} /> : <Cpu size={14} />;
  return (
    <aside className="flex min-w-[260px] flex-1 flex-col rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-xs font-semibold text-muted">
        <AlertTriangle size={13} /> Needs attention <span className="font-normal">· from last sync</span>
        <span className="ml-auto rounded-full bg-panel2 px-2 font-normal">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="m-0 px-4 py-4 text-xs text-muted">All clear in the last sync.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-1">
          {items.map((a, i) => (
            <li key={`${a.hostId}-${a.kind}-${i}`}>
              <button
                onClick={() => hosts.some((h) => h.id === a.hostId) && openServer(a.hostId, a.view)}
                className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-panel2"
              >
                <span className={clsx("mt-0.5", a.severity === "bad" ? "text-bad" : "text-warn")}>{icon(a)}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px]">{a.title}</span>
                  <span className="truncate text-xs text-muted">{a.detail}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line p-6">
      <p className="m-0 text-muted">No servers yet. Add one and it shows up here.</p>
      <Button variant="primary" onClick={() => shellHooks.newHost()}>
        <Plus size={13} /> Add server
      </Button>
    </div>
  );
}

