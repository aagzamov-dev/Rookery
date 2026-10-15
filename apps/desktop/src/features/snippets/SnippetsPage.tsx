import { useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Download, Package, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../../ipc/api";
import { askConfirm } from "../../stores/dialogs";
import { asCoreError } from "../../ipc/api";
import type { RunMode } from "../../ipc/bindings/RunMode";
import type { Snippet } from "../../ipc/bindings/Snippet";
import type { SnippetScope } from "../../ipc/bindings/SnippetScope";
import { normalizeChord } from "../../keys/chord";
import { useHosts } from "../../stores/hosts";
import { findChordUsers, useKeys } from "../../stores/keys";
import { emptySnippet, useSnippets } from "../../stores/snippets";
import { useTabs } from "../../stores/tabs";
import { Button, Field, Select, TextInput } from "../../ui/primitives";
import { ChordView, ShortcutRecorder } from "../../ui/ShortcutRecorder";
import { PACKS } from "./packs";
import { runSnippet } from "./run";
import { syncVars } from "./vars";

export function SnippetsPage() {
  const list = useSnippets((s) => s.list);
  const [selId, setSelId] = useState<string | null>(null);
  const [draftNew, setDraftNew] = useState<Snippet | null>(null);
  const [q, setQ] = useState("");
  const [pack, setPack] = useState<string | null>(null);

  const packs = useMemo(() => [...new Set(list.map((s) => s.pack ?? "Mine"))], [list]);
  const f = q.trim().toLowerCase();
  const visible = list.filter(
    (s) =>
      (!pack || (s.pack ?? "Mine") === pack) &&
      (!f || s.name.toLowerCase().includes(f) || (s.alias ?? "").toLowerCase().includes(f) || s.command.toLowerCase().includes(f)),
  );
  const selected = draftNew ?? list.find((s) => s.id === selId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <section aria-label="Snippet library" className="flex w-[300px] flex-none flex-col gap-3 border-r border-line bg-panel px-3.5 py-4">
        <div className="flex items-center justify-between">
          <h1 className="m-0 text-base font-semibold">Snippets</h1>
          <span className="ml-auto flex gap-0.5">
            <button aria-label="Import snippets" title="Import snippets (.json)" onClick={() => void importSnippets()} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text">
              <Upload size={13} />
            </button>
            <button aria-label="Export snippets" title="Export all snippets (.json)" onClick={() => void exportSnippets(list)} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text">
              <Download size={13} />
            </button>
          </span>
          <Button
            variant="primary"
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setDraftNew(emptySnippet());
              setSelId(null);
            }}
          >
            <Plus size={13} /> New
          </Button>
        </div>
        <label className="flex h-8 items-center gap-2 rounded-[7px] border border-line bg-bg px-2.5 text-muted">
          <Search size={13} />
          <input aria-label="Search snippets" placeholder="Search alias or command" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none" />
        </label>
        {packs.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <Chip active={!pack} onClick={() => setPack(null)}>
              All {list.length}
            </Chip>
            {packs.map((p) => (
              <Chip key={p} active={pack === p} onClick={() => setPack(p)}>
                {p} {list.filter((s) => (s.pack ?? "Mine") === p).length}
              </Chip>
            ))}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {visible.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setSelId(s.id);
                setDraftNew(null);
              }}
              className={clsx("flex flex-col gap-0.5 rounded-[7px] px-2.5 py-2 text-left", selected?.id === s.id && !draftNew ? "bg-accent-bg" : "hover:bg-panel2")}
            >
              <span className="flex items-center gap-2">
                <span className={clsx("truncate", s.alias ? "font-mono font-medium text-accent" : "font-medium")}>{s.alias ?? s.name}</span>
                {s.hotkey && (
                  <span className="ml-auto">
                    <ChordView chord={normalizeChord(s.hotkey)} dim />
                  </span>
                )}
              </span>
              <span className="truncate font-mono text-[11px] text-muted">
                {s.steps.length ? `▶ ${s.steps.length} steps: ${s.steps.join(" → ")}` : s.command}
              </span>
            </button>
          ))}
          {list.length > 0 && visible.length === 0 && <p className="px-2 text-xs text-muted">No matches.</p>}
        </div>
        <StarterPacks compact={list.length > 0} />
      </section>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          <SnippetEditor
            key={selected.id || "new"}
            initial={selected}
            onSaved={(s) => {
              setDraftNew(null);
              setSelId(s.id);
            }}
            onDeleted={() => {
              setDraftNew(null);
              setSelId(null);
            }}
          />
        ) : (
          <EmptyEditor hasSnippets={list.length > 0} />
        )}
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={clsx("h-[26px] rounded-full px-2.5 text-xs", active ? "bg-accent-bg text-text" : "border border-line text-muted hover:text-text")}>
      {children}
    </button>
  );
}

function StarterPacks({ compact }: { compact: boolean }) {
  const list = useSnippets((s) => s.list);
  const save = useSnippets((s) => s.save);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const add = async (id: string) => {
    const p = PACKS.find((x) => x.id === id)!;
    setBusy(id);
    let added = 0;
    try {
      for (const s of p.snippets()) {
        if (s.alias && list.some((x) => x.alias === s.alias)) continue; // keep the user's own
        await save(s);
        added++;
      }
      setMsg(added ? `Added ${added} ${p.name} snippets` : `${p.name} snippets are already in your library`);
    } catch (e) {
      setMsg(asCoreError(e).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={clsx("flex flex-col gap-1.5 border-t border-line pt-3", !compact && "flex-1")}>
      <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">
        <Package size={12} /> Starter packs
      </span>
      {PACKS.map((p) => (
        <div key={p.id} className="flex items-center gap-2">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs">{p.name}</span>
            {!compact && <span className="text-[11px] text-muted">{p.description}</span>}
          </span>
          <Button className="h-7 px-2.5 text-xs" disabled={busy === p.id} onClick={() => void add(p.id)}>
            Add
          </Button>
        </div>
      ))}
      {msg && <span className="text-[11px] text-muted">{msg}</span>}
    </div>
  );
}

function EmptyEditor({ hasSnippets }: { hasSnippets: boolean }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-md text-center text-muted">
        <h2 className="m-0 mb-2 text-base font-semibold text-text">{hasSnippets ? "Pick a snippet to edit" : "Save the commands you type often"}</h2>
        <p className="m-0 leading-relaxed">
          Give a command a short alias like <span className="font-mono text-accent">paserve</span>, then type it in a terminal and press <b>Tab</b>, pick it in
          the command palette, click it in the snippet bar, or press its hotkey. Add a starter pack on the left to begin.
        </p>
      </div>
    </div>
  );
}

const SCOPES: { id: SnippetScope; label: string }[] = [
  { id: "all", label: "All servers" },
  { id: "tag", label: "Servers with tag" },
  { id: "group", label: "Group" },
  { id: "host", label: "One server" },
  { id: "container", label: "Inside containers" },
];

const varSource = (d: Snippet) => (d.steps.length ? d.steps.join("\n") : d.command);

function SnippetEditor({ initial, onSaved, onDeleted }: { initial: Snippet; onSaved: (s: Snippet) => void; onDeleted: () => void }) {
  const save = useSnippets((s) => s.save);
  const remove = useSnippets((s) => s.remove);
  const allSnippets = useSnippets((s) => s.list);
  const hosts = useHosts((s) => s.hosts);
  const groups = useHosts((s) => s.groups);
  const bindings = useKeys((s) => s.bindings);
  const tabs = useTabs((s) => s.tabs);
  const openServers = useMemo(() => tabs.flatMap((t) => (t.kind === "server" ? [t.hostId] : [])), [tabs]);
  const [d, setD] = useState<Snippet>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState(false);
  const [testHost, setTestHost] = useState(openServers[0] ?? "");
  const [wf, setWf] = useState(initial.steps.length > 0);

  const toggleWorkflow = () => {
    setSavedMsg(false);
    if (wf) {
      setD((x) => ({ ...x, command: x.steps.filter((s) => s.trim()).join(" && "), steps: [] }));
      setWf(false);
    } else {
      setD((x) => ({ ...x, steps: x.command.trim() ? x.command.split(/\n|&&/).map((s) => s.trim()).filter(Boolean) : [""], command: "" }));
      setWf(true);
    }
  };
  const setSteps = (steps: string[]) => {
    setSavedMsg(false);
    setD((x) => ({ ...x, steps, vars: syncVars(steps.join("\n"), x.vars) }));
  };

  const set = <K extends keyof Snippet>(k: K, v: Snippet[K]) => {
    setSavedMsg(false);
    setD((x) => ({ ...x, [k]: v }));
  };
  const allTags = useMemo(() => [...new Set(hosts.flatMap((h) => h.tags))].sort(), [hosts]);

  const doSave = async () => {
    setErr(null);
    try {
      const saved = await save({ ...d, command: wf ? "" : d.command, steps: wf ? d.steps.filter((s) => s.trim()) : [], vars: syncVars(varSource(d), d.vars) });
      setD(saved);
      setSavedMsg(true);
      onSaved(saved);
    } catch (e) {
      setErr(asCoreError(e).message);
    }
  };

  const conflicts = (chord: string) =>
    findChordUsers(normalizeChord(chord), bindings, allSnippets)
      .filter((u) => !(u.kind === "snippet" && u.id === d.id))
      .map((u) => u.label);

  return (
    <form
      aria-label="Edit snippet"
      className="mx-auto flex max-w-[760px] flex-col gap-5 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        void doSave();
      }}
    >
      <div className="flex items-center gap-2.5">
        <h2 className="m-0 text-xl font-semibold">{d.id ? d.name || "Untitled" : "New snippet"}</h2>
        {d.pack && <span className="rounded-full bg-accent-bg px-2 py-0.5 text-[11px] text-[#BCD3FF]">{d.pack}</span>}
      </div>

      <div className="grid grid-cols-2 gap-3.5">
        <Field label="Name">
          <TextInput autoFocus={!d.id} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Serve Laravel app" />
        </Field>
        <Field label="Alias" hint="Type it in a terminal and press Tab, or search it in Ctrl+K.">
          <TextInput mono value={d.alias ?? ""} onChange={(e) => set("alias", e.target.value.replace(/\s/g, "") || null)} placeholder="paserve" className="text-accent" />
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">{wf ? "Steps — run in order in a new terminal" : "Command"}</span>
        <button type="button" onClick={toggleWorkflow} className="ml-auto text-xs text-accent">
          {wf ? "Make it a single command" : "Make it a workflow (several steps)"}
        </button>
      </div>
      {wf ? (
        <div className="flex flex-col gap-2">
          {d.steps.map((step, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-6 text-right font-mono text-xs text-muted">{i + 1}</span>
              <TextInput
                mono
                className="min-w-0 flex-1"
                value={step}
                placeholder={i === 0 ? "git pull --ff-only" : "next command"}
                onChange={(e) => setSteps(d.steps.map((s, j) => (j === i ? e.target.value : s)))}
              />
              <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => setSteps(d.steps.map((s, j) => (j === i - 1 ? d.steps[i] : j === i ? d.steps[i - 1] : s)))} className="grid h-8 w-7 place-items-center text-muted hover:text-text">
                <ArrowUp size={13} />
              </button>
              <button type="button" aria-label="Move down" disabled={i === d.steps.length - 1} onClick={() => setSteps(d.steps.map((s, j) => (j === i + 1 ? d.steps[i] : j === i ? d.steps[i + 1] : s)))} className="grid h-8 w-7 place-items-center text-muted hover:text-text">
                <ArrowDown size={13} />
              </button>
              <button type="button" aria-label="Remove step" onClick={() => setSteps(d.steps.filter((_, j) => j !== i))} className="grid h-8 w-7 place-items-center text-muted hover:text-[#FFA8A8]">
                <X size={13} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <Button type="button" className="h-8" onClick={() => setSteps([...d.steps, ""])}>
              <Plus size={13} /> Add step
            </Button>
            <label className="flex items-center gap-2 text-xs text-muted">
              If a step fails
              <Select className="h-8" value={d.continue_on_error ? "continue" : "stop"} onChange={(e) => set("continue_on_error", e.target.value === "continue")}>
                <option value="stop">stop the workflow</option>
                <option value="continue">continue with the next step</option>
              </Select>
            </label>
          </div>
        </div>
      ) : (
      <Field label="" hint="Use ${name} for values you want to fill in, e.g. --port=${port}">
        <textarea
          rows={3}
          value={d.command}
          onChange={(e) => {
            const command = e.target.value;
            setSavedMsg(false);
            setD((x) => ({ ...x, command, vars: syncVars(command, x.vars) }));
          }}
          spellCheck={false}
          className="resize-y rounded-lg border border-line bg-term p-3 font-mono text-[13px] leading-relaxed text-[#D3D9E4] outline-none focus:border-accent-line"
          placeholder="php artisan serve --port=${port}"
        />
      </Field>
      )}

      {d.vars.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted">Variables</span>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2.5">
            {d.vars.map((v, i) => (
              <div key={v.name} className="flex items-center gap-2.5 rounded-lg border border-line bg-panel px-3 py-2">
                <span className="font-mono text-accent">{v.name}</span>
                <TextInput
                  mono
                  aria-label={`Default for ${v.name}`}
                  className="h-7 min-w-0 flex-1"
                  placeholder="default"
                  value={v.default ?? ""}
                  onChange={(e) => set("vars", d.vars.map((x, j) => (j === i ? { ...x, default: e.target.value || null } : x)))}
                />
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input type="checkbox" checked={v.ask} onChange={(e) => set("vars", d.vars.map((x, j) => (j === i ? { ...x, ask: e.target.checked } : x)))} className="accent-accent" />
                  Ask
                </label>
              </div>
            ))}
          </div>
        </div>
      )}

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 text-xs text-muted">Where it shows</legend>
        <div className="flex flex-wrap items-center gap-2">
          {SCOPES.map((s) => (
            <label key={s.id} className={clsx("flex h-9 items-center gap-2 rounded-lg border px-3", d.scope === s.id ? "border-accent-line bg-accent-bg" : "border-line bg-panel")}>
              <input type="radio" name="scope" checked={d.scope === s.id} onChange={() => setD((x) => ({ ...x, scope: s.id, scope_value: null }))} className="accent-accent" />
              {s.label}
            </label>
          ))}
          {d.scope === "tag" && (
            <>
              <TextInput list="snippet-tags" className="h-9 w-40" placeholder="laravel" value={d.scope_value ?? ""} onChange={(e) => set("scope_value", e.target.value.trim() || null)} />
              <datalist id="snippet-tags">
                {allTags.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </>
          )}
          {d.scope === "group" && (
            <Select value={d.scope_value ?? ""} onChange={(e) => set("scope_value", e.target.value || null)}>
              <option value="">Choose group…</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
          {d.scope === "container" && (
            <TextInput className="h-9 w-56" placeholder="name or service, * = any" value={d.scope_value ?? ""} onChange={(e) => set("scope_value", e.target.value.trim() || null)} />
          )}
          {d.scope === "host" && (
            <Select value={d.scope_value ?? ""} onChange={(e) => set("scope_value", e.target.value || null)}>
              <option value="">Choose server…</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-3.5">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">Hotkey</span>
          <ShortcutRecorder value={d.hotkey ? normalizeChord(d.hotkey) : null} onChange={(c) => set("hotkey", c)} conflicts={conflicts} />
        </div>
        <Field label="When run">
          <Select value={d.run_mode} onChange={(e) => set("run_mode", e.target.value as RunMode)}>
            <option value="run">Type and press Enter</option>
            <option value="paste">Type only — I press Enter</option>
            <option value="new_terminal">Run in a new terminal</option>
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3.5">
        <label className="flex items-center gap-2.5 rounded-lg border border-[#5A2D33] bg-[#33232A] px-3 py-2.5">
          <input type="checkbox" checked={d.ask_prod} onChange={(e) => set("ask_prod", e.target.checked)} className="accent-bad" />
          <span>
            Ask before running on <b className="text-prod-fg">PROD</b> servers
          </span>
        </label>
        <Field label="Pack">
          <TextInput value={d.pack ?? ""} onChange={(e) => set("pack", e.target.value || null)} placeholder="Mine" />
        </Field>
      </div>

      {err && <div className="rounded-lg border border-[#5A2D33] bg-[#33232A] px-3 py-2 text-prod-fg">{err}</div>}

      <div className="flex flex-wrap items-center gap-2.5">
        <Button type="submit" variant="primary" className="h-9 px-4">
          Save snippet
        </Button>
        {savedMsg && <span className="text-xs text-ok">Saved</span>}
        {openServers.length > 0 && (
          <span className="ml-2 flex items-center gap-2">
            <Select className="h-9" value={testHost} onChange={(e) => setTestHost(e.target.value)} aria-label="Server to test on">
              {openServers.map((id) => (
                <option key={id} value={id}>
                  {hosts.find((h) => h.id === id)?.name ?? id}
                </option>
              ))}
            </Select>
            <Button type="button" className="h-9" disabled={(!d.command.trim() && !d.steps.some((s) => s.trim())) || !testHost || d.scope === "container"} onClick={() => void runSnippet({ ...d, steps: d.steps.filter((s) => s.trim()), vars: syncVars(varSource(d), d.vars) }, testHost)}>
              Run on server
            </Button>
          </span>
        )}
        {d.id && (
          <Button
            type="button"
            variant="ghost"
            className="ml-auto h-9 text-[#FFA8A8]"
            onClick={async () => {
              if (!confirm(`Delete snippet "${d.name}"?`)) return;
              await remove(d.id);
              onDeleted();
            }}
          >
            <Trash2 size={14} /> Delete
          </Button>
        )}
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ import / export

interface SnippetFile {
  /** "rook-snippets" = exported before the rename; still imported. */
  format: "rookery-snippets" | "rook-snippets";
  version: 1;
  snippets: Omit<Snippet, "id" | "created_at" | "updated_at">[];
}

async function exportSnippets(list: Snippet[]) {
  const path = await saveDialog({ defaultPath: "rookery-snippets.json", title: "Export snippets", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return;
  const file: SnippetFile = {
    format: "rookery-snippets",
    version: 1,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    snippets: list.map(({ id, created_at, updated_at, ...rest }) => rest),
  };
  try {
    await api.fileWriteText(path, JSON.stringify(file, null, 2));
    await askConfirm({ title: "Snippets exported", body: `${list.length} snippets saved to ${path}.`, confirmLabel: "OK" });
  } catch (e) {
    await askConfirm({ title: "Export failed", body: asCoreError(e).message, confirmLabel: "OK" });
  }
}

async function importSnippets() {
  const picked = await openDialog({ multiple: false, title: "Import snippets", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!picked || Array.isArray(picked)) return;
  const { list, save } = useSnippets.getState();
  const { hosts, groups } = useHosts.getState();
  let added = 0;
  let skipped = 0;
  try {
    const data = JSON.parse(await api.fileReadText(picked)) as Partial<SnippetFile>;
    if ((data.format !== "rookery-snippets" && data.format !== "rook-snippets") || !Array.isArray(data.snippets)) throw new Error("This is not a Rookery snippets file.");
    for (const raw of data.snippets) {
      const s: Snippet = { ...emptySnippet(), ...raw, id: "", created_at: 0, updated_at: 0 };
      if (s.alias && (list.some((x) => x.alias === s.alias) || useSnippets.getState().list.some((x) => x.alias === s.alias))) {
        skipped++;
        continue;
      }
      // Host / group ids don't carry over between computers.
      if ((s.scope === "host" && !hosts.some((h) => h.id === s.scope_value)) || (s.scope === "group" && !groups.some((g) => g.id === s.scope_value))) {
        s.scope = "all";
        s.scope_value = null;
      }
      await save(s);
      added++;
    }
    await askConfirm({
      title: "Snippets imported",
      body: `Added ${added}${skipped ? `, skipped ${skipped} whose alias you already have` : ""}.`,
      confirmLabel: "OK",
    });
  } catch (e) {
    await askConfirm({ title: "Import failed", body: e instanceof Error ? e.message : asCoreError(e).message, confirmLabel: "OK" });
  }
}