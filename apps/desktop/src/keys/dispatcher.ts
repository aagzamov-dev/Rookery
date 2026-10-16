// One keydown listener (capture phase) for every shortcut in the app.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { activeServerHostId, closeTab, lockApp, cycleTab } from "../app/tabActions";
import { useLocalShells } from "../features/local/LocalTab";
import { terminalRegistry } from "../features/server-tab/terminal/registry";
import { sqlRegistry } from "../features/sql/registry";
import { findAlias, resolveCommand, runSnippet } from "../features/snippets/run";
import { copyText } from "../ipc/clipboard";
import { useFiles } from "../stores/files";
import type { Group } from "../ipc/bindings/Group";
import type { Host } from "../ipc/bindings/Host";
import { useHosts } from "../stores/hosts";
import { decodeKeyText, DEFAULT_TERMINAL_PREFS, useKeys } from "../stores/keys";
import { appliesTo, useSnippets } from "../stores/snippets";
import { useTabs, type View } from "../stores/tabs";
import { useTermUi } from "../stores/termui";
import { useUi } from "../stores/ui";
import { useVault } from "../stores/vault";
import { useSync } from "../stores/sync";
import { ACTION_BY_ID, ACTIONS, type ActionId } from "./actions";
import { eventToChord, isMac, normalizeChord } from "./chord";

/** Hooks the shell provides (things that live in React state). */
export const shellHooks: {
  newHost: () => void;
  focusQuickConnect: () => void;
  uploadFiles: (hostId: string) => void;
  editHost: (host: Host) => void;
  editGroup: (group: Group) => void;
  openImport: () => void;
} = {
  newHost: () => {},
  editHost: () => {},
  editGroup: () => {},
  openImport: () => {},
  focusQuickConnect: () => {},
  uploadFiles: () => {},
};

const VIEW_OF: Partial<Record<ActionId, View>> = {
  "view.overview": "overview",
  "view.terminal": "terminal",
  "view.files": "files",
  "view.docker": "docker",
  "view.services": "services",
  "view.processes": "processes",
  "view.logs": "logs",
  "view.database": "database",
};

/** The terminal a terminal-action applies to: the focused one, else the active tab's. */
export function activeTerminalKey(termKey: string | null): string | null {
  if (termKey) return termKey;
  const { tabs, activeTabId, views } = useTabs.getState();
  const t = tabs.find((x) => x.id === activeTabId);
  if (t?.kind === "local") return t.id;
  if (t?.kind === "server") return views[t.hostId]?.activeTerminal ?? null;
  return null;
}

export function runAction(id: ActionId, termKey: string | null) {
  const tabs = useTabs.getState();
  const hostId = activeServerHostId();
  const term = activeTerminalKey(termKey);
  if (id.startsWith("sql.")) {
    const key = sqlRegistry.activeKey();
    const h = key ? sqlRegistry.get(key) : undefined;
    if (!h) return;
    if (id === "sql.run") h.run("current");
    else if (id === "sql.runAll") h.run("all");
    else if (id === "sql.cancel") h.cancel();
    else if (id === "sql.toggleTree") h.toggleTree();
    return;
  }
  const view = VIEW_OF[id];
  if (view) {
    if (hostId) tabs.setView(hostId, view);
    return;
  }
  const gotoN = /^tab\.goto(\d)$/.exec(id);
  if (gotoN) {
    const t = tabs.tabs[Number(gotoN[1]) - 1];
    if (t) tabs.activate(t.id);
    return;
  }
  switch (id) {
    // app
    case "palette.open":
      useUi.getState().setPaletteOpen(!useUi.getState().paletteOpen);
      break;
    case "app.lock":
      void lockApp();
      break;
    case "hostList.toggle":
      useUi.getState().toggleHostList();
      break;
    case "settings.open":
      tabs.openPage("settings");
      break;
    case "shortcuts.open":
      tabs.openPage("shortcuts");
      break;
    case "page.dashboard":
      tabs.openPage("dashboard");
      break;
    case "page.snippets":
      tabs.openPage("snippets");
      break;
    case "page.hosts":
      tabs.openPage("hosts");
      break;
    case "host.new":
      shellHooks.newHost();
      break;
    case "quickConnect.focus":
      shellHooks.focusQuickConnect();
      break;
    case "dashboard.sync": {
      const t = useSync.getState().tab;
      void useSync.getState().run(t === "all" ? { kind: "all" } : { kind: "group", id: t }).catch(() => {});
      useTabs.getState().openPage("dashboard");
      break;
    }
    case "app.fullscreen": {
      const w = getCurrentWindow();
      void w.isFullscreen().then((f) => w.setFullscreen(!f));
      break;
    }
    // tabs
    case "tab.next":
      cycleTab(1);
      break;
    case "tab.prev":
      cycleTab(-1);
      break;
    case "tab.close": {
      const t = tabs.tabs.find((x) => x.id === tabs.activeTabId);
      if (t) closeTab(t);
      break;
    }
    case "tab.closeOthers":
      for (const t of tabs.tabs) if (t.id !== tabs.activeTabId) closeTab(t);
      break;
    case "tab.reopen": {
      const t = tabs.popClosed();
      if (t?.kind === "server") tabs.openServer(t.hostId);
      else if (t?.kind === "page") tabs.openPage(t.page);
      else if (t?.kind === "local") tabs.openLocal(t.shellId, t.title);
      else if (t?.kind === "db") tabs.openDb(t.target, t.title, true);
      break;
    }
    case "tab.moveLeft":
      if (tabs.activeTabId) tabs.move(tabs.activeTabId, -1);
      break;
    case "tab.moveRight":
      if (tabs.activeTabId) tabs.move(tabs.activeTabId, 1);
      break;
    case "tab.last": {
      const t = tabs.tabs[tabs.tabs.length - 1];
      if (t) tabs.activate(t.id);
      break;
    }
    case "view.filesPanel":
      if (hostId) {
        const open = useFiles.getState().byHost[hostId]?.panelOpen ?? false;
        tabs.setView(hostId, "terminal");
        useFiles.getState().patch(hostId, { panelOpen: !open });
      }
      break;
    // terminal
    case "term.new":
      if (hostId) tabs.addTerminal(hostId);
      break;
    case "term.closeCurrent":
      if (hostId && term) {
        terminalRegistry.dispose(term);
        tabs.closeTerminal(hostId, term);
      }
      break;
    case "term.next":
    case "term.prev":
      if (hostId) {
        const v = tabs.views[hostId];
        if (v && v.terminals.length > 1) {
          const i = v.terminals.findIndex((t) => t.key === v.activeTerminal);
          const n = v.terminals.length;
          const next = v.terminals[(i + (id === "term.next" ? 1 : -1) + n) % n];
          tabs.setActiveTerminal(hostId, next.key);
          setTimeout(() => terminalRegistry.focus(next.key), 30);
        }
      }
      break;
    case "term.reconnect":
      if (term) terminalRegistry.reconnect(term);
      break;
    case "term.clear":
      if (term) terminalRegistry.clear(term);
      break;
    case "term.reset":
      if (term) terminalRegistry.reset(term);
      break;
    case "term.broadcast": {
      const bc = useTermUi.getState().broadcast;
      useTermUi.getState().setBroadcast(bc.mode === "off" ? "tab" : bc.mode === "tab" ? "all" : "off", hostId);
      break;
    }
    case "term.sudoFill":
      if (term) void terminalRegistry.sudoFill(term);
      break;
    case "local.new": {
      const sh = useLocalShells.getState().shells?.[0];
      if (sh) tabs.openLocal(sh.id, sh.label);
      break;
    }
    // copy & paste
    case "term.copy":
      if (term) void terminalRegistry.copySelection(term).then((ok) => ok && terminalRegistry.clearSelection(term));
      break;
    case "term.paste":
      if (term) void terminalRegistry.pasteFromClipboard(term);
      break;
    case "term.selectAll":
      if (term) terminalRegistry.selectAll(term);
      break;
    case "term.copyAll":
      if (term) {
        terminalRegistry.selectAll(term);
        void terminalRegistry.copySelection(term).then(() => terminalRegistry.clearSelection(term));
      }
      break;
    // scroll & find
    case "term.find":
      if (term) useTermUi.getState().setFind(term, true);
      break;
    case "term.findNext":
    case "term.findPrev":
      if (term) {
        const last = useTermUi.getState().lastFind[term];
        if (last?.q) terminalRegistry.find(term, last.q, { caseSensitive: last.caseSensitive, regex: last.regex, backwards: id === "term.findPrev" });
        else useTermUi.getState().setFind(term, true);
      }
      break;
    case "term.scrollTop":
      if (term) terminalRegistry.scroll(term, "top");
      break;
    case "term.scrollBottom":
      if (term) terminalRegistry.scroll(term, "bottom");
      break;
    case "term.pageUp":
      if (term) terminalRegistry.scroll(term, "pageUp");
      break;
    case "term.pageDown":
      if (term) terminalRegistry.scroll(term, "pageDown");
      break;
    case "term.lineUp":
      if (term) terminalRegistry.scroll(term, "lineUp");
      break;
    case "term.lineDown":
      if (term) terminalRegistry.scroll(term, "lineDown");
      break;
    // font
    case "term.zoomIn":
      void useKeys.getState().setTerminal({ fontSize: useKeys.getState().terminal.fontSize + 1 });
      break;
    case "term.zoomOut":
      void useKeys.getState().setTerminal({ fontSize: useKeys.getState().terminal.fontSize - 1 });
      break;
    case "term.zoomReset":
      void useKeys.getState().setTerminal({ fontSize: DEFAULT_TERMINAL_PREFS.fontSize });
      break;
    // files
    case "files.copyPath": {
      const p = hostId ? useFiles.getState().byHost[hostId]?.path : null;
      if (p) void copyText(p);
      break;
    }
    case "files.upload":
      if (hostId) shellHooks.uploadFiles(hostId);
      break;
    case "files.refresh":
      if (hostId) void useFiles.getState().refresh(hostId);
      break;
  }
}

export function actionForChord(chord: string, bindings: Record<ActionId, string[]>): ActionId | null {
  for (const a of ACTIONS) if (bindings[a.id].includes(chord)) return a.id;
  return null;
}

export function shellOwnsChord(chord: string, inTerminal: boolean): boolean {
  return inTerminal && !isMac && /^Ctrl\+[A-Z]$/.test(chord);
}

/** Chords the user chose (custom shortcut, custom key or snippet hotkey) win over the shell. Defaults don't. */
export function isUserBound(chord: string): boolean {
  const { overrides, customKeys } = useKeys.getState();
  if (Object.values(overrides).some((list) => list?.some((c) => normalizeChord(c) === chord))) return true;
  if (customKeys.some((k) => k.chord === chord)) return true;
  return useSnippets.getState().list.some((s) => s.hotkey && normalizeChord(s.hotkey) === chord);
}

const stop = (e: KeyboardEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

export function installKeyDispatcher(): () => void {
  // alias + Tab in the terminal → expand to the snippet's command (the user still presses Enter)
  terminalRegistry.setAliasHandler(({ hostId, key, alias, erase }) => {
    const s = findAlias(hostId, alias);
    if (!s) return false;
    void (async () => {
      const cmd = await resolveCommand(s, useHosts.getState().hostById(hostId)?.name);
      if (cmd != null) terminalRegistry.replaceInput(key, erase, cmd);
      terminalRegistry.focus(key);
    })();
    return true;
  });

  const onKey = (e: KeyboardEvent) => {
    const keys = useKeys.getState();
    if (keys.recording || !useVault.getState().status?.unlocked) return;
    const chord = eventToChord(e);
    if (!chord) return;
    const termKey = terminalRegistry.keyForElement(document.activeElement);
    const prefs = keys.terminal;

    if (termKey) {
      if (prefs.ctrlCCopies && chord === "Ctrl+C" && terminalRegistry.hasSelection(termKey)) {
        stop(e);
        void terminalRegistry.copySelection(termKey).then(() => terminalRegistry.clearSelection(termKey));
        return; // without a selection Ctrl+C reaches the shell as usual (interrupt)
      }
      if (prefs.ctrlVPastes && chord === "Ctrl+V") {
        stop(e);
        void terminalRegistry.pasteFromClipboard(termKey);
        return;
      }
    }

    // Windows/Linux: inside a terminal, plain Ctrl+letter belongs to the shell
    // (Ctrl+L clear, Ctrl+K kill line, Ctrl+B tmux…) — unless the user bound it themselves.
    if (shellOwnsChord(chord, !!termKey) && !isUserBound(chord)) return;

    // Custom keys: type text into the active terminal (macros).
    const custom = keys.customKeys.find((k) => k.chord === chord);
    if (custom) {
      const target = activeTerminalKey(termKey);
      if (target) {
        stop(e);
        terminalRegistry.sendRaw(target, decodeKeyText(custom.text));
        terminalRegistry.focus(target);
      }
      return;
    }

    const action = actionForChord(chord, keys.bindings);
    if (action) {
      if (ACTION_BY_ID[action].terminalOnly && !termKey) return; // text fields keep native copy/paste
      if (ACTION_BY_ID[action].sqlOnly && !sqlRegistry.activeKey()) return;
      stop(e);
      runAction(action, termKey);
      return;
    }

    const hostId = activeServerHostId();
    if (!hostId) return;
    const host = useHosts.getState().hostById(hostId);
    const groups = useHosts.getState().groups;
    const snippet = useSnippets
      .getState()
      .list.find((s) => s.hotkey && normalizeChord(s.hotkey) === chord && appliesTo(s, host, groups));
    if (snippet) {
      stop(e);
      void runSnippet(snippet, hostId);
    }
  };

  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
