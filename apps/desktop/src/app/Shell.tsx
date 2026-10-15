import { useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  FolderPlus,
  KeyRound,
  LayoutGrid,
  Lock,
  Pencil,
  Plus,
  Search,
  Server,
  SlidersHorizontal,
  X,
  Zap,
  Keyboard,
  TerminalSquare,
} from "lucide-react";
import { useHosts } from "../stores/hosts";
import { pageTabId, serverTabId, useTabs, type PageKind } from "../stores/tabs";
import { useSessions } from "../stores/sessions";
import { useUi } from "../stores/ui";
import { useVault } from "../stores/vault";
import { useKeys } from "../stores/keys";
import { useSnippets } from "../stores/snippets";
import { useSync } from "../stores/sync";
import { useSubscriptionEngine } from "../subscriptions/useEngine";
import { installKeyDispatcher, shellHooks } from "../keys/dispatcher";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../ipc/api";
import { useFiles } from "../stores/files";
import { useAutoLock } from "./useAutoLock";
import { closeTab } from "./tabActions";
import { ServerTab } from "../features/server-tab/ServerTab";
import { CommandPalette } from "../features/palette/CommandPalette";
import { DialogHost } from "../ui/DialogHost";
import { LocalTab, useLoadLocalShells, useLocalShells } from "../features/local/LocalTab";
import { restoreSession, useSessionPersistence } from "./session";
import { HostEditor, type HostDraft } from "../features/hosts/HostEditor";
import { GroupEditor } from "../features/hosts/GroupEditor";
import { PageTab } from "../features/pages/Pages";
import { EnvTag, IconButton, StatusDot } from "../ui/primitives";
import type { Group } from "../ipc/bindings/Group";
import type { Host } from "../ipc/bindings/Host";

export function Shell() {
  useSubscriptionEngine();
  useAutoLock();

  useEffect(() => {
    void useKeys.getState().load().then(() => restoreSession());
    void useSnippets.getState().load();
    void useSync.getState().load();
    return installKeyDispatcher();
  }, []);

  // Auto-sync pauses a minute after the window is minimised / hidden (Rust keeps the clock).
  useEffect(() => {
    const report = () => void api.syncWindowVisible(!document.hidden).catch(() => {});
    report();
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, []);
  useSessionPersistence();
  useLoadLocalShells();

  const hostListOpen = useUi((s) => s.hostListOpen);
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const [hostEditor, setHostEditor] = useState<HostDraft | null>(null);
  const [groupEditor, setGroupEditor] = useState<Group | "new" | null>(null);

  useEffect(() => {
    shellHooks.newHost = () => setHostEditor({});
    shellHooks.editHost = (host) => setHostEditor({ host });
    shellHooks.editGroup = (group) => setGroupEditor(group);
    shellHooks.focusQuickConnect = () => document.querySelector<HTMLInputElement>('input[aria-label="Quick connect"]')?.focus();
    shellHooks.uploadFiles = (hostId) => void uploadToCurrentFolder(hostId);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TitleBar onQuickConnect={(d) => setHostEditor(d)} />
      <div className="flex min-h-0 flex-1">
        <IconRail />
        {hostListOpen && (
          <HostList
            onNewHost={(groupId) => setHostEditor({ groupId })}
            onEditHost={(h) => setHostEditor({ host: h })}
            onNewGroup={() => setGroupEditor("new")}
            onEditGroup={(g) => setGroupEditor(g)}
          />
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <div className="relative min-h-0 flex-1">
            {tabs.length === 0 && <EmptyState onNewHost={() => setHostEditor({})} />}
            {tabs.map((t) =>
              t.kind === "server" ? (
                <ServerTab key={t.id} hostId={t.hostId} active={t.id === activeTabId} onEditHost={(h) => setHostEditor({ host: h })} />
              ) : t.kind === "local" ? (
                <LocalTab key={t.id} tabId={t.id} shellId={t.shellId} active={t.id === activeTabId} />
              ) : (
                <PageTab key={t.id} page={t.page} active={t.id === activeTabId} onEditHost={(h) => setHostEditor({ host: h })} />
              ),
            )}
          </div>
        </main>
      </div>
      {hostEditor && <HostEditor draft={hostEditor} onClose={() => setHostEditor(null)} />}
      {groupEditor && <GroupEditor group={groupEditor === "new" ? null : groupEditor} onClose={() => setGroupEditor(null)} />}
      <CommandPalette onNewHost={() => setHostEditor({})} />
      <DialogHost />
    </div>
  );
}

/** Upload shortcut: pick files, send them into the folder the Files view is showing. */
async function uploadToCurrentFolder(hostId: string) {
  const dir = useFiles.getState().byHost[hostId]?.path;
  if (!dir) return;
  const picked = await openDialog({ multiple: true, title: `Upload to ${dir}` });
  const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (list.length) await api.sftpUpload(hostId, list, dir).catch(() => {});
}

// --------------------------------------------------------------------------- title bar

function TitleBar({ onQuickConnect }: { onQuickConnect: (d: HostDraft) => void }) {
  const [q, setQ] = useState("");
  const submit = () => {
    // user@host[:port] → prefilled "new host" form (saving is the user's choice).
    const m = q.trim().match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
    if (!m) return;
    onQuickConnect({ quick: { user: m[1] ?? "", address: m[2], port: m[3] ? Number(m[3]) : 22 } });
    setQ("");
  };
  return (
    <header className="flex min-h-11 items-center gap-4 border-b border-line bg-panel px-3.5">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden className="grid h-[22px] w-[22px] place-items-center rounded-md bg-accent font-mono text-[11px] font-bold text-bg">
          &gt;_
        </span>
        Rookery
      </div>
      <label className="mx-auto flex h-[30px] w-full max-w-[560px] items-center gap-2 rounded-lg border border-line bg-bg px-2.5 text-muted">
        <Search size={14} />
        <input
          aria-label="Quick connect"
          placeholder="Quick connect: user@host:port"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="min-w-0 flex-1 bg-transparent text-text outline-none"
        />
      </label>
      <span className="rounded-full bg-panel2 px-2.5 py-1 text-xs text-muted">Local only · not backed up</span>
    </header>
  );
}

// --------------------------------------------------------------------------- icon rail

function IconRail() {
  const toggle = useUi((s) => s.toggleHostList);
  const hostListOpen = useUi((s) => s.hostListOpen);
  const activeTabId = useTabs((s) => s.activeTabId);
  const openPage = useTabs((s) => s.openPage);
  const lock = useVault((s) => s.lock);

  const item = (label: string, icon: ReactNode, onClick: () => void, active: boolean) => (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={clsx(
        "grid h-10 w-10 place-items-center rounded-lg",
        active ? "bg-accent-bg text-accent" : "text-muted hover:bg-panel2 hover:text-text",
      )}
    >
      {icon}
    </button>
  );
  const page = (p: PageKind, label: string, icon: ReactNode) => item(label, icon, () => openPage(p), activeTabId === pageTabId(p));

  return (
    <nav aria-label="App sections" className="flex w-14 flex-none flex-col items-center gap-1.5 border-r border-line bg-panel py-2.5">
      {item("Hosts", <Server size={18} />, toggle, hostListOpen)}
      {page("dashboard", "Dashboard", <LayoutGrid size={18} />)}
      {page("snippets", "Snippets", <Zap size={18} />)}
      {page("tunnels", "Tunnels", <ArrowLeftRight size={18} />)}
      {page("hosts", "Hosts & identities", <KeyRound size={18} />)}
      {page("shortcuts", "Keyboard shortcuts", <Keyboard size={18} />)}
      <span className="flex-1" />
      {item("Lock (Ctrl+L)", <Lock size={18} />, () => void lock(), false)}
      {page("settings", "Settings", <SlidersHorizontal size={18} />)}
    </nav>
  );
}

// --------------------------------------------------------------------------- host list

function HostList({
  onNewHost,
  onEditHost,
  onNewGroup,
  onEditGroup,
}: {
  onNewHost: (groupId: string | null) => void;
  onEditHost: (h: Host) => void;
  onNewGroup: () => void;
  onEditGroup: (g: Group) => void;
}) {
  const hosts = useHosts((s) => s.hosts);
  const groups = useHosts((s) => s.groups);
  const toggle = useUi((s) => s.toggleHostList);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const f = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      f
        ? hosts.filter((h) => h.name.toLowerCase().includes(f) || h.address.toLowerCase().includes(f) || h.tags.some((t) => t.toLowerCase().includes(f)))
        : hosts,
    [hosts, f],
  );

  const renderGroup = (g: Group, depth: number): ReactNode => {
    const children = groups.filter((c) => c.parent_id === g.id);
    const own = visible.filter((h) => h.group_id === g.id);
    if (f && own.length === 0 && children.length === 0) return null;
    const isCollapsed = collapsed[g.id] && !f;
    return (
      <div key={g.id} className="flex flex-col gap-px">
        <div className="group/g flex h-[26px] items-center gap-1.5 pr-1 text-[11px] font-semibold tracking-wider text-muted uppercase" style={{ paddingLeft: 6 + depth * 12 }}>
          <button aria-label={isCollapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))} className="grid h-5 w-5 place-items-center">
            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <span aria-hidden className="h-2 w-2 rounded-[2px]" style={{ background: g.color }} />
          <span className="flex-1 truncate">{g.name}</span>
          <button aria-label={`Add host to ${g.name}`} onClick={() => onNewHost(g.id)} className="hidden h-5 w-5 place-items-center rounded hover:text-text group-hover/g:grid">
            <Plus size={12} />
          </button>
          <button aria-label={`Edit ${g.name}`} onClick={() => onEditGroup(g)} className="hidden h-5 w-5 place-items-center rounded hover:text-text group-hover/g:grid">
            <Pencil size={11} />
          </button>
          <span className="font-medium group-hover/g:hidden">{hosts.filter((h) => h.group_id === g.id).length}</span>
        </div>
        {!isCollapsed && (
          <>
            {own.map((h) => (
              <HostRow key={h.id} host={h} depth={depth + 1} onEdit={() => onEditHost(h)} />
            ))}
            {children.map((c) => renderGroup(c, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const ungrouped = visible.filter((h) => !h.group_id || !groups.some((g) => g.id === h.group_id));

  return (
    <nav aria-label="Hosts" className="flex w-[252px] flex-none flex-col gap-3 border-r border-line bg-panel px-2.5 py-3">
      <div className="flex items-center gap-1 px-1">
        <span className="text-xs font-semibold tracking-wider text-muted uppercase">Hosts</span>
        <IconButton label="New group" className="ml-auto h-[26px] w-[26px]" onClick={onNewGroup}>
          <FolderPlus size={14} />
        </IconButton>
        <IconButton label="New host" className="h-[26px] w-[26px] border border-line bg-panel2 text-text" onClick={() => onNewHost(null)}>
          <Plus size={14} />
        </IconButton>
        <IconButton label="Collapse host list" className="h-[26px] w-[26px]" onClick={toggle}>
          <ChevronsLeft size={14} />
        </IconButton>
      </div>
      <label className="flex h-[30px] items-center gap-2 rounded-[7px] border border-line bg-bg px-2.5 text-muted">
        <Search size={13} />
        <input aria-label="Filter hosts" placeholder="Filter hosts or tags" value={filter} onChange={(e) => setFilter(e.target.value)} className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none" />
      </label>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
        {groups.filter((g) => !g.parent_id || !groups.some((p) => p.id === g.parent_id)).map((g) => renderGroup(g, 0))}
        {ungrouped.length > 0 && (
          <div className="flex flex-col gap-px">
            {groups.length > 0 && <div className="px-1.5 py-1 text-[11px] font-semibold tracking-wider text-muted uppercase">No group</div>}
            {ungrouped.map((h) => (
              <HostRow key={h.id} host={h} depth={groups.length > 0 ? 1 : 0} onEdit={() => onEditHost(h)} />
            ))}
          </div>
        )}
        {hosts.length === 0 && <p className="px-2 text-xs leading-relaxed text-muted">No hosts yet. Add one with the + button.</p>}
      </div>
      <span className="border-t border-line px-1.5 pt-2.5 text-[11px] leading-relaxed text-muted">Click a server to open it as a tab. Nothing connects until you do.</span>
    </nav>
  );
}

function HostRow({ host, depth, onEdit }: { host: Host; depth: number; onEdit: () => void }) {
  const openServer = useTabs((s) => s.openServer);
  const isOpen = useTabs((s) => s.tabs.some((t) => t.id === serverTabId(host.id)));
  const isActive = useTabs((s) => s.activeTabId === serverTabId(host.id));
  const state = useSessions((s) => (isOpen ? s.byHost[host.id]?.state : undefined));
  return (
    <div className={clsx("group/h flex h-[30px] items-center gap-2 rounded-md pr-1", isActive ? "bg-accent-bg" : "hover:bg-panel2")} style={{ paddingLeft: 8 + depth * 12 }}>
      <button
        onClick={() => openServer(host.id, host.start_view, host.start_folder)}
        onDoubleClick={() => openServer(host.id, "terminal", host.start_folder)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <StatusDot state={state} />
        <span className={clsx("flex-1 truncate", isOpen && "font-semibold")}>{host.name}</span>
        {host.env_label === "prod" && <EnvTag env="prod" />}
      </button>
      <button aria-label={`Edit ${host.name}`} onClick={onEdit} className="hidden h-6 w-6 place-items-center rounded text-muted hover:text-text group-hover/h:grid">
        <Pencil size={12} />
      </button>
    </div>
  );
}

// --------------------------------------------------------------------------- tab bar

const pageMeta: Record<PageKind, { label: string; icon: ReactNode }> = {
  dashboard: { label: "Dashboard", icon: <LayoutGrid size={13} /> },
  snippets: { label: "Snippets", icon: <Zap size={13} /> },
  tunnels: { label: "Tunnels", icon: <ArrowLeftRight size={13} /> },
  hosts: { label: "Hosts & identities", icon: <KeyRound size={13} /> },
  settings: { label: "Settings", icon: <SlidersHorizontal size={13} /> },
  shortcuts: { label: "Shortcuts", icon: <Keyboard size={13} /> },
};

function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const activate = useTabs((s) => s.activate);
  const hosts = useHosts((s) => s.hosts);
  const sessions = useSessions((s) => s.byHost);
  if (tabs.length === 0)
    return (
      <div className="flex h-10 border-b border-line bg-panel">
        <NewTabButton />
      </div>
    );
  return (
    <div role="tablist" aria-label="Open tabs" className="flex h-10 flex-none items-stretch overflow-x-auto border-b border-line bg-panel">
      {tabs.map((t) => {
        const active = t.id === activeTabId;
        const host = t.kind === "server" ? hosts.find((h) => h.id === t.hostId) : undefined;
        const prod = host?.env_label === "prod";
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => activate(t.id)}
            onAuxClick={(e) => e.button === 1 && closeTab(t)}
            onKeyDown={(e) => e.key === "Enter" && activate(t.id)}
            className={clsx(
              "group/t flex cursor-pointer items-center gap-2 border-r border-t-2 border-r-line pr-2 pl-3.5 whitespace-nowrap",
              active ? (prod ? "border-t-bad" : "border-t-accent") : "border-t-transparent",
              active ? (t.kind === "server" ? "bg-term text-text" : "bg-bg text-text") : "text-muted hover:text-text",
            )}
          >
            {t.kind === "server" ? (
              <>
                <StatusDot state={sessions[t.hostId]?.state} />
                {host?.name ?? "deleted host"}
                {host && <EnvTag env={host.env_label} />}
              </>
            ) : t.kind === "local" ? (
              <>
                <TerminalSquare size={13} className="text-muted" />
                {t.title}
              </>
            ) : (
              <>
                {pageMeta[t.page].icon}
                {pageMeta[t.page].label}
              </>
            )}
            <button
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t);
              }}
              className={clsx("grid h-5 w-5 place-items-center rounded text-muted hover:bg-panel2 hover:text-text", !active && "invisible group-hover/t:visible")}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <NewTabButton />
    </div>
  );
}

/** "+" at the end of the tab bar: open a local terminal (PowerShell, cmd, WSL, Git Bash, zsh…). */
function NewTabButton() {
  const shells = useLocalShells((s) => s.shells);
  const openLocal = useTabs((s) => s.openLocal);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex items-center">
      <button aria-label="New local terminal" title="New local terminal" onClick={() => setOpen(!open)} className="grid h-full w-10 place-items-center text-muted hover:text-text">
        <Plus size={14} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute top-full left-0 z-50 mt-1 flex min-w-[220px] flex-col rounded-lg border border-line bg-panel p-1 shadow-xl">
            <span className="px-2.5 pt-1.5 pb-1 text-[11px] tracking-wider text-muted uppercase">Local terminal</span>
            {(shells ?? []).map((s) => (
              <button
                key={s.id}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  openLocal(s.id, s.label);
                }}
                className="flex h-8 items-center gap-2 rounded-md px-2.5 text-left hover:bg-accent-bg"
              >
                <TerminalSquare size={13} className="text-muted" /> {s.label}
              </button>
            ))}
            {shells && shells.length === 0 && <span className="px-2.5 py-2 text-xs text-muted">No local shells found</span>}
            {!shells && <span className="px-2.5 py-2 text-xs text-muted">Looking for shells…</span>}
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState({ onNewHost }: { onNewHost: () => void }) {
  const hasHosts = useHosts((s) => s.hosts.length > 0);
  return (
    <div className="grid h-full place-items-center">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Server size={28} className="text-muted" />
        <h2 className="m-0 text-base font-semibold">{hasHosts ? "Pick a server on the left" : "Add your first server"}</h2>
        <p className="m-0 leading-relaxed text-muted">
          {hasHosts ? "It opens as a tab with its terminal. Nothing connects until you open it." : "Hosts, logins and keys stay on this computer, encrypted."}
        </p>
        {!hasHosts && (
          <button onClick={onNewHost} className="h-9 rounded-lg bg-accent px-4 font-semibold text-bg">
            Add host
          </button>
        )}
      </div>
    </div>
  );
}
