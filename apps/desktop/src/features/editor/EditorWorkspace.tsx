// Server tab → Editor (docs/08): folders on the left, files in tabs on the right, safe saving.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { diagnosticCount } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import {
  AlertTriangle,
  Copy,
  Eye,
  EyeOff,
  File as FileIcon,
  FilePlus2,
  History,
  Info,
  Loader2,
  Pilcrow,
  Pin,
  PinOff,
  Save,
  Search,
  Sparkles,
  WrapText,
  X,
} from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import { copyText } from "../../ipc/clipboard";
import type { SaveMode } from "../../ipc/bindings/SaveMode";
import { askChoice, askConfirm, askText } from "../../stores/dialogs";
import { useEditor, type EditorDoc } from "../../stores/editor";
import { parentPath } from "../../stores/files";
import { useHosts } from "../../stores/hosts";
import { useKeys } from "../../stores/keys";
import { applyPrefs, checkServer, close, hooks, mounted, openFile, rebase, reload, replaceText, saveRaw, stateOf, textOf } from "./actions";
import { states } from "./docs";
import { HistoryDialog, MergeDialog, ReviewDialog, when, type MergeInput } from "./Dialogs";
import { formatText } from "./format";
import { canFormat, LANG_LABEL } from "./lang";
import { FileTree } from "./FileTree";

type Note = { kind: "ok" | "error" | "info"; text: string } | null;

interface Pos {
  line: number;
  col: number;
  sel: number;
  problems: number;
}

const posOf = (s: EditorState): Pos => {
  const head = s.selection.main.head;
  const line = s.doc.lineAt(head);
  const sel = s.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0);
  return { line: line.number, col: head - line.from + 1, sel, problems: diagnosticCount(s) };
};

const METHOD: Record<string, string> = {
  atomic: "replaced in one step",
  in_place: "written in place (owner and permissions kept)",
  sudo: "written with sudo",
  unchanged: "it already had this text",
};

export function EditorWorkspace({ hostId, visible }: { hostId: string; visible: boolean }) {
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const he = useEditor((s) => s.byHost[hostId]);
  const prefs = useEditor((s) => s.prefs);
  const pins = useEditor((s) => s.pins[hostId]);
  const fontFamily = useKeys((s) => s.terminal.fontFamily);
  const fontSize = useKeys((s) => s.terminal.fontSize);
  const docs = he?.docs ?? [];
  const active = he?.active ?? null;
  const doc = docs.find((d) => d.key === active) ?? null;
  const isProd = host?.env_label === "prod";

  const [note, setNote] = useState<Note>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [merge, setMerge] = useState<MergeInput | null>(null);
  const [review, setReview] = useState<{ key: string; text: string; mode: SaveMode } | null>(null);
  const [history, setHistory] = useState(false);
  const editorEl = useRef<HTMLDivElement>(null);
  const savingKeys = useRef(new Set<string>());

  useEffect(() => {
    void useEditor.getState().load();
  }, []);

  // One CodeMirror view; each tab's state is swapped in and out (docs.ts keeps them).
  useEffect(() => {
    const view = new EditorView({ parent: editorEl.current! });
    mounted.set(hostId, { view, key: null });
    return () => {
      const m = mounted.get(hostId);
      // Keep the state only for a tab that is still open (closing the server tab forgets them all).
      if (m?.key && useEditor.getState().byHost[hostId]?.docs.some((d) => d.key === m.key)) states.set(m.key, m.view.state);
      view.destroy();
      mounted.delete(hostId);
    };
  }, [hostId]);

  useEffect(() => {
    const m = mounted.get(hostId);
    if (!m || m.key === active) return;
    if (m.key && states.has(m.key)) states.set(m.key, m.view.state);
    const next = active ? states.get(active) : undefined;
    if (active && next) {
      m.view.setState(next);
      m.key = active;
      setPos(posOf(next));
      if (visible) requestAnimationFrame(() => m.view.focus());
    } else {
      m.key = null;
      setPos(null);
    }
  }, [active, hostId, docs.length, visible]);

  // ------------------------------------------------------------ server changes (never polled)
  const lastCheck = useRef(0);
  const check = useCallback(
    (keys?: string[]) => {
      if (!keys && Date.now() - lastCheck.current < 1500) return;
      if (!keys) lastCheck.current = Date.now();
      void checkServer(hostId, keys);
    },
    [hostId],
  );
  useEffect(() => {
    if (!visible) return;
    check();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [visible, check]);
  useEffect(() => {
    if (visible && active) check([active]);
  }, [active, visible, check]);

  const flash = (n: Note, ms = 4000) => {
    setNote(n);
    if (n && n.kind !== "error") setTimeout(() => setNote((cur) => (cur === n ? null : cur)), ms);
  };

  // ------------------------------------------------------------ open
  const open = useCallback(
    async (path: string) => {
      try {
        await openFile(hostId, path);
        setNote(null);
      } catch (e) {
        setNote({ kind: "error", text: asCoreError(e).message });
      }
    },
    [hostId],
  );

  const openPath = async () => {
    const dir = doc ? parentPath(doc.path) : "~";
    const p = await askText({ title: "Open file", label: "Path on the server (absolute, or ~/…)", value: dir.endsWith("/") ? dir : `${dir}/`, confirmLabel: "Open" });
    if (p) await open(p);
  };

  // ------------------------------------------------------------ save
  const getDoc = (key: string) => useEditor.getState().byHost[hostId]?.docs.find((d) => d.key === key);

  const save = async (key: string, mode: SaveMode = "normal", reviewed = false): Promise<boolean> => {
    const d = getDoc(key);
    if (!d || d.readOnly || savingKeys.current.has(key)) return false;
    const text = textOf(key);
    if (mode === "normal" && text === d.baseText) {
      flash({ kind: "info", text: "No changes to save." }, 2000);
      return true;
    }
    if (isProd && !reviewed) {
      setReview({ key, text, mode });
      return false;
    }
    savingKeys.current.add(key);
    setSaving(key);
    let out;
    try {
      out = await saveRaw(key, text, mode);
    } catch (e) {
      setNote({ kind: "error", text: `Not saved: ${asCoreError(e).message}` });
      return false;
    } finally {
      savingKeys.current.delete(key);
      setSaving(null);
    }
    if (out.kind === "saved") {
      flash({ kind: "ok", text: `Saved ${d.name}: ${METHOD[out.method] ?? out.method}.` });
      return true;
    }
    if (out.kind === "conflict") {
      if (out.deleted) {
        const c = await askChoice({
          title: "The file was deleted on the server",
          body: `${d.realPath} no longer exists. Nothing was written.\n\nCreate it again with your text?`,
          choices: [{ id: "create", label: "Create it again", variant: "primary" }],
        });
        return c === "create" ? save(key, "overwrite", true) : false;
      }
      setMerge({ key, mine: text, theirs: out.theirs, theirsVersion: out.theirs_version });
      return false;
    }
    const ok = await askConfirm({
      title: "Save with sudo?",
      body: `${out.message}\n\nRookery can write it with sudo, using the sudo password saved for this server's login (it is never shown). The file keeps its owner and permissions.`,
      confirmLabel: "Save with sudo",
      danger: isProd,
    });
    return ok ? save(key, "sudo", true) : false;
  };

  const format = async (key: string) => {
    const d = getDoc(key);
    if (!d || d.readOnly) return;
    if (!canFormat(d.lang)) return flash({ kind: "info", text: `No formatter for ${LANG_LABEL[d.lang]} files.` });
    try {
      replaceText(key, await formatText(d.lang, textOf(key)));
      flash({ kind: "ok", text: "Formatted. Not saved yet." }, 2500);
    } catch (e) {
      // Prettier puts a code frame after the first line.
      setNote({ kind: "error", text: `Could not format: ${String((e as Error)?.message ?? e).split("\n")[0]}` });
    }
  };

  const latest = useRef({ save, format });
  latest.current = { save, format };
  useEffect(() => {
    hooks.set(hostId, {
      save: (k) => void latest.current.save(k),
      format: (k) => void latest.current.format(k),
      update: (k, u) => {
        if (mounted.get(hostId)?.key === k && (u.docChanged || u.selectionSet || u.transactions.length)) setPos(posOf(u.state));
      },
    });
    return () => {
      hooks.delete(hostId);
    };
  }, [hostId]);

  // ------------------------------------------------------------ tabs
  const closeDoc = async (key: string) => {
    const d = getDoc(key);
    if (!d) return;
    if (d.dirty) {
      const c = await askChoice({
        title: `Save changes to ${d.name}?`,
        body: "Your changes are lost if you don't save them.",
        choices: [
          { id: "discard", label: "Don't save", variant: "danger" },
          { id: "save", label: "Save", variant: "primary" },
        ],
      });
      if (!c) return;
      if (c === "save" && !(await save(key))) return;
    }
    close(key);
  };

  const compare = async (d: EditorDoc) => {
    try {
      const f = await api.editorOpen(hostId, d.realPath);
      setMerge({ key: d.key, mine: textOf(d.key), theirs: f.content, theirsVersion: f.version, compare: true });
    } catch (e) {
      setNote({ kind: "error", text: asCoreError(e).message });
    }
  };

  const dropMine = async (d: EditorDoc) => {
    if (d.dirty) {
      const ok = await askConfirm({ title: `Reload ${d.name} from the server?`, body: "Your unsaved changes in this tab are lost.", confirmLabel: "Reload", danger: true });
      if (!ok) return;
    }
    await reload(d.key).catch((e) => setNote({ kind: "error", text: asCoreError(e).message }));
  };

  const onKey = (e: ReactKeyboardEvent) => {
    // The merge / review / history dialogs have their own buttons: no shortcut saves behind them.
    if (e.defaultPrevented || merge || review || history) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void openPath();
    } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s" && active) {
      e.preventDefault();
      void save(active);
    }
  };

  const setPref = (p: Partial<typeof prefs>) => {
    useEditor.getState().setPrefs(p);
    applyPrefs();
  };

  const view = () => mounted.get(hostId)?.view ?? null;
  const pinned = !!doc && (pins ?? []).includes(doc.path);

  return (
    <div className="flex h-full min-h-0 bg-bg" onKeyDown={onKey}>
      <FileTree hostId={hostId} visible={visible} activePath={doc?.path ?? null} onOpen={(p) => void open(p)} onOpenPath={() => void openPath()} />

      <div className="flex min-w-0 flex-1 flex-col" style={{ ["--ed-font" as string]: fontFamily, ["--ed-size" as string]: `${fontSize}px` }}>
        {/* tabs */}
        <div role="tablist" aria-label="Open files" className="flex h-9 flex-none items-stretch overflow-x-auto border-b border-line bg-term">
          {docs.map((d) => (
            <div
              key={d.key}
              role="tab"
              aria-selected={d.key === active}
              title={d.realPath !== d.path ? `${d.path} → ${d.realPath}` : d.path}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void closeDoc(d.key);
                }
              }}
              className={clsx(
                "group/t flex max-w-[220px] flex-none items-center gap-1.5 border-r border-line pr-1 pl-3 text-[13px]",
                d.key === active ? "bg-[#171D29] text-text" : "text-muted hover:text-text",
              )}
            >
              <button className="truncate" onClick={() => useEditor.getState().activate(hostId, d.key)}>
                {d.name}
              </button>
              {d.changed && <AlertTriangle size={11} className="flex-none text-warn" aria-label="changed on the server" />}
              <button
                aria-label={d.dirty ? `Close ${d.name} (unsaved changes)` : `Close ${d.name}`}
                onClick={() => void closeDoc(d.key)}
                className="grid h-5 w-5 flex-none place-items-center rounded hover:bg-panel2"
              >
                {d.dirty ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-text group-hover/t:hidden" />
                    <X size={12} className="hidden group-hover/t:block" />
                  </>
                ) : (
                  <X size={12} className={d.key === active ? "" : "invisible group-hover/t:visible"} />
                )}
              </button>
            </div>
          ))}
        </div>

        {/* toolbar */}
        {doc && (
          <div className="flex h-9 flex-none items-center gap-1 border-b border-line bg-panel px-2 text-xs">
            <button
              onClick={() => void copyText(doc.realPath).then(() => flash({ kind: "info", text: "Path copied." }, 1500))}
              title="Copy path"
              className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 font-mono text-[11px] text-muted hover:bg-panel2 hover:text-text"
            >
              <span className="truncate">{doc.realPath}</span>
              <Copy size={11} className="flex-none" />
            </button>
            <span className="flex-1" />
            <Tool label={pinned ? "Unpin" : "Pin to the list on the left"} onClick={() => useEditor.getState().togglePin(hostId, doc.path)}>
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </Tool>
            <Tool label="Find / replace (Ctrl+F)" onClick={() => view() && openSearchPanel(view()!)}>
              <Search size={13} />
            </Tool>
            <Tool label="Word wrap" on={prefs.wrap} onClick={() => setPref({ wrap: !prefs.wrap })}>
              <WrapText size={13} />
            </Tool>
            <Tool label="Show spaces" on={prefs.whitespace} onClick={() => setPref({ whitespace: !prefs.whitespace })}>
              <Pilcrow size={13} />
            </Tool>
            {doc.lang === "env" && (
              <Tool label={prefs.hideEnvValues ? "Show values" : "Hide values (the line you edit stays visible)"} on={prefs.hideEnvValues} onClick={() => setPref({ hideEnvValues: !prefs.hideEnvValues })}>
                {prefs.hideEnvValues ? <EyeOff size={13} /> : <Eye size={13} />}
              </Tool>
            )}
            <Tool label="History: the server's version before each save" onClick={() => setHistory(true)}>
              <History size={13} />
            </Tool>
            {canFormat(doc.lang) && !doc.readOnly && (
              <button onClick={() => void format(doc.key)} title="Format (Shift+Alt+F)" className="flex h-7 items-center gap-1.5 rounded-md px-2 text-muted hover:bg-panel2 hover:text-text">
                <Sparkles size={13} /> Format
              </button>
            )}
            <button
              onClick={() => void save(doc.key)}
              disabled={doc.readOnly || saving === doc.key}
              title="Save (Ctrl+S)"
              className={clsx(
                "ml-1 flex h-7 items-center gap-1.5 rounded-md px-3 font-medium disabled:opacity-50",
                doc.dirty ? (isProd ? "bg-[#33232A] text-prod-fg ring-1 ring-[#5A2D33]" : "bg-accent text-bg") : "text-muted hover:bg-panel2 hover:text-text",
              )}
            >
              {saving === doc.key ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {isProd ? "Save to PROD" : "Save"}
            </button>
          </div>
        )}

        {/* banners */}
        {doc && <Banners doc={doc} onCompare={() => void compare(doc)} onReload={() => void dropMine(doc)} />}
        {note && (
          <div
            className={clsx(
              "flex flex-none items-start gap-2 border-b px-3 py-1.5 text-[13px]",
              note.kind === "error" ? "border-[#5A2D33] bg-[#33232A] text-prod-fg" : note.kind === "ok" ? "border-[#2C5A45] bg-[#1E3329] text-[#86E0B6]" : "border-line bg-panel text-muted",
            )}
          >
            <span className="min-w-0 flex-1 whitespace-pre-wrap">{note.text}</span>
            <button aria-label="Dismiss" onClick={() => setNote(null)} className="text-muted hover:text-text">
              <X size={13} />
            </button>
          </div>
        )}

        {/* editor */}
        <div className="relative min-h-0 flex-1">
          <div ref={editorEl} className="absolute inset-0" style={{ display: doc ? "block" : "none" }} />
          {!doc && <Empty onOpenPath={() => void openPath()} />}
        </div>

        {/* status */}
        {doc && pos && (
          <div className="flex h-6 flex-none items-center gap-3 border-t border-line bg-panel px-3 text-[11px] text-muted">
            <span>
              Ln {pos.line}, Col {pos.col}
              {pos.sel > 0 && ` (${pos.sel} selected)`}
            </span>
            {pos.problems > 0 && (
              <span className="flex items-center gap-1 text-warn">
                <AlertTriangle size={11} /> {pos.problems} {pos.problems === 1 ? "problem" : "problems"}
              </span>
            )}
            <span className="flex-1" />
            {doc.dirty && <span className="text-text">Unsaved</span>}
            <span>{LANG_LABEL[doc.lang]}</span>
            <span title={doc.mixedEol ? "The file had mixed line endings" : "Line endings are kept as they were"}>{doc.eol === "crlf" ? "CRLF" : "LF"}</span>
            <span>UTF-8{doc.bom ? " BOM" : ""}</span>
            <span className="font-mono" title={doc.owned ? "Your file: saved in one step (temp file + rename)" : "Not your file: written in place, owner kept"}>
              {doc.mode} {doc.owned ? "· yours" : "· shared"}
            </span>
          </div>
        )}
      </div>

      {merge && doc && getDoc(merge.key) && (
        <MergeDialog
          doc={getDoc(merge.key)!}
          input={merge}
          onCancel={() => setMerge(null)}
          onSave={(text) => {
            const key = merge.key;
            rebase(key, merge.theirsVersion, merge.theirs);
            replaceText(key, text);
            setMerge(null);
            void save(key, "normal", true);
          }}
          onTakeTheirs={async () => {
            const d = getDoc(merge.key)!;
            const ok = await askConfirm({ title: "Use the server's version?", body: "Your changes in this tab are replaced by the file as it is on the server now.", confirmLabel: "Use theirs", danger: true });
            if (!ok) return;
            setMerge(null);
            await reload(d.key).catch((e) => setNote({ kind: "error", text: asCoreError(e).message }));
          }}
          onOverwrite={async () => {
            const ok = await askConfirm({
              title: "Overwrite the server's version with yours?",
              body: "Their changes are lost on the server. (Their version is kept in History on this PC.)",
              confirmLabel: "Overwrite",
              danger: true,
            });
            if (!ok) return;
            const key = merge.key;
            setMerge(null);
            void save(key, "overwrite", true);
          }}
        />
      )}
      {review && getDoc(review.key) && (
        <ReviewDialog
          doc={getDoc(review.key)!}
          text={review.text}
          hostName={host?.name ?? "server"}
          onCancel={() => setReview(null)}
          onSave={() => {
            const r = review;
            setReview(null);
            void save(r.key, r.mode, true);
          }}
        />
      )}
      {history && doc && (
        <HistoryDialog
          doc={doc}
          current={stateOf(doc.key)?.doc.toString() ?? ""}
          onClose={() => setHistory(false)}
          onRestore={(text) => {
            replaceText(doc.key, text);
            setHistory(false);
            flash({ kind: "info", text: "Restored into the editor (undo with Ctrl+Z). Save to write it to the server." }, 6000);
          }}
        />
      )}
    </div>
  );
}

function Tool({ label, on, onClick, children }: { label: string; on?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button aria-label={label} title={label} aria-pressed={on} onClick={onClick} className={clsx("grid h-7 w-7 place-items-center rounded-md", on ? "bg-accent-bg text-text" : "text-muted hover:bg-panel2 hover:text-text")}>
      {children}
    </button>
  );
}

function Banners({ doc, onCompare, onReload }: { doc: EditorDoc; onCompare: () => void; onReload: () => void }) {
  const items: ReactNode[] = [];
  if (doc.changed) {
    items.push(
      <div key="changed" className="flex flex-none items-center gap-2 border-b border-[#7A6420] bg-[#33301F] px-3 py-1.5 text-[13px] text-[#F7CB6A]">
        <AlertTriangle size={13} className="flex-none" />
        <span className="flex-1">
          {doc.changed.exists ? `Changed on the server ${when(doc.changed.mtime)} while you edit.` : "Deleted on the server."} Saving will show both versions first.
        </span>
        {doc.changed.exists && (
          <button onClick={onCompare} className="rounded px-2 py-0.5 font-medium hover:bg-[#44391A]">
            Compare
          </button>
        )}
        <button onClick={onReload} className="rounded px-2 py-0.5 hover:bg-[#44391A]">
          {doc.dirty ? "Reload (drop mine)" : "Reload"}
        </button>
      </div>,
    );
  }
  if (doc.reloadedAt) {
    items.push(
      <div key="reloaded" className="flex flex-none items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-[13px] text-muted">
        <Info size={13} className="flex-none text-accent" />
        <span className="flex-1">Reloaded: the file changed on the server (you had no unsaved changes). Ctrl+Z brings back the previous text.</span>
        <button onClick={() => useEditor.getState().patch(doc.key, { reloadedAt: null })} aria-label="Dismiss" className="hover:text-text">
          <X size={13} />
        </button>
      </div>,
    );
  }
  if (doc.readOnly) {
    items.push(
      <div key="ro" className="flex flex-none items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-[13px] text-muted">
        <Info size={13} className="flex-none" /> {doc.readOnlyReason ?? "Read-only."}
      </div>,
    );
  }
  if (doc.mixedEol) {
    items.push(
      <div key="eol" className="flex flex-none items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-[13px] text-muted">
        <Info size={13} className="flex-none" /> This file mixes LF and CRLF line endings; saving writes {doc.eol === "crlf" ? "CRLF" : "LF"} everywhere.
      </div>,
    );
  }
  return <>{items}</>;
}

function Empty({ onOpenPath }: { onOpenPath: () => void }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center text-[13px] text-muted">
        <FileIcon size={28} className="text-line" />
        <span>Open a file from the folders on the left, or by path.</span>
        <button onClick={onOpenPath} className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-text hover:bg-panel2">
          <FilePlus2 size={13} /> Open path… <span className="text-muted">Ctrl+O</span>
        </button>
        <span className="text-xs">
          Saving checks that nobody changed the file since you opened it, keeps a copy of the old version on this PC, and verifies what was written.
        </span>
      </div>
    </div>
  );
}
