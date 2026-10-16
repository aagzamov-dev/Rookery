// Editor tabs per server (docs/08). The text itself lives in CodeMirror states (features/editor/docs.ts),
// so undo history survives switching tabs; this store holds what the UI shows about each file.
import { create } from "zustand";
import { api } from "../ipc/api";
import type { EditorFile } from "../ipc/bindings/EditorFile";
import type { Eol } from "../ipc/bindings/Eol";
import type { FileVersion } from "../ipc/bindings/FileVersion";
import { baseName, langOf, type LangId } from "../features/editor/lang";

export interface EditorDoc {
  /** `hostId|realPath` */
  key: string;
  hostId: string;
  /** As opened (e.g. a symlink). */
  path: string;
  /** What is written. */
  realPath: string;
  name: string;
  lang: LangId;
  /** The server version the editor text is based on, and its text. */
  base: FileVersion;
  baseText: string;
  eol: Eol;
  bom: boolean;
  mixedEol: boolean;
  readOnly: boolean;
  readOnlyReason: string | null;
  owned: boolean;
  mode: string;
  dirty: boolean;
  /** Seen on the server: a different size / time than `base` (or deleted). */
  changed: { size: number; mtime: number; exists: boolean } | null;
  /** Set after an automatic reload of an unchanged tab ("Reloaded: changed on the server"). */
  reloadedAt: number | null;
}

interface HostEditor {
  docs: EditorDoc[];
  active: string | null;
}

export interface EditorPrefs {
  wrap: boolean;
  whitespace: boolean;
  hideEnvValues: boolean;
}

const PREFS_KEY = "ui.editor.prefs";
const PINS_KEY = "ui.editor.pins";
const ROOTS_KEY = "ui.editor.roots";
const DEFAULT_PREFS: EditorPrefs = { wrap: false, whitespace: false, hideEnvValues: false };

interface EditorState {
  byHost: Record<string, HostEditor>;
  prefs: EditorPrefs;
  /** Pinned paths per server (paths only, never content). */
  pins: Record<string, string[]>;
  /** The folder the tree shows per server (remembered). */
  roots: Record<string, string>;
  loaded: boolean;
  load: () => Promise<void>;
  setPrefs: (p: Partial<EditorPrefs>) => void;
  togglePin: (hostId: string, path: string) => void;
  setRoot: (hostId: string, path: string) => void;
  /** Add (or refresh) a doc from a freshly opened file; makes it active. */
  put: (hostId: string, f: EditorFile) => EditorDoc;
  patch: (key: string, p: Partial<EditorDoc>) => void;
  activate: (hostId: string, key: string) => void;
  remove: (key: string) => void;
  forgetHost: (hostId: string) => void;
}

/** By the name it was opened as (e.g. a link called .env), else by the real file. */
export const langOfFile = (f: EditorFile): LangId => (langOf(f.path) !== "text" ? langOf(f.path) : langOf(f.real_path));

export const docKey = (hostId: string, realPath: string) => `${hostId}|${realPath}`;
export const hostOfKey = (key: string) => key.slice(0, key.indexOf("|"));

export const useEditor = create<EditorState>((set, get) => ({
  byHost: {},
  prefs: DEFAULT_PREFS,
  pins: {},
  roots: {},
  loaded: false,
  async load() {
    if (get().loaded) return;
    const [prefs, pins, roots] = await Promise.all([
      api.settingGet<EditorPrefs>(PREFS_KEY).catch(() => null),
      api.settingGet<Record<string, string[]>>(PINS_KEY).catch(() => null),
      api.settingGet<Record<string, string>>(ROOTS_KEY).catch(() => null),
    ]);
    set({ loaded: true, prefs: { ...DEFAULT_PREFS, ...(prefs ?? {}) }, pins: pins ?? {}, roots: roots ?? {} });
  },
  setPrefs(p) {
    const prefs = { ...get().prefs, ...p };
    set({ prefs });
    void api.settingSet(PREFS_KEY, prefs).catch(() => {});
  },
  togglePin(hostId, path) {
    const cur = get().pins[hostId] ?? [];
    const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path];
    const pins = { ...get().pins, [hostId]: next };
    if (next.length === 0) delete pins[hostId];
    set({ pins });
    void api.settingSet(PINS_KEY, pins).catch(() => {});
  },
  setRoot(hostId, path) {
    if (get().roots[hostId] === path) return;
    const roots = { ...get().roots, [hostId]: path };
    set({ roots });
    void api.settingSet(ROOTS_KEY, roots).catch(() => {});
  },
  put(hostId, f) {
    const key = docKey(hostId, f.real_path);
    const doc: EditorDoc = {
      key,
      hostId,
      path: f.path,
      realPath: f.real_path,
      name: baseName(f.path),
      lang: langOfFile(f),
      base: f.version,
      baseText: f.content,
      eol: f.eol,
      bom: f.bom,
      mixedEol: f.mixed_eol,
      readOnly: f.read_only,
      readOnlyReason: f.read_only_reason,
      owned: f.owned,
      mode: f.mode,
      dirty: false,
      changed: null,
      reloadedAt: null,
    };
    set((s) => {
      const h = s.byHost[hostId] ?? { docs: [], active: null };
      const i = h.docs.findIndex((d) => d.key === key);
      const docs = i >= 0 ? h.docs.map((d, j) => (j === i ? doc : d)) : [...h.docs, doc];
      return { byHost: { ...s.byHost, [hostId]: { docs, active: key } } };
    });
    return doc;
  },
  patch(key, p) {
    const hostId = hostOfKey(key);
    set((s) => {
      const h = s.byHost[hostId];
      if (!h) return s;
      return { byHost: { ...s.byHost, [hostId]: { ...h, docs: h.docs.map((d) => (d.key === key ? { ...d, ...p } : d)) } } };
    });
  },
  activate(hostId, key) {
    set((s) => {
      const h = s.byHost[hostId];
      return h ? { byHost: { ...s.byHost, [hostId]: { ...h, active: key } } } : s;
    });
  },
  remove(key) {
    const hostId = hostOfKey(key);
    set((s) => {
      const h = s.byHost[hostId];
      if (!h) return s;
      const i = h.docs.findIndex((d) => d.key === key);
      const docs = h.docs.filter((d) => d.key !== key);
      const active = h.active === key ? (docs[Math.min(i, docs.length - 1)]?.key ?? null) : h.active;
      return { byHost: { ...s.byHost, [hostId]: { docs, active } } };
    });
  },
  forgetHost(hostId) {
    set((s) => {
      const byHost = { ...s.byHost };
      delete byHost[hostId];
      return { byHost };
    });
  },
}));

/** Docs with unsaved changes (all servers, or one). */
export function dirtyDocs(hostId?: string): EditorDoc[] {
  const by = useEditor.getState().byHost;
  return Object.entries(by)
    .filter(([h]) => !hostId || h === hostId)
    .flatMap(([, h]) => h.docs.filter((d) => d.dirty));
}
