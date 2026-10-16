// Language support and problem checks per file type. Every pack is a dynamic import, so only the
// languages of the files you open are loaded.
import type { Extension } from "@codemirror/state";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { lintEnv } from "./env";
import type { LangId } from "./lang";

// legacy-modes types its parsers with @codemirror/streamparser's copy of the same interface.
const legacy = (p: object) => StreamLanguage.define(p as StreamParser<unknown>);

/** `.env`: comments, `export`, names, quoted values and `${VAR}` references. */
const envParser: StreamParser<{ value: boolean; quote: string | null }> = {
  name: "env",
  startState: () => ({ value: false, quote: null }),
  token(stream, st) {
    if (st.quote) {
      while (!stream.eol()) {
        if (stream.match("${")) {
          stream.backUp(2);
          if (stream.pos > stream.start) return "string";
          stream.match(/^\$\{[^}]*\}?/);
          return "variableName.special";
        }
        const ch = stream.next();
        if (ch === "\\" && st.quote === '"') stream.next();
        else if (ch === st.quote) {
          st.quote = null;
          st.value = false;
          return "string";
        }
      }
      return "string";
    }
    if (stream.sol()) st.value = false;
    if (!st.value) {
      if (stream.eatSpace()) return null;
      if (stream.peek() === "#") {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match(/^export(?=\s)/)) return "keyword";
      if (stream.match(/^[^=\s#]+/)) return "propertyName";
      if (stream.eat("=")) {
        st.value = true;
        return "operator";
      }
      stream.next();
      return null;
    }
    if (stream.match(/^\s+#.*/)) return "comment";
    const q = stream.peek();
    if (q === '"' || q === "'" || q === "`") {
      stream.next();
      st.quote = q;
      return "string";
    }
    if (stream.match(/^\$\{[^}]*\}?/) || stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/)) return "variableName.special";
    if (stream.match(/^(true|false|null)\b/i)) return "bool";
    if (stream.match(/^-?\d+(\.\d+)?(?=\s|$)/)) return "number";
    stream.match(/^[^$\s]+/) || stream.next();
    return "string";
  },
  languageData: { commentTokens: { line: "#" } },
};

async function language(id: LangId): Promise<Extension> {
  switch (id) {
    case "env":
      return StreamLanguage.define(envParser);
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "javascript":
    case "jsx":
    case "typescript":
    case "tsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ jsx: id === "jsx" || id === "tsx", typescript: id === "typescript" || id === "tsx" });
    }
    case "php":
      return (await import("@codemirror/lang-php")).php();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
    case "less":
      return (await import("@codemirror/lang-css")).css();
    case "scss":
      return (await import("@codemirror/lang-css")).css(); // close enough for highlighting
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "xml":
      return (await import("@codemirror/lang-xml")).xml();
    case "sql": {
      const { sql, StandardSQL } = await import("@codemirror/lang-sql");
      return sql({ dialect: StandardSQL });
    }
    case "shell":
      return legacy((await import("@codemirror/legacy-modes/mode/shell")).shell);
    case "nginx":
      return legacy((await import("@codemirror/legacy-modes/mode/nginx")).nginx);
    case "dockerfile":
      return legacy((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile);
    case "toml":
      return legacy((await import("@codemirror/legacy-modes/mode/toml")).toml);
    case "ini":
    case "properties":
      return legacy((await import("@codemirror/legacy-modes/mode/properties")).properties);
    default:
      return [];
  }
}

async function yamlProblems(view: EditorView): Promise<Diagnostic[]> {
  const { parseAllDocuments } = await import("yaml");
  const text = view.state.doc.toString();
  const out: Diagnostic[] = [];
  for (const doc of parseAllDocuments(text)) {
    for (const [list, severity] of [
      [doc.errors, "error"],
      [doc.warnings, "warning"],
    ] as const) {
      for (const e of list) {
        const from = Math.min(e.pos[0], text.length);
        out.push({ from, to: Math.min(Math.max(e.pos[1], from + 1), text.length), severity, message: e.message.split("\n")[0] });
      }
    }
  }
  return out;
}

function envProblems(view: EditorView): Diagnostic[] {
  const doc = view.state.doc;
  return lintEnv(doc.toString()).map((p) => {
    const line = doc.line(p.line + 1);
    return { from: line.from + Math.min(p.from, line.length), to: line.from + Math.min(Math.max(p.to, p.from + 1), line.length), severity: p.severity, message: p.message };
  });
}

/** Problems while typing (JSON, YAML, .env); nothing for other types. */
async function problems(id: LangId): Promise<Extension> {
  let source: ((v: EditorView) => Diagnostic[] | Promise<Diagnostic[]>) | null = null;
  if (id === "json") {
    const { jsonParseLinter } = await import("@codemirror/lang-json");
    const check = jsonParseLinter();
    source = (v) => (v.state.doc.length === 0 ? [] : check(v));
  } else if (id === "yaml") source = yamlProblems;
  else if (id === "env") source = envProblems;
  return source ? [linter(source, { delay: 400 }), lintGutter()] : [];
}

/** Language + problem checks for a file type. */
export async function supportFor(id: LangId): Promise<Extension> {
  const [lang, lint] = await Promise.all([language(id), problems(id)]);
  return [lang, lint];
}
