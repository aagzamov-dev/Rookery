import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Code2, Columns3, Copy, Download, Eye, Filter, Hash, KeyRound, Link2, Loader2, PanelRight, Plus, RefreshCw, Search, Table2, X } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { ColumnFilter } from "../../ipc/bindings/ColumnFilter";
import type { FilterOp } from "../../ipc/bindings/FilterOp";
import type { ForeignKey } from "../../ipc/bindings/ForeignKey";
import type { ResultColumn } from "../../ipc/bindings/ResultColumn";
import type { SortKey } from "../../ipc/bindings/SortKey";
import type { TableDetail } from "../../ipc/bindings/TableDetail";
import type { TableInfo } from "../../ipc/bindings/TableInfo";
import type { TableQuery } from "../../ipc/bindings/TableQuery";
import { useSql } from "../../stores/sql";
import { useContextMenu, type MenuItem } from "../../ui/ContextMenu";
import { bytes } from "../../ui/format";
import { Button, IconButton, Select } from "../../ui/primitives";
import { toCsv } from "./csv";
import { DataGrid } from "./ResultsGrid";
import { columnOrder, EMPTY_LAYOUT, moveColumn, PAGE_SIZES, useTableLayouts } from "./tableLayout";

export type TableSub = "data" | "structure";

/** Open another table (foreign-key jump), optionally filtered. */
export type OpenTable = (schema: string, table: string, opts?: { filter?: ColumnFilter; pin?: boolean }) => void;

interface Props {
  sessionId: string;
  connKey: string;
  schema: string;
  table: string;
  /** From the schema tree (columns + indexes known at once, for the default sort). */
  info?: TableInfo;
  sub: TableSub;
  onSub: (s: TableSub) => void;
  visible: boolean;
  fontFamily: string;
  onOpenTable: OpenTable;
  /** Put SQL into the Query tab. */
  onQuery: (sql: string) => void;
  /** A filter to apply when the tab is opened from a foreign key (changes `nonce` to re-apply). */
  initialFilter?: { filter: ColumnFilter; nonce: number };
}

export const OPS: { op: FilterOp; label: string; value: boolean }[] = [
  { op: "eq", label: "=", value: true },
  { op: "ne", label: "≠", value: true },
  { op: "contains", label: "contains", value: true },
  { op: "not_contains", label: "doesn't contain", value: true },
  { op: "starts_with", label: "starts with", value: true },
  { op: "ends_with", label: "ends with", value: true },
  { op: "lt", label: "<", value: true },
  { op: "le", label: "≤", value: true },
  { op: "gt", label: ">", value: true },
  { op: "ge", label: "≥", value: true },
  { op: "is_null", label: "is NULL", value: false },
  { op: "not_null", label: "is not NULL", value: false },
  { op: "empty", label: "is empty", value: false },
  { op: "not_empty", label: "is not empty", value: false },
];
const opLabel = (op: FilterOp) => OPS.find((o) => o.op === op)?.label ?? op;
const needsValue = (op: FilterOp) => OPS.find((o) => o.op === op)?.value ?? true;

export function filterText(f: ColumnFilter): string {
  const v = f.value ?? "";
  return needsValue(f.op) ? `${f.column} ${opLabel(f.op)} ${v.length > 40 ? `${v.slice(0, 40)}…` : v}` : `${f.column} ${opLabel(f.op)}`;
}

/** One table: Structure (columns, keys, CREATE) and Data (filter, sort, columns, paging). */
export function TableView(p: Props) {
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const wanted = p.visible; // Structure and the data's foreign-key links both need it

  const loadDetail = useCallback(async () => {
    setDetailBusy(true);
    setDetailErr(null);
    try {
      setDetail(await api.sqlTableDetail(p.sessionId, p.schema, p.table));
    } catch (e) {
      setDetailErr(asCoreError(e).message);
    } finally {
      setDetailBusy(false);
    }
  }, [p.sessionId, p.schema, p.table]);
  const asked = useRef(false);
  useEffect(() => {
    if (wanted && !asked.current) {
      asked.current = true;
      void loadDetail();
    }
  }, [wanted, loadDetail]);

  return (
    <div className="absolute inset-0 flex flex-col bg-bg" style={{ display: p.visible ? "flex" : "none" }}>
      <div className="flex min-h-9 items-center gap-1 border-b border-line bg-panel px-2">
        {(["data", "structure"] as TableSub[]).map((s) => (
          <button
            key={s}
            onClick={() => p.onSub(s)}
            className={clsx("flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px]", p.sub === s ? "bg-panel2 text-text" : "text-muted hover:text-text")}
          >
            {s === "data" ? <Table2 size={13} /> : <Columns3 size={13} />}
            {s === "data" ? "Data" : "Structure"}
          </button>
        ))}
        <span className="ml-2 truncate font-mono text-xs text-muted">
          {p.schema}.{p.table}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <DataPane {...p} visible={p.visible && p.sub === "data"} detail={detail} />
        {p.sub === "structure" && <StructurePane detail={detail} error={detailErr} busy={detailBusy} onReload={() => void loadDetail()} onOpenTable={p.onOpenTable} onQuery={p.onQuery} schema={p.schema} table={p.table} fontFamily={p.fontFamily} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- Data

function DataPane(p: Props & { detail: TableDetail | null }) {
  const layoutKey = `${p.connKey}|${p.schema}.${p.table}`;
  const layout = useTableLayouts((s) => s.layouts[layoutKey]) ?? EMPTY_LAYOUT;
  const updateLayout = useTableLayouts((s) => s.update);
  useEffect(() => void useTableLayouts.getState().load(), []);

  const pk = useMemo(() => p.info?.indexes.find((i) => i.primary)?.columns ?? [], [p.info]);
  const [filters, setFilters] = useState<ColumnFilter[]>(p.initialFilter ? [p.initialFilter.filter] : []);
  const [search, setSearch] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [whereText, setWhereText] = useState("");
  const [where, setWhere] = useState("");
  const [showWhere, setShowWhere] = useState(false);
  const [sort, setSort] = useState<SortKey[]>(() => pk.map((c) => ({ column: c, desc: false })));
  const [editor, setEditor] = useState<{ index: number | null; f: ColumnFilter } | null>(null);
  const [rows, setRows] = useState<(string | null)[][]>([]);
  const [columns, setColumns] = useState<ResultColumn[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSql, setLastSql] = useState("");
  const [showSql, setShowSql] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [count, setCount] = useState<number | null | "busy">(null);
  const [queryId, setQueryId] = useState<string | null>(null);
  const [append, setAppend] = useState(false);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const run = useSql((s) => (queryId ? s.runs[queryId] : undefined));
  const loading = !!queryId;
  const colsMenu = useContextMenu();

  // A foreign-key jump into an already open tab replaces the filters.
  const nonce = p.initialFilter?.nonce;
  useEffect(() => {
    if (p.initialFilter) setFilters([p.initialFilter.filter]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  // Search waits until you stop typing.
  useEffect(() => {
    const t = setTimeout(() => setSearchQ(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const query = useCallback(
    (offset: number): TableQuery => ({
      schema: p.schema,
      table: p.table,
      filters,
      search: searchQ || null,
      where_sql: where || null,
      sort,
      limit: layout.pageSize,
      offset,
    }),
    [p.schema, p.table, filters, searchQ, where, sort, layout.pageSize],
  );

  const load = useCallback(
    async (more: boolean) => {
      setError(null);
      try {
        const started = await api.sqlTableRows(p.sessionId, query(more ? rows.length : 0));
        useSql.getState().startRun({ queryId: started.query_id, sessionId: p.sessionId, sql: started.sql, offset: -1, rowLimit: layout.pageSize });
        setLastSql(started.sql);
        setAppend(more);
        setQueryId(started.query_id);
        if (!more) setCount(null);
      } catch (e) {
        setError(asCoreError(e).message);
      }
    },
    [p.sessionId, query, rows.length, layout.pageSize],
  );

  // Load when the Data tab is shown, and again whenever filters / sort / page size change.
  const key = JSON.stringify(query(0));
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!p.visible || loadedKey.current === key || loading) return;
    loadedKey.current = key;
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.visible, key, loading]);

  // A page finished: take its rows and free the run.
  useEffect(() => {
    if (!run?.finished || !queryId) return;
    const set = run.sets.find((s) => s.error) ?? run.sets.find((s) => s.columns);
    if (set?.error) setError(set.error);
    else if (set) {
      setColumns(set.columns ?? []);
      setRows((prev) => (append ? prev.concat(set.rows) : set.rows));
      setHasMore(set.truncated);
      setElapsed(set.elapsedMs);
      if (!append) setSel(null);
    }
    useSql.getState().forgetRun(queryId);
    setQueryId(null);
  }, [run?.finished, queryId, run, append]);

  const names = useMemo(() => columns.map((c) => c.name), [columns]);
  const order = useMemo(() => columnOrder(names, layout), [names, layout]);
  const fkOut = useMemo(() => {
    const m = new Map<string, ForeignKey>();
    for (const fk of p.detail?.foreign_keys ?? []) if (fk.from_columns.length) m.set(fk.from_columns[0], fk);
    return m;
  }, [p.detail]);
  const fkIn = useMemo(() => {
    const m = new Map<string, ForeignKey[]>();
    for (const fk of p.detail?.referenced_by ?? []) {
      const c = fk.to_columns[0];
      if (c) m.set(c, [...(m.get(c) ?? []), fk]);
    }
    return m;
  }, [p.detail]);
  const linked = useMemo(() => new Set(fkOut.keys()), [fkOut]);

  const addFilter = (f: ColumnFilter) => setFilters((fs) => [...fs.filter((x) => !(x.column === f.column && x.op === f.op)), f]);
  const sortBy = (column: string, add: boolean, desc?: boolean) =>
    setSort((cur) => {
      const at = cur.findIndex((k) => k.column === column);
      if (desc !== undefined) return add ? [...cur.filter((k) => k.column !== column), { column, desc }] : [{ column, desc }];
      // Click: ascending → descending → off.
      const next: SortKey | null = at < 0 ? { column, desc: false } : !cur[at].desc ? { column, desc: true } : null;
      const rest = add ? cur.filter((k) => k.column !== column) : [];
      return next ? (add && at >= 0 ? cur.map((k, i) => (i === at ? next : k)) : [...rest, next]) : rest;
    });
  const hide = (name: string) => updateLayout(layoutKey, { hidden: [...layout.hidden, name] });

  const cellMenu = (r: number, c: number): MenuItem[] => {
    const col = names[c];
    const val = rows[r]?.[c] ?? null;
    const short = val != null && val.length > 30 ? `${val.slice(0, 30)}…` : val;
    const items: MenuItem[] =
      val == null
        ? [
            { label: `Filter: ${col} is NULL`, icon: <Filter size={13} />, onClick: () => addFilter({ column: col, op: "is_null", value: null }) },
            { label: `Filter: ${col} is not NULL`, onClick: () => addFilter({ column: col, op: "not_null", value: null }) },
          ]
        : [
            { label: `Filter: ${col} = ${short}`, icon: <Filter size={13} />, onClick: () => addFilter({ column: col, op: "eq", value: val }) },
            { label: `Filter: ${col} ≠ ${short}`, onClick: () => addFilter({ column: col, op: "ne", value: val }) },
            { label: `Filter: ${col} contains…`, onClick: () => setEditor({ index: null, f: { column: col, op: "contains", value: val } }) },
          ];
    const out = fkOut.get(col);
    if (out && val != null) {
      items.push({ kind: "separator" }, {
        label: `Open ${out.to_table} where ${out.to_columns[0]} = ${short}`,
        icon: <Link2 size={13} />,
        onClick: () => p.onOpenTable(out.to_schema, out.to_table, { filter: { column: out.to_columns[0], op: "eq", value: val }, pin: true }),
      });
    }
    for (const fk of fkIn.get(col) ?? []) {
      if (val == null) break;
      items.push({
        label: `Rows in ${fk.from_table} pointing here`,
        icon: <Link2 size={13} />,
        onClick: () => p.onOpenTable(fk.from_schema, fk.from_table, { filter: { column: fk.from_columns[0], op: "eq", value: val }, pin: true }),
      });
    }
    return items;
  };

  const headerMenu = (c: number): MenuItem[] => {
    const col = names[c];
    return [
      { label: "Sort ascending", onClick: () => sortBy(col, false, false) },
      { label: "Sort descending", onClick: () => sortBy(col, false, true) },
      { label: "Clear sorting", onClick: () => setSort([]) },
      { kind: "separator" },
      { label: `Filter by ${col}…`, icon: <Filter size={13} />, onClick: () => setEditor({ index: null, f: { column: col, op: "contains", value: "" } }) },
      { label: "Hide column", onClick: () => hide(col) },
      { label: "Show all columns", onClick: () => updateLayout(layoutKey, { hidden: [] }) },
      { label: "Reset columns (order, widths)", onClick: () => updateLayout(layoutKey, { order: [], hidden: [], widths: {} }) },
    ];
  };

  const columnsMenu = (): MenuItem[] => [
    { kind: "label", label: "Show columns" },
    ...names.map<MenuItem>((n) => ({
      label: n,
      checked: !layout.hidden.includes(n),
      onClick: () => updateLayout(layoutKey, { hidden: layout.hidden.includes(n) ? layout.hidden.filter((h) => h !== n) : [...layout.hidden, n] }),
    })),
    { kind: "separator" },
    { label: "Show all", onClick: () => updateLayout(layoutKey, { hidden: [] }) },
    { label: "Reset order and widths", onClick: () => updateLayout(layoutKey, { order: [], widths: {} }) },
  ];

  const exportCsv = async () => {
    const path = await saveDialog({ defaultPath: `${p.table}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    try {
      await api.fileWriteText(path, toCsv(order.map((i) => names[i]), rows.map((r) => order.map((i) => r[i]))));
    } catch (e) {
      setError(asCoreError(e).message);
    }
  };

  const doCount = async () => {
    setCount("busy");
    try {
      setCount(await api.sqlTableCount(p.sessionId, query(0)));
    } catch (e) {
      setCount(null);
      setError(asCoreError(e).message);
    }
  };

  const active = filters.length + (searchQ ? 1 : 0) + (where ? 1 : 0);
  const row = sel ? rows[sel.r] : undefined;

  return (
    <div className="absolute inset-0 flex flex-col" style={{ display: p.visible ? "flex" : "none" }}>
      {/* filter bar */}
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 border-b border-line bg-term px-2 py-1">
        <label className="flex h-7 w-56 items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-muted focus-within:border-accent-line">
          <Search size={12} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search text columns" aria-label="Search rows" className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none" />
          {search && (
            <button aria-label="Clear search" onClick={() => setSearch("")}>
              <X size={11} />
            </button>
          )}
        </label>
        <Button className="h-7 px-2 text-xs" onClick={() => setEditor({ index: null, f: { column: names[order[0]] ?? p.info?.columns[0]?.name ?? "", op: "contains", value: "" } })} disabled={!names.length && !p.info}>
          <Plus size={12} /> Filter
        </Button>
        <Button className={clsx("h-7 px-2 font-mono text-xs", (showWhere || where) && "border-accent-line bg-accent-bg")} onClick={() => setShowWhere((x) => !x)} title="Write the condition yourself (what comes after WHERE)">
          WHERE
        </Button>
        {filters.map((f, i) => (
          <span key={i} className="flex h-6 items-center gap-1 rounded-full border border-accent-line bg-accent-bg pr-1 pl-2.5 text-xs">
            <button onClick={() => setEditor({ index: i, f })} title="Edit filter" className="max-w-[260px] truncate">
              {filterText(f)}
            </button>
            <button aria-label="Remove filter" onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))} className="grid h-4 w-4 place-items-center rounded-full hover:bg-panel2">
              <X size={10} />
            </button>
          </span>
        ))}
        {where && !showWhere && (
          <span className="flex h-6 items-center gap-1 rounded-full border border-accent-line bg-accent-bg pr-1 pl-2.5 font-mono text-xs">
            <button onClick={() => setShowWhere(true)} className="max-w-[260px] truncate">WHERE {where}</button>
            <button aria-label="Remove condition" onClick={() => { setWhere(""); setWhereText(""); }} className="grid h-4 w-4 place-items-center rounded-full hover:bg-panel2">
              <X size={10} />
            </button>
          </span>
        )}
        {active > 1 && (
          <button className="text-xs text-muted hover:text-text" onClick={() => { setFilters([]); setSearch(""); setWhere(""); setWhereText(""); }}>
            Clear all
          </button>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted">
          {loading ? (
            <span className="flex items-center gap-1 text-accent">
              <Loader2 size={12} className="animate-spin" /> loading…
            </span>
          ) : (
            <span>
              {rows.length}
              {hasMore ? "+" : ""} rows{elapsed != null ? ` · ${elapsed} ms` : ""}
            </span>
          )}
          {count === "busy" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : count != null ? (
            <span className="text-text">of {count.toLocaleString()}</span>
          ) : (
            <button className="flex items-center gap-0.5 hover:text-text" onClick={() => void doCount()} title="Count all matching rows (can be slow on big tables)">
              <Hash size={11} /> Count
            </button>
          )}
          <Select className="h-7 w-[74px] text-xs" value={layout.pageSize} onChange={(e) => updateLayout(layoutKey, { pageSize: Number(e.target.value) })} aria-label="Rows per page">
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <IconButton label="Reload" className="h-7 w-7" onClick={() => void load(false)} disabled={loading}>
            <RefreshCw size={13} />
          </IconButton>
          <IconButton label="Columns" className="h-7 w-7" onClick={(e) => colsMenu.open(columnsMenu)(e)}>
            <Columns3 size={13} />
          </IconButton>
          <IconButton label={detailOpen ? "Hide row details" : "Show row details"} className={clsx("h-7 w-7", detailOpen && "bg-accent-bg text-text")} onClick={() => setDetailOpen((x) => !x)}>
            <PanelRight size={13} />
          </IconButton>
          <IconButton label="Show the SQL" className={clsx("h-7 w-7", showSql && "bg-accent-bg text-text")} onClick={() => setShowSql((x) => !x)}>
            <Code2 size={13} />
          </IconButton>
          <IconButton label="Save these rows as CSV" className="h-7 w-7" onClick={() => void exportCsv()} disabled={!rows.length}>
            <Download size={13} />
          </IconButton>
        </span>
      </div>

      {editor && (
        <FilterEditor
          columns={names.length ? names : (p.info?.columns.map((c) => c.name) ?? [])}
          value={editor.f}
          editing={editor.index != null}
          onCancel={() => setEditor(null)}
          onApply={(f) => {
            setFilters((fs) => (editor.index != null ? fs.map((x, i) => (i === editor.index ? f : x)) : [...fs, f]));
            setEditor(null);
          }}
        />
      )}
      {showWhere && (
        <form
          className="flex items-center gap-2 border-b border-line bg-panel px-2 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            setWhere(whereText.trim());
          }}
        >
          <span className="font-mono text-xs text-muted">WHERE</span>
          <input
            autoFocus
            value={whereText}
            onChange={(e) => setWhereText(e.target.value)}
            placeholder={`e.g. created_at > '2026-01-01' AND status <> 'sent'`}
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 font-mono text-xs text-text outline-none focus:border-accent-line"
            style={{ fontFamily: p.fontFamily }}
          />
          <Button className="h-7 text-xs" variant="primary" type="submit">
            Apply
          </Button>
          <Button className="h-7 text-xs" variant="ghost" type="button" onClick={() => setShowWhere(false)}>
            Close
          </Button>
        </form>
      )}
      {showSql && lastSql && (
        <div className="flex items-center gap-2 border-b border-line bg-panel px-2 py-1.5">
          <code className="min-w-0 flex-1 truncate text-xs text-muted" style={{ fontFamily: p.fontFamily }} title={lastSql}>
            {lastSql}
          </code>
          <Button className="h-7 text-xs" onClick={() => void api.clipboardWrite(lastSql)}>
            <Copy size={12} /> Copy
          </Button>
          <Button className="h-7 text-xs" onClick={() => p.onQuery(`${lastSql.replace(/ LIMIT \d+( OFFSET \d+)?$/, ` LIMIT ${layout.pageSize}`)};`)}>
            Open in Query
          </Button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 border-b border-[#5A2D33] bg-[#33232A] px-3 py-1.5 text-xs whitespace-pre-wrap text-prod-fg">
          <span className="flex-1">{error}</span>
          <button className="text-muted hover:text-text" onClick={() => void load(false)}>
            Retry
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <DataGrid
            columns={columns}
            rows={rows}
            fontFamily={p.fontFamily}
            order={order}
            widths={layout.widths}
            onWidth={(name, w) => updateLayout(layoutKey, { widths: { ...layout.widths, [name]: w } })}
            sort={sort}
            onSort={(name, add) => sortBy(name, add)}
            onReorder={(from, to) => updateLayout(layoutKey, { order: moveColumn(names, order, from, to) })}
            headerMenu={headerMenu}
            cellMenu={cellMenu}
            selected={sel}
            onSelect={setSel}
            linked={linked}
            empty={loading ? "Loading…" : active ? "No rows match the filters." : "The table is empty."}
            footer={
              hasMore && !loading ? (
                <div className="px-3 py-2">
                  <button className="text-xs text-accent hover:underline" onClick={() => void load(true)}>
                    Load {layout.pageSize} more
                  </button>
                </div>
              ) : null
            }
          />
        </div>
        {detailOpen && (
          <aside className="flex w-[320px] flex-none flex-col border-l border-line bg-panel">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs font-semibold text-muted">
              <Eye size={13} /> Row {sel ? sel.r + 1 : ""}
              <IconButton label="Close row details" className="ml-auto h-6 w-6" onClick={() => setDetailOpen(false)}>
                <X size={12} />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
              {!row && <p className="m-0 text-xs text-muted">Click a row to see all its values here.</p>}
              {row &&
                [...order, ...names.map((_, i) => i).filter((i) => !order.includes(i))].map((i) => (
                  <div key={i} className={clsx("group/f mb-2.5", !order.includes(i) && "opacity-60")}>
                    <div className="flex items-center gap-1.5 text-[11px] text-muted">
                      {pk.includes(names[i]) && <KeyRound size={10} className="text-warn" />}
                      {linked.has(names[i]) && <Link2 size={10} className="text-accent" />}
                      <span className="font-semibold text-text">{names[i]}</span>
                      <span className="truncate">{p.info?.columns.find((c) => c.name === names[i])?.data_type}</span>
                      <button aria-label={`Copy ${names[i]}`} className="ml-auto hidden text-muted hover:text-text group-hover/f:block" onClick={() => void api.clipboardWrite(row[i] ?? "")}>
                        <Copy size={11} />
                      </button>
                    </div>
                    <div
                      className={clsx("mt-0.5 max-h-48 overflow-auto rounded border border-[#303A4E] bg-term px-2 py-1 text-xs break-all whitespace-pre-wrap select-text", row[i] == null && "text-[#6B7690] italic")}
                      style={{ fontFamily: p.fontFamily }}
                    >
                      {row[i] ?? "NULL"}
                    </div>
                  </div>
                ))}
            </div>
          </aside>
        )}
      </div>
      {colsMenu.node}
    </div>
  );
}

function FilterEditor({ columns, value, editing, onApply, onCancel }: { columns: string[]; value: ColumnFilter; editing: boolean; onApply: (f: ColumnFilter) => void; onCancel: () => void }) {
  const [f, setF] = useState<ColumnFilter>({ ...value, column: value.column || columns[0] || "" });
  const valueNeeded = needsValue(f.op);
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-2 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!f.column) return;
        onApply({ ...f, value: valueNeeded ? (f.value ?? "") : null });
      }}
    >
      <Filter size={13} className="text-muted" />
      <Select className="h-7 max-w-[220px] text-xs" value={f.column} onChange={(e) => setF({ ...f, column: e.target.value })} aria-label="Column">
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>
      <Select className="h-7 text-xs" value={f.op} onChange={(e) => setF({ ...f, op: e.target.value as FilterOp })} aria-label="Condition">
        {OPS.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </Select>
      {valueNeeded && (
        <input
          autoFocus
          value={f.value ?? ""}
          onChange={(e) => setF({ ...f, value: e.target.value })}
          placeholder="value"
          aria-label="Value"
          className="h-7 w-60 rounded-md border border-line bg-bg px-2 text-xs text-text outline-none focus:border-accent-line"
        />
      )}
      <Button className="h-7 text-xs" variant="primary" type="submit">
        {editing ? "Update" : "Add filter"}
      </Button>
      <Button className="h-7 text-xs" variant="ghost" type="button" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

// -------------------------------------------------------------- Structure

function StructurePane({
  detail,
  error,
  busy,
  onReload,
  onOpenTable,
  onQuery,
  schema,
  table,
  fontFamily,
}: {
  detail: TableDetail | null;
  error: string | null;
  busy: boolean;
  onReload: () => void;
  onOpenTable: OpenTable;
  onQuery: (sql: string) => void;
  schema: string;
  table: string;
  fontFamily: string;
}) {
  const fkCols = useMemo(() => new Set((detail?.foreign_keys ?? []).flatMap((f) => f.from_columns)), [detail]);
  const th = "px-2.5 py-1.5 text-left font-semibold text-muted";
  const td = "px-2.5 py-1 align-top";
  const fkTarget = (schemaName: string, tableName: string, cols: string[]) => (
    <button className="text-accent hover:underline" onClick={() => onOpenTable(schemaName, tableName, { pin: true })} title="Open this table">
      {schemaName !== schema ? `${schemaName}.` : ""}
      {tableName}
      <span className="text-muted"> ({cols.join(", ")})</span>
    </button>
  );
  return (
    <div className="absolute inset-0 overflow-auto px-4 py-3 text-[12.5px]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-semibold">{table}</span>
        {detail && <span className="rounded bg-panel2 px-1.5 py-0.5 text-[11px] text-muted uppercase">{detail.kind}</span>}
        {detail?.rows_est != null && <span className="text-xs text-muted">~{detail.rows_est.toLocaleString()} rows</span>}
        {detail?.size_bytes != null && <span className="text-xs text-muted">· {bytes(detail.size_bytes)}</span>}
        {detail?.engine && <span className="text-xs text-muted">· {detail.engine}</span>}
        {detail?.collation && <span className="text-xs text-muted">· {detail.collation}</span>}
        <span className="ml-auto flex gap-1.5">
          <Button className="h-7 text-xs" onClick={onReload} disabled={busy}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Reload
          </Button>
        </span>
      </div>
      {detail?.comment && <p className="m-0 mb-3 text-xs text-muted">{detail.comment}</p>}
      {error && <div className="mb-3 rounded-md border border-[#5A2D33] bg-[#33232A] px-3 py-2 text-xs text-prod-fg">{error}</div>}
      {!detail && !error && <p className="text-xs text-muted">Loading the structure…</p>}
      {detail && (
        <>
          <Section title={`Columns · ${detail.columns.length}`}>
            <table className="w-full border-collapse">
              <thead className="border-b border-line bg-panel">
                <tr>
                  <th className={clsx(th, "w-8")}>#</th>
                  <th className={th}>Name</th>
                  <th className={th}>Type</th>
                  <th className={th}>Null</th>
                  <th className={th}>Default</th>
                  <th className={th}>Extra</th>
                  <th className={th}>Comment</th>
                </tr>
              </thead>
              <tbody>
                {detail.columns.map((c, i) => (
                  <tr key={c.name} className="border-b border-[#232b3b] hover:bg-[#1F2737]">
                    <td className={clsx(td, "text-[#6B7690]")}>{i + 1}</td>
                    <td className={clsx(td, "font-medium")}>
                      <span className="flex items-center gap-1.5">
                        {c.key === "PRI" ? <KeyRound size={11} className="text-warn" aria-label="primary key" /> : c.key ? <KeyRound size={11} className="text-muted" aria-label="index" /> : <span className="w-[11px]" />}
                        {fkCols.has(c.name) && <Link2 size={11} className="text-accent" aria-label="foreign key" />}
                        {c.name}
                      </span>
                    </td>
                    <td className={clsx(td, "font-mono text-xs")} style={{ fontFamily }}>
                      {c.data_type}
                    </td>
                    <td className={td}>{c.nullable ? "yes" : <span className="text-muted">no</span>}</td>
                    <td className={clsx(td, "max-w-[260px] truncate font-mono text-xs text-muted")} title={c.default ?? ""} style={{ fontFamily }}>
                      {c.default ?? ""}
                    </td>
                    <td className={clsx(td, "text-xs text-muted")}>{c.extra ?? ""}</td>
                    <td className={clsx(td, "text-xs text-muted")}>{c.comment ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section title={`Indexes · ${detail.indexes.length}`}>
            {detail.indexes.length === 0 ? (
              <p className="m-0 px-2.5 py-2 text-xs text-muted">No indexes.</p>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {detail.indexes.map((ix) => (
                    <tr key={ix.name} className="border-b border-[#232b3b]">
                      <td className={clsx(td, "w-24 text-[11px] font-semibold text-muted")}>{ix.primary ? "PRIMARY" : ix.unique ? "UNIQUE" : "INDEX"}</td>
                      <td className={clsx(td, "font-medium")}>{ix.name}</td>
                      <td className={clsx(td, "font-mono text-xs")} style={{ fontFamily }}>
                        {ix.columns.join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          <Section title={`Foreign keys · ${detail.foreign_keys.length}`}>
            {detail.foreign_keys.length === 0 ? (
              <p className="m-0 px-2.5 py-2 text-xs text-muted">This table points to no other table.</p>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {detail.foreign_keys.map((fk) => (
                    <tr key={fk.name} className="border-b border-[#232b3b]">
                      <td className={clsx(td, "font-medium")}>{fk.from_columns.join(", ")}</td>
                      <td className={td}>→ {fkTarget(fk.to_schema, fk.to_table, fk.to_columns)}</td>
                      <td className={clsx(td, "text-xs text-muted")}>
                        {fk.on_delete && `on delete ${fk.on_delete.toLowerCase()}`}
                        {fk.on_update && fk.on_update !== "NO ACTION" && ` · on update ${fk.on_update.toLowerCase()}`}
                      </td>
                      <td className={clsx(td, "text-xs text-[#6B7690]")}>{fk.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          {detail.referenced_by.length > 0 && (
            <Section title={`Referenced by · ${detail.referenced_by.length}`}>
              <table className="w-full border-collapse">
                <tbody>
                  {detail.referenced_by.map((fk) => (
                    <tr key={`${fk.from_table}.${fk.name}`} className="border-b border-[#232b3b]">
                      <td className={td}>{fkTarget(fk.from_schema, fk.from_table, fk.from_columns)}</td>
                      <td className={clsx(td, "text-muted")}>→ {fk.to_columns.join(", ")}</td>
                      <td className={clsx(td, "text-xs text-[#6B7690]")}>{fk.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
          {detail.create_sql && (
            <Section
              title="CREATE code"
              right={
                <span className="flex gap-1.5">
                  <Button className="h-6 px-2 text-[11px]" onClick={() => void api.clipboardWrite(detail.create_sql ?? "")}>
                    <Copy size={11} /> Copy
                  </Button>
                  <Button className="h-6 px-2 text-[11px]" onClick={() => onQuery(detail.create_sql ?? "")}>
                    Open in Query
                  </Button>
                </span>
              }
            >
              <pre className="m-0 overflow-auto px-3 py-2 text-xs leading-relaxed whitespace-pre text-[#D3D9E4] select-text" style={{ fontFamily }}>
                {detail.create_sql}
              </pre>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-line bg-term">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs font-semibold text-muted">
        {title}
        {right && <span className="ml-auto">{right}</span>}
      </div>
      {children}
    </section>
  );
}
