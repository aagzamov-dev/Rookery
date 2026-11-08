import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { buildRequest, highlight, splitList } from "./SearchView";

const prefs = { mode: "content" as const, regex: false, caseSensitive: false, wholeWord: true, include: "*.php, *.env", exclude: "", excludeDirs: "node_modules .git", hidden: false, followLinks: false, folders: false, maxDepth: "", maxResults: 1000 };

it("builds a request with every filter", () => {
  const r = buildRequest("h", " /srv/app ", " needle ", prefs);
  if (typeof r === "string") throw new Error(r);
  expect(r).toMatchObject({ host_id: "h", slot: "search", folder: "/srv/app", query: "needle", whole_word: true, include: ["*.php", "*.env"], exclude_dirs: ["node_modules", ".git"], max_depth: null, folders: false });
  // Names: word/regex do not apply.
  const n = buildRequest("h", "/", "conf", { ...prefs, mode: "names", regex: true, folders: true });
  if (typeof n === "string") throw new Error(n);
  expect([n.regex, n.whole_word, n.folders]).toEqual([false, false, true]);
});

it("explains why it cannot search yet", () => {
  expect(buildRequest("h", "/srv", "a", prefs)).toMatch(/2 characters/);
  expect(buildRequest("h", "", "abc", prefs)).toMatch(/folder/);
  expect(buildRequest("h", "/", "a(", { ...prefs, regex: true })).toMatch(/not valid/);
  expect(buildRequest("h", "/", "abc", { ...prefs, maxDepth: "0" })).toMatch(/Depth/);
});

it("splits lists and highlights matches", () => {
  expect(splitList(" a, b  c,,")).toEqual(["a", "b", "c"]);
  const parts = highlight("Foo foo.bar", { query: "foo", regex: false, case_sensitive: false, whole_word: false });
  expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["Foo", "foo"]);
  expect(highlight("a.b", { query: ".", regex: false, case_sensitive: true, whole_word: false }).filter((p) => p.hit)).toHaveLength(1);
  expect(highlight("x", { query: "(", regex: true, case_sensitive: true, whole_word: false })).toEqual([{ text: "x", hit: false }]);
});
