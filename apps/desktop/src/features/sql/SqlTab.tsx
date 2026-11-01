import { allowDatabaseSessionClose } from "./jobGuard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { AlertTriangle, Bookmark, Download, History, Loader2, Lock, PanelLeft, Play, RefreshCw, Square, Table2, Terminal, Unlock, X } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { SchemaTree as Tree } from "../../ipc/bindings/SchemaTree";
import { askConfirm } from "../../stores/dialogs";
import { useKeys } from "../../stores/keys";
import { useSql, type SqlResultSet, type SqlRun } from "../../stores/sql";
import type { MenuItem } from "../../ui/ContextMenu";
import { Button, IconButton, Select } from "../../ui/primitives";
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
import { ResizablePanel } from "../../ui/ResizablePanel";
import { DatabaseFiles } from "./DatabaseFiles";
import { TransactionReviewDialog } from "./TransactionReviewDialog";

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
  visible?: boolean;
  requestsActive?: boolean;
  /** Registry / draft key: `host:<id>` for a server view, the tab id for a database tab. */
  tabKey: string;
  sessionId: string;
  /** Connection actions in the toolbar menu (Disconnect, Save…). */
  extra?: MenuItem[];
  /** Connection name and env, for confirmations ("Allow changes on shop prod (PROD)?"). */
  label: string;
  env?: string;
}

const EMPTY: SqlResultSet[] = [];
function ConnectionMode({ sessionId, label, env }: { sessionId: string; label: string; env?: string }) {
  const meta = useSql((s) => s.sessions[sessionId]);
  const [busy, setBusy] = useState(false);
  if (!meta) return null;

  const changeMode = async (enabled: boolean) => {
    if (busy || enabled === !meta.readOnly) return;
    setBusy(true);
    try {
      if (enabled && env === "prod") {
        const ok = await askConfirm({
          title: `Enable edit mode on ${label} (PROD)?`,
          body: "Editing stays enabled until you close this connection or select Read-only. Cell edits require diff review and remain in a transaction until Commit.",
          confirmLabel: "Enable edit mode",
          danger: true,
        });
        if (!ok) return;
      }
      await api.sqlSetEditMode(sessionId, enabled);
    } catch (e) {
      await askConfirm({ title: "Could not change connection mode", body: asCoreError(e).message, confirmLabel: "OK" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className={clsx("flex items-center gap-1.5 text-xs", meta.readOnly ? "text-muted" : "text-warn")}>
      {meta.readOnly ? <Lock size={12} /> : <Unlock size={12} />}
      <Select aria-label="SQL connection mode" className="h-7 text-xs" value={meta.readOnly ? "read-only" : "edit"} disabled={busy} onChange={(e) => void changeMode(e.target.value === "edit")}>
        <option value="read-only">Read-only</option>
        <option value="edit">Edit mode</option>
      </Select>
    </label>
  );
}

/** Database tab / server Database view: schema tree, editor, results (docs/07 §2.2). */
export function SqlTab({ tabKey, sessionId, extra, label, env, visible = true, requestsActive = visible }: Props) {
  const meta = useSql((s) => s.sessions[sessionId]);
  const toolbar = useRef<HTMLDivElement>(null);
  const [compactToolbar, setCompactToolbar] = useState(true);
  useEffect(() => {
    const element = toolbar.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setCompactToolbar(entry.contentRect.width < 800));
    observer.observe(element);
    return () => observer.disconnect();
  }, [!!meta]);
  const draftsLoaded = useSql((s) => s.draftsLoaded);
  const fontFamily = useKeys((s) => s.terminal.fontFamily);
  const fontSize = useKeys((s) => s.terminal.fontSize);
  const dialect: Dialect = meta?.engine === "mysql" ? "mysql" : "postgres";

  const editor = useRef<SqlEditorHandle>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [system, setSystem] = useState(false);
  const [showTree, setShowTree] = useState(true);
  const [split, setSplit] = useState(0.45);
  const [runId, setRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<number | "messages">("messages");
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  useEffect(() => { if (!meta?.txOpen) setReviewOpen(false); }, [meta?.txOpen]);
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
  const database = meta?.database ?? null;
  const loadedTreeKey = useRef<string | null>(null);
  const treeKey = JSON.stringify([sessionId, system, database]);
  const loadTree = useCallback(async () => {
    const key = JSON.stringify([sessionId, system, database]);
    loadedTreeKey.current = key;
    setTreeLoading(true);
    setTreeError(null);
    try {
      setTree(await api.sqlSchema(sessionId, system));
    } catch (e) {
      if (loadedTreeKey.current === key) loadedTreeKey.current = null;
      setTreeError(asCoreError(e).message);
    } finally {
      setTreeLoading(false);
    }
  }, [sessionId, system, database]);
  useEffect(() => {
    if (requestsActive && loadedTreeKey.current !== treeKey) void loadTree();
  }, [loadTree, treeKey, requestsActive]);

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
    if (!(await allowDatabaseSessionClose([sessionId]))) return;
    if (meta.txOpen && !(await settleTransactions([meta], `switching to ${db}`))) return;
    try {
      await api.sqlUse(sessionId, db);
    } catch (e) {
      setNotice(asCoreError(e).message);
    }
  };

  // Drag the editor / results divider.
  const body = useRef<HTMLDivElement>(null);
  const resizeSplit = (clientY: number) => {
    const bounds = body.current?.getBoundingClientRect();
    if (bounds?.height) setSplit(Math.min(0.85, Math.max(0.12, (clientY - bounds.top) / bounds.height)));
  };

  const reconnect = async () => {
    if (!(await allowDatabaseSessionClose([sessionId]))) return;
    if (meta?.txOpen || running) {
      const confirmed = await askConfirm({ title: "Reconnect database?", body: "This interrupts the current operation and abandons the connection. Its outcome may be unknown; verify changes before retrying.", confirmLabel: "Reconnect" });
      if (!confirmed) return;
    }
    setReconnecting(true);
    try { await api.sqlReconnect(sessionId); await loadTree(); }
    catch (error) { setNotice(asCoreError(error).message); }
    finally { setReconnecting(false); }
  };

  if (!meta) return null;
  const totalMs = sets.reduce((a, s) => a + (s.elapsedMs ?? 0), 0);
  const activeSet = typeof tab === "number" ? sets[tab] : undefined;

  return (
    <div className="absolute inset-0 flex flex-col bg-bg" data-sql-key={tabKey}>
      {/* toolbar */}
      <div ref={toolbar} className="@container flex h-[42px] shrink-0 flex-nowrap items-center gap-1.5 whitespace-nowrap border-b border-line bg-term px-2.5 [&>button]:shrink-0">
        <IconButton label={showTree ? "Hide schema tree" : "Show schema tree"} onClick={() => setShowTree((x) => !x)}>
          <PanelLeft size={15} />
        </IconButton>
        {!compactToolbar && <IconButton label="Reconnect database" disabled={reconnecting || meta.state === "reconnecting"} onClick={() => void reconnect()}><RefreshCw size={14} /></IconButton>}
        {queryActive && (
          <>
            <Button variant="primary" className="h-7" disabled={running} onClick={() => void exec("current")} title="Run the statement at the cursor, or the selection (Ctrl+Enter)">
              <Play size={13} /> Run
            </Button>
            {!compactToolbar && <Button className="h-7" disabled={running} onClick={() => void exec("all")} title="Run everything (Ctrl+Shift+Enter)">Run all</Button>}
            <Button className="h-7" disabled={!running} onClick={cancel} title="Stop the query on the server (Ctrl+.)">
              <Square size={12} /> Cancel
            </Button>
          </>
        )}
        <span className="mx-1 h-5 w-px bg-line" />
        <span className="hidden text-xs text-muted @[650px]:inline">DB</span>
        <Select aria-label="Database" className="h-7 min-w-0 max-w-[200px] flex-1 text-xs" value={meta.database ?? ""} onChange={(e) => void switchDb(e.target.value)} disabled={!tree?.databases.length}>
          {!meta.database && <option value="">(none)</option>}
          {(tree?.databases ?? (meta.database ? [meta.database] : [])).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
        <ConnectionMode sessionId={sessionId} label={label} env={env} />
        <span className="hidden text-xs text-muted @[650px]:inline">Tx: {meta.txOpen ? <b className="text-warn">open</b> : "none"}</span>
        {running ? (
          <span className="hidden items-center gap-1 text-xs text-accent @[650px]:flex">
            <Loader2 size={12} className="animate-spin" /> running…
          </span>
        ) : (
          run && <span className="hidden text-xs text-muted @[650px]:inline">{totalMs} ms</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <DatabaseFiles sessionId={sessionId} active={visible} requestsActive={requestsActive} enabled={meta.state === "connected" && !meta.txOpen} actions={[
            ...(compactToolbar ? [
              { label: "Run all", icon: <Play size={12} />, disabled: running || !queryActive, onClick: () => void exec("all") },
              { label: "Reconnect database", icon: <RefreshCw size={14} />, disabled: reconnecting || meta.state === "reconnecting", onClick: () => void reconnect() },
            ] : []),
            { label: "Save as snippet", icon: <Bookmark size={12} />, onClick: () => void saveSqlSnippet(editorText()) },
            { label: "History", icon: <History size={12} />, checked: !!panel, onClick: () => setPanel((p) => p ? null : "history") },
            ...(extra ?? []),
          ]} />
        </span>
      </div>

      {meta.txOpen && (
        <div className="flex items-center gap-3 border-b border-[#6A5828] bg-[#2F2A1E] px-4 py-1.5 text-[13px]">
          <AlertTriangle size={14} className="text-warn" />
          <span>
            Uncommitted changes{meta.txRows ? ` · ${meta.txRows} rows` : ""}
          </span>
          <Button className="ml-auto h-9 px-4" disabled={running} onClick={() => setReviewOpen(true)}>Review</Button>
          <Button className="h-9 px-4" variant="primary" onClick={() => void api.sqlTx(sessionId, "commit").catch((e) => setNotice(asCoreError(e).message))}>
            Commit
          </Button>
          <Button className="h-9 px-4" onClick={() => void api.sqlTx(sessionId, "rollback").catch((e) => setNotice(asCoreError(e).message))}>
            Rollback
          </Button>
        </div>
      )}
      {reviewOpen && meta.txOpen && <TransactionReviewDialog sessionId={sessionId} label={label} fontFamily={fontFamily} onClose={() => setReviewOpen(false)} />}
      {(meta.state === "lost" || meta.state === "reconnecting") && meta.message && (
        <div className="flex items-center gap-2 border-b border-[#5A2D33] bg-[#33232A] px-4 py-1.5 text-[13px] text-prod-fg">
          <AlertTriangle size={14} /><span className="flex-1">{meta.message}</span>
          <Button disabled={reconnecting || meta.state === "reconnecting"} onClick={() => void reconnect()}>{reconnecting || meta.state === "reconnecting" ? "Reconnecting…" : "Reconnect"}</Button>
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
          <ResizablePanel id="sql-schema" label="Resize database tree" initialWidth={260}>
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
          </ResizablePanel>
        )}
        <div className="relative min-w-0 flex-1">
        {tables.map((t) => (
          <TableView
            key={t.key}
            sessionId={sessionId}
            connKey={meta.connKey}
            env={env}
            schema={t.schema}
            table={t.table}
            info={tableInfo(t.schema, t.table)}
            sub={t.sub}
            onSub={(sub) => setTables((cur) => cur.map((x) => (x.key === t.key ? { ...x, sub, pinned: true } : x)))}
            visible={visible && active === t.key}
            requestsActive={requestsActive}
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
          <div onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
            onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeSplit(event.clientY); }}
            onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
            tabIndex={0} aria-orientation="horizontal" aria-valuemin={12} aria-valuemax={85} aria-valuenow={Math.round(split * 100)}
            onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setSplit((value) => Math.min(0.85, Math.max(0.12, value + (event.key === "ArrowDown" ? 0.05 : -0.05)))); } }} className="h-1.5 flex-none cursor-row-resize touch-none border-y border-line bg-panel hover:bg-accent-line" role="separator" aria-label="Resize editor" />
          <ResultsArea dialect={dialect} run={run} sets={sets} tab={tab} setTab={setTab} active={activeSet} meta={meta} fontFamily={fontFamily} onExport={exportCsv} onMore={(s) => run && void exec("all", { text: run.sql, rowLimit: s.rows.length + 500 })} />
        </div>
        </div>
        {panel && queryActive && (
          <ResizablePanel id="sql-history" label="Resize query sidebar" initialWidth={300} side="right">
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
          </ResizablePanel>
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
