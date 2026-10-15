// Keyboard chords: "Ctrl+Shift+V", "Meta+K", "Shift+Insert", "F5".
// Keys come from KeyboardEvent.code (physical key) so Shift doesn't change them
// and shortcuts work the same on every keyboard layout.

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MOD_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

const CODE_NAMES: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  NumpadAdd: "=",
  NumpadSubtract: "-",
};

function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code;
  return CODE_NAMES[code] ?? null;
}

/** Chord for a keydown event, or null for a lone modifier / unknown key. */
export function eventToChord(e: KeyboardEvent): string | null {
  const key = keyFromCode(e.code);
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  return [...mods, key].join("+");
}

/** Resolve "Mod" (Ctrl on Windows/Linux, ⌘ on macOS) and put modifiers in canonical order. */
export function normalizeChord(chord: string): string {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  // "Ctrl++" style is not used; "=" is the plus key.
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((m) => (m === "Mod" ? (isMac ? "Meta" : "Ctrl") : m === "Cmd" ? "Meta" : m)));
  return [...MOD_ORDER.filter((m) => mods.has(m)), key.length === 1 ? key.toUpperCase() : key].join("+");
}

/** A chord needs Ctrl/Alt/⌘, unless it is a function key or Shift+Insert. */
export function isValidChord(chord: string): boolean {
  const parts = chord.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (/^F\d{1,2}$/.test(key)) return true;
  // Shift + navigation keys are safe (terminals don't type them as text).
  if (/^Shift\+(Insert|PageUp|PageDown|Home|End)$/.test(chord)) return true;
  return mods.some((m) => m === "Ctrl" || m === "Alt" || m === "Meta");
}

/** What a plain Ctrl+letter does in bash/zsh and common tools (shown when the user binds it). */
const SHELL_KEYS: Record<string, string> = {
  A: "moves to the start of the line (and is the screen prefix)",
  B: "moves back one character (and is the tmux prefix)",
  C: "stops the running command",
  D: "exits the shell / sends end-of-input",
  E: "moves to the end of the line",
  K: "deletes to the end of the line",
  L: "clears the screen",
  R: "searches command history",
  U: "deletes the whole line",
  W: "deletes the previous word",
  X: "exits nano (and starts readline Ctrl+X combos)",
  Z: "pauses the running program",
  V: "types the next key literally",
};

/** Warning text when a chord replaces a shell key inside terminals (Windows/Linux only). */
export function shellKeyNote(chord: string): string | null {
  if (isMac) return null;
  const m = /^Ctrl\+([A-Z])$/.exec(chord);
  if (!m) return null;
  const what = SHELL_KEYS[m[1]] ?? "is used by the shell and many terminal programs";
  return `In terminals Ctrl+${m[1]} ${what} — your shortcut will replace that.`;
}

const MAC_SYMBOLS: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };

/** Pieces for display, e.g. ["Ctrl", "Shift", "V"] or ["⌘", "V"]. */
export function chordParts(chord: string): string[] {
  return chord.split("+").map((p) => (isMac ? MAC_SYMBOLS[p] ?? p : p === "Meta" ? "Win" : p));
}

export function formatChord(chord: string): string {
  return chordParts(chord).join(isMac ? "" : "+");
}
