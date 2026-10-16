import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Bookmark, Play, Search, Trash2, X } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { SqlHistoryEntry } from "../../ipc/bindings/SqlHistoryEntry";
import { askConfirm, askText } from "../../stores/dialogs";
import { emptySnippet, isSqlSnippet, useSnippets } from "../../stores/snippets";
import { useTabs } from "../../stores/tabs";

export type SidePanelTab = "history" | "snippets";

interface Props {
  tab: SidePanelTab;
  onTab: (t: SidePanelTab) => void;
  onClose: () => void;
  /** History key of the connection. */
  connKey: string;
  /** Changes when a run finishes, so the history reloads. */
  reloadToken: unknown;
  /** Put SQL into the editor (and run it). */
  onSql: (sql: string, andRun: boolean) => void;
  /** Selection or whole editor text, for "Save as snippet". */
  editorText: () => string;
  fontFamily: string;
}

const when = (ms: number) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** Ask for a name and keep the SQL as an SQL snippet (never run by terminals). */
export async function saveSqlSnippet(sql: string): Promise<void> {
  const text = sql.trim();
  if (!text) return;
  const first = text.split("\n")[0].replace(/\s+/g, " ").slice(0, 60);
  const name = await askText({ title: "Save as SQL snippet", label: "Name", value: first, confirmLabel: "Save snippet" });
  if (!name?.trim()) return;
  try {
    await useSnippets.getState().save({ ...emptySnippet(), kind: "sql", name: name.trim(), command: text });
  } catch (e) {
    await askConfirm({ title: "Could not save the snippet", body: asCoreError(e).message, confirmLabel: "OK" });
  }
}

/** SQL tab side panel: this connection's query history and the SQL snippets. */
export function SidePanel({ tab, onTab, onClose, connKey, reloadToken, onSql, editorText, fontFamily }: Props) {
  const [q, setQ] = useState("");
  const f = q.trim().toLowerCase();

  return (
    <div className="flex h-full flex-col border-l border-line bg-panel">
      <div className="flex h-9 flex-none items-center gap-0.5 border-b border-line px-2">
        {(["history", "snippets"] as const).map((t) => (
          <button key={t} onClick={() => onTab(t)} className={clsx("h-6 rounded px-2.5 text-xs", tab === t ? "bg-panel2 text-text" : "text-muted hover:text-text")}>
            {t === "history" ? "History" : "Snippets"}
          </button>
        ))}
        <button aria-label="Close panel" onClick={onClose} className="ml-auto grid h-6 w-6 place-items-center rounded text-muted hover:bg-panel2 hover:text-text">
          <X size={13} />
        </button>
      </div>
      <label className="m-2 flex h-7 flex-none items-center gap-2 rounded-md border border-line bg-bg px-2 text-muted">
        <Search size={12} />
        <input aria-label="Filter" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none" />
      </label>
      {tab === "history" ? (
        <HistoryList connKey={connKey} reloadToken={reloadToken} filter={f} onSql={onSql} fontFamily={fontFamily} />
      ) : (
        <SnippetList filter={f} onSql={onSql} editorText={editorText} fontFamily={fontFamily} />
      )}
    </div>
  );
}

function RowActions({ sql, onSql, save }: { sql: string; onSql: Props["onSql"]; save?: boolean }) {
  return (
    <span className="absolute top-1.5 right-1.5 hidden gap-0.5 rounded-md border border-line bg-panel2 p-0.5 group-hover:flex">
      <button
        title="Run it"
        aria-label="Run"
        onClick={(e) => {
          e.stopPropagation();
          onSql(sql, true);
        }}
        className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-panel hover:text-accent"
      >
        <Play size={12} />
      </button>
      {save && (
        <button
          title="Save as snippet"
          aria-label="Save as snippet"
          onClick={(e) => {
            e.stopPropagation();
            void saveSqlSnippet(sql);
          }}
          className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-panel hover:text-accent"
        >
          <Bookmark size={12} />
        </button>
      )}
    </span>
  );
}

function HistoryList({ connKey, reloadToken, filter, onSql, fontFamily }: { connKey: string; reloadToken: unknown; filter: string; onSql: Props["onSql"]; fontFamily: string }) {
  const [list, setList] = useState<SqlHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.sqlHistory(connKey));
      setError(null);
    } catch (e) {
      setError(asCoreError(e).message);
    }
  }, [connKey]);
  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const clear = async () => {
    const ok = await askConfirm({ title: "Clear the query history?", body: "The history of this connection on this computer is deleted.", confirmLabel: "Clear history", danger: true });
    if (!ok) return;
    await api.sqlHistoryClear(connKey).catch((e) => setError(asCoreError(e).message));
    void load();
  };

  const shown = useMemo(() => (list ?? []).filter((h) => !filter || h.sql.toLowerCase().includes(filter)), [list, filter]);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {error && <p className="m-0 px-1 py-2 text-xs text-prod-fg">{error}</p>}
        {list && list.length === 0 && <p className="m-0 px-1 py-2 text-xs text-muted">Queries you run here show up in this list. They stay on this computer.</p>}
        {list && list.length > 0 && shown.length === 0 && <p className="m-0 px-1 py-2 text-xs text-muted">No matches.</p>}
        {shown.map((h) => (
          <div
            key={h.id}
            role="button"
            tabIndex={0}
            title="Click: put into the editor"
            onClick={() => onSql(h.sql, false)}
            onKeyDown={(e) => e.key === "Enter" && onSql(h.sql, false)}
            className="group relative mb-1 cursor-pointer rounded-md border border-transparent px-2 py-1.5 hover:border-line hover:bg-panel2"
          >
            <div className="line-clamp-3 font-mono text-[11.5px] break-all whitespace-pre-wrap text-text" style={{ fontFamily }}>
              {h.sql}
            </div>
            <div className="mt-0.5 flex gap-1.5 text-[11px] text-muted">
              <span className={h.ok ? "text-ok" : "text-bad"}>{h.ok ? "✓" : "✗"}</span>
              {h.rows != null && h.ok && <span>{h.rows} {h.rows === 1 ? "row" : "rows"}</span>}
              {h.elapsed_ms != null && <span>· {h.elapsed_ms} ms</span>}
              <span className="ml-auto">{when(h.ran_at)}</span>
            </div>
            <RowActions sql={h.sql} onSql={onSql} save />
          </div>
        ))}
      </div>
      {list && list.length > 0 && (
        <div className="flex flex-none items-center border-t border-line px-3 py-1.5 text-[11px] text-muted">
          <span>Last {list.length} · this computer only</span>
          <button onClick={() => void clear()} className="ml-auto flex items-center gap-1 hover:text-prod-fg">
            <Trash2 size={11} /> Clear
          </button>
        </div>
      )}
    </>
  );
}

function SnippetList({ filter, onSql, editorText, fontFamily }: { filter: string; onSql: Props["onSql"]; editorText: () => string; fontFamily: string }) {
  const all = useSnippets((s) => s.list);
  const sqlSnippets = useMemo(() => all.filter(isSqlSnippet), [all]);
  const shown = sqlSnippets.filter((s) => !filter || s.name.toLowerCase().includes(filter) || s.command.toLowerCase().includes(filter));

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {sqlSnippets.length === 0 && <p className="m-0 px-1 py-2 text-xs text-muted">Save queries you use often: select text in the editor (or a history entry) and press “Save as snippet”.</p>}
        {sqlSnippets.length > 0 && shown.length === 0 && <p className="m-0 px-1 py-2 text-xs text-muted">No matches.</p>}
        {shown.map((s) => (
          <div
            key={s.id}
            role="button"
            tabIndex={0}
            title="Click: put into the editor"
            onClick={() => onSql(s.command, false)}
            onKeyDown={(e) => e.key === "Enter" && onSql(s.command, false)}
            className="group relative mb-1 cursor-pointer rounded-md border border-transparent px-2 py-1.5 hover:border-line hover:bg-panel2"
          >
            <div className="truncate text-xs font-medium">{s.name}</div>
            <div className="line-clamp-2 font-mono text-[11px] break-all whitespace-pre-wrap text-muted" style={{ fontFamily }}>
              {s.command}
            </div>
            <RowActions sql={s.command} onSql={onSql} />
          </div>
        ))}
      </div>
      <div className="flex flex-none items-center gap-3 border-t border-line px-3 py-1.5 text-[11px]">
        <button onClick={() => void saveSqlSnippet(editorText())} className="flex items-center gap-1 text-accent hover:underline" title="Save the selection (or the whole editor) as a snippet">
          <Bookmark size={11} /> Save editor text
        </button>
        <button onClick={() => useTabs.getState().openPage("snippets")} className="ml-auto text-muted hover:text-text">
          Manage
        </button>
      </div>
    </>
  );
}
