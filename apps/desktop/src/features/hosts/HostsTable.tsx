import { useMemo, useState } from "react";
import clsx from "clsx";
import { Copy, Download, Pencil, Search, Tag, Trash2, X } from "lucide-react";
import { shellHooks } from "../../keys/dispatcher";
import type { EnvLabel } from "../../ipc/bindings/EnvLabel";
import type { Host } from "../../ipc/bindings/Host";
import { asCoreError } from "../../ipc/api";
import { askConfirm, askText } from "../../stores/dialogs";
import { useHosts } from "../../stores/hosts";
import { Button, EnvTag, Select } from "../../ui/primitives";

const ENVS: EnvLabel[] = ["none", "prod", "staging", "dev", "lab", "client"];

/** A copy of a server, ready to save: new id, "(copy)" name, same login and settings. */
export function duplicateHost(h: Host): Host {
  return { ...h, id: "", name: `${h.name} (copy)`, created_at: 0, updated_at: 0 };
}

/** Hosts list with multi-select and bulk actions (docs/03 §7.3). */
export function HostsTable({ onEditHost }: { onEditHost: (h: Host) => void }) {
  const hosts = useHosts((s) => s.hosts);
  const groups = useHosts((s) => s.groups);
  const identities = useHosts((s) => s.identities);
  const { saveHost, deleteHost } = useHosts.getState();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);

  const f = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      hosts.filter(
        (h) =>
          !f ||
          h.name.toLowerCase().includes(f) ||
          h.address.toLowerCase().includes(f) ||
          h.tags.some((t) => t.toLowerCase().includes(f)) ||
          (groups.find((g) => g.id === h.group_id)?.name.toLowerCase().includes(f) ?? false),
      ),
    [hosts, groups, f],
  );
  const selected = hosts.filter((h) => sel.has(h.id));
  const allShown = rows.length > 0 && rows.every((h) => sel.has(h.id));

  const bulk = async (label: string, change: (h: Host) => Host) => {
    try {
      for (const h of selected) await saveHost(change(h));
      setMsg(`${label} · ${selected.length} server${selected.length === 1 ? "" : "s"}`);
    } catch (e) {
      setMsg(asCoreError(e).message);
    }
  };

  return (
    <section className="flex min-w-[320px] flex-[2] flex-col gap-2">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-lg font-semibold">Hosts</h1>
        <span className="text-xs text-muted">{hosts.length}</span>
        <Button className="ml-auto h-8" onClick={() => shellHooks.openImport()} title="From MobaXterm, PuTTY or ~/.ssh/config">
          <Download size={13} /> Import…
        </Button>
        <label className="flex h-8 items-center gap-2 rounded-md border border-line bg-bg px-2.5 text-muted">
          <Search size={13} />
          <input aria-label="Filter hosts" placeholder="Filter by name, address, tag, group" value={q} onChange={(e) => setQ(e.target.value)} className="w-56 bg-transparent text-xs text-text outline-none" />
        </label>
      </div>

      {selected.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-accent-line bg-accent-bg px-3 py-2 text-[13px]">
          <span className="font-semibold">{selected.length} selected</span>
          <Select
            aria-label="Move to group"
            className="h-7"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v) void bulk("Moved", (h) => ({ ...h, group_id: v === "__none" ? null : v }));
            }}
          >
            <option value="">Move to group…</option>
            <option value="__none">No group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Set login"
            className="h-7"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v) void bulk("Login changed", (h) => ({ ...h, identity_id: v === "__inherit" ? null : v }));
            }}
          >
            <option value="">Set login…</option>
            <option value="__inherit">Inherit from group</option>
            {identities.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} — {i.username}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Set environment"
            className="h-7"
            value=""
            onChange={(e) => {
              const v = e.target.value as EnvLabel;
              if (v) void bulk("Environment set", (h) => ({ ...h, env_label: v }));
            }}
          >
            <option value="">Environment…</option>
            {ENVS.map((x) => (
              <option key={x} value={x}>
                {x === "none" ? "None" : x.toUpperCase()}
              </option>
            ))}
          </Select>
          <Button
            className="h-7"
            onClick={async () => {
              const tag = (await askText({ title: "Add a tag to the selected servers", label: "Tag", value: "", confirmLabel: "Add tag" }))?.trim();
              if (tag) void bulk(`Tagged “${tag}”`, (h) => ({ ...h, tags: h.tags.includes(tag) ? h.tags : [...h.tags, tag] }));
            }}
          >
            <Tag size={12} /> Add tag
          </Button>
          <Button
            variant="danger"
            className="h-7"
            onClick={async () => {
              const ok = await askConfirm({
                title: `Delete ${selected.length} server${selected.length === 1 ? "" : "s"}?`,
                body: selected.map((h) => h.name).join(", "),
                confirmLabel: "Delete",
                danger: true,
              });
              if (!ok) return;
              for (const h of selected) await deleteHost(h.id).catch(() => {});
              setSel(new Set());
              setMsg("Deleted.");
            }}
          >
            <Trash2 size={12} /> Delete
          </Button>
          <button aria-label="Clear selection" className="ml-auto text-muted hover:text-text" onClick={() => setSel(new Set())}>
            <X size={14} />
          </button>
        </div>
      )}
      {msg && <p className="m-0 text-xs text-muted">{msg}</p>}

      <div className="flex flex-col rounded-xl border border-line bg-panel">
        <div className="grid grid-cols-[28px_minmax(140px,1.4fr)_minmax(120px,1fr)_minmax(90px,0.8fr)_minmax(90px,0.8fr)_64px] items-center gap-2 border-b border-line px-3 py-2 text-xs font-semibold text-muted">
          <input
            type="checkbox"
            aria-label="Select all shown"
            className="accent-accent"
            checked={allShown}
            onChange={(e) => setSel(e.target.checked ? new Set([...sel, ...rows.map((h) => h.id)]) : new Set([...sel].filter((id) => !rows.some((h) => h.id === id))))}
          />
          <span>Name</span>
          <span>Address</span>
          <span>Group</span>
          <span>Login</span>
          <span />
        </div>
        {rows.map((h) => (
          <div
            key={h.id}
            className={clsx(
              "grid grid-cols-[28px_minmax(140px,1.4fr)_minmax(120px,1fr)_minmax(90px,0.8fr)_minmax(90px,0.8fr)_64px] items-center gap-2 border-b border-[#303A4E] px-3 py-1.5 last:border-b-0",
              sel.has(h.id) && "bg-panel2",
            )}
          >
            <input
              type="checkbox"
              aria-label={`Select ${h.name}`}
              className="accent-accent"
              checked={sel.has(h.id)}
              onChange={(e) => {
                const next = new Set(sel);
                if (e.target.checked) next.add(h.id);
                else next.delete(h.id);
                setSel(next);
              }}
            />
            <button onClick={() => onEditHost(h)} className="flex min-w-0 items-center gap-2 text-left">
              <span className="truncate font-medium">{h.name}</span>
              <EnvTag env={h.env_label} />
            </button>
            <span className="truncate font-mono text-xs text-muted">
              {h.address}:{h.port}
            </span>
            <span className="truncate text-xs text-muted">{groups.find((g) => g.id === h.group_id)?.name ?? "—"}</span>
            <span className="truncate text-xs text-muted">{identities.find((i) => i.id === h.identity_id)?.name ?? "inherits"}</span>
            <span className="flex justify-end gap-0.5">
              <button
                aria-label={`Duplicate ${h.name}`}
                title="Duplicate"
                className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-panel2 hover:text-text"
                onClick={async () => {
                  const copy = await saveHost(duplicateHost(h)).catch((e) => {
                    setMsg(asCoreError(e).message);
                    return null;
                  });
                  if (copy) onEditHost(copy);
                }}
              >
                <Copy size={13} />
              </button>
              <button aria-label={`Edit ${h.name}`} title="Edit" className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-panel2 hover:text-text" onClick={() => onEditHost(h)}>
                <Pencil size={13} />
              </button>
            </span>
          </div>
        ))}
        {rows.length === 0 && <p className="m-0 px-3 py-3 text-muted">{hosts.length ? "Nothing matches." : "No hosts yet."}</p>}
      </div>
    </section>
  );
}
