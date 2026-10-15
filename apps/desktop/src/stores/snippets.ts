import { create } from "zustand";
import { api } from "../ipc/api";
import type { Group } from "../ipc/bindings/Group";
import type { Host } from "../ipc/bindings/Host";
import type { Snippet } from "../ipc/bindings/Snippet";

interface SnippetsState {
  list: Snippet[];
  loaded: boolean;
  load: () => Promise<void>;
  save: (s: Snippet) => Promise<Snippet>;
  remove: (id: string) => Promise<void>;
}

export const useSnippets = create<SnippetsState>((set, get) => ({
  list: [],
  loaded: false,
  load: async () => set({ list: await api.snippetsList(), loaded: true }),
  save: async (s) => {
    const saved = await api.snippetSave(s);
    const list = get().list.filter((x) => x.id !== saved.id);
    set({ list: [...list, saved].sort(bySort) });
    return saved;
  },
  remove: async (id) => {
    await api.snippetDelete(id);
    set({ list: get().list.filter((x) => x.id !== id) });
  },
}));

const bySort = (a: Snippet, b: Snippet) =>
  (a.pack ?? "").localeCompare(b.pack ?? "") || a.sort - b.sort || a.name.localeCompare(b.name);

/** Does this snippet show on this host? Group scope includes child groups. */
export function appliesTo(s: Snippet, host: Host | undefined, groups: Group[]): boolean {
  if (s.scope === "all") return true;
  if (!host) return false;
  switch (s.scope) {
    case "host":
      return s.scope_value === host.id;
    case "tag":
      return !!s.scope_value && host.tags.some((t) => t.toLowerCase() === s.scope_value!.toLowerCase());
    case "group": {
      let gid = host.group_id;
      for (let i = 0; gid && i < 32; i++) {
        if (gid === s.scope_value) return true;
        gid = groups.find((g) => g.id === gid)?.parent_id ?? null;
      }
      return false;
    }
  }
  return false;
}

export function emptySnippet(): Snippet {
  return {
    id: "",
    name: "",
    alias: null,
    command: "",
    vars: [],
    scope: "all",
    scope_value: null,
    run_mode: "run",
    hotkey: null,
    ask_prod: true,
    pack: null,
    steps: [],
    continue_on_error: false,
    sort: 0,
    created_at: 0,
    updated_at: 0,
  };
}

/** Container-scoped snippets: pattern with `*` against the container name or compose service. */
export function appliesToContainer(s: Snippet, c: { name: string; service: string | null }): boolean {
  if (s.scope !== "container") return false;
  const pat = (s.scope_value ?? "*").trim() || "*";
  const re = new RegExp(`^${pat.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(c.name) || (!!c.service && re.test(c.service));
}

export const isWorkflow = (s: Snippet) => s.steps.length > 0;

/**
 * One shell line for a workflow: a header per step, then the step; stops at the first
 * failure unless `continue_on_error`.
 */
export function workflowCommand(s: Snippet): string {
  const n = s.steps.length;
  const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
  const parts = s.steps.map((step, i) => `printf '\\033[1;34m▶ [${i + 1}/${n}] %s\\033[0m\\n' ${q(step)} && { ${step}; }`);
  const join = s.continue_on_error ? " ; " : " && ";
  return `${parts.join(join)} && printf '\\033[1;32m✔ %s finished\\033[0m\\n' ${q(s.name)} || printf '\\033[1;31m✖ %s stopped\\033[0m\\n' ${q(s.name)}`;
}
