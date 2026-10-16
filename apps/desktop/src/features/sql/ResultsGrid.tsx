import { useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Copy, Link2 } from "lucide-react";
import { api } from "../../ipc/api";
import type { ResultColumn } from "../../ipc/bindings/ResultColumn";
import type { SortKey } from "../../ipc/bindings/SortKey";
import { useContextMenu, type MenuItem } from "../../ui/ContextMenu";
import type { SqlResultSet } from "../../stores/sql";
import { numericColumns, toCsv, toTsv } from "./csv";

const ROW_H = 24;
const NUM_W = 52;
const SHOW_MAX = 200; // longer values are cut with "…" (full value on hover / copy)
const MIN_W = 48;
const MAX_W = 900;

/** Default width from the header and the first rows (7.4 px per char), clamped. */
function autoWidth(name: string, rows: (string | null)[][], i: number): number {
  let n = name.length + 3;
  for (let r = 0; r < rows.length && r < 100; r++) n = Math.max(n, Math.min(48, (rows[r][i] ?? "NULL").length));
  return Math.min(360, Math.max(64, n * 7.4 + 18));
}

export interface DataGridProps {
  columns: ResultColumn[];
  rows: (string | null)[][];
  fontFamily: string;
  /** Visible column indexes in display order (default: all). */
  order?: number[];
  /** Width per column name (overrides the automatic width). */
  widths?: Record<string, number>;
  onWidth?: (name: string, width: number) => void;
  /** Header click sorts; shift-click adds a second key. */
  sort?: SortKey[];
  onSort?: (name: string, add: boolean) => void;
  /** Drag a header onto another (display positions). */
  onReorder?: (from: number, to: number) => void;
  headerMenu?: (col: number) => MenuItem[];
  /** Items shown above the copy items of a cell's menu. */
  cellMenu?: (row: number, col: number) => MenuItem[];
  selected?: { r: number; c: number } | null;
  onSelect?: (cell: { r: number; c: number }) => void;
  /** Columns that point to another table (shown with a link mark). */
  linked?: Set<string>;
  /** Below the last row (e.g. "Load more"). */
  footer?: ReactNode;
  empty?: string;
}

/** Virtualised grid: only the visible rows are in the DOM. */
export function DataGrid(p: DataGridProps) {
  const { columns: cols, rows, fontFamily } = p;
  const scroller = useRef<HTMLDivElement>(null);
  const [ownSel, setOwnSel] = useState<{ r: number; c: number } | null>(null);
  const sel = p.selected !== undefined ? p.selected : ownSel;
  const select = (cell: { r: number; c: number }) => {
    setOwnSel(cell);
    p.onSelect?.(cell);
  };
  const [live, setLive] = useState<{ name: string; w: number } | null>(null); // width while dragging
  const dragFrom = useRef<number | null>(null);
  const resized = useRef(false);
  const menu = useContextMenu();

  const order = useMemo(() => p.order ?? cols.map((_, i) => i), [p.order, cols]);
  const numeric = useMemo(() => numericColumns(cols.map((c) => c.numeric), rows), [cols, rows]);
  const auto = useMemo(() => cols.map((c, i) => autoWidth(c.name, rows, i)), [cols, rows]);
  const width = (i: number) => (live?.name === cols[i].name ? live.w : (p.widths?.[cols[i].name] ?? auto[i]));
  const total = NUM_W + order.reduce((a, i) => a + width(i), 0);

  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 20 });

  const copy = (text: string) => void api.clipboardWrite(text);
  const names = cols.map((c) => c.name);
  const baseMenu = (r: number, c: number): MenuItem[] => [
    { label: "Copy value", icon: <Copy size={13} />, onClick: () => copy(rows[r][c] ?? "") },
    { label: "Copy row", onClick: () => copy(toTsv([rows[r]])) },
    { label: "Copy column", onClick: () => copy(rows.map((x) => x[c] ?? "").join("\n")) },
    { kind: "separator" as const },
    { label: "Copy all as CSV", onClick: () => copy(toCsv(names, rows)) },
    { label: "Copy all for a spreadsheet (TSV)", onClick: () => copy(toTsv([names, ...rows])) },
  ];

  const startResize = (e: React.PointerEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = width(i);
    const name = cols[i].name;
    resized.current = true;
    const move = (ev: PointerEvent) => setLive({ name, w: Math.min(MAX_W, Math.max(MIN_W, w0 + ev.clientX - x0)) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      p.onWidth?.(name, Math.min(MAX_W, Math.max(MIN_W, w0 + ev.clientX - x0)));
      setLive(null);
      setTimeout(() => (resized.current = false), 0); // the click after a resize is not a sort
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!sel) return;
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyC") {
      e.preventDefault();
      copy(rows[sel.r]?.[sel.c] ?? "");
      return;
    }
    const pos = order.indexOf(sel.c);
    const next =
      e.key === "ArrowDown" ? { r: Math.min(rows.length - 1, sel.r + 1), c: sel.c }
      : e.key === "ArrowUp" ? { r: Math.max(0, sel.r - 1), c: sel.c }
      : e.key === "ArrowRight" ? { r: sel.r, c: order[Math.min(order.length - 1, pos + 1)] }
      : e.key === "ArrowLeft" ? { r: sel.r, c: order[Math.max(0, pos - 1)] }
      : null;
    if (next && next.c != null) {
      e.preventDefault();
      select(next);
      v.scrollToIndex(next.r);
    }
  };

  return (
    <div ref={scroller} tabIndex={0} className="relative h-full overflow-auto bg-term outline-none" style={{ fontFamily }} onKeyDown={onKey}>
      <div style={{ width: total, minWidth: "100%" }}>
        <div className="sticky top-0 z-10 flex border-b border-line bg-panel text-xs text-muted" style={{ height: ROW_H + 2 }}>
          <div className="flex-none border-r border-line" style={{ width: NUM_W }} />
          {order.map((i, pos) => {
            const c = cols[i];
            const sortAt = p.sort?.findIndex((k) => k.column === c.name) ?? -1;
            const sk = sortAt >= 0 ? p.sort![sortAt] : null;
            return (
              <div
                key={c.name + i}
                draggable={!!p.onReorder}
                onDragStart={(e) => {
                  dragFrom.current = pos;
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => p.onReorder && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom.current != null && dragFrom.current !== pos) p.onReorder?.(dragFrom.current, pos);
                  dragFrom.current = null;
                }}
                onClick={(e) => !resized.current && p.onSort?.(c.name, e.shiftKey)}
                onContextMenu={p.headerMenu ? menu.open(() => p.headerMenu!(i)) : undefined}
                title={`${c.name}${c.type_name ? ` · ${c.type_name}` : ""}${p.onSort ? "\nClick: sort · Shift+click: sort by more columns · Drag: move" : ""}`}
                className={clsx(
                  "relative flex flex-none items-center gap-1 border-r border-line px-2 font-semibold text-text select-none",
                  numeric[i] && "justify-end",
                  p.onSort && "cursor-pointer hover:bg-panel2",
                )}
                style={{ width: width(i) }}
              >
                {p.linked?.has(c.name) && <Link2 size={11} className="flex-none text-accent" aria-label="foreign key" />}
                <span className="truncate">{c.name}</span>
                {sk && (
                  <span className="flex flex-none items-center text-accent">
                    {sk.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
                    {p.sort!.length > 1 && <span className="text-[10px]">{sortAt + 1}</span>}
                  </span>
                )}
                {p.onWidth && (
                  <span
                    onPointerDown={(e) => startResize(e, i)}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute top-0 right-[-3px] z-10 h-full w-[6px] cursor-col-resize hover:bg-accent-line"
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
        </div>
        <div className="relative text-[12.5px]" style={{ height: v.getTotalSize() }}>
          {v.getVirtualItems().map((it) => {
            const row = rows[it.index];
            return (
              <div key={it.key} className="absolute left-0 flex w-full border-b border-[#232b3b] hover:bg-[#1F2737]" style={{ top: 0, height: ROW_H, transform: `translateY(${it.start}px)` }}>
                <div className="flex-none border-r border-line px-2 text-right text-[11px] leading-6 text-[#6B7690]" style={{ width: NUM_W }}>
                  {it.index + 1}
                </div>
                {order.map((c) => {
                  const val = row[c];
                  const selected = sel?.r === it.index && sel.c === c;
                  return (
                    <div
                      key={c}
                      title={val != null && val.length > 40 ? val.slice(0, 2000) : undefined}
                      onMouseDown={() => select({ r: it.index, c })}
                      onContextMenu={(e) => {
                        select({ r: it.index, c });
                        const extra = p.cellMenu?.(it.index, c) ?? [];
                        menu.open([...extra, ...(extra.length ? [{ kind: "separator" as const }] : []), ...baseMenu(it.index, c)])(e);
                      }}
                      className={clsx(
                        "flex-none truncate border-r border-[#232b3b] px-2 leading-6",
                        numeric[c] && "text-right",
                        val == null && "text-[#6B7690] italic",
                        selected && "bg-accent-bg outline outline-1 -outline-offset-1 outline-accent-line",
                      )}
                      style={{ width: width(c) }}
                    >
                      {val == null ? "NULL" : val.length > SHOW_MAX ? `${val.slice(0, SHOW_MAX)}…` : val}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {p.footer}
      </div>
      {rows.length === 0 && <div className="px-3 py-3 text-xs text-muted">{p.empty ?? "No rows."}</div>}
      {menu.node}
    </div>
  );
}

/** Query tab results: the grid with its default behaviour. */
export function ResultsGrid({ set, fontFamily }: { set: SqlResultSet; fontFamily: string }) {
  return <DataGrid columns={set.columns ?? []} rows={set.rows} fontFamily={fontFamily} />;
}
