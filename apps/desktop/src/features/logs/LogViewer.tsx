import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { ArrowDownToLine, Copy, Eraser, Search, WrapText } from "lucide-react";
import { copyText } from "../../ipc/clipboard";
import { levelOf, splitTs, type Level } from "../../stores/logs";

const RENDER_MAX = 2_000;

interface Props {
  title: ReactNode;
  lines: string[];
  ended: string | null;
  live: boolean;
  onClear?: () => void;
  actions?: ReactNode;
}

type Filter = "all" | "error" | "warn";

export function LogViewer({ title, lines, ended, live, onClear, actions }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [wrap, setWrap] = useState(false);
  const [stick, setStick] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  const parsed = useMemo(
    () => lines.map((raw) => ({ raw, level: levelOf(raw) as Level, ...splitTs(raw) })),
    [lines],
  );
  const counts = useMemo(() => {
    let e = 0;
    let w = 0;
    for (const p of parsed) {
      if (p.level === "error") e++;
      else if (p.level === "warn") w++;
    }
    return { e, w };
  }, [parsed]);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const f = parsed.filter((p) => (filter === "all" || p.level === filter) && (!needle || p.raw.toLowerCase().includes(needle)));
    return f.length > RENDER_MAX ? f.slice(f.length - RENDER_MAX) : f;
  }, [parsed, filter, needle]);

  // Auto-scroll to the newest line unless the user scrolled up to read.
  useEffect(() => {
    const el = boxRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [shown, stick]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-term">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <h2 className="m-0 text-[13px] font-semibold">{title}</h2>
        {live && !ended && (
          <span className="flex items-center gap-1.5 text-[11px] text-ok">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ok" /> Live
          </span>
        )}
        {ended && <span className="text-[11px] text-[#F7CB6A]">{ended}</span>}
        <div className="ml-auto flex items-center gap-1">
          {actions}
          <IconBtn label={wrap ? "Don't wrap lines" : "Wrap lines"} active={wrap} onClick={() => setWrap(!wrap)}>
            <WrapText size={13} />
          </IconBtn>
          <IconBtn label="Copy visible lines" onClick={() => void copyText(shown.map((p) => p.raw).join("\n")).catch((e) => alert((e as Error).message))}>
            <Copy size={13} />
          </IconBtn>
          {onClear && (
            <IconBtn label="Clear" onClick={onClear}>
              <Eraser size={13} />
            </IconBtn>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
        <Chip active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </Chip>
        <Chip active={filter === "error"} onClick={() => setFilter("error")} tone="bad">
          Errors {counts.e}
        </Chip>
        <Chip active={filter === "warn"} onClick={() => setFilter("warn")} tone="warn">
          Warnings {counts.w}
        </Chip>
        <label className="ml-auto flex h-6 items-center gap-1.5 rounded-md border border-line px-2 text-muted">
          <Search size={11} />
          <input aria-label="Search logs" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="w-28 bg-transparent text-xs text-text outline-none" />
        </label>
      </div>
      <div ref={boxRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto px-2 py-1.5 font-mono text-xs leading-[1.7] text-[#D3D9E4]">
        {shown.map((p, i) => (
          <div
            key={i}
            className={clsx(
              "flex gap-2.5 rounded px-1.5",
              wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
              p.level === "error" && "bg-[#3A2329]",
              p.level === "warn" && "bg-[#352F20]",
            )}
          >
            {p.time && <span className="flex-none text-[#8390A8]">{p.time}</span>}
            <span>{needle ? highlight(p.text, needle) : p.text}</span>
          </div>
        ))}
        {lines.length === 0 && <div className="px-1.5 py-2 text-muted">{live ? "Waiting for log lines…" : "No lines yet."}</div>}
      </div>
      {!stick && (
        <button
          onClick={() => setStick(true)}
          className="absolute right-5 bottom-4 flex items-center gap-1.5 rounded-full border border-accent-line bg-accent-bg px-3 py-1 text-xs text-text"
        >
          <ArrowDownToLine size={12} /> Jump to latest
        </button>
      )}
    </section>
  );
}

function highlight(text: string, needle: string) {
  const out: ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  for (let j = lower.indexOf(needle); j >= 0; j = lower.indexOf(needle, j + needle.length)) {
    out.push(text.slice(i, j), <mark key={j} className="rounded-sm bg-[#F2BA4555] text-text">{text.slice(j, j + needle.length)}</mark>);
    i = j + needle.length;
  }
  out.push(text.slice(i));
  return out;
}

function Chip({ active, onClick, tone, children }: { active: boolean; onClick: () => void; tone?: "bad" | "warn"; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "h-6 rounded-full px-2.5 text-xs",
        active ? "bg-accent-bg text-text" : "border border-line",
        !active && tone === "bad" && "text-[#FFA8A8]",
        !active && tone === "warn" && "text-[#F7CB6A]",
        !active && !tone && "text-muted",
      )}
    >
      {children}
    </button>
  );
}

function IconBtn({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={clsx("grid h-7 w-7 place-items-center rounded-md border border-line", active ? "bg-accent-bg text-text" : "text-muted hover:text-text")}>
      {children}
    </button>
  );
}
