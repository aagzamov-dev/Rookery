import { expect, it } from "vitest";
import type { GitFile } from "../../ipc/bindings/GitFile";
import { buildChangeTree, changeView, type ChangeNode } from "./tree";

const file = (path: string, index = ".", worktree = "M"): GitFile => ({ path, original_path: null, index, worktree, conflicted: false });
const leaves = (nodes: ChangeNode[]): GitFile[] => nodes.flatMap((node) => node.kind === "file" ? [node.file] : leaves(node.children));

it("builds sorted collapsible folders with basenames while retaining full action paths", () => {
  const files = [file("README.md"), file("src/z.ts"), file("src/components/button.tsx"), file("src/a.ts"), file(".env")];
  const tree = buildChangeTree(files);
  expect(tree.map((node) => node.name)).toEqual(["src", ".env", "README.md"]);
  const src = tree[0];
  expect(src.kind).toBe("folder");
  if (src.kind !== "folder") throw new Error("expected folder");
  expect(src.children.map((node) => node.name)).toEqual(["components", "a.ts", "z.ts"]);
  expect(leaves(tree).map((item) => item.path).sort()).toEqual(files.map((item) => item.path).sort());
});

it("keeps independent staged/unstaged records and rename/conflict metadata", () => {
  const changed = { ...file("src/app.ts", "M", "M"), original_path: "old.ts" };
  const conflict = { ...file("src/conflict.ts", "U", "U"), conflicted: true };
  const stagedTree = buildChangeTree([changed]);
  const worktree = buildChangeTree([changed, conflict]);
  expect(leaves(stagedTree)[0]).toBe(changed);
  expect(leaves(worktree)[0]).toBe(changed);
  expect(leaves(stagedTree)[0].original_path).toBe("old.ts");
  expect(leaves(worktree)[1].conflicted).toBe(true);
  expect(leaves(worktree)[0].path).toBe("src/app.ts");
});

it("defaults to the folder tree and restores an explicit flat-list preference", () => {
  expect(changeView(null)).toBe("tree");
  expect(changeView("unknown")).toBe("tree");
  expect(changeView("tree")).toBe("tree");
  expect(changeView("list")).toBe("list");
  expect(buildChangeTree([])).toEqual([]);
});

it("retains a deleted file beside a replacement directory of the same name", () => {
  const deleted = file("src", ".", "D");
  const replacement = file("src/new.ts", "?", "?");
  const tree = buildChangeTree([deleted, replacement]);
  expect(tree.map((node) => [node.kind, node.path])).toEqual([["folder", "src"], ["file", "src"]]);
  expect(leaves(tree)).toEqual([replacement, deleted]);
});
