import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Search } from "lucide-react";
import { activeServerHostId } from "../../app/tabActions";
import { ACTIONS } from "../../keys/actions";
import { runAction } from "../../keys/dispatcher";
import { formatChord } from "../../keys/chord";
import { useHosts } from "../../stores/hosts";
import { useKeys } from "../../stores/keys";
import { useSnippets } from "../../stores/snippets";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { runSnippet, snippetsForHost } from "../snippets/run";

type Section = "Snippets" | "Hosts" | "Actions";

interface Item {
  id: string;
  section: Section;
  title: string;
  sub?: string;
  chord?: string | null;
  mono?: boolean;
  run: (pasteOnly: boolean) => void;
}

/** Subsequence match with bonuses for prefix / word starts. 0 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) return 500 - idx;
  let ti = 0;
  let score = 100;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    score -= found - ti;
    ti = found + 1;
  }
  return Math.max(1, score);
}

export function CommandPalette({ onNewHost }: { onNewHost: () => void }) {
  const open = useUi((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette onNewHost={onNewHost} />;
}

function Palette({ onNewHost }: { onNewHost: () => void }) {
  const close = () => useUi.getState().setPaletteOpen(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<Element | null>(document.activeElement);
  const bindings = useKeys((s) => s.bindings);
  const hosts = useHosts((s) => s.hosts);
  const snippetsLoaded = useSnippets((s) => s.list);
  const hostId = activeServerHostId();
  const host = hostId ? hosts.find((h) => h.id === hostId) : undefined;

  const done = (focusBack = true) => {
    close();
    if (focusBack && prevFocus.current instanceof HTMLElement) prevFocus.current.focus();
  };

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (hostId) {
      for (const s of snippetsForHost(hostId)) {
        out.push({
          id: `s:${s.id}`,
          section: "Snippets",
          title: s.alias ?? s.name,
          sub: s.alias ? `${s.name} · ${s.command}` : s.command,
          chord: s.hotkey,
          mono: !!s.alias,
          run: (paste) => {
            done(false);
            void runSnippet(s, hostId, paste ? "paste" : undefined);
          },
        });
      }
    }
    for (const h of hosts) {
      out.push({
        id: `h:${h.id}`,
        section: "Hosts",
        title: h.name,
        sub: `${h.address}${h.port !== 22 ? `:${h.port}` : ""} · open as tab`,
        run: () => {
          done(false);
          useTabs.getState().openServer(h.id, h.start_view, h.start_folder);
        },
      });
    }
    for (const a of ACTIONS) {
      if (a.id === "palette.open") continue;
      out.push({
        id: `a:${a.id}`,
        section: "Actions",
        title: a.label,
        chord: bindings[a.id][0],
        run: () => {
          done(true);
          // Give focus back first so terminal actions find the terminal.
          setTimeout(() => runAction(a.id, null), 0);
        },
      });
    }
    const page = (id: string, title: string, fn: () => void) =>
      out.push({ id, section: "Actions", title, run: () => (done(false), fn()) });
    page("p:new-host", "New host", onNewHost);
    page("p:snippets", "Open Snippets", () => useTabs.getState().openPage("snippets"));
    page("p:shortcuts", "Keyboard shortcuts", () => useTabs.getState().openPage("settings"));
    page("p:dashboard", "Open Dashboard", () => useTabs.getState().openPage("dashboard"));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, hosts, bindings, snippetsLoaded]);

  const filtered = useMemo(() => {
    if (!q.trim()) return items.slice(0, 60);
    return items
      .map((it) => ({ it, s: Math.max(fuzzyScore(q, it.title), fuzzyScore(q, it.sub ?? "") * 0.5) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.it);
  }, [q, items]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      done();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[sel]?.run(e.ctrlKey || e.metaKey);
    }
  };

  let lastSection: Section | null = null;
  return (
    <div className="fixed inset-0 z-[60] flex justify-center bg-black/50 pt-[12vh]" onMouseDown={() => done()}>
      <div
        role="dialog"
        aria-label="Command palette"
        className="flex h-fit max-h-[70vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-[#435069] bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <label className="flex items-center gap-2.5 border-b border-line px-4 py-3.5">
          <Search size={16} className="text-muted" />
          <input
            autoFocus
            aria-label="Search commands"
            placeholder={hostId ? "Run a snippet, open a host or an action…" : "Open a host or run an action…"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-text outline-none placeholder:text-[#6B7690]"
          />
          {host && <span className="text-[11px] text-muted">on {host.name}</span>}
        </label>
        <div ref={listRef} className="flex flex-col overflow-y-auto p-1.5">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-muted">No matches</div>}
          {filtered.map((it, i) => {
            const head = it.section !== lastSection ? it.section : null;
            lastSection = it.section;
            return (
              <div key={it.id} className="flex flex-col">
                {head && <span className="px-2.5 pt-2.5 pb-1 text-[11px] tracking-wider text-muted uppercase">{head}</span>}
                <button
                  data-idx={i}
                  onMouseMove={() => setSel(i)}
                  onClick={(e) => it.run(e.ctrlKey || e.metaKey)}
                  className={clsx("flex h-[38px] items-center gap-2.5 rounded-[7px] px-2.5 text-left", i === sel ? "bg-accent-bg" : "")}
                >
                  <span className={clsx("min-w-[72px] truncate", it.mono ? "font-mono text-accent" : "text-text")}>{it.title}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted">{it.sub}</span>
                  {it.chord && <Kbd chord={it.chord} />}
                </button>
              </div>
            );
          })}
          {!hostId && <div className="px-3 py-2 text-xs text-muted">Open a server tab to run its snippets here.</div>}
        </div>
        <div className="flex flex-wrap gap-4 border-t border-line px-4 py-2.5 text-[11px] text-muted">
          <span>↑↓ move</span>
          <span>Enter run</span>
          <span>Ctrl+Enter paste only</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  );
}

export function Kbd({ chord }: { chord: string }) {
  return <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-muted">{formatChord(chord)}</span>;
}
