// What the editor does, outside React: open, track unsaved changes, notice changes on the server,
// reload, save. The UI (EditorWorkspace) handles the dialogs (review, merge, sudo).
import type { EditorState, Extension, TransactionSpec } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { api } from "../../ipc/api";
import type { SaveMode } from "../../ipc/bindings/SaveMode";
import type { SaveOutcome } from "../../ipc/bindings/SaveOutcome";
import { docKey, langOfFile, useEditor, type EditorDoc } from "../../stores/editor";
import { createState, hide, hideExt, lang, readOnly, readOnlyExt, states, whitespace, whitespaceExt, wrap, wrapExt } from "./docs";
import type { LangId } from "./lang";
import { useTabs } from "../../stores/tabs";
import { supportFor } from "./languages";

/** The editor view on screen per server, and which file it shows. */
export const mounted = new Map<string, { view: EditorView; key: string | null }>();

/** Callbacks of the workspace on screen (Ctrl+S / format inside the editor, cursor moves). */
export const hooks = new Map<string, { save: (key: string) => void; format: (key: string) => void; update: (key: string, u: ViewUpdate) => void }>();

const support = new Map<LangId, Promise<Extension>>();
const supportOf = (l: LangId) => {
  let p = support.get(l);
  if (!p) {
    p = supportFor(l).catch(() => []);
    support.set(l, p);
  }
  return p;
};

const getDoc = (key: string): EditorDoc | undefined => {
  const hostId = key.slice(0, key.indexOf("|"));
  return useEditor.getState().byHost[hostId]?.docs.find((d) => d.key === key);
};

function shown(key: string): EditorView | null {
  const hostId = key.slice(0, key.indexOf("|"));
  const m = mounted.get(hostId);
  return m && m.key === key ? m.view : null;
}

export function stateOf(key: string): EditorState | undefined {
  return shown(key)?.state ?? states.get(key);
}

export const textOf = (key: string): string => stateOf(key)?.doc.toString() ?? "";

/** Apply a transaction to a file's state, on screen or not. */
export function dispatchTo(key: string, spec: TransactionSpec) {
  const v = shown(key);
  if (v) v.dispatch(spec);
  else {
    const s = states.get(key);
    if (s) states.set(key, s.update(spec).state);
  }
}

/** Replace the whole text (undoable). */
export function replaceText(key: string, text: string) {
  const s = stateOf(key);
  if (!s || s.doc.toString() === text) return;
  dispatchTo(key, { changes: { from: 0, to: s.doc.length, insert: text } });
}

// ---------------------------------------------------------------- dirty

const dirtyTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** A change marks the tab dirty at once; whether it is still different is checked a moment later. */
export function noteChange(key: string) {
  const d = getDoc(key);
  if (!d) return;
  if (!d.dirty) useEditor.getState().patch(key, { dirty: true, reloadedAt: null });
  clearTimeout(dirtyTimers.get(key));
  dirtyTimers.set(
    key,
    setTimeout(() => {
      dirtyTimers.delete(key);
      const cur = getDoc(key);
      if (cur) {
        const dirty = textOf(key) !== cur.baseText;
        if (dirty !== cur.dirty) useEditor.getState().patch(key, { dirty });
      }
    }, 300),
  );
}

// ---------------------------------------------------------------- open

function newState(key: string, hostId: string, l: LangId, ro: boolean, text: string): EditorState {
  const { prefs } = useEditor.getState();
  const s = createState({
    text,
    lang: l,
    readOnly: ro,
    wrap: prefs.wrap,
    whitespace: prefs.whitespace,
    hideValues: prefs.hideEnvValues,
    onUpdate: (u) => {
      if (u.docChanged) noteChange(key);
      hooks.get(hostId)?.update(key, u);
    },
    onSave: () => hooks.get(hostId)?.save(key),
    onFormat: () => hooks.get(hostId)?.format(key),
  });
  void supportOf(l).then((ext) => dispatchTo(key, { effects: lang.reconfigure(ext) }));
  return s;
}

/**
 * Open a file in the editor (or switch to it). An open tab with unsaved changes is never replaced;
 * a clean one is refreshed from the server.
 */
export async function openFile(hostId: string, path: string): Promise<EditorDoc> {
  const f = await api.editorOpen(hostId, path);
  const key = docKey(hostId, f.real_path);
  const existing = getDoc(key);
  const store = useEditor.getState();
  if (existing?.dirty) {
    store.activate(hostId, key);
    return existing;
  }
  if (existing && stateOf(key)) {
    const d = store.put(hostId, f);
    // Same tab, maybe new content: keep its undo history.
    replaceText(key, f.content);
    clearTimeout(dirtyTimers.get(key));
    useEditor.getState().patch(key, { dirty: false });
    return d;
  }
  // The state exists before the tab does, so the view can show it at once.
  states.set(key, newState(key, hostId, langOfFile(f), f.read_only, f.content));
  return store.put(hostId, f);
}

/** Open a file and show the server's Editor view (Files → Edit in Rookery). */
export async function openInEditor(hostId: string, path: string) {
  await openFile(hostId, path);
  useTabs.getState().setView(hostId, "editor");
}

/** Re-read from the server, dropping unsaved changes (the caller asked first). */
export async function reload(key: string, note = false) {
  const d = getDoc(key);
  if (!d) return;
  const f = await api.editorOpen(d.hostId, d.realPath);
  useEditor.getState().patch(key, {
    base: f.version,
    baseText: f.content,
    eol: f.eol,
    bom: f.bom,
    mixedEol: f.mixed_eol,
    readOnly: f.read_only,
    readOnlyReason: f.read_only_reason,
    owned: f.owned,
    mode: f.mode,
    changed: null,
  });
  replaceText(key, f.content);
  clearTimeout(dirtyTimers.get(key));
  useEditor.getState().patch(key, { dirty: false, reloadedAt: note ? Date.now() : null });
  dispatchTo(key, { effects: readOnly.reconfigure(readOnlyExt(f.read_only)) });
}

export function close(key: string) {
  useEditor.getState().remove(key);
  states.delete(key);
  clearTimeout(dirtyTimers.get(key));
  const hostId = key.slice(0, key.indexOf("|"));
  const m = mounted.get(hostId);
  if (m?.key === key) m.key = null;
}

export function forgetHost(hostId: string) {
  for (const d of useEditor.getState().byHost[hostId]?.docs ?? []) states.delete(d.key);
  useEditor.getState().forgetHost(hostId);
}

/** Wrap / whitespace / hide values changed: apply to every open file. */
export function applyPrefs() {
  const { prefs, byHost } = useEditor.getState();
  for (const h of Object.values(byHost)) {
    for (const d of h.docs) {
      dispatchTo(d.key, {
        effects: [wrap.reconfigure(wrapExt(prefs.wrap)), whitespace.reconfigure(whitespaceExt(prefs.whitespace)), hide.reconfigure(hideExt(prefs.hideEnvValues, d.lang))],
      });
    }
  }
}

// ---------------------------------------------------------------- changed on the server

/**
 * The cheap check (size and time; never polled: on focus, when the view or a tab is shown).
 * A clean tab whose file changed is reloaded; a dirty one gets the banner.
 */
export async function checkServer(hostId: string, keys?: string[]) {
  const docs = (useEditor.getState().byHost[hostId]?.docs ?? []).filter((d) => !keys || keys.includes(d.key));
  await Promise.all(
    docs.map(async (d) => {
      try {
        const st = await api.editorStat(hostId, d.realPath);
        const same = st.exists && st.size === d.base.size && st.mtime === d.base.mtime;
        const cur = getDoc(d.key);
        if (!cur) return;
        if (same) {
          if (cur.changed) useEditor.getState().patch(d.key, { changed: null });
          return;
        }
        if (!cur.dirty && st.exists) {
          // Only the time changed (e.g. `touch`)? Then the content is the same: just take the new version.
          const f = await api.editorOpen(hostId, d.realPath);
          if (f.version.sha256 === cur.base.sha256) useEditor.getState().patch(d.key, { base: f.version, changed: null });
          else if (!getDoc(d.key)?.dirty) await reload(d.key, true);
          return;
        }
        useEditor.getState().patch(d.key, { changed: { size: st.size, mtime: st.mtime, exists: st.exists } });
      } catch {
        /* offline: checked again next time */
      }
    }),
  );
}

// ---------------------------------------------------------------- save

/** One save attempt. `text` is what is saved (the editor may change meanwhile). */
export async function saveRaw(key: string, text: string, mode: SaveMode): Promise<SaveOutcome> {
  const d = getDoc(key);
  if (!d) throw new Error("The file is no longer open.");
  const out = await api.editorSave(d.hostId, d.realPath, text, d.eol, d.bom, d.base, mode);
  if (out.kind === "saved") {
    useEditor.getState().patch(key, { base: out.version, baseText: text, changed: null, reloadedAt: null, mixedEol: false });
    useEditor.getState().patch(key, { dirty: textOf(key) !== text });
  }
  return out;
}

/** The merge (or "keep theirs as the base") moves the base to the server's version. */
export function rebase(key: string, base: EditorDoc["base"], baseText: string) {
  useEditor.getState().patch(key, { base, baseText, changed: null });
  noteChange(key);
}
