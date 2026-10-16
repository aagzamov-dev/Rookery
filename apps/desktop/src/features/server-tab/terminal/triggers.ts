// Terminal triggers (docs/03 §3.10): lines that match get a coloured band behind the text and
// a mark in the scrollbar. Decorations only — the output stream is never rewritten, so TUI
// apps (vim, htop) are untouched, and the alternate screen is not scanned at all.
import type { Terminal } from "@xterm/xterm";
import type { Trigger, TriggerColor } from "../../../stores/keys";

export const TRIGGER_COLORS: Record<TriggerColor, string> = {
  red: "#FF7A7A",
  yellow: "#F2BA45",
  green: "#57C994",
  blue: "#8AB4FF",
  purple: "#C3A6FF",
};

export interface CompiledTrigger {
  t: Trigger;
  re: RegExp;
}

let cache: { src: Trigger[]; out: CompiledTrigger[] } | null = null;

/** Valid, enabled triggers as RegExps (cached per prefs object). */
export function compileTriggers(list: Trigger[]): CompiledTrigger[] {
  if (cache?.src === list) return cache.out;
  const out: CompiledTrigger[] = [];
  for (const t of list) {
    if (!t.enabled || !t.pattern.trim()) continue;
    try {
      out.push({ t, re: new RegExp(t.pattern, t.caseSensitive ? "" : "i") });
    } catch {
      /* invalid pattern: shown as an error in Settings */
    }
  }
  cache = { src: list, out };
  return out;
}

export function triggerError(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "invalid pattern";
  }
}

/** First trigger matching a line, if any. */
export function matchLine(line: string, triggers: CompiledTrigger[]): CompiledTrigger | null {
  for (const c of triggers) if (c.re.test(line)) return c;
  return null;
}

/**
 * Scan completed lines since `from` (absolute buffer row) and decorate matches.
 * Returns the next row to scan. `onMatch` runs once per matching line (notifications).
 */
export function scanTerminal(term: Terminal, from: number, triggers: CompiledTrigger[], onMatch?: (c: CompiledTrigger, line: string) => void): number {
  const buf = term.buffer.active;
  if (buf.type === "alternate") return from;
  const cursorRow = buf.baseY + buf.cursorY; // still being written: scan it next time
  let row = Math.min(from, cursorRow);
  const stop = Math.min(cursorRow, row + 300);
  for (; row < stop; row++) {
    const line = buf.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (!text) continue;
    const hit = matchLine(text, triggers);
    if (!hit) continue;
    const marker = term.registerMarker(row - cursorRow);
    if (!marker) continue;
    const color = TRIGGER_COLORS[hit.t.color];
    term.registerDecoration({
      marker,
      width: term.cols,
      layer: "bottom",
      // xterm paints this itself and accepts only #RRGGBB: a faint tint of the theme background
      backgroundColor: blend(term.options.theme?.background ?? "#171D29", color, 0.2),
      overviewRulerOptions: { color, position: "right" },
    });
    onMatch?.(hit, text);
  }
  return row;
}

/** Mix two #RRGGBB colours: `amount` of `over` on top of `base`. */
export function blend(base: string, over: string, amount: number): string {
  const rgb = (h: string) => {
    const m = /^#?([0-9a-f]{6})/i.exec(h);
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [a, b] = [rgb(base), rgb(over)];
  return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, "0")).join("");
}
