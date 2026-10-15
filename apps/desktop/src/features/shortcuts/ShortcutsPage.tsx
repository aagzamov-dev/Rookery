import { useMemo, useState } from "react";
import clsx from "clsx";
import { Download, Keyboard, Plus, RotateCcw, Search, Trash2, Upload, Wand2, X } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, asCoreError } from "../../ipc/api";
import { ACTION_GROUPS, ACTIONS, type ActionDef, type ActionId } from "../../keys/actions";
import { isMac, normalizeChord } from "../../keys/chord";
import { presetsForPlatform } from "../../keys/presets";
import { askConfirm } from "../../stores/dialogs";
import { findChordUsers, useKeys, type CustomKey, type Overrides, type TerminalPrefs } from "../../stores/keys";
import { useSnippets } from "../../stores/snippets";
import { useTabs } from "../../stores/tabs";
import { Button, Select, TextInput } from "../../ui/primitives";
import { ChordView, ShortcutRecorder } from "../../ui/ShortcutRecorder";

type Show = "all" | "assigned" | "unassigned" | "changed";

/**
 * Every function in one list (MobaXterm style): pick a function, give it one or more
 * shortcuts. Plus presets, custom "type this text" keys, and keymap import / export.
 */
export function ShortcutsPage() {
  const bindings = useKeys((s) => s.bindings);
  const overrides = useKeys((s) => s.overrides);
  const resetAll = useKeys((s) => s.resetAll);
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [msg, setMsg] = useState<string | null>(null);

  const f = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      ACTIONS.filter((a) => {
        const chords = bindings[a.id];
        if (show === "assigned" && chords.length === 0) return false;
        if (show === "unassigned" && chords.length > 0) return false;
        if (show === "changed" && overrides[a.id] === undefined) return false;
        return !f || a.label.toLowerCase().includes(f) || a.group.toLowerCase().includes(f) || chords.some((c) => c.toLowerCase().includes(f));
      }),
    [bindings, overrides, show, f],
  );
  const counts = {
    all: ACTIONS.length,
    assigned: ACTIONS.filter((a) => bindings[a.id].length > 0).length,
    unassigned: ACTIONS.filter((a) => bindings[a.id].length === 0).length,
    changed: Object.keys(overrides).length,
  };

  return (
    <div className="mx-auto flex max-w-[1080px] flex-col gap-5 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Keyboard size={20} className="text-accent" />
        <h1 className="m-0 text-xl font-semibold">Keyboard shortcuts</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <PresetPicker onDone={setMsg} />
          <Button onClick={() => void importKeymap(setMsg)}>
            <Upload size={13} /> Import
          </Button>
          <Button onClick={() => void exportKeymap(setMsg)}>
            <Download size={13} /> Export
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              if (await askConfirm({ title: "Reset every shortcut to its default?", body: "Custom keys and snippet hotkeys stay.", confirmLabel: "Reset all", danger: true })) void resetAll();
            }}
          >
            <RotateCcw size={13} /> Reset all
          </Button>
        </div>
      </div>
      {msg && (
        <div className="flex items-center gap-2 rounded-lg border border-accent-line bg-accent-bg px-3 py-2 text-xs">
          <span className="flex-1">{msg}</span>
          <button aria-label="Dismiss" onClick={() => setMsg(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(["all", "assigned", "unassigned", "changed"] as Show[]).map((k) => (
          <button key={k} onClick={() => setShow(k)} className={clsx("h-7 rounded-full px-3 text-xs", show === k ? "bg-accent-bg text-text" : "border border-line text-muted hover:text-text")}>
            {k === "all" ? "All" : k === "assigned" ? "Has a shortcut" : k === "unassigned" ? "No shortcut yet" : "Changed by me"} {counts[k]}
          </button>
        ))}
        <label className="ml-auto flex h-8 items-center gap-2 rounded-md border border-line bg-bg px-2.5 text-muted">
          <Search size={13} />
          <input autoFocus aria-label="Search functions or keys" placeholder="Search function or key (e.g. paste, F3)" value={q} onChange={(e) => setQ(e.target.value)} className="w-64 bg-transparent text-xs text-text outline-none" />
        </label>
      </div>
      {!isMac && (
        <p className="m-0 text-xs leading-relaxed text-muted">
          Inside a terminal, the default Ctrl+letter shortcuts give way to the shell (Ctrl+L clears, Ctrl+R searches history) — the Ctrl+Shift versions work there. A
          Ctrl+letter you set yourself (for example Ctrl+A = Select all) works inside terminals too and replaces the shell key.
        </p>
      )}

      {ACTION_GROUPS.map((g) => {
        const list = rows.filter((a) => a.group === g);
        if (list.length === 0) return null;
        return (
          <section key={g} className="flex flex-col rounded-xl border border-line bg-panel">
            <div className="grid grid-cols-[minmax(220px,1fr)_minmax(0,2fr)] gap-3 border-b border-line px-4 py-2.5 text-xs font-semibold text-muted">
              <span>{g}</span>
              <span>Shortcuts</span>
            </div>
            {list.map((a) => (
              <ActionRow key={a.id} a={a} />
            ))}
          </section>
        );
      })}
      {rows.length === 0 && <p className="text-muted">Nothing matches.</p>}

      <CustomKeys />
      <SnippetHotkeys />
    </div>
  );
}

function ActionRow({ a }: { a: ActionDef }) {
  const chords = useKeys((s) => s.bindings[a.id]);
  const changed = useKeys((s) => s.overrides[a.id] !== undefined);
  const bindings = useKeys((s) => s.bindings);
  const setBinding = useKeys((s) => s.setBinding);
  const resetBinding = useKeys((s) => s.resetBinding);
  const snippets = useSnippets((s) => s.list);

  const conflicts = (chord: string) =>
    findChordUsers(normalizeChord(chord), bindings, snippets)
      .filter((u) => !(u.kind === "action" && u.id === a.id))
      .map((u) => u.label);

  return (
    <div className="grid grid-cols-[minmax(220px,1fr)_minmax(0,2fr)] items-start gap-3 border-b border-[#303A4E] px-4 py-2 last:border-b-0">
      <span className="flex flex-col gap-0.5 pt-1.5">
        <span>{a.label}</span>
        {a.terminalOnly && <span className="text-[11px] text-muted">when a terminal has focus</span>}
      </span>
      <div className="flex flex-wrap items-start gap-2">
        {chords.map((c, i) => (
          <div key={`${c}-${i}`} className="flex items-start gap-0.5">
            <ShortcutRecorder
              value={c}
              warnShell={changed}
              conflicts={conflicts}
              onChange={(next) => {
                const list = chords.slice();
                if (next) list[i] = next;
                else list.splice(i, 1);
                void setBinding(a.id, list);
              }}
            />
            <button aria-label={`Remove ${c}`} title="Remove" onClick={() => void setBinding(a.id, chords.filter((_, j) => j !== i))} className="grid h-8 w-6 place-items-center text-muted hover:text-text">
              <X size={12} />
            </button>
          </div>
        ))}
        <ShortcutRecorder value={null} placeholder={chords.length ? "+ Add" : "+ Assign"} conflicts={conflicts} onChange={(next) => next && void setBinding(a.id, [...chords, next])} />
        {changed && (
          <Button variant="ghost" className="h-8 px-2" title="Reset to default" onClick={() => void resetBinding(a.id as ActionId)}>
            <RotateCcw size={12} />
          </Button>
        )}
      </div>
    </div>
  );
}

function PresetPicker({ onDone }: { onDone: (m: string) => void }) {
  const setOverrides = useKeys((s) => s.setOverrides);
  const setTerminal = useKeys((s) => s.setTerminal);
  const presets = presetsForPlatform();
  return (
    <span className="flex items-center gap-1.5">
      <Wand2 size={13} className="text-muted" />
      <Select
        aria-label="Apply a preset"
        className="h-8"
        value=""
        onChange={async (e) => {
          const p = presets.find((x) => x.id === e.target.value);
          e.target.value = "";
          if (!p) return;
          const ok = await askConfirm({
            title: `Use “${p.name}” shortcuts?`,
            body: `${p.description} Your current changes to app shortcuts are replaced. Custom keys and snippet hotkeys stay.`,
            confirmLabel: "Apply preset",
          });
          if (!ok) return;
          await setOverrides(p.overrides);
          await setTerminal(p.terminal);
          onDone(`Applied “${p.name}”.`);
        }}
      >
        <option value="">Presets…</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
    </span>
  );
}

function CustomKeys() {
  const keys = useKeys((s) => s.customKeys);
  const setKeys = useKeys((s) => s.setCustomKeys);
  const bindings = useKeys((s) => s.bindings);
  const snippets = useSnippets((s) => s.list);
  const update = (id: string, patch: Partial<CustomKey>) => void setKeys(keys.map((k) => (k.id === id ? { ...k, ...patch } : k)));
  const conflicts = (self: string) => (chord: string) =>
    findChordUsers(normalizeChord(chord), bindings, snippets, keys)
      .filter((u) => !(u.kind === "custom" && u.id === self))
      .map((u) => u.label);

  return (
    <section className="flex flex-col rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="text-xs font-semibold text-muted">Custom keys — type text into the terminal</span>
        <span className="text-[11px] text-muted">
          Use <code className="font-mono">\n</code> for Enter, <code className="font-mono">\t</code> Tab, <code className="font-mono">\e</code> Esc, <code className="font-mono">\x03</code> Ctrl+C
        </span>
        <Button
          className="ml-auto h-7 px-2.5 text-xs"
          onClick={() => void setKeys([...keys, { id: `k${Date.now().toString(36)}`, label: "New key", chord: "", text: "" }])}
        >
          <Plus size={12} /> Add custom key
        </Button>
      </div>
      {keys.length === 0 && (
        <p className="m-0 px-4 py-3 text-xs text-muted">
          Like MobaXterm macros: e.g. a key that types <code className="font-mono">sudo !!\n</code>, <code className="font-mono">exit\n</code> or your password-less
          SSH jump command. They work in every terminal tab.
        </p>
      )}
      {keys.map((k) => (
        <div key={k.id} className="grid grid-cols-[minmax(140px,1fr)_auto_minmax(0,2fr)_auto] items-start gap-3 border-b border-[#303A4E] px-4 py-2 last:border-b-0">
          <TextInput aria-label="Name" className="h-8" value={k.label} onChange={(e) => update(k.id, { label: e.target.value })} />
          <ShortcutRecorder value={k.chord || null} conflicts={conflicts(k.id)} onChange={(c) => update(k.id, { chord: c ?? "" })} placeholder="+ Assign" />
          <TextInput aria-label="Text to type" mono className="h-8" placeholder="sudo !!\n" value={k.text} onChange={(e) => update(k.id, { text: e.target.value })} />
          <button aria-label={`Delete ${k.label}`} onClick={() => void setKeys(keys.filter((x) => x.id !== k.id))} className="grid h-8 w-8 place-items-center text-muted hover:text-[#FFA8A8]">
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </section>
  );
}

function SnippetHotkeys() {
  const snippets = useSnippets((s) => s.list);
  const withKeys = snippets.filter((s) => s.hotkey);
  return (
    <section className="flex flex-col rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="text-xs font-semibold text-muted">Snippet hotkeys</span>
        <button onClick={() => useTabs.getState().openPage("snippets")} className="ml-auto text-xs text-accent">
          Edit in Snippets
        </button>
      </div>
      {withKeys.length === 0 && <p className="m-0 px-4 py-3 text-xs text-muted">Give a snippet a hotkey in the Snippets tab and it shows here.</p>}
      {withKeys.map((s) => (
        <div key={s.id} className="flex items-center gap-3 border-b border-[#303A4E] px-4 py-2.5 last:border-b-0">
          <span className="flex-1">
            {s.alias ? <span className="font-mono text-accent">{s.alias}</span> : s.name}
            <span className="ml-2 text-xs text-muted">{s.alias ? s.name : ""}</span>
          </span>
          <ChordView chord={normalizeChord(s.hotkey!)} />
        </div>
      ))}
    </section>
  );
}

// ------------------------------------------------------------ keymap files

interface KeymapFile {
  /** "rook-keymap" = exported before the rename; still imported. */
  format: "rookery-keymap" | "rook-keymap";
  version: 1;
  overrides: Overrides;
  customKeys: CustomKey[];
  terminal: Partial<TerminalPrefs>;
}

async function exportKeymap(done: (m: string) => void) {
  const path = await saveDialog({ defaultPath: "rookery-keymap.json", title: "Export keyboard shortcuts", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return;
  const s = useKeys.getState();
  const file: KeymapFile = {
    format: "rookery-keymap",
    version: 1,
    overrides: s.overrides,
    customKeys: s.customKeys,
    terminal: { ctrlCCopies: s.terminal.ctrlCCopies, ctrlVPastes: s.terminal.ctrlVPastes, rightClickPastes: s.terminal.rightClickPastes, copyOnSelect: s.terminal.copyOnSelect },
  };
  try {
    await api.fileWriteText(path, JSON.stringify(file, null, 2));
    done(`Saved to ${path}`);
  } catch (e) {
    done(asCoreError(e).message);
  }
}

async function importKeymap(done: (m: string) => void) {
  const picked = await openDialog({ multiple: false, title: "Import keyboard shortcuts", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!picked || Array.isArray(picked)) return;
  try {
    const data = JSON.parse(await api.fileReadText(picked)) as Partial<KeymapFile>;
    if (data.format !== "rookery-keymap" && data.format !== "rook-keymap") throw new Error("This is not a Rookery keymap file.");
    const s = useKeys.getState();
    const known = new Set(ACTIONS.map((a) => a.id));
    const overrides = Object.fromEntries(Object.entries(data.overrides ?? {}).filter(([k]) => known.has(k as ActionId))) as Overrides;
    await s.setOverrides(overrides);
    if (Array.isArray(data.customKeys)) await s.setCustomKeys(data.customKeys.filter((k) => k && typeof k.text === "string"));
    if (data.terminal) await s.setTerminal(data.terminal);
    done(`Imported ${Object.keys(overrides).length} shortcuts and ${data.customKeys?.length ?? 0} custom keys.`);
  } catch (e) {
    done(e instanceof Error ? e.message : asCoreError(e).message);
  }
}
