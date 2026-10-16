import { useMemo, useState } from "react";
import clsx from "clsx";
import { ChevronDown, ChevronRight, Eye, KeyRound, Loader2, RefreshCw, Table2 } from "lucide-react";
import type { SchemaTree as Tree } from "../../ipc/bindings/SchemaTree";
import type { TableInfo } from "../../ipc/bindings/TableInfo";
import { IconButton } from "../../ui/primitives";
import { useContextMenu, type MenuItem } from "../../ui/ContextMenu";
import type { Dialect } from "./split";

/** Quote a name only when it needs it. */
export function qid(name: string, d: Dialect): string {
  if (d === "mysql") return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : `\`${name.replace(/`/g, "``")}\``;
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** `schema.table` on Postgres (unless public), the table alone on MySQL (current database). */
export function tableRef(schema: string, table: string, d: Dialect): string {
  return d === "postgres" && schema !== "public" ? `${qid(schema, d)}.${qid(table, d)}` : qid(table, d);
}

/** A CREATE TABLE from what the tree knows (Postgres has no SHOW CREATE TABLE). */
export function createFor(schema: string, t: TableInfo, d: Dialect): string {
  const cols = t.columns.map((c) => `  ${qid(c.name, d)} ${c.data_type}${c.nullable ? "" : " NOT NULL"}${c.default != null ? ` DEFAULT ${c.default}` : ""}`);
  const pk = t.indexes.find((i) => i.primary);
  if (pk) cols.push(`  PRIMARY KEY (${pk.columns.map((c) => qid(c, d)).join(", ")})`);
  const idx = t.indexes
    .filter((i) => !i.primary)
    .map((i) => `CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${qid(i.name, d)} ON ${tableRef(schema, t.name, d)} (${i.columns.join(", ")});`);
  return [`CREATE TABLE ${tableRef(schema, t.name, d)} (\n${cols.join(",\n")}\n);`, ...idx].join("\n");
}

interface Props {
  tree: Tree | null;
  loading: boolean;
  error: string | null;
  dialect: Dialect;
  system: boolean;
  onSystem: (on: boolean) => void;
  onRefresh: () => void;
  /** Put SQL into the editor; `run` = also run it. */
  onSql: (sql: string, run: boolean) => void;
  onCopy: (text: string) => void;
}

const rowsLabel = (n: number | null) => (n == null ? "" : n >= 1000 ? `~${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `~${n}`);

export function SchemaTree({ tree, loading, error, dialect, system, onSystem, onRefresh, onSql, onCopy }: Props) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const menu = useContextMenu();
  const q = filter.trim().toLowerCase();

  const schemas = useMemo(() => {
    if (!tree) return [];
    return tree.schemas
      .map((s) => ({ ...s, tables: q ? s.tables.filter((t) => t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q))) : s.tables }))
      .filter((s) => !q || s.tables.length > 0);
  }, [tree, q]);
  const single = schemas.length === 1;

  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const isOpen = (k: string, dflt: boolean) => open[k] ?? dflt;

  const tableMenu = (schema: string, t: TableInfo): MenuItem[] => {
    const ref = tableRef(schema, t.name, dialect);
    return [
      { label: "Select top 100", onClick: () => onSql(`SELECT * FROM ${ref} LIMIT 100;`, true) },
      { label: "Count rows", onClick: () => onSql(`SELECT count(*) FROM ${ref};`, true) },
      { kind: "separator" },
      { label: "Insert column list", onClick: () => onSql(t.columns.map((c) => qid(c.name, dialect)).join(", "), false) },
      {
        label: "Show CREATE",
        onClick: () => (dialect === "mysql" ? onSql(`SHOW CREATE TABLE ${ref};`, true) : onSql(createFor(schema, t, dialect), false)),
      },
      { label: "Copy name", onClick: () => onCopy(ref) },
    ];
  };

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-1 border-b border-line p-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tables / columns"
          aria-label="Filter tables"
          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-xs text-text outline-none placeholder:text-[#6B7690] focus:border-accent-line"
        />
        <IconButton label="Reload schema" className="h-7 w-7" onClick={onRefresh}>
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 text-[12.5px]">
        {error && <div className="px-3 py-2 text-xs text-prod-fg">{error}</div>}
        {!tree && !error && loading && <div className="px-3 py-2 text-xs text-muted">Loading…</div>}
        {tree && !tree.database && dialect === "mysql" && <div className="px-3 py-2 text-xs text-muted">No database selected. Pick one in the toolbar.</div>}
        {schemas.map((s) => {
          const sk = `s:${s.name}`;
          const sOpen = single || isOpen(sk, s.name === "public" || !!q);
          return (
            <div key={s.name}>
              {!single && (
                <button onClick={() => toggle(sk)} className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-muted hover:text-text">
                  {sOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="truncate">{s.name}</span>
                  <span className="ml-auto text-[11px]">{s.tables.length}</span>
                </button>
              )}
              {sOpen &&
                s.tables.map((t) => {
                  const tk = `t:${s.name}.${t.name}`;
                  const tOpen = isOpen(tk, false);
                  return (
                    <div key={t.name}>
                      <button
                        onClick={() => toggle(tk)}
                        onDoubleClick={() => onSql(`SELECT * FROM ${tableRef(s.name, t.name, dialect)} LIMIT 100;`, true)}
                        onContextMenu={menu.open(() => tableMenu(s.name, t))}
                        title="Double-click: show the first 100 rows · right-click: more"
                        className={clsx("flex w-full items-center gap-1.5 py-0.5 pr-2 text-left hover:bg-panel2", single ? "pl-2" : "pl-5")}
                      >
                        {tOpen ? <ChevronDown size={12} className="flex-none text-muted" /> : <ChevronRight size={12} className="flex-none text-muted" />}
                        {t.kind === "view" || t.kind === "matview" ? <Eye size={13} className="flex-none text-muted" /> : <Table2 size={13} className="flex-none text-accent" />}
                        <span className="truncate">{t.name}</span>
                        <span className="ml-auto flex-none text-[11px] text-[#6B7690]">{rowsLabel(t.rows_est)}</span>
                      </button>
                      {tOpen && (
                        <div className={clsx("pb-1", single ? "pl-7" : "pl-10")}>
                          {t.columns.map((c) => (
                            <div key={c.name} className="flex items-center gap-1.5 py-px pr-2" title={`${c.data_type}${c.nullable ? "" : " NOT NULL"}${c.default != null ? ` DEFAULT ${c.default}` : ""}`}>
                              {c.key === "PRI" ? <KeyRound size={11} className="flex-none text-warn" /> : <span className="w-[11px] flex-none" />}
                              <span className={clsx("truncate", c.key && "font-medium")}>{c.name}</span>
                              <span className="ml-auto truncate font-mono text-[11px] text-[#6B7690]">
                                {c.data_type}
                              </span>
                            </div>
                          ))}
                          {t.indexes.length > 0 && (
                            <div className="mt-0.5 text-[11px] text-[#6B7690]">
                              {t.indexes.map((i) => (
                                <div key={i.name} className="truncate" title={i.columns.join(", ")}>
                                  {i.primary ? "PK" : i.unique ? "UNIQUE" : "INDEX"} {i.name} ({i.columns.join(", ")})
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
        {tree && schemas.length === 0 && !error && <div className="px-3 py-2 text-xs text-muted">{q ? "Nothing matches." : "No tables."}</div>}
      </div>
      <label className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-[11px] text-muted">
        <input type="checkbox" checked={system} onChange={(e) => onSystem(e.target.checked)} /> Show system {dialect === "mysql" ? "databases" : "schemas"}
      </label>
      {menu.node}
    </div>
  );
}
