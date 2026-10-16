import { useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy } from "lucide-react";
import { api } from "../../ipc/api";
import { useContextMenu, type MenuItem } from "../../ui/ContextMenu";
import type { SqlResultSet } from "../../stores/sql";
import { numericColumns, toCsv, toTsv } from "./csv";

const ROW_H = 24;
const NUM_W = 52;
const SHOW_MAX = 200; // longer values are cut with "…" (full value on hover / copy)

/** Virtualised result grid: only the visible rows are in the DOM. */
export function ResultsGrid({ set, fontFamily }: { set: SqlResultSet; fontFamily: string }) {
  const cols = useMemo(() => set.columns ?? [], [set.columns]);
  const rows = set.rows;
  const scroller = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const menu = useContextMenu();

  const numeric = useMemo(() => numericColumns(cols.map((c) => c.numeric), rows), [cols, rows]);
  // Width from the header and the first rows (7 px per char), clamped.
  const widths = useMemo(
    () =>
      cols.map((c, i) => {
        let n = c.name.length + 2;
        for (let r = 0; r < rows.length && r < 100; r++) n = Math.max(n, Math.min(48, (rows[r][i] ?? "NULL").length));
        return Math.min(360, Math.max(64, n * 7.4 + 18));
      }),
    [cols, rows],
  );
  const total = NUM_W + widths.reduce((a, b) => a + b, 0);

  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 20 });

  const copy = (text: string) => void api.clipboardWrite(text);
  const names = cols.map((c) => c.name);
  const cellMenu = (r: number, c: number): MenuItem[] => [
    { label: "Copy value", icon: <Copy size={13} />, onClick: () => copy(rows[r][c] ?? "") },
    { label: "Copy row", onClick: () => copy(toTsv([rows[r]])) },
    { label: "Copy column", onClick: () => copy(rows.map((x) => x[c] ?? "").join("\n")) },
    { kind: "separator" as const },
    { label: "Copy all as CSV", onClick: () => copy(toCsv(names, rows)) },
    { label: "Copy all for a spreadsheet (TSV)", onClick: () => copy(toTsv([names, ...rows])) },
  ];

  return (
    <div
      ref={scroller}
      tabIndex={0}
      className="relative h-full overflow-auto bg-term outline-none"
      style={{ fontFamily }}
      onKeyDown={(e) => {
        if (sel && (e.ctrlKey || e.metaKey) && e.code === "KeyC") {
          e.preventDefault();
          copy(rows[sel.r]?.[sel.c] ?? "");
        }
      }}
    >
      <div style={{ width: total, minWidth: "100%" }}>
        <div className="sticky top-0 z-10 flex border-b border-line bg-panel text-xs text-muted" style={{ height: ROW_H + 2 }}>
          <div className="flex-none border-r border-line" style={{ width: NUM_W }} />
          {cols.map((c, i) => (
            <div
              key={i}
              title={c.type_name ? `${c.name} · ${c.type_name}` : c.name}
              className={clsx("flex flex-none items-center truncate border-r border-line px-2 font-semibold text-text", numeric[i] && "justify-end")}
              style={{ width: widths[i] }}
            >
              {c.name}
            </div>
          ))}
        </div>
        <div className="relative text-[12.5px]" style={{ height: v.getTotalSize() }}>
          {v.getVirtualItems().map((it) => {
            const row = rows[it.index];
            return (
              <div key={it.key} className="absolute left-0 flex w-full border-b border-[#232b3b] hover:bg-[#1F2737]" style={{ top: 0, height: ROW_H, transform: `translateY(${it.start}px)` }}>
                <div className="flex-none border-r border-line px-2 text-right text-[11px] leading-6 text-[#6B7690]" style={{ width: NUM_W }}>
                  {it.index + 1}
                </div>
                {row.map((val, c) => {
                  const selected = sel?.r === it.index && sel.c === c;
                  return (
                    <div
                      key={c}
                      title={val != null && val.length > 40 ? val.slice(0, 2000) : undefined}
                      onMouseDown={() => setSel({ r: it.index, c })}
                      onContextMenu={(e) => {
                        setSel({ r: it.index, c });
                        menu.open(cellMenu(it.index, c))(e);
                      }}
                      className={clsx(
                        "flex-none truncate border-r border-[#232b3b] px-2 leading-6",
                        numeric[c] && "text-right",
                        val == null && "text-[#6B7690] italic",
                        selected && "bg-accent-bg outline outline-1 -outline-offset-1 outline-accent-line",
                      )}
                      style={{ width: widths[c] }}
                    >
                      {val == null ? "NULL" : val.length > SHOW_MAX ? `${val.slice(0, SHOW_MAX)}…` : val}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {rows.length === 0 && <div className="px-3 py-3 text-xs text-muted">No rows.</div>}
      {menu.node}
    </div>
  );
}
