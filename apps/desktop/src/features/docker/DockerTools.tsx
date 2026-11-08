// Docker view extras: auto sudo for the server, and "Download logs" (chosen containers and period → zip).
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Download, Loader2, ShieldCheck, X } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { Container } from "../../ipc/bindings/Container";
import type { LogExportJob } from "../../ipc/bindings/LogExportJob";
import { useDocker, useDockerSudo, useLogExports } from "../../stores/docker";
import { useHosts } from "../../stores/hosts";
import { Button, Field, Modal, Select, TextInput } from "../../ui/primitives";
import { dateInputValue } from "../logs/history";

// ------------------------------------------------------------------ sudo

/** Turn auto sudo on (optionally with a password) or off for one server. */
export function SudoDialog({ hostId, onClose }: { hostId: string; onClose: () => void }) {
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const state = useDockerSudo((s) => s.byHost[hostId]);
  const [password, setPassword] = useState("");
  const [savePw, setSavePw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void useDockerSudo.getState().load(hostId);
  }, [hostId]);

  const apply = async (enabled: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await useDockerSudo.getState().set(hostId, enabled, enabled ? password : undefined, enabled && savePw && !!password);
      // A stopped Docker view (permission error) starts again; running collectors were restarted in the core.
      if (useDocker.getState().byHost[hostId]?.error) useDocker.getState().forget(hostId);
      onClose();
    } catch (e) {
      setErr(asCoreError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const on = !!state?.enabled;
  // Paused after a refused password: saving again needs a new one (no silent retry of the wrong one).
  const needsNew = on && !!state?.error && !password;
  return (
    <Modal
      title={`Use sudo on ${host?.name ?? "this server"}`}
      onClose={onClose}
      width={500}
      footer={
        <>
          {on && (
            <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => void apply(false)}>
              Turn off
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || needsNew} onClick={() => void apply(true)}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {on ? "Save" : "Use sudo"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!needsNew) void apply(true);
        }}
      >
        <p className="m-0 text-[13px] leading-relaxed text-muted">
          Docker on this server runs as <code className="font-mono text-text">sudo docker</code>, and this server's terminals fill the{" "}
          <code className="font-mono text-text">[sudo]</code> password prompt of commands that run sudo. Saving files with sudo in the editor still asks first.
        </p>
        <p className="m-0 rounded-md border border-[#6A5828] bg-[#352F20] px-3 py-2 text-xs leading-relaxed text-[#F7CB6A]">
          <code className="font-mono">sudo docker</code> has full root access to the server. Adding your login to the <code className="font-mono">docker</code> group
          is the long-term fix.
        </p>
        {state?.error && <p className="m-0 rounded-md border border-[#5A2D33] bg-[#33232A] px-3 py-2 text-xs text-[#FFA8A8]">{state.error}</p>}
        <Field
          label={state?.has_password ? "Password (optional: the login's saved password is used)" : "sudo password"}
          hint={
            needsNew || (on && state?.error)
              ? "Type the correct password. To retry the same one, turn sudo off and on again."
              : state?.has_password
                ? "Type one only to use a different password."
                : "Leave empty if sudo needs no password on this server (NOPASSWD)."
          }
        >
          <TextInput type="password" autoFocus autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <label className={clsx("flex items-center gap-2 text-xs", !password && "opacity-50")}>
          <input type="checkbox" disabled={!password} checked={savePw} onChange={(e) => setSavePw(e.target.checked)} />
          Save it as this login's sudo password (otherwise it is forgotten when Rookery locks or quits)
        </label>
        {err && <p className="m-0 text-xs text-[#FFA8A8]">{err}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Header button: shows whether auto sudo is on and opens [`SudoDialog`]. */
export function SudoButton({ hostId, onOpen }: { hostId: string; onOpen: () => void }) {
  const state = useDockerSudo((s) => s.byHost[hostId]);
  useEffect(() => {
    void useDockerSudo.getState().load(hostId);
  }, [hostId]);
  const on = !!state?.enabled;
  return (
    <button
      onClick={onOpen}
      title={on ? (state?.error ?? "Docker runs with sudo on this server") : "Use sudo for Docker on this server"}
      className={clsx(
        "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs",
        on ? (state?.error ? "border-[#6A5828] text-[#F7CB6A]" : "border-accent-line bg-accent-bg text-text") : "border-line text-muted hover:text-text",
      )}
    >
      <ShieldCheck size={12} className={on && !state?.error ? "text-accent" : undefined} /> sudo{on ? (state?.error ? " paused" : " on") : ""}
    </button>
  );
}

// ------------------------------------------------------------- download logs

type Period = "15m" | "1h" | "6h" | "24h" | "7d" | "all" | "custom";
const PERIODS: { id: Period; label: string; ms?: number }[] = [
  { id: "15m", label: "Last 15 minutes", ms: 15 * 60_000 },
  { id: "1h", label: "Last hour", ms: 3_600_000 },
  { id: "6h", label: "Last 6 hours", ms: 6 * 3_600_000 },
  { id: "24h", label: "Last 24 hours", ms: 24 * 3_600_000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 24 * 3_600_000 },
  { id: "all", label: "Everything Docker keeps" },
  { id: "custom", label: "Choose time…" },
];

/** The chosen period as RFC 3339 (null = open end). */
export function periodRange(period: Period, from: string, to: string, now = Date.now()): { since: string | null; until: string | null } | null {
  if (period === "all") return { since: null, until: null };
  if (period === "custom") {
    const a = new Date(from);
    const b = new Date(to);
    if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()) || a >= b) return null;
    return { since: a.toISOString(), until: b.toISOString() };
  }
  const ms = PERIODS.find((p) => p.id === period)?.ms ?? 3_600_000;
  return { since: new Date(now - ms).toISOString(), until: null };
}

const stamp = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;

export function DownloadLogsDialog({ hostId, containers, preselect, onClose }: { hostId: string; containers: Container[]; preselect: string | null; onClose: () => void }) {
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(preselect ? [preselect] : containers.map((c) => c.id)));
  const [q, setQ] = useState("");
  const [period, setPeriod] = useState<Period>("24h");
  const [from, setFrom] = useState(() => dateInputValue(new Date(Date.now() - 24 * 3_600_000)));
  const [to, setTo] = useState(() => dateInputValue(new Date()));
  const [timestamps, setTimestamps] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const f = q.trim().toLowerCase();
  const shown = useMemo(
    () => containers.filter((c) => !f || c.name.toLowerCase().includes(f) || (c.project ?? "").toLowerCase().includes(f) || c.image.toLowerCase().includes(f)),
    [containers, f],
  );
  const picked = containers.filter((c) => chosen.has(c.id));
  const range = periodRange(period, from, to);
  const toggle = (id: string) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const start = async () => {
    if (!range || picked.length === 0) return;
    setErr(null);
    const name = (host?.name ?? "server").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
    const path = await saveDialog({ defaultPath: `${name}-docker-logs-${stamp(new Date())}.zip`, filters: [{ name: "Zip archive", extensions: ["zip"] }] });
    if (!path) return;
    // "Last hour" means the hour before Download is clicked (the dialogs may stay open a while).
    const now = periodRange(period, from, to);
    if (!now) return;
    setBusy(true);
    try {
      await api.dockerLogsExport({
        host_id: hostId,
        containers: picked.map((c) => ({ id: c.id, name: c.name })),
        since: now.since,
        until: now.until,
        timestamps,
        path: path.toLowerCase().endsWith(".zip") ? path : `${path}.zip`,
      });
      onClose(); // progress shows in the Docker view header
    } catch (e) {
      setErr(asCoreError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Download logs"
      onClose={onClose}
      width={560}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-muted">
            {picked.length} of {containers.length} containers
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !range || picked.length === 0} onClick={() => void start()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Download zip…
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Period">
          <Select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        {period === "custom" && (
          <>
            <Field label="From">
              <TextInput aria-label="From" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Until">
              <TextInput aria-label="Until" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </>
        )}
      </div>
      {!range && <p className="m-0 text-xs text-[#FFA8A8]">Choose a start time before the end time.</p>}
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
        Add Docker's timestamp to every line
      </label>
      <div className="flex flex-col overflow-hidden rounded-lg border border-line">
        <div className="flex items-center gap-2 border-b border-line bg-panel2 px-2.5 py-1.5 text-xs">
          <input aria-label="Filter containers" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 bg-transparent text-text outline-none" />
          <button className="text-accent" onClick={() => setChosen(new Set(containers.map((c) => c.id)))}>
            All
          </button>
          <button className="text-accent" onClick={() => setChosen(new Set(containers.filter((c) => c.state === "running").map((c) => c.id)))}>
            Running
          </button>
          <button className="text-accent" onClick={() => setChosen(new Set())}>
            None
          </button>
        </div>
        <div className="max-h-[260px] overflow-auto">
          {shown.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center gap-2 border-b border-[#303A4E] px-2.5 py-1.5 text-xs last:border-b-0 hover:bg-panel2">
              <input type="checkbox" checked={chosen.has(c.id)} onChange={() => toggle(c.id)} />
              <span className="truncate font-medium">{c.name}</span>
              {c.project && <span className="truncate text-muted">{c.project}</span>}
              <span className={clsx("ml-auto flex-none text-[11px]", c.state === "running" ? "text-ok" : "text-muted")}>{c.state}</span>
            </label>
          ))}
          {shown.length === 0 && <div className="px-3 py-4 text-center text-xs text-muted">No containers match.</div>}
        </div>
      </div>
      <p className="m-0 text-[11px] leading-relaxed text-muted">
        Containers are read one at a time, straight into the zip. Only what Docker still keeps can be included: rotated logs and log drivers that send logs elsewhere
        are listed in manifest.txt.
      </p>
      {err && <p className="m-0 text-xs text-[#FFA8A8]">{err}</p>}
    </Modal>
  );
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

/** Running and finished exports of this server, under the Docker header. */
export function LogExportStatus({ hostId }: { hostId: string }) {
  const all = useLogExports((s) => s.jobs);
  const jobs = Object.values(all).filter((j) => j.host_id === hostId);
  if (jobs.length === 0) return null;
  return (
    <div className="flex flex-col border-b border-line">
      {jobs.map((j) => (
        <ExportRow key={j.id} job={j} />
      ))}
    </div>
  );
}

function ExportRow({ job }: { job: LogExportJob }) {
  const dismiss = useLogExports((s) => s.dismiss);
  const running = job.state === "running";
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  return (
    <div className={clsx("flex items-center gap-2 px-3.5 py-1.5 text-xs", job.state === "failed" ? "bg-[#33232A] text-[#FFA8A8]" : "bg-panel2")}>
      {running ? <Loader2 size={12} className="animate-spin text-accent" /> : <Download size={12} className="text-muted" />}
      <span className="min-w-0 flex-1 truncate">
        {running && `Downloading logs: ${job.current ?? "starting"} (${Math.min(job.done + 1, job.total)} of ${job.total}) · ${size(job.bytes)}`}
        {job.state === "done" && `Logs saved (${job.total} containers, ${size(job.bytes)})${job.failed.length ? ` · not readable: ${job.failed.join(", ")}` : ""}`}
        {job.state === "cancelled" && "Log download cancelled; nothing was saved."}
        {job.state === "failed" && `Log download failed: ${job.error ?? "unknown error"}`}
      </span>
      {running && (
        <span className="h-1.5 w-24 flex-none overflow-hidden rounded-full bg-line" aria-label={`${pct}%`}>
          <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
        </span>
      )}
      {running && (
        <button className="text-accent" onClick={() => void api.dockerLogsExportCancel(job.id)}>
          Cancel
        </button>
      )}
      {job.state === "done" && (
        <button className="text-accent" onClick={() => void revealItemInDir(job.path).catch(() => {})}>
          Show in folder
        </button>
      )}
      {!running && (
        <button aria-label="Dismiss" onClick={() => dismiss(job.id)} className="text-muted hover:text-text">
          <X size={12} />
        </button>
      )}
    </div>
  );
}
