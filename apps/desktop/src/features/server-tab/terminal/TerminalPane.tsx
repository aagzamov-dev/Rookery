import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ChevronDown, ChevronUp, KeyRound, X } from "lucide-react";
import { useTermUi } from "../../../stores/termui";
import { terminalRegistry, type TermOptions } from "./registry";

interface Props {
  termKey: string;
  hostId: string;
  visible: boolean;
  opts: TermOptions;
}

/** Hosts one registry terminal. Stays mounted while its tab exists. */
export function TerminalPane({ termKey, hostId, visible, opts }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const sudo = useTermUi((s) => !!s.sudoPrompt[termKey]);
  const findOpen = useTermUi((s) => !!s.findOpen[termKey]);

  useEffect(() => {
    if (ref.current) terminalRegistry.attach(termKey, hostId, ref.current, opts);
    // Disposal happens when the slot or tab is closed, not on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termKey, hostId]);

  useEffect(() => {
    terminalRegistry.setVisible(termKey, visible);
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      terminalRegistry.fit(termKey);
      if (!useTermUi.getState().findOpen[termKey]) terminalRegistry.focus(termKey);
    });
    const ro = new ResizeObserver(() => terminalRegistry.fit(termKey));
    if (ref.current) ro.observe(ref.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [visible, termKey]);

  return (
    <div className="absolute inset-0" style={{ display: visible ? "block" : "none" }}>
      <div ref={ref} className="h-full w-full" />
      {findOpen && <FindBar termKey={termKey} />}
      {sudo && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void terminalRegistry.sudoFill(termKey)}
          className="absolute right-4 bottom-4 flex items-center gap-2 rounded-lg border border-accent-line bg-accent-bg px-3 py-2 text-xs text-text shadow-lg hover:brightness-110"
        >
          <KeyRound size={13} className="text-accent" /> Fill sudo password from vault
        </button>
      )}
    </div>
  );
}

function FindBar({ termKey }: { termKey: string }) {
  const setFind = useTermUi((s) => s.setFind);
  const last = useTermUi.getState().lastFind[termKey];
  const [q, setQ] = useState(last?.q ?? "");
  const [caseSensitive, setCase] = useState(last?.caseSensitive ?? false);
  const [regex, setRegex] = useState(last?.regex ?? false);
  const [miss, setMiss] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const go = (backwards = false) => {
    if (!q) return;
    useTermUi.getState().setLastFind(termKey, { q, caseSensitive, regex });
    setMiss(!terminalRegistry.find(termKey, q, { caseSensitive, regex, backwards }));
  };
  const close = () => {
    terminalRegistry.clearFind(termKey);
    setFind(termKey, false);
    terminalRegistry.focus(termKey);
  };

  return (
    <div className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-lg border border-line bg-panel p-1 shadow-lg">
      <input
        ref={inputRef}
        aria-label="Find in terminal"
        placeholder="Find"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setMiss(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "F3") {
            e.preventDefault();
            go(e.shiftKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        className={clsx("h-7 w-52 rounded-md border bg-bg px-2 text-xs outline-none", miss ? "border-bad" : "border-line focus:border-accent-line")}
      />
      <Toggle on={caseSensitive} onClick={() => setCase(!caseSensitive)} label="Match case">
        Aa
      </Toggle>
      <Toggle on={regex} onClick={() => setRegex(!regex)} label="Regular expression">
        .*
      </Toggle>
      <button aria-label="Previous match (Shift+Enter)" title="Previous (Shift+Enter)" onClick={() => go(true)} className="grid h-7 w-7 place-items-center rounded text-muted hover:text-text">
        <ChevronUp size={14} />
      </button>
      <button aria-label="Next match (Enter)" title="Next (Enter)" onClick={() => go(false)} className="grid h-7 w-7 place-items-center rounded text-muted hover:text-text">
        <ChevronDown size={14} />
      </button>
      <button aria-label="Close find (Esc)" title="Close (Esc)" onClick={close} className="grid h-7 w-7 place-items-center rounded text-muted hover:text-text">
        <X size={13} />
      </button>
    </div>
  );
}

function Toggle({ on, onClick, label, children }: { on: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={onClick}
      className={clsx("h-7 rounded px-1.5 font-mono text-[11px]", on ? "bg-accent-bg text-text" : "text-muted hover:text-text")}
    >
      {children}
    </button>
  );
}
