import type { SnippetVar } from "../../ipc/bindings/SnippetVar";

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

/** Variable names in order of first appearance. */
export function parseVarNames(command: string): string[] {
  const seen = new Set<string>();
  for (const m of command.matchAll(VAR_RE)) seen.add(m[1]);
  return [...seen];
}

/** Keep settings for names still in the command, add new names (ask, no default). */
export function syncVars(command: string, existing: SnippetVar[]): SnippetVar[] {
  return parseVarNames(command).map((name) => existing.find((v) => v.name === name) ?? { name, default: null, ask: true });
}

export function fillCommand(command: string, values: Record<string, string>): string {
  return command.replace(VAR_RE, (whole, name: string) => (name in values ? values[name] : whole));
}
