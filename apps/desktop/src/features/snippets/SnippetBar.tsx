import { Play, Zap } from "lucide-react";
import { useHosts } from "../../stores/hosts";
import { appliesTo, useSnippets } from "../../stores/snippets";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { runSnippet } from "./run";

const MAX = 10;

/** Snippets for this server above its terminal. Click = run, Shift+click = type only. */
export function SnippetBar({ hostId }: { hostId: string }) {
  const list = useSnippets((s) => s.list);
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const groups = useHosts((s) => s.groups);
  const mine = list.filter((s) => appliesTo(s, host, groups));
  const shown = mine.slice(0, MAX);

  return (
    <div className="flex min-h-[42px] flex-wrap items-center gap-2 border-b border-line bg-term px-3 py-1.5">
      <span className="mr-1 flex items-center gap-1.5 text-[11px] text-muted">
        <Zap size={12} /> Snippets
      </span>
      {shown.map((s) => (
        <button
          key={s.id}
          title={`${s.command}\nClick: run · Shift+click: type only`}
          onMouseDown={(e) => e.preventDefault()} // keep focus in the terminal
          onClick={(e) => void runSnippet(s, hostId, e.shiftKey ? "paste" : undefined)}
          className="flex h-[26px] items-center gap-2 rounded-md border border-line bg-panel px-2.5 whitespace-nowrap hover:border-accent-line"
        >
          {s.run_mode === "new_terminal" && <Play size={10} className="text-accent" />}
          <span className={s.alias ? "font-mono text-xs text-accent" : "text-xs"}>{s.alias ?? s.name}</span>
          {s.alias && <span className="text-[11px] text-muted">{s.name}</span>}
        </button>
      ))}
      {mine.length > MAX && (
        <button onClick={() => useUi.getState().setPaletteOpen(true)} className="text-xs text-accent">
          +{mine.length - MAX} more
        </button>
      )}
      {mine.length === 0 && (
        <button onClick={() => useTabs.getState().openPage("snippets")} className="text-xs text-accent">
          Add snippets for this server
        </button>
      )}
    </div>
  );
}
