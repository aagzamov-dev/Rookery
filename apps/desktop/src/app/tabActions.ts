import { terminalRegistry } from "../features/server-tab/terminal/registry";
import { api } from "../ipc/api";
import { useDocker } from "../stores/docker";
import { useFiles } from "../stores/files";
import { useLogs } from "../stores/logs";
import { useSessions } from "../stores/sessions";
import { useTabs, type Tab } from "../stores/tabs";

/** Closing a server tab frees everything for that server: terminals, SFTP, edit watchers, buffers, lease. */
export function closeTab(tab: Tab) {
  useTabs.getState().close(tab.id);
  if (tab.kind === "local") terminalRegistry.disposeHost(tab.id);
  if (tab.kind === "server") {
    terminalRegistry.disposeHost(tab.hostId);
    void api.sftpClose(tab.hostId);
    useFiles.getState().forget(tab.hostId);
    useDocker.getState().forget(tab.hostId);
    useLogs.getState().forgetHost(tab.hostId);
    void useSessions.getState().detach(tab.hostId);
  }
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
