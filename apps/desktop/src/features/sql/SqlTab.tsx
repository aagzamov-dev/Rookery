import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { AlertTriangle, Bookmark, Download, History, Loader2, Lock, PanelLeft, Play, Square, Table2, Terminal, Unlock, X } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { SchemaTree as Tree } from "../../ipc/bindings/SchemaTree";
import { askConfirm } from "../../stores/dialogs";
import { useKeys } from "../../stores/keys";
import { useSql, type SqlResultSet, type SqlRun } from "../../stores/sql";
import { Button, IconButton, Select } from "../../ui/primitives";
import { useContextMenu, type MenuItem } from "../../ui/ContextMenu";
import { classifySql } from "./classify";
import { settleTransactions } from "./txGuard";
import { toCsv } from "./csv";
import { sqlRegistry } from "./registry";
import { ResultsGrid } from "./ResultsGrid";
import { SchemaTree } from "./SchemaTree";
import { SidePanel, saveSqlSnippet, type SidePanelTab } from "./SidePanel";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { charToIndex, splitSql, type Dialect } from "./split";
import { TableView, type OpenTable, type TableSub } from "./TableView";
import type { ColumnFilter } from "../../ipc/bindings/ColumnFilter";

/** A table opened as a tab inside the SQL tab. Unpinned = preview (the next single click replaces it). */
interface OpenedTable {
  key: string;
  schema: string;
  table: string;
  pinned: boolean;
  sub: TableSub;
  filter?: { filter: ColumnFilter; nonce: number };
}

interface Props {
  /** Registry / draft key: `host:<id>` for a server view, the tab id for a database tab. */
  tabKey: string;
  sessionId: string;
  /** Extra buttons at the right end of the toolbar (Disconnect, Save…). */
  extra?: ReactNode;
  /** Connection name and env, for confirmations ("Allow changes on shop prod (PROD)?"). */
  label: string;
  env?: string;
}

const EMPTY: SqlResultSet[] = [];
const ALLOW_MINUTES = 15;

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Toolbar 🔒: read-only state, "Allow changes for 15 minutes", countdown. */
function WritesButton({ sessionId, label, env }: { sessionId: string; label: string; env?: string }) {
  const meta = useSql((s) => s.sessions[sessionId]);
  const menu = useContextMenu();
  const [now, setNow] = useState(Date.now());
  const until = meta?.writesUntil ?? null;
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!meta) return null;
  const envText = env && env !== "none" ? ` (${env.toUpperCase()})` : "";

  const allow = async () => {
    const ok = await askConfirm({
      title: `Allow changes on ${label}${envText}?`,
      body: `Writes are allowed for ${ALLOW_MINUTES} minutes, then the connection is read-only again by itself. Every change goes into a transaction: nothing is saved until you press Commit.`,
      confirmLabel: `Allow changes for ${ALLOW_MINUTES} minutes`,
      danger: env === "prod",
    });
    if (ok) await api.sqlAllowWrites(sessionId, ALLOW_MINUTES).catch((e) => askConfirm({ title: "Could not allow changes", body: asCoreError(e).message, confirmLabel: "OK" }));
  };
  const stop = () => void api.sqlAllowWrites(sessionId, 0);

  const items: MenuItem[] = !meta.protected
    ? [{ kind: "label", label: "This connection is not read-only. Turn on “Open read-only” (or label it PROD) to protect it." }]
    : meta.readOnly
      ? [{ label: `Allow changes for ${ALLOW_MINUTES} minutes…`, icon: <Unlock size={13} />, onClick: () => void allow() }]
      : [
          { label: "Read-only again now", icon: <Lock size={13} />, onClick: stop },
          { label: `Extend to ${ALLOW_MINUTES} minutes from now`, onClick: () => void api.sqlAllowWrites(sessionId, ALLOW_MINUTES) },
        ];
  const writing = !meta.readOnly && meta.protected;
  return (
    <>
      <button
        onClick={(e) => menu.open(items)(e)}
        title={meta.readOnly ? "Read-only: the server refuses changes. Click to allow changes for a while." : "Changes are allowed"}
        className={clsx("flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:brightness-125", writing ? "bg-[#352F20] text-[#F7CB6A]" : "text-muted hover:text-text")}
      >
        {meta.readOnly ? <Lock size={12} /> : <Unlock size={12} />}
        {meta.readOnly ? "Read-only" : meta.protected ? `Changes allowed · ${until ? mmss(until - now) : ""}` : "Read / write"}
      </button>
      {menu.node}
    </>
  );
}

/** Database tab / server Database view: schema tree, editor, results (docs/07 §2.2). */
export function SqlTab({ tabKey, sessionId, extra, label, env }: Props) {
  const meta = useSql((s) => s.sessions[sessionId]);
  const draftsLoaded = useSql((s) => s.draftsLoaded);
  const fontFamily = useKeys((s) => s.terminal.fontFamily);
  const fontSize = useKeys((s) => s.terminal.fontSize);
  const dialect: Dialect = meta?.engine === "mysql" ? "mysql" : "postgres";

  const editor = useRef<SqlEditorHandle>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [system, setSystem] = useState(false);
  const [showTree, setShowTree] = useState(true);
  const [split, setSplit] = useState(0.45);
  const [runId, setRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<number | "messages">("messages");
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<SidePanelTab | null>(null);
  const [tables, setTables] = useState<OpenedTable[]>([]);
  const [active, setActive] = useState<string>("query");
  const queryActive = active === "query";
  const run = useSql((s) => (runId ? s.runs[runId] : undefined));
  const running = !!run && !run.finished;
  const sets = run?.sets ?? EMPTY;

  useEffect(() => {
    void useSql.getState().loadDrafts();
  }, []);

  // ------------------------------------------------------------- schema
  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    setTreeError(null);
    try {
      setTree(await api.sqlSchema(sessionId, system));
    } catch (e) {
      setTreeError(asCoreError(e).message);
    } finally {
      setTreeLoading(false);
    }
  }, [sessionId, system]);
  const database = meta?.database ?? null;
  useEffect(() => {
    void loadTree();
  }, [loadTree, database]);

  const completion = useMemo<SQLNamespace>(() => {
    if (!tree) return {};
    if (dialect === "mysql") {
      const ns: Record<string, string[]> = {};
      for (const s of tree.schemas) for (const t of s.tables) ns[t.name] = t.columns.map((c) => c.name);
      return ns;
    }
    const ns: Record<string, Record<string, string[]>> = {};
    for (const s of tree.schemas) {
      ns[s.name] = {};
      for (const t of s.tables) ns[s.name][t.name] = t.columns.map((c) => c.name);
    }
    return ns;
  }, [tree, dialect]);

  // ---------------------------------------------------------------- run
  const exec = useCallback(
    async (mode: "current" | "all", opts: { text?: string; rowLimit?: number } = {}) => {
      if (!meta || running) return;
      const v = editor.current?.view();
      let text = opts.text;
      let offset = -1;
      if (text == null) {
        if (!v) return;
        const doc = v.state.doc.toString();
        const sel = v.state.selection.main;
        if (!sel.empty) {
          text = doc.slice(sel.from, sel.to);
          offset = sel.from;
        } else if (mode === "all") {
          text = doc;
          offset = 0;
        } else {
          const st = splitSql(doc, dialect).statements;
          const at = st.find((s) => sel.head >= s.from && sel.head <= s.to) ?? [...st].reverse().find((s) => s.to <= sel.head) ?? st[0];
          if (!at) return;
          text = at.text;
          offset = at.from;
        }
      }
      const parsed = splitSql(text, dialect);
      if (parsed.error) {
        setNotice(parsed.error);
        return;
      }
      if (!parsed.statements.length) return;
      const risk = classifySql(parsed.statements, dialect);
      // Read-only sessions refuse writes in Rust and on the server; no need to ask first.
      if (!meta.readOnly && risk.reasons.length) {
        // On PROD you type the database name to run it.
        const prodName = env === "prod" ? (meta.database ?? label) : undefined;
        const ok = await askConfirm({
          title: prodName ? `Run this on PROD (${label})?` : "Run this?",
          body: risk.reasons.map((r) => `• ${r}`).join("\n"),
          preview: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
          confirmLabel: "Run",
          danger: true,
          typeToConfirm: prodName,
        });
        if (!ok) return;
      }
      if (risk.mysqlDdl && meta.txOpen) {
        const ok = await askConfirm({
          title: "Commit the open transaction?",
          body: "ALTER / CREATE / DROP commit immediately on MySQL. Your uncommitted changes are committed first.",
          confirmLabel: "Run and commit",
          danger: true,
        });
        if (!ok) return;
      }
      setNotice(null);
      editor.current?.markError(null);
      try {
        const queryId = await api.sqlRun(sessionId, text, { row_limit: opts.rowLimit ?? null });
        useSql.getState().startRun({ queryId, sessionId, sql: text, offset, rowLimit: opts.rowLimit ?? null });
        setRunId((prev) => {
          if (prev) useSql.getState().forgetRun(prev);
          return queryId;
        });
        setTab("messages");
      } catch (e) {
        setNotice(asCoreError(e).message);
      }
    },
    [meta, running, dialect, sessionId],
  );

  const cancel = useCallback(() => {
    if (runId && running) void api.sqlCancel(runId);
  }, [runId, running]);

  // Shortcuts (Mod+Enter …) arrive through the key dispatcher.
  const handle = useRef({ exec, cancel, toggle: () => setShowTree((x) => !x) });
  handle.current = { exec, cancel, toggle: () => setShowTree((x) => !x) };
  useEffect(
    () =>
      sqlRegistry.register(tabKey, {
        run: (m) => void handle.current.exec(m),
        cancel: () => handle.current.cancel(),
        toggleTree: () => handle.current.toggle(),
      }),
    [tabKey],
  );

  // When a run finishes: show its first result / error, mark the error in the editor.
  const finished = run?.finished;
  useEffect(() => {
    if (!run || !finished) return;
    const err = run.sets.find((s) => s.error);
    if (err && err.errorPos != null && run.offset >= 0) editor.current?.markError(run.offset + charToIndex(run.sql, err.errorPos));
    const grid = run.sets.findIndex((s) => s.columns && !s.error);
    setTab(err || grid < 0 ? "messages" : grid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, runId]);
  // Show the first grid as soon as rows start arriving.
  const firstGrid = sets.findIndex((s) => s.columns);
  useEffect(() => {
    if (running && firstGrid >= 0 && tab === "messages") setTab(firstGrid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstGrid, running]);

  // Tree actions add a line at the end of the editor (your text stays) and may run it.
  const fromTree = (sql: string, andRun: boolean) => {
    if (!andRun) {
      editor.current?.insert(sql);
      return;
    }
    const v = editor.current?.view();
    if (v) {
      const doc = v.state.doc.toString();
      const sep = doc.trim() ? (doc.endsWith("\n") ? "\n" : "\n\n") : "";
      const from = doc.trim() ? doc.length + sep.length : 0;
      v.dispatch({ changes: doc.trim() ? { from: doc.length, insert: sep + sql } : { from: 0, to: doc.length, insert: sql }, selection: { anchor: from + sql.length }, scrollIntoView: true });
    }
    void exec("all", { text: sql });
  };

  /** Click a table: open it as a tab (single click = preview, double click / jumps = kept). */
  const openTable: OpenTable = (schema, table, opts = {}) => {
    const key = `${schema}.${table}`;
    const filter = opts.filter ? { filter: opts.filter, nonce: Date.now() } : undefined;
    setTables((cur) => {
      const at = cur.findIndex((t) => t.key === key);
      if (at >= 0) return cur.map((t, i) => (i === at ? { ...t, pinned: t.pinned || !!opts.pin, ...(filter ? { filter, sub: "data" as TableSub } : {}) } : t));
      const next: OpenedTable = { key, schema, table, pinned: !!opts.pin, sub: "data", filter };
      const preview = cur.findIndex((t) => !t.pinned);
      return preview >= 0 && !opts.pin ? cur.map((t, i) => (i === preview ? next : t)) : [...cur, next];
    });
    setActive(key);
  };
  const closeTable = (key: string) => {
    setTables((cur) => {
      const i = cur.findIndex((t) => t.key === key);
      const rest = cur.filter((t) => t.key !== key);
      if (active === key) setActive(rest[Math.min(i, rest.length - 1)]?.key ?? "query");
      return rest;
    });
  };
  const tableInfo = (schema: string, table: string) => tree?.schemas.find((x) => x.name === schema)?.tables.find((t) => t.name === table);

  /** "Open in Query": add the SQL on a new line at the end of the editor and select it. */
  const toQuery = (sql: string) => {
    setActive("query");
    requestAnimationFrame(() => {
      const v = editor.current?.view();
      if (!v) return;
      const doc = v.state.doc.toString();
      const sep = doc.trim() ? (doc.endsWith("\n") ? "\n" : "\n\n") : "";
      const from = doc.trim() ? doc.length + sep.length : 0;
      v.dispatch({
        changes: doc.trim() ? { from: doc.length, insert: sep + sql } : { from: 0, to: doc.length, insert: sql },
        selection: { anchor: from, head: from + sql.length },
        scrollIntoView: true,
      });
      v.focus();
    });
  };

  /** The selection, or the whole editor (Save as snippet). */
  const editorText = () => {
    const v = editor.current?.view();
    if (!v) return "";
    const sel = v.state.selection.main;
    return sel.empty ? v.state.doc.toString() : v.state.sliceDoc(sel.from, sel.to);
  };

  const exportCsv = async (set: SqlResultSet) => {
    const path = await saveDialog({ defaultPath: `result-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    try {
      await api.fileWriteText(path, toCsv((set.columns ?? []).map((c) => c.name), set.rows));
      setNotice(`Saved ${set.rows.length} rows to ${path}`);
    } catch (e) {
      setNotice(asCoreError(e).message);
    }
  };

  const switchDb = async (db: string) => {
    if (!meta || db === meta.database) return;
    if (meta.txOpen && !(await settleTransactions([meta], `switching to ${db}`))) return;
    try {
      await api.sqlUse(sessionId, db);
    } catch (e) {
      setNotice(asCoreError(e).message);
    }
  };

  // Drag the editor / results divider.
  const body = useRef<HTMLDivElement>(null);
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = body.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => setSplit(Math.min(0.85, Math.max(0.12, (ev.clientY - r.top) / r.height)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!meta) return null;
  const totalMs = sets.reduce((a, s) => a + (s.elapsedMs ?? 0), 0);
  const activeSet = typeof tab === "number" ? sets[tab] : undefined;

  return (
    <div className="absolute inset-0 flex flex-col bg-bg" data-sql-key={tabKey}>
      {/* toolbar */}
      <div className="flex min-h-[42px] flex-wrap items-center gap-1.5 border-b border-line bg-term px-2.5">
        <IconButton label={showTree ? "Hide schema tree" : "Show schema tree"} onClick={() => setShowTree((x) => !x)}>
          <PanelLeft size={15} />
        </IconButton>
        {queryActive && (
          <>
            <Button variant="primary" className="h-7" disabled={running} onClick={() => void exec("current")} title="Run the statement at the cursor, or the selection (Ctrl+Enter)">
              <Play size={13} /> Run
            </Button>
            <Button className="h-7" disabled={running} onClick={() => void exec("all")} title="Run everything (Ctrl+Shift+Enter)">
              Run all
            </Button>
            <Button className="h-7" disabled={!running} onClick={cancel} title="Stop the query on the server (Ctrl+.)">
              <Square size={12} /> Cancel
            </Button>
          </>
        )}
        <span className="mx-1 h-5 w-px bg-line" />
        <span className="text-xs text-muted">DB</span>
        <Select className="h-7 max-w-[200px] text-xs" value={meta.database ?? ""} onChange={(e) => void switchDb(e.target.value)} disabled={!tree?.databases.length}>
          {!meta.database && <option value="">(none)</option>}
          {(tree?.databases ?? (meta.database ? [meta.database] : [])).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
        <WritesButton sessionId={sessionId} label={label} env={env} />
        <span className="text-xs text-muted">Tx: {meta.txOpen ? <b className="text-warn">open</b> : "none"}</span>
        {running ? (
          <span className="flex items-center gap-1 text-xs text-accent">
            <Loader2 size={12} className="animate-spin" /> running…
          </span>
        ) : (
          run && <span className="text-xs text-muted">{totalMs} ms</span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Button className="h-7" onClick={() => void saveSqlSnippet(editorText())} title="Save the selection (or the whole editor) as an SQL snippet">
            <Bookmark size={12} /> Save as snippet
          </Button>
          <Button className={clsx("h-7", panel && "border-accent-line bg-accent-bg")} onClick={() => setPanel((p) => (p ? null : "history"))} title="Query history and SQL snippets">
            <History size={12} /> History
          </Button>
          {extra}
        </span>
      </div>

      {meta.txOpen && (
        <div className="flex items-center gap-3 border-b border-[#6A5828] bg-[#2F2A1E] px-4 py-1.5 text-[13px]">
          <AlertTriangle size={14} className="text-warn" />
          <span>
            Uncommitted changes{meta.txRows ? ` · ${meta.txRows} rows` : ""}
          </span>
          <Button className="ml-auto h-7" variant="primary" onClick={() => void api.sqlTx(sessionId, "commit").catch((e) => setNotice(asCoreError(e).message))}>
            Commit
          </Button>
          <Button className="h-7" onClick={() => void api.sqlTx(sessionId, "rollback").catch((e) => setNotice(asCoreError(e).message))}>
            Rollback
          </Button>
        </div>
      )}
      {meta.state === "lost" && meta.message && (
        <div className="flex items-center gap-2 border-b border-[#5A2D33] bg-[#33232A] px-4 py-1.5 text-[13px] text-prod-fg">
          <AlertTriangle size={14} /> {meta.message}
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 border-b border-line bg-panel px-4 py-1.5 text-[13px]">
          <span className="flex-1">{notice}</span>
          <button className="text-xs text-muted hover:text-text" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-9 items-end gap-0.5 overflow-x-auto border-b border-line bg-panel px-2 pt-1" role="tablist" aria-label="Query and tables">
        <button
          role="tab"
          aria-selected={queryActive}
          onClick={() => setActive("query")}
          className={clsx("flex h-8 flex-none items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-[13px]", queryActive ? "border-line bg-bg text-text" : "border-transparent text-muted hover:text-text")}
        >
          <Terminal size={13} /> Query
          {running && <Loader2 size={11} className="animate-spin text-accent" />}
        </button>
        {tables.map((t) => (
          <div
            key={t.key}
            role="tab"
            aria-selected={active === t.key}
            onClick={() => setActive(t.key)}
            onDoubleClick={() => setTables((cur) => cur.map((x) => (x.key === t.key ? { ...x, pinned: true } : x)))}
            onAuxClick={(e) => e.button === 1 && closeTable(t.key)}
            title={`${t.schema}.${t.table}${t.pinned ? "" : " · preview (double-click to keep it open)"}`}
            className={clsx(
              "group/t flex h-8 max-w-[220px] flex-none cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 pr-1 pl-3 text-[13px]",
              active === t.key ? "border-line bg-bg text-text" : "border-transparent text-muted hover:text-text",
            )}
          >
            <Table2 size={13} className="flex-none text-accent" />
            <span className={clsx("truncate", !t.pinned && "italic")}>{t.table}</span>
            <button
              aria-label={`Close ${t.table}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTable(t.key);
              }}
              className="grid h-5 w-5 flex-none place-items-center rounded text-muted opacity-60 hover:bg-panel2 hover:text-text group-hover/t:opacity-100"
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        {showTree && (
          <div className="w-[260px] flex-none">
            <SchemaTree
              tree={tree}
              loading={treeLoading}
              error={treeError}
              dialect={dialect}
              system={system}
              onSystem={setSystem}
              onRefresh={() => void loadTree()}
              onSql={fromTree}
              onCopy={(t) => void api.clipboardWrite(t)}
              onOpen={openTable}
              activeKey={queryActive ? null : active}
            />
          </div>
        )}
        <div className="relative min-w-0 flex-1">
        {tables.map((t) => (
          <TableView
            key={t.key}
            sessionId={sessionId}
            connKey={meta.connKey}
            schema={t.schema}
            table={t.table}
            info={tableInfo(t.schema, t.table)}
            sub={t.sub}
            onSub={(sub) => setTables((cur) => cur.map((x) => (x.key === t.key ? { ...x, sub, pinned: true } : x)))}
            visible={active === t.key}
            fontFamily={fontFamily}
            onOpenTable={openTable}
            onQuery={toQuery}
            initialFilter={t.filter}
          />
        ))}
        <div ref={body} className="absolute inset-0 flex min-w-0 flex-col" style={{ display: queryActive ? "flex" : "none" }}>
          <div className="min-h-0" style={{ height: `${split * 100}%` }}>
            {draftsLoaded && (
              <SqlEditor
                ref={editor}
                initial={useSql.getState().drafts[tabKey] ?? ""}
                dialect={dialect}
                schema={completion}
                defaultSchema={dialect === "postgres" ? "public" : undefined}
                fontFamily={fontFamily}
                fontSize={fontSize}
                onChange={(t) => useSql.getState().setDraft(tabKey, t)}
              />
            )}
          </div>
          <div onPointerDown={startDrag} className="h-1.5 flex-none cursor-row-resize border-y border-line bg-panel hover:bg-accent-line" role="separator" aria-label="Resize editor" />
          <ResultsArea dialect={dialect} run={run} sets={sets} tab={tab} setTab={setTab} active={activeSet} meta={meta} fontFamily={fontFamily} onExport={exportCsv} onMore={(s) => run && void exec("all", { text: run.sql, rowLimit: s.rows.length + 500 })} />
        </div>
        </div>
        {panel && queryActive && (
          <div className="w-[300px] flex-none">
            <SidePanel
              tab={panel}
              onTab={setPanel}
              onClose={() => setPanel(null)}
              connKey={meta.connKey}
              reloadToken={`${runId}:${finished ? 1 : 0}`}
              onSql={fromTree}
              editorText={editorText}
              fontFamily={fontFamily}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ResultsArea({
  dialect,
  run,
  sets,
  tab,
  setTab,
  active,
  meta,
  fontFamily,
  onExport,
  onMore,
}: {
  dialect: Dialect;
  run?: SqlRun;
  sets: SqlResultSet[];
  tab: number | "messages";
  setTab: (t: number | "messages") => void;
  active?: SqlResultSet;
  meta: { database: string | null; version: string };
  fontFamily: string;
  onExport: (s: SqlResultSet) => void;
  onMore: (s: SqlResultSet) => void;
}) {
  const sql = run?.sql;
  const statements = useMemo(() => (sql ? splitSql(sql, dialect).statements : []), [sql, dialect]); // for labels
  const command = (stmt: number) => (statements[stmt]?.words[0] ?? "").toUpperCase();
  const grids = sets.map((s, i) => ({ s, i })).filter((x) => x.s.columns && !x.s.error);

  if (!run) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-term px-6 text-center text-[13px] text-muted">
        Connected to {meta.database ?? "the server"} ({meta.version}). Click a table to see its data and structure, or write SQL and press Ctrl+Enter.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-8 flex-wrap items-center gap-0.5 border-b border-line bg-panel px-2">
        {grids.map(({ i }, n) => (
          <button key={i} onClick={() => setTab(i)} className={clsx("h-6 rounded px-2.5 text-xs", tab === i ? "bg-panel2 text-text" : "text-muted hover:text-text")}>
            Result {n + 1}
          </button>
        ))}
        <button onClick={() => setTab("messages")} className={clsx("h-6 rounded px-2.5 text-xs", tab === "messages" ? "bg-panel2 text-text" : "text-muted hover:text-text")}>
          Messages{sets.some((s) => s.error) && <span className="ml-1 text-bad">●</span>}
        </button>
        {active && (
          <span className="ml-auto flex items-center gap-2 text-xs text-muted">
            <span>
              {active.rows.length} rows{active.truncated ? " (limit)" : ""}
              {active.elapsedMs != null && ` · ${active.elapsedMs} ms`}
            </span>
            {active.truncated && run.finished && (
              <button className="text-accent hover:underline" onClick={() => onMore(active)}>
                Load 500 more
              </button>
            )}
            <button className="flex items-center gap-1 hover:text-text" onClick={() => onExport(active)} title="Save these rows as a CSV file">
              <Download size={12} /> CSV
            </button>
          </span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {active ? (
          <ResultsGrid set={active} fontFamily={fontFamily} />
        ) : (
          <div className="absolute inset-0 overflow-auto bg-term px-3 py-2 font-mono text-[12.5px]" style={{ fontFamily }}>
            {sets.map((s) => (
              <div key={s.index} className={clsx("whitespace-pre-wrap py-0.5", s.error ? "text-prod-fg" : "text-text")}>
                {s.error
                  ? `✗ ${s.error}`
                  : s.columns
                    ? `${command(s.stmt) || "Result"} · ${s.rows.length} rows${s.truncated ? " (limit)" : ""}${s.elapsedMs != null ? ` · ${s.elapsedMs} ms` : ""}`
                    : `${command(s.stmt) || "OK"} · ${s.affected ?? 0} rows affected${s.elapsedMs != null ? ` · ${s.elapsedMs} ms` : ""}`}
              </div>
            ))}
            {run.notices.map((n, i) => (
              <div key={`n${i}`} className="py-0.5 text-muted">
                {n}
              </div>
            ))}
            {!run.finished && <div className="py-0.5 text-muted">Running…</div>}
            {run.finished && sets.length === 0 && <div className="py-0.5 text-muted">Done.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
