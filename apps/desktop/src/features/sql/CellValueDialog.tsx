import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { json } from "@codemirror/lang-json";
import { syntaxHighlighting } from "@codemirror/language";
import { askConfirm, useDialogs } from "../../stores/dialogs";
import { asCoreError } from "../../ipc/api";
import { Button, Modal } from "../../ui/primitives";
import { DiffView } from "../editor/Dialogs";
import { highlight, theme } from "../editor/docs";

interface Props {
  title: string;
  identity: string;
  original: string | null;
  type: string;
  nullable: boolean;
  edit: boolean;
  editReason: string | null;
  prod: boolean;
  shortcut: string;
  fontFamily: string;
  onSave?: (value: string | null) => Promise<void>;
  onClose: () => void;
}

export function CellValueDialog(p: Props) {
  const [editing, setEditing] = useState(p.edit);
  const [text, setText] = useState(p.original ?? "");
  const [isNull, setIsNull] = useState(p.original === null);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkingClose = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const value = isNull ? null : text;
  const dirty = value !== p.original;
  const canEdit = !!p.onSave && !p.editReason;
  const jsonType = /^jsonb?$/i.test(p.type);

  useEffect(() => {
    const dialog = root.current?.closest('[role="dialog"]');
    const trap = (event: Event) => {
      const e = event as KeyboardEvent;
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const elements = [
        ...(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"], [contenteditable="true"]') ?? []),
      ].filter((el) => el.getClientRects().length);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    dialog?.addEventListener("keydown", trap);
    return () => dialog?.removeEventListener("keydown", trap);
  }, []);

  const close = async () => {
    if (busy || checkingClose.current || useDialogs.getState().current) return;
    checkingClose.current = true;
    const discard =
      !dirty ||
      (await askConfirm({ title: "Discard this cell edit?", body: "Your changes have not been applied.", confirmLabel: "Discard changes", danger: true }));
    checkingClose.current = false;
    if (discard) p.onClose();
  };
  const save = async () => {
    if (!canEdit || busy || !dirty) return;
    if (jsonType && value !== null) {
      try {
        JSON.parse(value);
      } catch {
        setError("Enter valid JSON before applying this change.");
        return;
      }
    }
    if (p.prod && !review) {
      setReview(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await p.onSave?.(value);
      p.onClose();
    } catch (e) {
      setError(asCoreError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`${review ? "Review change on PROD" : editing ? "Edit value" : "Full value"} · ${p.title}`}
      width={1120}
      onClose={() => void close()}
      footer={
        <>
          {review && (
            <Button className="h-10 px-4 text-sm" disabled={busy} onClick={() => setReview(false)}>
              Back to editing
            </Button>
          )}
          <Button className="h-10 px-4 text-sm" disabled={busy} onClick={() => void close()}>
            {dirty ? "Cancel" : "Close"}
          </Button>
          {!editing && p.onSave && (
            <Button className="h-10 px-5 text-sm" variant="primary" disabled={!canEdit} title={p.editReason ?? p.shortcut} onClick={() => setEditing(true)}>
              Edit{p.shortcut ? ` (${p.shortcut})` : ""}
            </Button>
          )}
          {editing && (
            <Button className="h-10 px-5 text-sm" variant={review ? "danger" : "primary"} disabled={!canEdit || !dirty || busy} onClick={() => void save()}>
              {busy ? "Applying…" : review ? "Apply to PROD transaction" : p.prod ? "Review changes…" : "Apply to transaction"}
            </Button>
          )}
        </>
      }
    >
      <div ref={root} className="flex min-h-0 flex-col gap-3">
        <div className="max-h-20 overflow-auto font-mono text-xs break-all text-muted">{p.identity}</div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span>
            {p.type || "Text"} · {value === null ? "NULL" : `${value.length.toLocaleString()} characters`}
          </span>
          {editing && (
            <label className="ml-auto flex min-h-9 cursor-pointer items-center gap-2.5 text-sm">
              <input className="h-5 w-5 accent-accent" type="checkbox" checked={isNull} disabled={!p.nullable || busy || review || !canEdit} onChange={(e) => setIsNull(e.target.checked)} />
              Set NULL
            </label>
          )}
        </div>
        {p.editReason && <p className="m-0 text-xs text-muted">{p.editReason}</p>}
        {error && (
          <div role="alert" className="rounded border border-bad p-2 text-prod-fg">
            {error}
          </div>
        )}
        {review ? (
          <>
            <div className="grid grid-cols-2 text-xs text-muted">
              <span>Original{p.original === null ? " · NULL" : ""}</span>
              <span>Updated{value === null ? " · NULL" : ""}</span>
            </div>
            <div className="flex min-h-0 flex-col" style={{ ["--ed-font" as string]: p.fontFamily, ["--ed-size" as string]: "13px" }}>
              <DiffView autoHeight left={p.original ?? ""} right={value ?? ""} lang={jsonType ? "json" : "text"} />
            </div>
          </>
        ) : (
          <ValueEditor text={text} editing={editing && !isNull && !busy && canEdit} jsonType={jsonType} fontFamily={p.fontFamily} onChange={setText} />
        )}
        {editing && <p className="m-0 text-xs text-warn">Applying changes leaves them uncommitted. Use Commit or Rollback in the connection toolbar.</p>}
      </div>
    </Modal>
  );
}

function ValueEditor({
  text,
  editing,
  jsonType,
  fontFamily,
  onChange,
}: {
  text: string;
  editing: boolean;
  jsonType: boolean;
  fontFamily: string;
  onChange: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const readOnly = useRef(new Compartment());
  const current = useRef(text);
  current.current = text;
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: current.current,
        extensions: [
          theme,
          Prec.high(EditorView.theme({
            "&": { height: "auto", minHeight: "20vh", maxHeight: "50vh" },
            ".cm-scroller": { overflow: "auto", minHeight: "0" },
            ".cm-content": { minHeight: "20vh" },
          })),
          lineNumbers(),
          history(),
          EditorState.lineSeparator.of("\n"),
          EditorView.lineWrapping,
          readOnly.current.of(EditorState.readOnly.of(true)),
          jsonType ? json() : [],
          syntaxHighlighting(highlight),
          search({ top: true }),
          keymap.of([...searchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    view.focus();
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [jsonType, onChange]);
  useEffect(() => {
    editor.current?.dispatch({ effects: readOnly.current.reconfigure(EditorState.readOnly.of(!editing)) });
    if (editing) editor.current?.focus();
  }, [editing]);
  return (
    <div
      ref={host}
      className="relative isolate overflow-hidden rounded border border-line"
      style={{ ["--ed-font" as string]: fontFamily, ["--ed-size" as string]: "13px" }}
    />
  );
}
