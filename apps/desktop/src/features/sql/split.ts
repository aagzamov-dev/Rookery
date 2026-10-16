// Statement splitter for the SQL editor ("run statement at cursor", risk checks).
// Same rules as the Rust lexer (crates/rookery-core/src/sql/lex.rs), which is the authority
// for what is sent: `;` inside strings, quoted names, comments and $$ quotes never splits.
// Offsets are JS string indices (UTF-16), the same as CodeMirror positions.

export type Dialect = "postgres" | "mysql";

export interface Stmt {
  from: number;
  to: number;
  text: string;
  /** Words outside strings / quoted names / comments, original case. */
  words: string[];
}

export interface SplitResult {
  statements: Stmt[];
  error?: string;
}

const isWordStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isWord = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

export function splitSql(text: string, dialect: Dialect): SplitResult {
  const mysql = dialect === "mysql";
  const out: Stmt[] = [];
  let words: string[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;

  const finish = (s: number, e: number) => {
    if (!words.length) return;
    const raw = text.slice(s, e);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    out.push({ from: s + lead, to: e - trail, text: raw.trim(), words });
    words = [];
  };

  const skipLine = (p: number) => {
    const nl = text.indexOf("\n", p);
    return nl < 0 ? n : nl + 1;
  };
  const skipBlock = (p: number) => {
    let depth = 0;
    while (p < n) {
      if (text[p] === "/" && text[p + 1] === "*" && (!mysql || depth === 0)) {
        depth++;
        p += 2;
      } else if (text[p] === "*" && text[p + 1] === "/") {
        depth--;
        p += 2;
        if (depth === 0) return p;
      } else p++;
    }
    return n;
  };
  const skipQuoted = (p: number, q: string, backslash: boolean) => {
    p++;
    while (p < n) {
      const c = text[p];
      if (c === "\\" && backslash) p += 2;
      else if (c === q) {
        if (text[p + 1] === q) p += 2;
        else return p + 1;
      } else p++;
    }
    return n;
  };

  while (i < n) {
    const c = text[i];
    if (c === ";") {
      finish(start, i);
      start = ++i;
    } else if (c === "-" && text[i + 1] === "-") i = skipLine(i);
    else if (c === "#" && mysql) i = skipLine(i);
    else if (c === "/" && text[i + 1] === "*") i = skipBlock(i);
    else if (c === "'") {
      const eString = !mysql && words.length > 0 && words[words.length - 1].toLowerCase() === "e" && i > 0 && /[eE]/.test(text[i - 1]);
      if (eString) words.pop();
      i = skipQuoted(i, "'", mysql || eString);
    } else if (c === '"') i = skipQuoted(i, '"', mysql);
    else if (c === "`" && mysql) i = skipQuoted(i, "`", false);
    else if (c === "$" && !mysql && (i === 0 || !isWord(text[i - 1]))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const end = text.indexOf(m[0], i + m[0].length);
        i = end < 0 ? n : end + m[0].length;
      } else i++;
    } else if (isWordStart(c)) {
      const s = i;
      while (i < n && isWord(text[i])) i++;
      const w = text.slice(s, i);
      if (mysql && words.length === 0 && w.toLowerCase() === "delimiter") {
        return { statements: out, error: "DELIMITER is a mysql command-line feature and is not supported here; separate statements with ;" };
      }
      words.push(w);
    } else i++;
  }
  finish(start, n);
  return { statements: out };
}

/** The statement under the cursor; in the gap after a `;` it is the one before. */
export function statementAt(stmts: Stmt[], pos: number): Stmt | undefined {
  let best: Stmt | undefined;
  for (const s of stmts) {
    if (pos >= s.from && pos <= s.to) return s;
    if (s.to <= pos) best = s;
  }
  return best ?? stmts[0];
}

/** Rust counts error positions in Unicode chars; convert to a JS string index. */
export function charToIndex(text: string, chars: number): number {
  let idx = 0;
  let count = 0;
  for (const ch of text) {
    if (count === chars) return idx;
    idx += ch.length;
    count++;
  }
  return idx;
}
