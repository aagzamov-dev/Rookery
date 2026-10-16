import { useState } from "react";
import clsx from "clsx";
import { ChevronDown, ChevronRight, Copy, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import type { DbConnection } from "../../ipc/bindings/DbConnection";
import { askConfirm } from "../../stores/dialogs";
import { useSql } from "../../stores/sql";
import { useTabs } from "../../stores/tabs";
import { useContextMenu, type MenuItem } from "../../ui/ContextMenu";
import { EnvTag } from "../../ui/primitives";
import { useConnDialog } from "./connDialog";

const icon = (c: DbConnection) => (c.engine === "mysql" ? "🐬" : "🐘");

export function openConn(c: DbConnection, newTab = false) {
  useTabs.getState().openDb({ kind: "saved", id: c.id }, c.name, newTab);
}

/** Sidebar section under the hosts: saved database connections. Nothing connects until opened. */
export function DbList({ filter }: { filter: string }) {
  const conns = useSql((s) => s.conns);
  const [collapsed, setCollapsed] = useState(false);
  const f = filter.trim().toLowerCase();
  const visible = f ? conns.filter((c) => c.name.toLowerCase().includes(f) || c.address.toLowerCase().includes(f) || (c.database ?? "").toLowerCase().includes(f)) : conns;
  if (f && visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-px">
      <div className="group/g flex h-[26px] items-center gap-1.5 pr-1 pl-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">
        <button aria-label={collapsed ? "Expand databases" : "Collapse databases"} onClick={() => setCollapsed(!collapsed)} className="grid h-5 w-5 place-items-center">
          {collapsed && !f ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <span className="flex-1 truncate">Databases</span>
        <button aria-label="New database connection" title="New database connection" onClick={() => useConnDialog.getState().open({})} className="grid h-5 w-5 place-items-center rounded hover:text-text">
          <Plus size={12} />
        </button>
        <span className="w-4 text-right font-medium">{conns.length || ""}</span>
      </div>
      {(!collapsed || f) &&
        visible.map((c) => <DbRow key={c.id} conn={c} />)}
      {!collapsed && conns.length === 0 && (
        <button onClick={() => useConnDialog.getState().open({})} className="px-3 py-1 text-left text-xs text-muted hover:text-text">
          + Add a database (PostgreSQL, MySQL, MariaDB)
        </button>
      )}
    </div>
  );
}

function DbRow({ conn }: { conn: DbConnection }) {
  const isOpen = useTabs((s) => s.tabs.some((t) => t.kind === "db" && t.target.kind === "saved" && t.target.id === conn.id));
  const isActive = useTabs((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    return t?.kind === "db" && t.target.kind === "saved" && t.target.id === conn.id;
  });
  const menu = useContextMenu();
  const readOnly = conn.read_only || conn.env_label === "prod";
  const items: MenuItem[] = [
    { label: "Open", onClick: () => openConn(conn) },
    { label: "Open in new tab", onClick: () => openConn(conn, true) },
    { kind: "separator" },
    { label: "Edit…", icon: <Pencil size={13} />, onClick: () => useConnDialog.getState().open({ conn }) },
    {
      label: "Duplicate",
      icon: <Copy size={13} />,
      onClick: () => useConnDialog.getState().open({ prefill: { ...conn, id: "", name: `${conn.name} copy`, has_password: false } }),
    },
    {
      label: "Delete…",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: async () => {
        if (await askConfirm({ title: `Delete "${conn.name}"?`, body: "The connection and its saved password are removed (on your other devices too, after sync).", confirmLabel: "Delete", danger: true })) {
          await useSql.getState().deleteConn(conn.id).catch(() => {});
        }
      },
    },
  ];
  return (
    <div onContextMenu={menu.open(items)} className={clsx("group/h flex h-[30px] items-center gap-2 rounded-md pr-1 pl-5", isActive ? "bg-accent-bg" : "hover:bg-panel2")}>
      <button onClick={() => openConn(conn)} onDoubleClick={() => openConn(conn, true)} title={`${conn.username}@${conn.address}:${conn.port}${conn.database ? `/${conn.database}` : ""}`} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span aria-hidden className="text-[13px] leading-none">
          {icon(conn)}
        </span>
        <span className={clsx("flex-1 truncate", isOpen && "font-semibold")}>{conn.name}</span>
        {readOnly && <Lock size={11} className="flex-none text-muted" aria-label="read-only" />}
        {conn.env_label !== "none" && <EnvTag env={conn.env_label} />}
      </button>
      <button aria-label={`Edit ${conn.name}`} onClick={() => useConnDialog.getState().open({ conn })} className="hidden h-6 w-6 place-items-center rounded text-muted hover:text-text group-hover/h:grid">
        <Pencil size={12} />
      </button>
      {menu.node}
    </div>
  );
}
