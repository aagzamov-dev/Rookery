import { useEffect, useState } from "react";
import clsx from "clsx";
import { chordParts, eventToChord, isMac, isValidChord, shellKeyNote } from "../keys/chord";
import { useKeys } from "../stores/keys";

interface Props {
  value: string | null;
  onChange: (chord: string | null) => void;
  /** Labels of other things already using `chord` (shown as a warning). */
  conflicts?: (chord: string) => string[];
  placeholder?: string;
  /** Show the "replaces a shell key" note for Ctrl+letter (custom bindings, snippet hotkeys). */
  warnShell?: boolean;
}

export function ChordView({ chord, dim }: { chord: string; dim?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      {chordParts(chord).map((p, i) => (
        <kbd
          key={i}
          className={clsx(
            "rounded-[5px] border border-b-2 border-line px-1.5 py-px font-mono text-[11px]",
            dim ? "text-muted" : "bg-panel2 text-text",
          )}
        >
          {p}
        </kbd>
      ))}
    </span>
  );
}

/** Click, then press the new shortcut. Esc cancels, Backspace clears. */
export function ShortcutRecorder({ value, onChange, conflicts, placeholder = "Not set", warnShell = true }: Props) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const setGlobalRecording = useKeys((s) => s.setRecording);

  useEffect(() => {
    if (!recording) return;
    setGlobalRecording(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if (plain && e.key === "Escape") return setRecording(false);
      if (plain && (e.key === "Backspace" || e.key === "Delete")) {
        onChange(null);
        return setRecording(false);
      }
      const chord = eventToChord(e);
      if (!chord) return; // modifier only — keep waiting
      if (!isValidChord(chord)) {
        setHint(`Add ${isMac ? "⌘, ⌥ or ⌃" : "Ctrl or Alt"} — single keys are typed into the terminal`);
        return;
      }
      setHint(null);
      onChange(chord);
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setGlobalRecording(false);
    };
  }, [recording, onChange, setGlobalRecording]);

  const used = value && conflicts ? conflicts(value) : [];

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => {
          setHint(null);
          setRecording((r) => !r);
        }}
        onBlur={() => setRecording(false)}
        className={clsx(
          "flex h-8 min-w-[150px] items-center gap-2 rounded-md border px-2.5 text-left",
          recording ? "border-accent bg-accent-bg" : "border-line bg-panel hover:border-accent-line",
        )}
      >
        {recording ? (
          <span className="text-xs text-accent">Press keys… Esc to cancel</span>
        ) : value ? (
          <ChordView chord={value} />
        ) : (
          <span className="text-xs text-muted">{placeholder}</span>
        )}
      </button>
      {hint && <span className="text-[11px] text-[#F7CB6A]">{hint}</span>}
      {!recording && used.length > 0 && <span className="text-[11px] text-[#FFA8A8]">Also used by: {used.join(", ")}</span>}
      {!recording && warnShell && value && shellKeyNote(value) && <span className="max-w-[260px] text-[11px] text-[#F7CB6A]">{shellKeyNote(value)}</span>}
    </div>
  );
}
