// Format (Shift+Alt+F): Prettier for the languages it knows (loaded on first use only), Rookery's
// own tidy-up for .env. Only the editor text changes; nothing is saved until you save.
import { formatEnv } from "./env";
import { PRETTIER_PARSER, type LangId } from "./lang";

/** The file's own indentation: tabs, or the most common step of leading spaces. */
export function detectIndent(text: string): { useTabs: boolean; width: number } {
  let tabs = 0;
  const steps = new Map<number, number>();
  let prev = 0;
  for (const line of text.split("\n").slice(0, 2000)) {
    if (!line.trim()) continue;
    if (line.startsWith("\t")) {
      tabs++;
      continue;
    }
    const n = line.length - line.trimStart().length;
    const d = Math.abs(n - prev);
    if (d === 2 || d === 4 || d === 8) steps.set(d, (steps.get(d) ?? 0) + 1);
    prev = n;
  }
  let width = 2;
  let best = 0;
  for (const [w, c] of steps) if (c > best) [width, best] = [w, c];
  return { useTabs: tabs > best, width };
}

async function plugins(parser: string) {
  switch (parser) {
    case "babel":
    case "json":
      return [await import("prettier/plugins/babel"), await import("prettier/plugins/estree")];
    case "typescript":
      return [await import("prettier/plugins/typescript"), await import("prettier/plugins/estree")];
    case "css":
    case "scss":
    case "less":
      return [await import("prettier/plugins/postcss")];
    case "html":
      return [await import("prettier/plugins/html"), await import("prettier/plugins/babel"), await import("prettier/plugins/estree"), await import("prettier/plugins/postcss")];
    case "markdown":
      return [await import("prettier/plugins/markdown")];
    case "yaml":
      return [await import("prettier/plugins/yaml")];
    default:
      return [];
  }
}

/** The formatted text, or throws with the formatter's message (e.g. a syntax error). */
export async function formatText(lang: LangId, text: string): Promise<string> {
  if (lang === "env") return formatEnv(text);
  const parser = PRETTIER_PARSER[lang];
  if (!parser) throw new Error("No formatter for this file type.");
  const { format } = await import("prettier/standalone");
  const { useTabs, width } = detectIndent(text);
  const out = await format(text, { parser, plugins: await plugins(parser), useTabs, tabWidth: width, printWidth: 120, endOfLine: "lf" });
  // Keep the file's final-newline choice.
  return text.endsWith("\n") ? out : out.replace(/\n$/, "");
}
