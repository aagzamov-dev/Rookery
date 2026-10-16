// The editor's big dialogs: side-by-side diff, three-way merge, PROD review, history.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { MergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { History as HistoryIcon, Loader2, X } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { EditorBackup } from "../../ipc/bindings/EditorBackup";
import type { FileVersion } from "../../ipc/bindings/FileVersion";
import type { EditorDoc } from "../../stores/editor";
import { Button } from "../../ui/primitives";
import { bytes } from "../../ui/format";
import { useKeys } from "../../stores/keys";
import { highlight, theme } from "./docs";
import type { LangId } from "./lang";
import { supportFor } from "./languages";
import { hasMarkers, resolve, threeWay, type Pick } from "./merge";

const mergeTheme = EditorView.theme(
  {
    "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "rgba(255, 122, 122, 0.09)" },
    "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "rgba(87, 201, 148, 0.09)" },
    "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": { background: "rgba(255, 122, 122, 0.32)" },
    "&.cm-merge-b .cm-changedText": { background: "rgba(87, 201, 148, 0.32)" },
    "&.cm-merge-a .cm-changeGutter": { borderLeft: "3px solid #FF7A7A" },
    "&.cm-merge-b .cm-changeGutter": { borderLeft: "3px solid #57C994" },
    ".cm-collapsedLines": { background: "#222A3A", color: "#A3ADC2", padding: "4px 10px", cursor: "pointer" },
    ".cm-collapsedLines:before": { content: "none" },
    ".cm-collapsedLines:after": { content: "none" },
  },
  { dark: true },
);

/** Side by side: left = before / server, right = after / yours (editable when `onRight` is set). */
export function DiffView({ left, right, lang, onRight, rightVersion = 0 }: { left: string; right: string; lang: LangId; onRight?: (t: string) => void; rightVersion?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef(onRight);
  cb.current = onRight;
  const [support, setSupport] = useState<Extension | null>(null);
  useEffect(() => {
    let live = true;
    void supportFor(lang).then((e) => live && setSupport(e));
    return () => {
      live = false;
    };
  }, [lang]);
  useEffect(() => {
    if (!host.current) return;
    // Same line rule as the editor: the merge result is saved, so a stray \r must stay as it is.
    const common = [EditorState.lineSeparator.of("\n"), lineNumbers(), theme, mergeTheme, syntaxHighlighting(highlight), EditorView.lineWrapping, support ?? []];
    const mv = new MergeView({
      parent: host.current,
      a: { doc: left, extensions: [...common, EditorState.readOnly.of(true)] },
      b: {
        doc: right,
        extensions: [...common, EditorState.readOnly.of(!cb.current), EditorView.updateListener.of((u) => u.docChanged && cb.current?.(u.state.doc.toString()))],
      },
      collapseUnchanged: { margin: 3, minSize: 6 },
      gutter: true,
      highlightChanges: true,
    });
    return () => mv.destroy();
    // `right` is applied when `rightVersion` changes (the editor owns it in between).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, rightVersion, support]);
  return <div ref={host} className="ed-diff min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-[#171D29]" />;
}

function Big({ title, sub, onClose, children, footer }: { title: string; sub?: ReactNode; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const fontFamily = useKeys((s) => s.terminal.fontFamily);
  const fontSize = useKeys((s) => s.terminal.fontSize);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex bg-black/60 p-6" style={{ ["--ed-font" as string]: fontFamily, ["--ed-size" as string]: `${fontSize}px` }}>
      <div role="dialog" aria-label={title} className="flex min-h-0 w-full flex-col rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-start gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
            {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
          </div>
          <button aria-label="Close" onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text">
            <X size={15} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-3">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}

const Labels = ({ left, right }: { left: string; right: string }) => (
  <div className="grid grid-cols-2 gap-2 text-xs font-medium text-muted">
    <span>{left}</span>
    <span>{right}</span>
  </div>
);

export function when(sec: number) {
  if (!sec) return "";
  const d = Date.now() / 1000 - sec;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(sec * 1000).toLocaleString();
}

// ------------------------------------------------------------------ merge

export interface MergeInput {
  key: string;
  mine: string;
  theirs: string;
  theirsVersion: FileVersion;
  /** Opened from "Compare" (not from a failed save). */
  compare?: boolean;
}

/**
 * base = what you opened, mine = the editor, theirs = the server now. Saving the result saves it
 * with "theirs" as the new base; it is checked again on the server, so nothing is overwritten blindly.
 */
export function MergeDialog({ doc, input, onCancel, onSave, onTakeTheirs, onOverwrite }: {
  doc: EditorDoc;
  input: MergeInput;
  onCancel: () => void;
  onSave: (text: string) => void;
  onTakeTheirs: () => void;
  onOverwrite: () => void;
}) {
  const merged = useMemo(() => threeWay(doc.baseText, input.mine, input.theirs), [doc.baseText, input.mine, input.theirs]);
  const [picks, setPicks] = useState<(Pick | undefined)[]>([]);
  const auto = useMemo(() => resolve(merged, picks), [merged, picks]);
  const [result, setResult] = useState(auto.text);
  const [version, setVersion] = useState(0);
  const [edited, setEdited] = useState(false);
  const conflicts = merged.chunks.filter((c) => c.kind === "conflict");

  const pick = (i: number, p: Pick) => {
    const next = [...picks];
    next[i] = p;
    setPicks(next);
    setResult(resolve(merged, next).text);
    setVersion((v) => v + 1);
    setEdited(false);
  };
  const markers = hasMarkers(result);
  const same = input.mine === input.theirs;

  return (
    <Big
      title={input.compare ? "Changed on the server" : "Someone changed this file on the server"}
      sub={
        <>
          <span className="font-mono">{doc.realPath}</span> · server version {bytes(input.theirsVersion.size)}, saved {when(input.theirsVersion.mtime)}. Nothing was written.
        </>
      }
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <span className="flex-1" />
          <Button variant="outline" onClick={onTakeTheirs}>
            Use the server's version
          </Button>
          <Button variant="danger" onClick={onOverwrite}>
            Overwrite with mine…
          </Button>
          <Button variant="primary" disabled={markers} onClick={() => onSave(result)} title={markers ? "Choose a side for every conflict first" : undefined}>
            Save merged
          </Button>
        </>
      }
    >
      <div className={clsx("rounded-lg border px-3 py-2 text-[13px]", conflicts.length ? "border-[#7A6420] bg-[#33301F]" : "border-[#2C5A45] bg-[#1E3329]")}>
        {same
          ? "The server already has exactly your text."
          : conflicts.length === 0
            ? "Your changes and theirs touch different lines: they were combined. Check the result on the right, then save."
            : `${conflicts.length} ${conflicts.length === 1 ? "place was" : "places were"} changed on both sides. Choose for each one; other changes were combined.`}
      </div>
      {conflicts.length > 0 && (
        <div className="flex max-h-[34vh] flex-none flex-col gap-2 overflow-auto">
          {conflicts.map((c, i) => (
            <div key={i} className="rounded-lg border border-line bg-bg">
              <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
                <span className="font-medium">Conflict {i + 1}</span>
                <span className="flex-1" />
                {(["mine", "theirs", "both"] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => c.kind === "conflict" && pick(i, p)}
                    className={clsx("h-6 rounded-md border px-2.5", picks[i] === p ? "border-accent bg-accent-bg text-text" : "border-line text-muted hover:text-text")}
                  >
                    {p === "mine" ? "Keep mine" : p === "theirs" ? "Keep theirs" : "Keep both"}
                  </button>
                ))}
              </div>
              {c.kind === "conflict" && (
                <div className="grid grid-cols-2 divide-x divide-line font-mono text-xs">
                  <pre className="m-0 overflow-auto bg-[rgba(138,180,255,0.06)] px-3 py-2 whitespace-pre-wrap">{c.mine.join("\n") || "(removed)"}</pre>
                  <pre className="m-0 overflow-auto bg-[rgba(87,201,148,0.06)] px-3 py-2 whitespace-pre-wrap">{c.theirs.join("\n") || "(removed)"}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <Labels left="On the server now" right={`Result (editable)${edited ? " · edited" : ""}${markers ? " · conflicts left" : ""}`} />
      <DiffView
        left={input.theirs}
        right={result}
        rightVersion={version}
        lang={doc.lang}
        onRight={(t) => {
          setResult(t);
          setEdited(true);
        }}
      />
    </Big>
  );
}

// ------------------------------------------------------------------ PROD review

export function ReviewDialog({ doc, text, hostName, onCancel, onSave }: { doc: EditorDoc; text: string; hostName: string; onCancel: () => void; onSave: () => void }) {
  return (
    <Big
      title={`Review before saving to PROD · ${hostName}`}
      sub={<span className="font-mono">{doc.realPath}</span>}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onSave} autoFocus>
            Save to PROD
          </Button>
        </>
      }
    >
      <Labels left="On the server (opened version)" right="Yours" />
      <DiffView left={doc.baseText} right={text} lang={doc.lang} />
    </Big>
  );
}

// ------------------------------------------------------------------ history

export function HistoryDialog({ doc, current, onClose, onRestore }: { doc: EditorDoc; current: string; onClose: () => void; onRestore: (text: string) => void }) {
  const [list, setList] = useState<EditorBackup[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api
      .editorBackups(doc.hostId, doc.realPath)
      .then((l) => {
        setList(l);
        if (l[0]) setSel(l[0].id);
      })
      .catch((e) => setErr(asCoreError(e).message));
  }, [doc.hostId, doc.realPath]);
  useEffect(() => {
    if (!sel) return;
    setText(null);
    api
      .editorBackupRead(doc.hostId, doc.realPath, sel)
      .then(setText)
      .catch((e) => setErr(asCoreError(e).message));
  }, [sel, doc.hostId, doc.realPath]);
  return (
    <Big
      title={`History · ${doc.name}`}
      sub="The server's version before each save from this PC (last 20, 30 days). Kept on this PC only."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={text == null} onClick={() => text != null && onRestore(text)}>
            Restore into editor
          </Button>
        </>
      }
    >
      {err && <div className="rounded-lg border border-[#5A2D33] bg-[#33232A] px-3 py-2 text-[13px] text-prod-fg">{err}</div>}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex w-56 flex-none flex-col gap-0.5 overflow-auto">
          {list == null && !err && (
            <span className="flex items-center gap-2 text-xs text-muted">
              <Loader2 size={13} className="animate-spin" /> Loading…
            </span>
          )}
          {list?.length === 0 && (
            <span className="flex items-start gap-2 text-xs text-muted">
              <HistoryIcon size={13} className="mt-0.5 flex-none" /> No backups yet: one is made before every save.
            </span>
          )}
          {list?.map((b) => (
            <button
              key={b.id}
              onClick={() => setSel(b.id)}
              className={clsx("flex flex-col rounded-md px-2.5 py-1.5 text-left", sel === b.id ? "bg-accent-bg" : "hover:bg-panel2")}
            >
              <span className="text-[13px]">{new Date(b.at).toLocaleString()}</span>
              <span className="text-[11px] text-muted">{bytes(b.size)}</span>
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Labels left="Backup" right="Editor now" />
          {text != null ? <DiffView left={text} right={current} lang={doc.lang} /> : <div className="flex-1 rounded-lg border border-line" />}
        </div>
      </div>
    </Big>
  );
}
