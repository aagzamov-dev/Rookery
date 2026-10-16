// Three-way merge (docs/08 §5): base = what you opened, mine = the editor, theirs = the server now.
// Changes in different lines combine by themselves; changes to the same lines are conflicts the
// user picks (mine / theirs / both). Line based, like git.
import { diff3Merge } from "node-diff3";

export type Chunk = { kind: "ok"; lines: string[] } | { kind: "conflict"; mine: string[]; base: string[]; theirs: string[] };
export type Pick = "mine" | "theirs" | "both";

export interface Merged {
  chunks: Chunk[];
  conflicts: number;
}

export function threeWay(base: string, mine: string, theirs: string): Merged {
  const a = mine.split("\n");
  const o = base.split("\n");
  const b = theirs.split("\n");
  const chunks: Chunk[] = [];
  let conflicts = 0;
  for (const r of diff3Merge<string>(a, o, b, { excludeFalseConflicts: true })) {
    if (r.ok) {
      const last = chunks[chunks.length - 1];
      if (last?.kind === "ok") last.lines.push(...r.ok);
      else chunks.push({ kind: "ok", lines: [...r.ok] });
    } else if (r.conflict) {
      chunks.push({ kind: "conflict", mine: r.conflict.a, base: r.conflict.o, theirs: r.conflict.b });
      conflicts++;
    }
  }
  return { chunks, conflicts };
}

/**
 * The merged text. `picks[i]` is the choice for the i-th conflict; a conflict without a pick is
 * written with git-style markers (the UI does not save while markers remain).
 */
export function resolve(m: Merged, picks: (Pick | undefined)[]): { text: string; unresolved: number } {
  const out: string[] = [];
  let i = 0;
  let unresolved = 0;
  for (const c of m.chunks) {
    if (c.kind === "ok") {
      out.push(...c.lines);
      continue;
    }
    const p = picks[i++];
    if (p === "mine") out.push(...c.mine);
    else if (p === "theirs") out.push(...c.theirs);
    else if (p === "both") out.push(...c.mine, ...c.theirs);
    else {
      unresolved++;
      out.push("<<<<<<< yours", ...c.mine, "=======", ...c.theirs, ">>>>>>> on the server");
    }
  }
  return { text: out.join("\n"), unresolved };
}

export const hasMarkers = (text: string) => /^<<<<<<< yours$/m.test(text) && /^>>>>>>> on the server$/m.test(text);
