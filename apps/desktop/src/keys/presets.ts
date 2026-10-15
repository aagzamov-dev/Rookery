// Keymap presets: one click to make Rookery feel like the terminal you're used to.
import type { Overrides, TerminalPrefs } from "../stores/keys";
import { DEFAULT_TERMINAL_PREFS } from "../stores/keys";
import { isMac } from "./chord";

export interface Preset {
  id: string;
  name: string;
  description: string;
  /** Only offered on this platform. */
  only?: "mac" | "win";
  overrides: Overrides;
  terminal: Partial<TerminalPrefs>;
}

const clipboardDefaults: Partial<TerminalPrefs> = {
  ctrlCCopies: DEFAULT_TERMINAL_PREFS.ctrlCCopies,
  ctrlVPastes: DEFAULT_TERMINAL_PREFS.ctrlVPastes,
  rightClickPastes: DEFAULT_TERMINAL_PREFS.rightClickPastes,
  copyOnSelect: DEFAULT_TERMINAL_PREFS.copyOnSelect,
};

const gotoCtrlAlt = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tab.goto${i + 1}`, [`Ctrl+Alt+${i + 1}`]]));

export const PRESETS: Preset[] = [
  {
    id: "rookery",
    name: "Rookery default",
    description: "Ctrl+Shift+C / V, Ctrl+C copies a selection, Ctrl+V pastes, right-click pastes.",
    overrides: {},
    terminal: clipboardDefaults,
  },
  {
    id: "moba",
    name: "MobaXterm / PuTTY-like",
    description: "Select text to copy, right-click to paste, Shift+Insert / Ctrl+Insert. Ctrl+C and Ctrl+V go to the shell.",
    overrides: {
      "term.copy": ["Ctrl+Insert", "Ctrl+Shift+C"],
      "term.paste": ["Shift+Insert", "Ctrl+Shift+V"],
    },
    terminal: { copyOnSelect: true, rightClickPastes: true, ctrlCCopies: false, ctrlVPastes: false },
  },
  {
    id: "winterm",
    name: "Windows Terminal-like",
    description: "Ctrl+Shift+T new terminal, Ctrl+Shift+W close, Ctrl+Shift+F find, Ctrl+Shift+P palette, Ctrl+Alt+1…9 tabs.",
    only: "win",
    overrides: {
      "palette.open": ["Ctrl+Shift+P"],
      "term.new": ["Ctrl+Shift+T"],
      "tab.close": ["Ctrl+Shift+W"],
      "term.find": ["Ctrl+Shift+F"],
      "term.copy": ["Ctrl+Shift+C"],
      "term.paste": ["Ctrl+Shift+V"],
      ...gotoCtrlAlt,
    },
    terminal: { ctrlCCopies: true, ctrlVPastes: true, rightClickPastes: false, copyOnSelect: false },
  },
  {
    id: "iterm",
    name: "iTerm2-like",
    description: "⌘T new terminal, ⌘W close, ⌘⇧[ / ] tabs, ⌘F find, ⌘K clear, ⌘⇧P palette, ⌘1…9 tabs.",
    only: "mac",
    overrides: {
      "term.new": ["Meta+T"],
      "tab.close": ["Meta+W"],
      "tab.next": ["Meta+Shift+]", "Ctrl+Tab"],
      "tab.prev": ["Meta+Shift+[", "Ctrl+Shift+Tab"],
      "term.find": ["Meta+F"],
      "term.clear": ["Meta+K"],
      "palette.open": ["Meta+Shift+P"],
      "term.selectAll": ["Meta+A"],
    },
    terminal: { copyOnSelect: false, rightClickPastes: false },
  },
];

export const presetsForPlatform = () => PRESETS.filter((p) => !p.only || (p.only === "mac") === isMac);
