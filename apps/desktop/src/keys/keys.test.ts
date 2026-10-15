import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../ipc/clipboard", () => ({ copyText: vi.fn(), readClipboard: vi.fn() }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));

import { eventToChord, isValidChord, normalizeChord } from "./chord";
import { resolveBindings, findChordUsers } from "../stores/keys";
import { fillCommand, parseVarNames, syncVars } from "../features/snippets/vars";
import { fuzzyScore } from "../features/palette/CommandPalette";
import { appliesTo, emptySnippet } from "../stores/snippets";
import { emptyGroup, emptyHost } from "../stores/hosts";
import { ACTIONS } from "./actions";
import { PRESETS } from "./presets";

const ev = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) =>
  ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }) as KeyboardEvent;

describe("chords", () => {
  it("reads physical keys, not shifted characters", () => {
    expect(eventToChord(ev("KeyV", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+V");
    expect(eventToChord(ev("Equal", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+=");
    expect(eventToChord(ev("Digit1", { metaKey: true }))).toBe("Meta+1");
    expect(eventToChord(ev("Insert", { shiftKey: true }))).toBe("Shift+Insert");
    expect(eventToChord(ev("ShiftLeft", { shiftKey: true }))).toBeNull();
  });

  it("normalizes modifier order and Mod", () => {
    expect(normalizeChord("Shift+Ctrl+v")).toBe("Ctrl+Shift+V");
    expect(["Ctrl+K", "Meta+K"]).toContain(normalizeChord("Mod+K"));
  });

  it("requires a real modifier", () => {
    expect(isValidChord("Ctrl+Shift+C")).toBe(true);
    expect(isValidChord("Shift+A")).toBe(false);
    expect(isValidChord("A")).toBe(false);
    expect(isValidChord("F5")).toBe(true);
    expect(isValidChord("Shift+Insert")).toBe(true);
  });

  it("finds conflicts between actions and snippet hotkeys", () => {
    const b = resolveBindings({ "term.clear": ["Ctrl+Shift+S"] });
    const users = findChordUsers("Ctrl+Shift+S", b, [{ id: "s1", name: "Serve", hotkey: "Shift+Ctrl+S" }]);
    expect(users.map((u) => u.kind)).toEqual(["action", "snippet"]);
  });
});

describe("snippet variables", () => {
  it("parses, syncs and fills ${vars}", () => {
    const cmd = "cd ${dir} && php artisan serve --port=${port} # ${port}";
    expect(parseVarNames(cmd)).toEqual(["dir", "port"]);
    const vars = syncVars(cmd, [{ name: "port", default: "8000", ask: true }, { name: "gone", default: "x", ask: true }]);
    expect(vars).toEqual([
      { name: "dir", default: null, ask: true },
      { name: "port", default: "8000", ask: true },
    ]);
    expect(fillCommand(cmd, { dir: "/var/www", port: "9000" })).toBe("cd /var/www && php artisan serve --port=9000 # 9000");
    expect(fillCommand("echo ${missing}", {})).toBe("echo ${missing}");
  });
});

describe("palette search", () => {
  it("prefers prefix, then substring, then subsequence", () => {
    expect(fuzzyScore("pas", "paserve")).toBeGreaterThan(fuzzyScore("pas", "php artisan serve"));
    expect(fuzzyScore("serve", "php artisan serve")).toBeGreaterThan(0);
    expect(fuzzyScore("pzx", "paserve")).toBe(0);
  });
});

describe("snippet scope", () => {
  it("matches tags case-insensitively and groups through parents", () => {
    const parent = { ...emptyGroup(), id: "g1", name: "Clients" };
    const child = { ...emptyGroup(), id: "g2", name: "Acme", parent_id: "g1" };
    const host = { ...emptyHost("g2"), id: "h1", tags: ["Laravel"] };
    const s = emptySnippet();
    expect(appliesTo({ ...s, scope: "all" }, undefined, [])).toBe(true);
    expect(appliesTo({ ...s, scope: "tag", scope_value: "laravel" }, host, [])).toBe(true);
    expect(appliesTo({ ...s, scope: "tag", scope_value: "docker" }, host, [])).toBe(false);
    expect(appliesTo({ ...s, scope: "group", scope_value: "g1" }, host, [parent, child])).toBe(true);
    expect(appliesTo({ ...s, scope: "host", scope_value: "h2" }, host, [])).toBe(false);
  });
});

describe("presets and defaults", () => {
  const ids = new Set(ACTIONS.map((a) => a.id));
  it("only name real functions with valid chords", () => {
    for (const p of PRESETS)
      for (const [id, chords] of Object.entries(p.overrides)) {
        expect(ids.has(id as never), `${p.id}: ${id}`).toBe(true);
        for (const c of chords ?? []) expect(isValidChord(normalizeChord(c)), `${p.id}: ${c}`).toBe(true);
      }
  });
  it("no two default functions share a chord", () => {
    const seen = new Map<string, string>();
    for (const [id, chords] of Object.entries(resolveBindings({})))
      for (const c of chords) {
        expect(seen.get(c), `${c}: ${seen.get(c)} and ${id}`).toBeUndefined();
        seen.set(c, id);
      }
  });
});
