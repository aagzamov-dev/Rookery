import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Loader2, MoreHorizontal, X } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { DatabaseBackup } from "../../ipc/bindings/DatabaseBackup";
import type { DatabaseFile } from "../../ipc/bindings/DatabaseFile";
import type { DatabaseFileInfo } from "../../ipc/bindings/DatabaseFileInfo";
import type { DatabaseOperation } from "../../ipc/bindings/DatabaseOperation";
import type { DumpFormat } from "../../ipc/bindings/DumpFormat";
import type { TableMode } from "../../ipc/bindings/TableMode";
import type { TableSelection } from "../../ipc/bindings/TableSelection";
import { terminalDatabaseJob, useDatabaseFiles } from "../../stores/databaseFiles";
import { askConfirm } from "../../stores/dialogs";
import { useSql } from "../../stores/sql";
import { Button, Field, Modal, Select, TextInput } from "../../ui/primitives";
import { ContextMenu, type MenuItem } from "../../ui/ContextMenu";
import { mb, tableKey, tableTotals } from "./dumpSelection";

type Mode = "export" | "import" | "backups";

export function DatabaseFiles({ sessionId, enabled, active = true, requestsActive = active, actions = [] }: { sessionId: string; enabled: boolean; active?: boolean; requestsActive?: boolean; actions?: MenuItem[] }) {
  const menuButton = useRef<HTMLButtonElement>(null);
  const operationLog = useRef<HTMLPreElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { if (!active) setMenu(null); }, [active]);
  const meta = useSql((s) => s.sessions[sessionId]);
  const jobs = useDatabaseFiles((s) => s.jobs);
  const dismissed = useDatabaseFiles((s) => s.dismissed);
  const sessionJobs = Object.values(jobs).filter((entry) => entry.session_id === sessionId);
  const job = sessionJobs.find((entry) => entry.state === "running") ?? sessionJobs.reduce<(typeof sessionJobs)[number] | undefined>((latest, entry) => !latest || entry.started_at >= latest.started_at ? entry : latest, undefined);
  useEffect(() => {
    const log = operationLog.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [job?.log]);
  const running = job?.state === "running";
  const globalRunning = Object.values(jobs).some((j) => j.state === "running");
  const [mode, setMode] = useState<Mode | null>(null);
  const [info, setInfo] = useState<DatabaseFileInfo | null>(null);
  const [backups, setBackups] = useState<DatabaseBackup[]>([]);
  const [selection, setSelection] = useState<TableSelection[]>([]);
  const [search, setSearch] = useState("");
  const [location, setLocation] = useState<"local" | "server">("local");
  const [path, setPath] = useState("");
  const generatedPath = useRef<string | null>(null);
  const [format, setFormat] = useState<DumpFormat>("sql");
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState<"confirming" | "submitting" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!mode || !running || !enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [mode, running, enabled]);
  const current = useRef({ sessionId, enabled, requestsActive });
  current.current = { sessionId, enabled, requestsActive };
  const generation = useRef(0);
  useEffect(() => {
    if (!enabled) { generation.current += 1; setMode(null); setBusy(false); setStarting(null); }
    return () => { generation.current += 1; };
  }, [enabled, sessionId]);
  const close = () => { generation.current += 1; setMode(null); setBusy(false); setStarting(null); };

  const load = async (next: Mode) => {
    if (!current.current.enabled || !current.current.requestsActive || busy || starting) return;
    const request = ++generation.current;
    const active = () => request === generation.current && current.current.enabled && current.current.sessionId === sessionId;
    setMode(next); setInfo(null); setBackups([]); setSelection([]); setError(null); setSearch(""); setPath(""); setTrusted(false); setBusy(true);
    try {
      const statuses = await api.databaseFileStatus();
      if (!active()) return;
      for (const status of statuses) useDatabaseFiles.getState().received(status);
      if (Object.values(useDatabaseFiles.getState().jobs).some((status) => status.state === "running")) return;
      if (!current.current.requestsActive) return;
      const details = await api.databaseFileInfo(sessionId, next === "export");
      if (!active()) return;
      setInfo(details); setLocation("local"); setFormat(details.engine === "postgres" ? "postgres_archive" : next === "export" ? "sql_gzip" : "sql");
      setSelection(details.tables.map((table) => ({ schema: table.schema, name: table.name, mode: "data" })));
      if (next === "backups" && current.current.requestsActive) { const records = await api.databaseBackups(sessionId); if (active()) setBackups(records); }
    } catch (e) { if (active()) setError(asCoreError(e).message); } finally { if (request === generation.current && current.current.sessionId === sessionId) setBusy(false); }
  };
  const pickFile = async () => {
    const request = generation.current;
    try {
      const defaultPath = `${info?.database ?? "database"}-${Date.now()}.${info?.engine === "postgres" ? "dump" : format === "sql_gzip" ? "sql.gz" : "sql"}`;
      const result = mode === "export"
        ? await save({ defaultPath })
        : await open({ multiple: false, directory: false });
      if (request === generation.current && current.current.enabled && typeof result === "string") {
        setPath(result);
        generatedPath.current = mode === "export" && result.split(/[\\/]/).at(-1) === defaultPath ? result : null;
        if (mode === "import") setFormat(result.toLowerCase().endsWith(".gz") ? "sql_gzip" : info?.engine === "postgres" && !result.toLowerCase().endsWith(".sql") ? "postgres_archive" : "sql");
      }
    } catch (e) { setError(asCoreError(e).message); }
  };
  const start = async (operation: DatabaseOperation) => {
    if (starting || !info || !current.current.enabled || !current.current.requestsActive) return;
    const request = generation.current;
    setStarting("confirming"); setError(null);
    try {
      const destructive = operation.kind === "import" || operation.kind === "restore" || operation.kind === "delete";
      const remoteWrite = operation.kind === "export" && info.server_files;
      let confirmed = false;
      if (destructive || (remoteWrite && info.production)) {
        confirmed = await askConfirm({
          title: `${operation.kind === "delete" ? "Delete backup" : operation.kind === "export" ? "Write server backup" : "Import into database"} · ${info.database}${info.production ? " (PROD)" : ""}?`,
          body: operation.kind === "delete" ? "The recorded backup file will be permanently deleted after its checksum is checked."
            : remoteWrite ? `Run the dump on the connection's SSH server using private staging, then save ${path}.`
            : `Target connection: ${info.target}. Native imports apply changes immediately and may leave partial changes on error or cancellation. Dump SQL can change databases or run other commands with your database account and local client privileges. Rookery cannot confine arbitrary dumps to this target or roll them back.`,
          preview: operation.kind === "import" ? operation.file.path : operation.kind === "restore" ? backups.find((b) => b.id === operation.backup_id)?.file.path : undefined,
          confirmLabel: operation.kind === "delete" ? "Delete backup" : remoteWrite ? "Write backup" : "Import / restore",
          danger: true,
          typeToConfirm: info.production ? info.database : undefined,
        });
        if (!confirmed) return;
      }
      if (request !== generation.current || !current.current.enabled || !current.current.requestsActive || current.current.sessionId !== sessionId) return;
      setStarting("submitting");
      await api.databaseFileStart(sessionId, operation, confirmed);
      if (request !== generation.current || !current.current.enabled || !current.current.requestsActive) return;
      for (const status of await api.databaseFileStatus()) useDatabaseFiles.getState().received(status);
    } catch (e) { setError(asCoreError(e).message); } finally { setStarting(null); }
  };
  const download = async (backup: DatabaseBackup) => {
    try {
      const target = await save({ defaultPath: backup.file.path.split(/[\\/]/).at(-1) });
      if (target) await start({ kind: "download", backup_id: backup.id, path: target });
    } catch (e) { setError(asCoreError(e).message); }
  };
  const changeFormat = (next: DumpFormat) => {
    if (mode === "export" && generatedPath.current === path) {
      const nextPath = path.replace(/\.sql(?:\.gz)?$/i, next === "sql_gzip" ? ".sql.gz" : ".sql");
      setPath(nextPath); generatedPath.current = nextPath;
    }
    setFormat(next);
  };
  const file: DatabaseFile = { location, path };
  const totals = info ? tableTotals(info.tables, selection) : null;
  const selectedModes = new Map(selection.map((table) => [tableKey(table), table.mode]));
  const selected = selection.filter((table) => table.mode !== "exclude").length;
  const changeAll = (value: TableMode) => setSelection((tables) => tables.map((table) => ({ ...table, mode: value })));
  const changeTable = (key: string, value: TableMode) => setSelection((tables) => tables.map((table) => tableKey(table) === key ? { ...table, mode: value } : table));
  const formatPathMismatch = mode === "export" && info?.engine === "mysql" && (format === "sql_gzip" ? /\.sql$/i.test(path) : /\.gz$/i.test(path));
  const canStart = !formatPathMismatch && enabled && requestsActive && !busy && !starting && !globalRunning && !!info && !!path.trim() && (mode === "export" ? selected > 0 : trusted && !meta?.readOnly);
  const progress = job && !dismissed[job.id] && <div role="status" className="relative rounded-lg border border-line bg-bg p-3 text-xs">
    {terminalDatabaseJob(job) && <button aria-label="Dismiss database operation" className="absolute right-2 top-2 rounded p-1 text-muted hover:text-text" onClick={() => useDatabaseFiles.getState().dismiss(job.id)}><X size={13} /></button>}
    <div className="flex items-center gap-2 pr-7">{running && <Loader2 size={13} className="animate-spin" />}<b>{job.state}</b><span>{job.stage}</span></div>
    <div className="mt-1 text-muted">{mb(job.bytes)}{job.total !== null ? ` / ${mb(job.total)}` : " · total unknown"} · {((running ? Math.max(0, now - job.started_at) : job.elapsed_ms) / 1000).toFixed(1)} s</div>
    {job.total !== null && job.total > 0 && <progress className="mt-2 w-full" value={job.bytes} max={job.total} />}
    <pre ref={operationLog} aria-label="Database operation log" className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-term p-3 font-mono text-xs text-[#D3D9E4]">{(job.log ?? []).join("\n")}</pre>
    {job.error && <div className="mt-2 whitespace-pre-wrap break-words text-prod-fg">{job.error}</div>}
    {running && <Button className="mt-2 h-7" onClick={() => void api.databaseFileCancel(job.id).catch((e: unknown) => setError(asCoreError(e).message))}>Cancel job</Button>}
  </div>;

  return <>
    <Button ref={menuButton} className="h-7 shrink-0" aria-label="More SQL actions" aria-haspopup="menu" aria-expanded={!!menu} onClick={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu(menu ? null : { x: rect.right - 200, y: rect.bottom + 4 });
    }}><MoreHorizontal size={14} /> More</Button>
    {menu && active && <ContextMenu {...menu} onClose={() => { setMenu(null); menuButton.current?.focus(); }} items={[
      ...actions,
      ...(actions.length ? [{ kind: "separator" as const }] : []),
      ...(["export", "import", "backups"] as const).map((next) => ({
        label: next === "export" ? "Export" : next === "import" ? "Import" : "Backups",
        disabled: !enabled || !requestsActive || busy || !!starting,
        onClick: () => void load(next),
      })),
    ]} />}
    {running && <span title={`Database job running · ${mb(job.bytes)}`} className="flex items-center gap-1 text-xs text-accent"><Loader2 size={12} className="animate-spin" /><span className="hidden @[650px]:inline">{mb(job.bytes)}</span></span>}
    {mode && enabled && <Modal title={`${mode === "export" ? "Export" : mode === "import" ? "Import" : "Backups"} · ${info?.database ?? meta?.database ?? "database"}`} width={840} onClose={close} footer={<>
      <Button onClick={close}>Close{running ? " · job continues" : ""}</Button>
      {mode !== "backups" && <Button variant="primary" disabled={!canStart} onClick={() => void start(mode === "export" ? { kind: "export", file, tables: selection, ...(info?.engine === "mysql" ? { format } : {}) } : { kind: "import", file, format })}>{mode === "export" ? "Export" : "Import"}</Button>}
    </>}>
      <div className="shrink-0 space-y-4">
      {busy && <div role="status" className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" />Loading database details…</div>}
      {starting === "confirming" && <p role="status" className="m-0 text-sm text-muted">Awaiting confirmation. The job has not started.</p>}
      {starting === "submitting" && !running && <p role="status" className="m-0 text-sm text-muted">Checking database access and table selection…</p>}
      {error && <div role="alert" className="whitespace-pre-wrap text-sm text-prod-fg">{error}</div>}
      {progress}
      {!busy && !info && !running && <Button disabled={!requestsActive || !enabled} onClick={() => void load(mode)}>Load details</Button>}
      {info && <p className="m-0 break-all font-mono text-xs text-muted">{info.target}{info.production ? " · PROD" : ""}</p>}
      {info && mode !== "backups" && <>
        <div className="grid grid-cols-[180px_1fr_auto] items-end gap-2">
          <Field label={mode === "export" ? "Destination" : "Source"}><Select value={location} onChange={(e) => { setLocation(e.target.value as "local" | "server"); setPath(""); }} disabled={busy || !!starting || globalRunning}>
            <option value="local">This computer</option><option value="server" disabled={!info.server_files}>SSH server</option>
          </Select></Field>
          <Field label={location === "server" ? "Absolute server file path" : "Local file"}><TextInput value={path} onChange={(e) => { setPath(e.target.value); generatedPath.current = null; if (mode === "import") { if (e.target.value.toLowerCase().endsWith(".gz")) setFormat("sql_gzip"); else if (e.target.value.toLowerCase().endsWith(".sql")) setFormat("sql"); } }} disabled={busy || !!starting || globalRunning} placeholder={location === "server" ? `/backups/${info.database}.${info.engine === "postgres" ? "dump" : format === "sql_gzip" ? "sql.gz" : "sql"}` : "Choose a file…"} /></Field>
          {location === "local" && <Button disabled={busy || !!starting || globalRunning} onClick={() => void pickFile()}>Browse…</Button>}
        </div>
        <p className="m-0 text-xs text-muted">{location === "server" ? "SSH exports run on the server. Imports and downloads stream through private local staging." : "SSH exports run on the server, then download through SFTP. Local files use private staging; allow local disk space for the entire output file. Gzip SQL imports stream without an uncompressed staging file."} Existing destinations are never replaced.</p>
        <details className="text-xs text-muted"><summary className="cursor-pointer">Native tools and connection details</summary><p>SSH exports run native clients on the SSH server. Imports and direct local exports run clients on this computer. Matching PostgreSQL / MySQL / MariaDB client tools must already be on PATH where they run. Compressed SSH exports also require gzip; they stream directly into one compressed file. SSH exports also require GNU coreutils. Docker-only targets require a host-accessible client and endpoint; in-container export is unsupported. Rookery does not install them. Server files are available for SSH connections. MariaDB Require TLS also verifies the server certificate.</p></details>
      </>}
      {formatPathMismatch && <p role="alert" className="m-0 text-sm text-prod-fg">Use a .sql.gz filename for compressed SQL, or .sql for plain SQL. Update the filename or export format.</p>}
      {info && mode === "export" && <>
        {info.engine === "mysql" && <Field label="Export format"><Select aria-label="Export format" value={format} disabled={busy || !!starting || globalRunning} onChange={(e) => changeFormat(e.target.value as DumpFormat)}><option value="sql">SQL (.sql)</option><option value="sql_gzip">Compressed SQL (.sql.gz)</option></Select></Field>}
        <div className="flex items-center gap-2"><TextInput aria-label="Search tables" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tables…" className="flex-1" /><Button disabled={busy || !!starting || globalRunning} onClick={() => changeAll("data")}>Select all</Button><Button disabled={busy || !!starting || globalRunning} onClick={() => changeAll("exclude")}>Clear</Button></div>
        <div className="min-h-40 max-h-[320px] overflow-auto rounded-lg border border-line">
          <table className="w-full text-left text-xs"><thead className="sticky top-0 bg-panel2"><tr><th className="p-2">Table</th><th className="p-2">Data ≈</th><th className="p-2">Indexes ≈</th><th className="p-2">Export</th></tr></thead><tbody>
            {info.tables.filter((table) => `${table.schema}.${table.name}`.toLowerCase().includes(search.toLowerCase())).map((table) => {
              const key = tableKey(table); const value = selectedModes.get(key) ?? "exclude";
              return <tr key={key} className="border-t border-line"><td className="p-2 font-mono break-all"><label className="flex items-center gap-2"><input type="checkbox" aria-label={`Include ${table.schema}.${table.name}`} checked={value !== "exclude"} disabled={busy || !!starting || globalRunning} onChange={(e) => changeTable(key, e.target.checked ? "data" : "exclude")} />{table.schema}.{table.name}</label></td><td className="p-2 whitespace-nowrap">{mb(table.data_bytes)}</td><td className="p-2 whitespace-nowrap">{mb(table.index_bytes)}</td><td className="p-2"><Select aria-label={`Export mode for ${table.schema}.${table.name}`} value={value} disabled={busy || !!starting || globalRunning} onChange={(e) => changeTable(key, e.target.value as TableMode)}><option value="data">Structure + data</option><option value="structure">Structure only</option><option value="exclude">Exclude</option></Select></td></tr>;
            })}
          </tbody></table>
        </div>
        {totals && <p className="m-0 text-xs">{selected} / {info.tables.length} tables selected · All data ≈ {mb(totals.data)} · indexes ≈ {mb(totals.index)} · total ≈ {mb(totals.data + totals.index)} · selected data + indexes ≈ {mb(totals.selected)}. These are storage estimates; dump size differs. Structure-only DDL is not estimated.</p>}
        <details className="text-xs text-muted"><summary className="cursor-pointer">Export consistency and verification</summary><p>{info.engine === "postgres" ? "PostgreSQL custom archive. Full selection retains database objects; subsets may omit dependencies. Structure-only excludes table rows." : "Table backup includes triggers; routines, events and users are excluded. One transactional data snapshot; nontransactional tables and concurrent DDL can be inconsistent. Mixed table modes capture schema and data in separate passes."} An export success and checksum do not prove that a restore works.</p></details>
      </>}
      {info && mode === "import" && <>
        <Field label="Dump format"><Select value={format} disabled={busy || !!starting || globalRunning} onChange={(e) => changeFormat(e.target.value as DumpFormat)}>{info.engine === "postgres" && <option value="postgres_archive">PostgreSQL custom archive (.dump)</option>}<option value="sql">Plain SQL (.sql)</option><option value="sql_gzip">Compressed SQL (.sql.gz)</option></Select></Field>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={trusted} disabled={busy || !!starting || globalRunning} onChange={(e) => setTrusted(e.target.checked)} /><span>I trust this dump. It may execute database or local client commands, change databases, and apply changes immediately. Errors and cancellation can leave partial changes.</span></label>
        {meta?.readOnly && <p className="m-0 text-sm text-warn">Enable Edit mode in the database toolbar before importing or restoring.</p>}
      </>}
      {mode === "backups" && <>
        <div className="flex items-center justify-between gap-2"><p className="m-0 text-xs text-muted">Only exports created by Rookery for this connection and database. Files are checked when downloaded, restored or deleted.</p><Button disabled={busy || !!starting || globalRunning} onClick={() => void load("backups")}>Refresh</Button></div>
        {backups.length === 0 && !busy && <p className="m-0 text-sm text-muted">No Rookery database backups recorded.</p>}
        <div className="max-h-[420px] space-y-2 overflow-auto">{backups.slice().reverse().map((backup) => <div key={backup.id} className="rounded-lg border border-line p-3 text-xs">
          <b className="break-all">{backup.file.path}</b><p className="my-1 text-muted">{new Date(backup.created_at).toLocaleString()} · {mb(backup.bytes)} · {backup.file.location === "server" ? "SSH server" : "This computer"} · {backup.format} · {backup.tables.filter((table) => table.mode !== "exclude").length} tables</p>
          <p className="my-1 text-muted">{backup.tool_version} · {backup.verification}</p><p title={backup.sha256} className="my-1 truncate font-mono text-muted">SHA-256 {backup.sha256}</p>
          <div className="mt-2 flex gap-2"><Button disabled={busy || !!starting || globalRunning} onClick={() => void download(backup)}>Download…</Button><Button disabled={busy || !!starting || globalRunning || meta?.readOnly} onClick={() => void start({ kind: "restore", backup_id: backup.id })}>Restore…</Button><Button variant="danger" disabled={busy || !!starting || globalRunning} onClick={() => void start({ kind: "delete", backup_id: backup.id })}>Delete…</Button></div>
        </div>)}</div>
      </>}
      </div>
    </Modal>}
  </>;
}
