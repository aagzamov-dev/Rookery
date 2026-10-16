// `.env` files (docs/08 §3): problems while typing, a careful tidy-up, and where the values are
// (for "Hide values"). Pure functions, no CodeMirror.

export interface EnvProblem {
  /** 0-based line. */
  line: number;
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
}

const KEY_OK = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

interface Parsed {
  line: number;
  exported: boolean;
  key: string;
  /** Offsets inside the line. */
  keyFrom: number;
  keyTo: number;
  eq: number;
  /** The raw value text after `=` (may span lines when quoted). */
  value: string;
  /** Lines the value takes (1 unless a quoted value continues). */
  span: number;
  unclosed: boolean;
}

/** One entry per KEY=value; comments and blank lines are skipped. */
function parse(lines: string[]): { entries: Parsed[]; bad: { line: number; text: string }[] } {
  const entries: Parsed[] = [];
  const bad: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = raw.indexOf("=");
    if (eq < 0) {
      bad.push({ line: i, text: raw });
      continue;
    }
    const left = raw.slice(0, eq);
    let exported = false;
    const m = /^(\s*)export\s+/.exec(left);
    let keyFrom = left.length - left.trimStart().length;
    if (m) {
      exported = true;
      keyFrom = m[0].length;
    }
    const key = left.slice(keyFrom).trim();
    const keyTo = keyFrom + left.slice(keyFrom).trimEnd().length;
    let value = raw.slice(eq + 1);
    let span = 1;
    let unclosed = false;
    const v = value.trimStart();
    const q = v[0];
    if (q === '"' || q === "'" || q === "`") {
      // A quoted value may continue on the next lines (dotenv allows multi-line values).
      let body = v.slice(1);
      while (!closes(body, q)) {
        if (i + span >= lines.length) {
          unclosed = true;
          break;
        }
        body += "\n" + lines[i + span];
        value += "\n" + lines[i + span];
        span++;
      }
    }
    entries.push({ line: i, exported, key, keyFrom, keyTo, eq, value, span, unclosed });
    i += span - 1;
  }
  return { entries, bad };
}

/** Does a quoted value (text after the opening quote) close on this text? */
function closes(body: string, q: string): boolean {
  for (let j = 0; j < body.length; j++) {
    if (body[j] === "\\" && q === '"') {
      j++;
      continue;
    }
    if (body[j] === q) return true;
  }
  return false;
}

export function lintEnv(text: string): EnvProblem[] {
  const lines = text.split("\n");
  const { entries, bad } = parse(lines);
  const out: EnvProblem[] = [];
  for (const b of bad) {
    out.push({ line: b.line, from: 0, to: b.text.length, severity: "error", message: "Not a KEY=value line (comments start with #)." });
  }
  const seen = new Map<string, number>();
  for (const e of entries) {
    const raw = lines[e.line];
    if (!e.key) {
      out.push({ line: e.line, from: 0, to: e.eq + 1, severity: "error", message: "Missing name before =." });
      continue;
    }
    if (!KEY_OK.test(e.key)) {
      out.push({ line: e.line, from: e.keyFrom, to: e.keyTo, severity: "error", message: `"${e.key}" is not a valid name (letters, digits and _; not starting with a digit).` });
    }
    if (e.keyTo < e.eq || (/^\s/.test(raw.slice(e.eq + 1)) && raw.slice(e.eq + 1).trim() !== "")) {
      out.push({ line: e.line, from: e.keyFrom, to: Math.min(raw.length, e.eq + 2), severity: "warning", message: "Spaces around = : some tools keep them as part of the name or value." });
    }
    const v = e.value.trim();
    if (e.unclosed) {
      out.push({ line: e.line, from: e.eq + 1, to: raw.length, severity: "error", message: "The quote is never closed: everything after it becomes the value." });
    } else if (v && !/^["'`]/.test(v)) {
      const noComment = v.replace(/\s+#.*$/, "");
      if (/\s/.test(noComment)) {
        out.push({ line: e.line, from: e.eq + 1, to: raw.length, severity: "warning", message: "Value with spaces but no quotes: put it in quotes to be safe." });
      }
    }
    const prev = seen.get(e.key);
    if (prev !== undefined) {
      out.push({ line: e.line, from: e.keyFrom, to: e.keyTo, severity: "warning", message: `${e.key} is already set on line ${prev + 1}.` });
    } else {
      seen.set(e.key, e.line);
    }
  }
  return out.sort((a, b) => a.line - b.line || a.from - b.from);
}

/**
 * Tidy up: no spaces around the name and `=`, no trailing spaces, at most one blank line in a row.
 * Comments, order, quotes and values stay as they are (it never changes what a value means).
 */
export function formatEnv(text: string): string {
  const lines = text.split("\n");
  const { entries } = parse(lines);
  const byLine = new Map(entries.map((e) => [e.line, e]));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const e = byLine.get(i);
    if (e && e.key) {
      const value = e.value.replace(/^[ \t]+/, "");
      const first = `${e.exported ? "export " : ""}${e.key}=${value}`;
      // Only the last line of a multi-line value can lose trailing spaces safely (outside the quotes).
      const parts = first.split("\n");
      parts[parts.length - 1] = parts[parts.length - 1].trimEnd();
      if (parts.length === 1 && !/^["'`]/.test(value)) parts[0] = parts[0].trimEnd();
      out.push(...parts);
      i += e.span - 1;
      continue;
    }
    const t = lines[i].trimEnd();
    const isLast = i === lines.length - 1;
    if (t === "" && !isLast && out.length > 0 && out[out.length - 1] === "") continue;
    out.push(t);
  }
  return out.join("\n");
}

/** Absolute [from, to) ranges of the values, for "Hide values". */
export function envValueRanges(text: string): { from: number; to: number }[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const { entries } = parse(lines);
  const out: { from: number; to: number }[] = [];
  for (const e of entries) {
    const from = starts[e.line] + e.eq + 1;
    let len = e.value.length;
    // An unquoted value ends before an inline comment.
    if (!/^\s*["'`]/.test(e.value)) {
      const c = /\s+#/.exec(e.value);
      if (c) len = c.index;
    }
    if (len > 0) out.push({ from, to: from + len });
  }
  return out;
}
