import { useMemo, useState } from "react";
import clsx from "clsx";
import { Box, Database, Loader2, Play, RotateCw, ScrollText, Search, Square, SquareTerminal, Trash2, X, Zap } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { Container } from "../../ipc/bindings/Container";
import { askConfirm } from "../../stores/dialogs";
import { isProblem, statsFor, useDocker } from "../../stores/docker";
import { useHosts } from "../../stores/hosts";
import { useSql } from "../../stores/sql";
import { isDatabaseImage } from "../sql/shortcuts";
import { streamKey, useLogs } from "../../stores/logs";
import { useTabs } from "../../stores/tabs";
import { LogViewer } from "../logs/LogViewer";
import { appliesToContainer, useSnippets } from "../../stores/snippets";
import { askText } from "../../stores/dialogs";
import { runInContainer } from "../snippets/run";
import { shellQuote } from "../files/quote";
import { terminalRegistry } from "../server-tab/terminal/registry";

type Act = "start" | "stop" | "restart" | "kill" | "remove";

/**
 * Loads on first open (docker ps), then updates only from `docker events`.
 * Live CPU/RAM and the logs panel run only while this view is visible.
 */
export function DockerView({ hostId }: { hostId: string }) {
  const d = useDocker((s) => s.byHost[hostId]);
  const select = useDocker((s) => s.select);
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const [q, setQ] = useState("");
  const [problems, setProblems] = useState(false);
  const [busy, setBusy] = useState<Record<string, Act | "sql" | undefined>>({});
  const [err, setErr] = useState<string | null>(null);

  const containers = d?.containers ?? [];
  const f = q.trim().toLowerCase();
  const visible = containers.filter(
    (c) => (!problems || isProblem(c)) && (!f || c.name.toLowerCase().includes(f) || c.image.toLowerCase().includes(f) || (c.project ?? "").includes(f)),
  );
  const groups = useMemo(() => {
    const m = new Map<string, Container[]>();
    for (const c of visible) {
      const k = c.project ?? "";
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [visible]);

  const running = containers.filter((c) => c.state === "running").length;
  const problemCount = containers.filter(isProblem).length;
  const selected = containers.find((c) => c.id === d?.selected) ?? null;
  const prod = host?.env_label === "prod";

  const act = async (c: Container, a: Act) => {
    const dangerous = a === "remove" || a === "kill" || (prod && a !== "start");
    if (dangerous) {
      const ok = await askConfirm({
        title: `${a === "remove" ? "Remove" : a[0].toUpperCase() + a.slice(1)} ${c.name}?`,
        body:
          a === "remove"
            ? "The container is deleted (its image and named volumes stay)."
            : prod
              ? `This is a PRODUCTION server (${host?.name}).`
              : undefined,
        preview: `docker ${a === "remove" ? "rm" : a} ${c.name}`,
        confirmLabel: a === "remove" ? "Remove container" : `${a[0].toUpperCase() + a.slice(1)}`,
        danger: true,
      });
      if (!ok) return;
    }
    setErr(null);
    setBusy((b) => ({ ...b, [c.id]: a }));
    try {
      await api.dockerAction(hostId, c.id, a);
    } catch (e) {
      setErr(`${c.name}: ${asCoreError(e).message}`);
    } finally {
      setBusy((b) => ({ ...b, [c.id]: undefined }));
    }
  };

  /** One `docker inspect`, then the server's Database view opens prefilled (it asks for the password). */
  const openInSql = async (c: Container) => {
    setErr(null);
    setBusy((b) => ({ ...b, [c.id]: "sql" }));
    try {
      const p = await api.sqlDockerInspect(hostId, c.name);
      useSql.getState().setServerPrefill(hostId, p);
      useTabs.getState().setView(hostId, "database");
    } catch (e) {
      setErr(`${c.name}: ${asCoreError(e).message}`);
    } finally {
      setBusy((b) => ({ ...b, [c.id]: undefined }));
    }
  };

  const shell = (c: Container) => {
    const key = useTabs.getState().addTerminal(hostId, { container: c.name, title: c.name });
    if (key) setTimeout(() => terminalRegistry.focus(key), 50);
  };

  if (!d?.at) {
    return (
      <div className="grid h-full place-items-center bg-bg text-muted">
        <span className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading containers…
        </span>
      </div>
    );
  }

  if (d.error && containers.length === 0) {
    return (
      <div className="grid h-full place-items-center bg-bg p-6">
        <div className="max-w-md text-center">
          <Box size={26} className="mx-auto mb-3 text-muted" />
          <p className="m-0 leading-relaxed text-muted">{d.error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-3 bg-bg p-3">
      <section aria-label="Containers" className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-2.5">
          <h2 className="m-0 text-sm font-semibold">Containers</h2>
          <span className="text-xs text-muted">
            {running} running · {containers.length - running} stopped
          </span>
          {problemCount > 0 && (
            <button onClick={() => setProblems(!problems)} className={clsx("h-6 rounded-full px-2.5 text-xs", problems ? "bg-[#352F20] text-[#F7CB6A]" : "border border-[#6A5828] text-[#F7CB6A]")}>
              Problems {problemCount}
            </button>
          )}
          {d.error && <span className="text-xs text-[#F7CB6A]">{d.error}</span>}
          <label className="ml-auto flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-muted">
            <Search size={12} />
            <input aria-label="Filter containers" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} className="w-32 bg-transparent text-xs text-text outline-none" />
          </label>
        </div>
        {err && <div className="border-b border-[#5A2D33] bg-[#33232A] px-3.5 py-2 text-xs text-[#FFA8A8]">{err}</div>}
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="min-w-[640px]">
            <div className="grid grid-cols-[minmax(0,1.7fr)_minmax(0,1.3fr)_60px_120px_182px] gap-x-3 px-3.5 py-2 text-[11px] tracking-wider text-muted uppercase">
              <span>Name</span>
              <span>Image</span>
              <span className="text-right">CPU</span>
              <span className="text-right">Memory</span>
              <span className="text-right">Actions</span>
            </div>
            {groups.map(([project, list]) => (
              <div key={project || "_standalone"}>
                <div className="flex items-center gap-2 border-y border-line bg-panel2 px-3.5 py-1.5 text-xs">
                  <Box size={13} className="text-accent" />
                  <span className="font-semibold">{project || "Standalone"}</span>
                  <span className="text-muted">{project ? "compose" : ""} · {list.length}</span>
                </div>
                {list.map((c) => {
                  const st = statsFor(d, c);
                  const run = c.state === "running";
                  const b = busy[c.id];
                  return (
                    <div
                      key={c.id}
                      onClick={() => select(hostId, c.id)}
                      className={clsx(
                        "grid h-[42px] cursor-pointer grid-cols-[minmax(0,1.7fr)_minmax(0,1.3fr)_60px_120px_182px] items-center gap-x-3 border-b border-[#303A4E] px-3.5",
                        selected?.id === c.id ? "bg-[#26385A]" : "hover:bg-panel2",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Dot c={c} />
                        <span className="truncate font-medium">{c.name}</span>
                        <span className={clsx("truncate text-[11px]", isProblem(c) ? "text-[#F7CB6A]" : "text-muted")} title={c.status}>
                          {c.health === "unhealthy" ? "unhealthy" : c.state === "running" ? (c.health ?? "") : c.status.replace(/ ago$/, "")}
                        </span>
                      </span>
                      <span className="truncate font-mono text-xs text-muted" title={c.image}>
                        {c.image}
                      </span>
                      <span className="text-right font-mono text-xs">{run && st ? `${st.cpu_pct.toFixed(1)}%` : "—"}</span>
                      <span className="truncate text-right font-mono text-xs" title={st?.mem_usage}>
                        {run && st ? st.mem_usage.split(" / ")[0] : "—"}
                      </span>
                      <span className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                        <Btn label="Logs" onClick={() => select(hostId, c.id)}>
                          <ScrollText size={14} />
                        </Btn>
                        <Btn label="Shell in container (opens a terminal in this tab)" onClick={() => shell(c)} disabled={!run}>
                          <SquareTerminal size={14} />
                        </Btn>
                        {isDatabaseImage(c.image) && (
                          <Btn label="Open in SQL (this server's Database view)" onClick={() => void openInSql(c)} disabled={!run || !!b}>
                            {b === "sql" ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
                          </Btn>
                        )}
                        <Btn label="Restart" onClick={() => void act(c, "restart")} disabled={!!b}>
                          {b === "restart" ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
                        </Btn>
                        {run ? (
                          <Btn label="Stop" onClick={() => void act(c, "stop")} disabled={!!b}>
                            {b === "stop" ? <Loader2 size={14} className="animate-spin" /> : <Square size={13} />}
                          </Btn>
                        ) : (
                          <Btn label="Start" onClick={() => void act(c, "start")} disabled={!!b}>
                            {b === "start" ? <Loader2 size={14} className="animate-spin" /> : <Play size={13} />}
                          </Btn>
                        )}
                        <Btn label="Remove" onClick={() => void act(c, "remove")} disabled={!!b || run}>
                          <Trash2 size={13} />
                        </Btn>
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
            {containers.length === 0 && <div className="px-4 py-6 text-center text-muted">No containers on this server.</div>}
          </div>
        </div>
      </section>

      {selected && (
        <div className="flex w-[44%] min-w-[340px] flex-col overflow-hidden rounded-xl border border-line">
          <ContainerLogs hostId={hostId} container={selected} onClose={() => select(hostId, null)} />
        </div>
      )}
    </div>
  );
}

function QuickCommands({ hostId, container }: { hostId: string; container: Container }) {
  const snippets = useSnippets((s) => s.list);
  const mine = snippets.filter((s) => appliesToContainer(s, container));
  const running = container.state === "running";
  const adHoc = async () => {
    const cmd = await askText({ title: `Run in ${container.name}`, label: "Command (runs with sh -lc in a new terminal)", value: "", confirmLabel: "Run" });
    if (!cmd) return;
    const key = useTabs.getState().addTerminal(hostId, { title: `@ ${container.name}` });
    if (!key) return;
    terminalRegistry.runCommand(key, `docker exec -it ${container.name} sh -lc ${shellQuote(cmd)}`);
    setTimeout(() => terminalRegistry.focus(key), 50);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-panel px-3 py-1.5">
      <span className="mr-1 flex items-center gap-1 text-[11px] text-muted">
        <Zap size={11} /> In container
      </span>
      {mine.map((s) => (
        <button
          key={s.id}
          disabled={!running}
          title={s.command}
          onClick={() => void runInContainer(s, hostId, container.name)}
          className="h-6 rounded-md border border-line bg-panel2 px-2 font-mono text-[11px] text-accent hover:border-accent-line"
        >
          {s.alias ?? s.name}
        </button>
      ))}
      <button disabled={!running} onClick={() => void adHoc()} className="h-6 rounded-md border border-dashed border-line px-2 text-[11px] text-muted hover:text-text">
        Run…
      </button>
      {mine.length === 0 && <span className="text-[11px] text-muted">Add snippets with “Inside containers” scope to see them here.</span>}
    </div>
  );
}

function ContainerLogs({ hostId, container, onClose }: { hostId: string; container: Container; onClose: () => void }) {
  const stream = useLogs((s) => s.streams[streamKey(hostId, `docker:${container.id}`)]);
  const clear = useLogs((s) => s.clear);
  return (
    <div className="flex h-full min-h-0 flex-col">
    <QuickCommands hostId={hostId} container={container} />
    <div className="min-h-0 flex-1">
    <LogViewer
      title={
        <span>
          Logs <span className="ml-1 font-mono text-xs font-normal text-accent">{container.name}</span>
        </span>
      }
      lines={stream?.lines ?? []}
      ended={stream?.ended ?? null}
      live
      onClear={() => clear(hostId, `docker:${container.id}`)}
      actions={
        <button aria-label="Close logs" title="Close logs" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-md border border-line text-muted hover:text-text">
          <X size={13} />
        </button>
      }
    />
    </div>
    </div>
  );
}

function Dot({ c }: { c: Container }) {
  const color =
    c.state === "running" ? (c.health === "unhealthy" ? "bg-bad" : c.health === "starting" ? "bg-warn" : "bg-ok") : c.state === "restarting" ? "bg-warn" : isProblem(c) ? "bg-bad" : "bg-[#6B7690]";
  return <span aria-label={c.state} className={clsx("h-2 w-2 flex-none rounded-full", color)} />;
}

function Btn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} disabled={disabled} className="grid h-[30px] w-[30px] place-items-center rounded-md text-muted hover:bg-line hover:text-text">
      {children}
    </button>
  );
}
