import { terminalRegistry } from "../features/server-tab/terminal/registry";
import { tabPasswords } from "../features/sql/DbTab";
import { sqlKeyForHost } from "../features/sql/registry";
import { openTransactions, settleTransactions } from "../features/sql/txGuard";
import { useVault } from "../stores/vault";
import { askChoice } from "../stores/dialogs";
import { dirtyDocs, useEditor } from "../stores/editor";
import { forgetHost as forgetEditor } from "../features/editor/actions";
import { api } from "../ipc/api";
import { useDocker } from "../stores/docker";
import { useFiles } from "../stores/files";
import { useLogs } from "../stores/logs";
import { useSessions } from "../stores/sessions";
import { useTabs, type Tab } from "../stores/tabs";

/**
 * Closing a server tab frees everything for that server: terminals, SFTP, edit watchers, buffers, lease.
 * Uncommitted SQL changes in the tab (database tab or a server's Database view) and unsaved files
 * in its Editor are asked about first.
 */
export async function closeTab(tab: Tab): Promise<boolean> {
  if (tab.kind === "server" && !(await settleEditor(tab.hostId, "closing this tab"))) return false;
  const keys = tab.kind === "db" ? [tab.id] : tab.kind === "server" ? [sqlKeyForHost(tab.hostId)] : [];
  if (keys.length && !(await settleTransactions(openTransactions(keys), "closing this tab"))) return false;
  useTabs.getState().close(tab.id);
  if (tab.kind === "local") terminalRegistry.disposeHost(tab.id);
  if (tab.kind === "db") tabPasswords.delete(tab.id); // the tab's session closes when it unmounts
  if (tab.kind === "server") {
    terminalRegistry.disposeHost(tab.hostId);
    void api.sftpClose(tab.hostId);
    useFiles.getState().forget(tab.hostId);
    useDocker.getState().forget(tab.hostId);
    useLogs.getState().forgetHost(tab.hostId);
    forgetEditor(tab.hostId);
    void useSessions.getState().detach(tab.hostId);
  }
  return true;
}

/** Lock from the button / shortcut: ask about uncommitted SQL changes first (auto-lock can't ask). */
export async function lockApp() {
  if (!(await settleTransactions(openTransactions(), "locking"))) return;
  await useVault.getState().lock();
}

/**
 * Unsaved files in the Editor (one server, or all): "Show them" goes to the first one and stops,
 * "Don't save" goes on. Returns true to go on.
 */
export async function settleEditor(hostId: string | null, action: string): Promise<boolean> {
  const dirty = dirtyDocs(hostId ?? undefined);
  if (dirty.length === 0) return true;
  const list = dirty.map((d) => `• ${d.realPath}`).join("\n");
  const c = await askChoice({
    title: dirty.length === 1 ? "A file has unsaved changes" : `${dirty.length} files have unsaved changes`,
    body: `${list}\n\nBefore ${action}: look at them (and save), or drop the changes?`,
    choices: [
      { id: "discard", label: "Don't save", variant: "danger" },
      { id: "show", label: "Show them", variant: "primary" },
    ],
  });
  if (c === "discard") return true;
  if (c === "show") {
    const d = dirty[0];
    const tabs = useTabs.getState();
    const t = tabs.tabs.find((x) => x.kind === "server" && x.hostId === d.hostId);
    if (t) tabs.activate(t.id);
    tabs.setView(d.hostId, "editor");
    useEditor.getState().activate(d.hostId, d.key);
  }
  return false;
}

/** Host id of the active tab if it is a server tab. */
export function activeServerHostId(): string | null {
  const { tabs, activeTabId } = useTabs.getState();
  const t = tabs.find((x) => x.id === activeTabId);
  return t?.kind === "server" ? t.hostId : null;
}

export function cycleTab(dir: 1 | -1) {
  const { tabs, activeTabId, activate } = useTabs.getState();
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeTabId);
  activate(tabs[(i + dir + tabs.length) % tabs.length].id);
}
