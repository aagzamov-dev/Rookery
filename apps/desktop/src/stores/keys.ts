// Keybindings + terminal/app preferences, persisted in the local DB (`ui.*` settings).
import { create } from "zustand";
import type { ITheme } from "@xterm/xterm";
import { api } from "../ipc/api";
import { ACTIONS, type ActionId } from "../keys/actions";
import { isMac, normalizeChord } from "../keys/chord";

export interface TerminalPrefs {
  /** Ctrl+C copies when text is selected, otherwise it interrupts (Windows Terminal style). */
  ctrlCCopies: boolean;
  /** Ctrl+V pastes instead of sending ^V. */
  ctrlVPastes: boolean;
  /** Right-click: copy if text is selected, otherwise paste (PuTTY / MobaXterm style). */
  rightClickPastes: boolean;
  /** Copy automatically when you select text. */
  copyOnSelect: boolean;
  /** Ask before pasting text with more than one line. */
  warnMultilinePaste: boolean;
  fontSize: number;
  fontFamily: string;
  /** Theme name (built-in or imported). A host can override it. */
  theme: string;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  /** Desktop notification when a command that ran longer than `notifyAfterSec` finishes in the background. */
  notifyLongCommands: boolean;
  notifyAfterSec: number;
  /** Highlight lines matching a trigger (ERROR, WARN…); the output itself is never changed. */
  highlightTriggers: boolean;
  triggers: Trigger[];
}

/** Terminal trigger: lines matching `pattern` (regex) get a coloured band and a scrollbar mark. */
export interface Trigger {
  id: string;
  pattern: string;
  color: TriggerColor;
  /** Desktop notification when it matches while you are in another tab or app. */
  notify: boolean;
  enabled: boolean;
  caseSensitive: boolean;
}
export type TriggerColor = "red" | "yellow" | "green" | "blue" | "purple";

export const DEFAULT_TRIGGERS: Trigger[] = [
  { id: "errors", pattern: String.raw`\b(ERROR|FATAL|CRITICAL|PANIC|Exception|Traceback|failed)\b`, color: "red", notify: false, enabled: true, caseSensitive: true },
  { id: "warnings", pattern: String.raw`\b(WARN|WARNING|DEPRECATED)\b`, color: "yellow", notify: false, enabled: true, caseSensitive: true },
];

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  ctrlCCopies: !isMac,
  ctrlVPastes: !isMac,
  rightClickPastes: !isMac,
  copyOnSelect: false,
  warnMultilinePaste: true,
  fontSize: 13,
  fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  theme: "Slate Blue",
  cursorStyle: "block",
  cursorBlink: true,
  notifyLongCommands: true,
  notifyAfterSec: 20,
  highlightTriggers: true,
  triggers: DEFAULT_TRIGGERS,
};

export interface AppPrefs {
  /** Reopen last session's tabs on start (server tabs wait for a click to connect). */
  restoreTabs: boolean;
  /** Connect restored server tabs right away instead of waiting for a click. */
  autoConnectRestored: boolean;
  /** Lock after this many minutes without input; 0 = never. */
  autoLockMin: number;
  /** Write every SSH session to a log file (a host can also turn it on just for itself). */
  logSessions: boolean;
  /** Delete session logs older than this many days; 0 = keep forever. */
  logRetentionDays: number;
  /** System-wide shortcut that brings Rookery to the front / minimises it; null = off. */
  globalHotkey: string | null;
}

export const DEFAULT_APP_PREFS: AppPrefs = {
  restoreTabs: true,
  autoConnectRestored: false,
  autoLockMin: 10,
  logSessions: false,
  logRetentionDays: 30,
  globalHotkey: null,
};

/** A key that types text into the active terminal (macros like MobaXterm). `\n`, `\t`, `\e`, `\xNN` are decoded. */
export interface CustomKey {
  id: string;
  label: string;
  chord: string;
  text: string;
}

export const FONT_MIN = 9;
export const FONT_MAX = 28;

export type Overrides = Partial<Record<ActionId, string[]>>;

interface KeysState {
  overrides: Overrides;
  bindings: Record<ActionId, string[]>;
  terminal: TerminalPrefs;
  app: AppPrefs;
  customThemes: Record<string, ITheme>;
  customKeys: CustomKey[];
  /** True while a shortcut recorder is capturing keys — the dispatcher stays quiet. */
  recording: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  setBinding: (id: ActionId, chords: string[]) => Promise<void>;
  resetBinding: (id: ActionId) => Promise<void>;
  resetAll: () => Promise<void>;
  /** Replace all overrides at once (presets, import). */
  setOverrides: (o: Overrides) => Promise<void>;
  setTerminal: (patch: Partial<TerminalPrefs>) => Promise<void>;
  setApp: (patch: Partial<AppPrefs>) => Promise<void>;
  saveTheme: (name: string, theme: ITheme) => Promise<void>;
  deleteTheme: (name: string) => Promise<void>;
  setCustomKeys: (keys: CustomKey[]) => Promise<void>;
  setRecording: (v: boolean) => void;
}

export function resolveBindings(overrides: Overrides): Record<ActionId, string[]> {
  const out = {} as Record<ActionId, string[]>;
  for (const a of ACTIONS) out[a.id] = (overrides[a.id] ?? a.defaults).map(normalizeChord);
  return out;
}

export const useKeys = create<KeysState>((set, get) => ({
  overrides: {},
  bindings: resolveBindings({}),
  terminal: DEFAULT_TERMINAL_PREFS,
  app: DEFAULT_APP_PREFS,
  customThemes: {},
  customKeys: [],
  recording: false,
  loaded: false,

  load: async () => {
    const get_ = <T,>(k: string) => api.settingGet<T>(k).catch(() => null);
    const [ov, term, app, themes, custom] = await Promise.all([
      get_<Overrides>("ui.keybindings"),
      get_<Partial<TerminalPrefs>>("ui.terminal"),
      get_<Partial<AppPrefs>>("ui.app"),
      get_<Record<string, ITheme>>("ui.customThemes"),
      get_<CustomKey[]>("ui.customKeys"),
    ]);
    const overrides = ov ?? {};
    set({
      overrides,
      bindings: resolveBindings(overrides),
      terminal: { ...DEFAULT_TERMINAL_PREFS, ...(term ?? {}) },
      app: { ...DEFAULT_APP_PREFS, ...(app ?? {}) },
      customThemes: themes ?? {},
      customKeys: (custom ?? []).map((k) => ({ ...k, chord: normalizeChord(k.chord) })),
      loaded: true,
    });
  },

  setBinding: async (id, chords) => {
    const overrides = { ...get().overrides, [id]: chords.map(normalizeChord) };
    set({ overrides, bindings: resolveBindings(overrides) });
    await api.settingSet("ui.keybindings", overrides);
  },

  resetBinding: async (id) => {
    const overrides = { ...get().overrides };
    delete overrides[id];
    set({ overrides, bindings: resolveBindings(overrides) });
    await api.settingSet("ui.keybindings", overrides);
  },

  resetAll: async () => {
    set({ overrides: {}, bindings: resolveBindings({}) });
    await api.settingSet("ui.keybindings", {});
  },

  setOverrides: async (o) => {
    const overrides: Overrides = {};
    for (const [k, v] of Object.entries(o)) if (Array.isArray(v)) overrides[k as ActionId] = v.map(normalizeChord);
    set({ overrides, bindings: resolveBindings(overrides) });
    await api.settingSet("ui.keybindings", overrides);
  },

  setTerminal: async (patch) => {
    const terminal = { ...get().terminal, ...patch };
    terminal.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(terminal.fontSize)));
    terminal.notifyAfterSec = Math.min(3600, Math.max(5, Math.round(terminal.notifyAfterSec)));
    set({ terminal });
    await api.settingSet("ui.terminal", terminal);
  },

  setApp: async (patch) => {
    const app = { ...get().app, ...patch };
    set({ app });
    await api.settingSet("ui.app", app);
  },

  saveTheme: async (name, theme) => {
    const customThemes = { ...get().customThemes, [name]: theme };
    set({ customThemes });
    await api.settingSet("ui.customThemes", customThemes);
  },

  deleteTheme: async (name) => {
    const customThemes = { ...get().customThemes };
    delete customThemes[name];
    set({ customThemes });
    await api.settingSet("ui.customThemes", customThemes);
    if (get().terminal.theme === name) await get().setTerminal({ theme: "Slate Blue" });
  },

  setCustomKeys: async (keys) => {
    const customKeys = keys.map((k) => ({ ...k, chord: normalizeChord(k.chord) }));
    set({ customKeys });
    await api.settingSet("ui.customKeys", customKeys);
  },

  setRecording: (recording) => set({ recording }),
}));

/** Every place a chord is used: app actions, custom keys and snippet hotkeys. */
export function findChordUsers(
  chord: string,
  bindings: Record<ActionId, string[]>,
  snippetHotkeys: { id: string; name: string; hotkey: string | null }[],
  customKeys: CustomKey[] = useKeys.getState().customKeys,
): { kind: "action" | "snippet" | "custom"; id: string; label: string }[] {
  const out: { kind: "action" | "snippet" | "custom"; id: string; label: string }[] = [];
  for (const a of ACTIONS) if (bindings[a.id].includes(chord)) out.push({ kind: "action", id: a.id, label: a.label });
  for (const k of customKeys) if (k.chord === chord) out.push({ kind: "custom", id: k.id, label: `Custom: ${k.label}` });
  for (const s of snippetHotkeys) if (s.hotkey && normalizeChord(s.hotkey) === chord) out.push({ kind: "snippet", id: s.id, label: `Snippet: ${s.name}` });
  return out;
}

/** Decode `\n \r \t \e \\ \xNN` in custom key text. */
export function decodeKeyText(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|[nrte\\])/g, (_, e: string) => {
    if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: "\n", r: "\r", t: "\t", e: "\x1b", "\\": "\\" }[e] ?? e;
  });
}
