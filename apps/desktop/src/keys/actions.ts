import { isMac } from "./chord";

/** Every function a shortcut can trigger. Many have no default — assign them on the Shortcuts page. */
export type ActionId =
  // app
  | "palette.open"
  | "app.lock"
  | "hostList.toggle"
  | "settings.open"
  | "shortcuts.open"
  | "page.dashboard"
  | "page.snippets"
  | "page.hosts"
  | "host.new"
  | "quickConnect.focus"
  | "app.fullscreen"
  | "dashboard.sync"
  // tabs
  | "tab.next"
  | "tab.prev"
  | "tab.close"
  | "tab.closeOthers"
  | "tab.reopen"
  | "tab.moveLeft"
  | "tab.moveRight"
  | "tab.last"
  | `tab.goto${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  // server views
  | "view.overview"
  | "view.terminal"
  | "view.files"
  | "view.editor"
  | "view.docker"
  | "view.database"
  | "view.services"
  | "view.processes"
  | "view.logs"
  | "view.filesPanel"
  // terminal
  | "term.new"
  | "term.closeCurrent"
  | "term.next"
  | "term.prev"
  | "term.reconnect"
  | "term.clear"
  | "term.reset"
  | "term.broadcast"
  | "term.sudoFill"
  | "local.new"
  // copy & paste
  | "term.copy"
  | "term.paste"
  | "term.selectAll"
  | "term.copyAll"
  // scroll & find
  | "term.find"
  | "term.findNext"
  | "term.findPrev"
  | "term.scrollTop"
  | "term.scrollBottom"
  | "term.pageUp"
  | "term.pageDown"
  | "term.lineUp"
  | "term.lineDown"
  // font
  | "term.zoomIn"
  | "term.zoomOut"
  | "term.zoomReset"
  // files
  | "files.copyPath"
  | "files.upload"
  | "files.refresh"
  // SQL editor
  | "sql.run"
  | "sql.runAll"
  | "sql.cancel"
  | "sql.toggleTree";

export type ActionGroup = "App" | "Tabs" | "Server views" | "Terminal" | "Copy & paste" | "Scroll & find" | "Font size" | "Files" | "SQL";

export const ACTION_GROUPS: ActionGroup[] = ["App", "Tabs", "Server views", "Terminal", "Copy & paste", "Scroll & find", "Font size", "Files", "SQL"];

export interface ActionDef {
  id: ActionId;
  label: string;
  group: ActionGroup;
  /** Defaults use "Mod" = Ctrl on Windows/Linux, ⌘ on macOS. Empty = not assigned. */
  defaults: string[];
  /** Only fires while a terminal has keyboard focus (so text fields keep their own copy/paste). */
  terminalOnly?: boolean;
  /** Only fires while a SQL editor is focused or visible. */
  sqlOnly?: boolean;
  hint?: string;
}

const W = (win: string[], mac: string[]) => (isMac ? mac : win);

const gotoTabs: ActionDef[] = Array.from({ length: 9 }, (_, i) => ({
  id: `tab.goto${i + 1}` as ActionId,
  label: `Go to tab ${i + 1}`,
  group: "Tabs" as const,
  defaults: W([`Alt+${i + 1}`], [`Meta+${i + 1}`]),
}));

export const ACTIONS: ActionDef[] = [
  // App
  { id: "palette.open", label: "Command palette", group: "App", defaults: W(["Ctrl+K", "Ctrl+Shift+P"], ["Meta+K", "Meta+Shift+P"]) },
  { id: "app.lock", label: "Lock app", group: "App", defaults: W(["Ctrl+L", "Ctrl+Shift+L"], ["Meta+L"]) },
  { id: "hostList.toggle", label: "Show / hide host list", group: "App", defaults: W(["Ctrl+B", "Ctrl+Shift+B"], ["Meta+B"]) },
  { id: "settings.open", label: "Open Settings", group: "App", defaults: ["Mod+,"] },
  { id: "shortcuts.open", label: "Open Keyboard shortcuts", group: "App", defaults: [] },
  { id: "page.dashboard", label: "Open Dashboard", group: "App", defaults: [] },
  { id: "page.snippets", label: "Open Snippets", group: "App", defaults: [] },
  { id: "page.hosts", label: "Open Hosts & identities", group: "App", defaults: [] },
  { id: "host.new", label: "New host", group: "App", defaults: [] },
  { id: "quickConnect.focus", label: "Focus quick connect", group: "App", defaults: [] },
  { id: "app.fullscreen", label: "Full screen", group: "App", defaults: ["F11"] },
  { id: "dashboard.sync", label: "Dashboard: sync the selected group", group: "App", defaults: [] },

  // Tabs
  { id: "tab.next", label: "Next tab", group: "Tabs", defaults: ["Ctrl+Tab"] },
  { id: "tab.prev", label: "Previous tab", group: "Tabs", defaults: ["Ctrl+Shift+Tab"] },
  { id: "tab.close", label: "Close tab", group: "Tabs", defaults: ["Mod+Shift+W"] },
  { id: "tab.closeOthers", label: "Close other tabs", group: "Tabs", defaults: [] },
  { id: "tab.reopen", label: "Reopen closed tab", group: "Tabs", defaults: [] },
  { id: "tab.moveLeft", label: "Move tab left", group: "Tabs", defaults: ["Ctrl+Shift+PageUp"] },
  { id: "tab.moveRight", label: "Move tab right", group: "Tabs", defaults: ["Ctrl+Shift+PageDown"] },
  { id: "tab.last", label: "Go to last tab", group: "Tabs", defaults: [] },
  ...gotoTabs,

  // Server views (in the order of the view bar)
  { id: "view.overview", label: "Overview", group: "Server views", defaults: W(["Ctrl+1"], ["Meta+Alt+1"]) },
  { id: "view.terminal", label: "Terminal", group: "Server views", defaults: W(["Ctrl+2"], ["Meta+Alt+2"]) },
  { id: "view.files", label: "Files", group: "Server views", defaults: W(["Ctrl+3"], ["Meta+Alt+3"]) },
  { id: "view.editor", label: "Editor", group: "Server views", defaults: W(["Ctrl+9"], ["Meta+Alt+9"]) },
  { id: "view.docker", label: "Docker", group: "Server views", defaults: W(["Ctrl+4"], ["Meta+Alt+4"]) },
  { id: "view.services", label: "Services", group: "Server views", defaults: W(["Ctrl+5"], ["Meta+Alt+5"]) },
  { id: "view.processes", label: "Processes", group: "Server views", defaults: W(["Ctrl+6"], ["Meta+Alt+6"]) },
  { id: "view.logs", label: "Logs", group: "Server views", defaults: W(["Ctrl+7"], ["Meta+Alt+7"]) },
  { id: "view.database", label: "Database", group: "Server views", defaults: W(["Ctrl+8"], ["Meta+Alt+8"]) },
  { id: "view.filesPanel", label: "Files panel next to the terminal", group: "Server views", defaults: ["Mod+Shift+E"] },

  // Terminal
  { id: "term.new", label: "New terminal on this server", group: "Terminal", defaults: ["Mod+Shift+T"] },
  { id: "term.closeCurrent", label: "Close this terminal", group: "Terminal", defaults: [] },
  { id: "term.next", label: "Next terminal on this server", group: "Terminal", defaults: [] },
  { id: "term.prev", label: "Previous terminal on this server", group: "Terminal", defaults: [] },
  { id: "term.reconnect", label: "Reconnect ended terminal", group: "Terminal", defaults: [], terminalOnly: true },
  { id: "term.clear", label: "Clear scrollback", group: "Terminal", defaults: ["Mod+Shift+K"], terminalOnly: true },
  { id: "term.reset", label: "Reset terminal (fix garbled screen)", group: "Terminal", defaults: [], terminalOnly: true },
  { id: "term.broadcast", label: "Broadcast on / off", group: "Terminal", defaults: [] },
  { id: "term.sudoFill", label: "Fill sudo password", group: "Terminal", defaults: [], terminalOnly: true },
  { id: "local.new", label: "New local terminal (first shell)", group: "Terminal", defaults: [] },

  // Copy & paste
  { id: "term.copy", label: "Copy selection", group: "Copy & paste", defaults: W(["Ctrl+Shift+C", "Ctrl+Insert"], ["Meta+C"]), terminalOnly: true },
  { id: "term.paste", label: "Paste", group: "Copy & paste", defaults: W(["Ctrl+Shift+V", "Shift+Insert"], ["Meta+V"]), terminalOnly: true },
  { id: "term.selectAll", label: "Select all", group: "Copy & paste", defaults: ["Mod+Shift+A"], terminalOnly: true },
  { id: "term.copyAll", label: "Copy all terminal text", group: "Copy & paste", defaults: [], terminalOnly: true },

  // Scroll & find
  { id: "term.find", label: "Find in terminal", group: "Scroll & find", defaults: ["Mod+Shift+F"], terminalOnly: true },
  { id: "term.findNext", label: "Find next", group: "Scroll & find", defaults: ["F3"], terminalOnly: true },
  { id: "term.findPrev", label: "Find previous", group: "Scroll & find", defaults: ["Shift+F3"], terminalOnly: true },
  { id: "term.scrollTop", label: "Scroll to top", group: "Scroll & find", defaults: ["Ctrl+Shift+Home"], terminalOnly: true },
  { id: "term.scrollBottom", label: "Scroll to bottom", group: "Scroll & find", defaults: ["Ctrl+Shift+End"], terminalOnly: true },
  { id: "term.pageUp", label: "Scroll one page up", group: "Scroll & find", defaults: ["Shift+PageUp"], terminalOnly: true },
  { id: "term.pageDown", label: "Scroll one page down", group: "Scroll & find", defaults: ["Shift+PageDown"], terminalOnly: true },
  { id: "term.lineUp", label: "Scroll one line up", group: "Scroll & find", defaults: ["Ctrl+Shift+Up"], terminalOnly: true },
  { id: "term.lineDown", label: "Scroll one line down", group: "Scroll & find", defaults: ["Ctrl+Shift+Down"], terminalOnly: true },

  // Font size
  { id: "term.zoomIn", label: "Bigger font", group: "Font size", defaults: ["Mod+="] },
  { id: "term.zoomOut", label: "Smaller font", group: "Font size", defaults: ["Mod+-"] },
  { id: "term.zoomReset", label: "Reset font size", group: "Font size", defaults: ["Mod+0"] },

  // Files
  { id: "files.copyPath", label: "Copy current folder path", group: "Files", defaults: [] },
  { id: "files.upload", label: "Upload files to current folder", group: "Files", defaults: [] },
  { id: "files.refresh", label: "Refresh file list", group: "Files", defaults: [] },
  // SQL editor
  { id: "sql.run", label: "Run statement at cursor (or the selection)", group: "SQL", defaults: ["Mod+Enter"], sqlOnly: true },
  { id: "sql.runAll", label: "Run everything in the editor", group: "SQL", defaults: ["Mod+Shift+Enter"], sqlOnly: true },
  { id: "sql.cancel", label: "Cancel the running query", group: "SQL", defaults: ["Mod+."], sqlOnly: true },
  { id: "sql.toggleTree", label: "Show / hide the schema tree", group: "SQL", defaults: [], sqlOnly: true },
];

export const ACTION_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a])) as Record<ActionId, ActionDef>;
