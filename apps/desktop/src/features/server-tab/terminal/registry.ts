// xterm instances live here, outside React, so switching tabs/views never
// destroys a terminal or its scrollback (docs/01-ARCHITECTURE.md §5.2).
// Handles SSH terminals and local terminal tabs the same way.
import { Terminal, type IMarker, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { api, asCoreError } from "../../../ipc/api";
import { copyText, readClipboard } from "../../../ipc/clipboard";
import { askConfirm } from "../../../stores/dialogs";
import { useFiles } from "../../../stores/files";
import { useHosts } from "../../../stores/hosts";
import { useKeys } from "../../../stores/keys";
import { useTermUi } from "../../../stores/termui";
import { resolveTheme } from "./themes";
import { compileTriggers, scanTerminal } from "./triggers";

export const SCROLLBACK = 10_000;

export interface TermOptions {
  cwd?: string;
  container?: string;
  /** Local terminal tab: id of a shell from `local_shells`. */
  localShell?: string;
}

/** Called on Tab when the current input line is a single word. Return true if handled. */
export type AliasHandler = (ctx: { hostId: string; key: string; alias: string; erase: number }) => boolean;

interface Entry {
  key: string;
  hostId: string;
  opts: TermOptions;
  local: boolean;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  opened: boolean;
  termId: string | null;
  connecting: boolean;
  exited: boolean;
  visible: boolean;
  /** Input typed since the last Enter; null when unknown (arrows, history, completion). */
  lineBuf: string | null;
  /** Input waiting for the channel to open. */
  pending: string;
  /** Long-command notification: when Enter was pressed and what was typed. */
  cmdStart: number | null;
  cmdText: string | null;
  /** Shell integration v2 reports exit codes (OSC 133;D). */
  has133: boolean;
  /** Triggers: where scanning continues (a marker survives scrollback trimming). */
  scanMarker: IMarker | null;
  /** Trigger id → last notification time (one per 30 s). */
  trigNotified: Record<string, number>;
}

const decodeB64 = (b64: string) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const PRINTABLE = /^[^\x00-\x1f\x7f]+$/;
const SUDO_PROMPT = /\[sudo[^\]\n]*\][^\r\n]*:\s*$/;

let notifyAllowed: boolean | null = null;
async function notify(title: string, body: string) {
  try {
    if (notifyAllowed === null) {
      notifyAllowed = await isPermissionGranted();
      if (!notifyAllowed) notifyAllowed = (await requestPermission()) === "granted";
    }
    if (notifyAllowed) sendNotification({ title, body });
  } catch {
    /* notifications unavailable */
  }
}

const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

class TerminalRegistry {
  private byKey = new Map<string, Entry>();
  private byTermId = new Map<string, Entry>();
  /** Input for terminals whose pane has not mounted yet (e.g. a snippet opening a new terminal). */
  private queued = new Map<string, string>();
  private aliasHandler: AliasHandler | null = null;
  private utf8 = new TextDecoder();

  constructor() {
    useKeys.subscribe((s, prev) => {
      const a = s.terminal;
      const b = prev.terminal;
      if (
        a.fontSize !== b.fontSize ||
        a.fontFamily !== b.fontFamily ||
        a.theme !== b.theme ||
        a.cursorStyle !== b.cursorStyle ||
        a.cursorBlink !== b.cursorBlink ||
        s.customThemes !== prev.customThemes
      )
        this.applyOptions();
    });
    // A host's own theme may change in the host editor.
    useHosts.subscribe((s, prev) => {
      if (s.hosts !== prev.hosts) this.applyOptions();
    });
  }

  setAliasHandler(h: AliasHandler) {
    this.aliasHandler = h;
  }

  private themeFor(hostId: string): ITheme {
    const { terminal, customThemes } = useKeys.getState();
    const host = useHosts.getState().hostById(hostId);
    return resolveTheme(host?.theme || terminal.theme, customThemes);
  }

  private applyOptions() {
    const t = useKeys.getState().terminal;
    for (const e of this.byKey.values()) {
      e.term.options.fontSize = t.fontSize;
      e.term.options.fontFamily = t.fontFamily;
      e.term.options.cursorStyle = t.cursorStyle;
      e.term.options.cursorBlink = t.cursorBlink;
      e.term.options.theme = this.themeFor(e.hostId);
      e.el.style.background = e.term.options.theme.background ?? "";
      this.fit(e.key);
    }
  }

  /** Mount (or re-mount) the terminal for `key` into `container`. Idempotent. */
  attach(key: string, hostId: string, container: HTMLElement, opts: TermOptions) {
    let e = this.byKey.get(key);
    if (!e) {
      e = this.create(key, hostId, opts);
      this.byKey.set(key, e);
    }
    if (e.el.parentElement !== container) container.appendChild(e.el);
    if (!e.opened) {
      e.term.open(e.el);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        e.term.loadAddon(webgl);
      } catch {
        /* falls back to the DOM renderer */
      }
      e.opened = true;
      this.fit(key);
      void this.connect(e);
    }
  }

  private create(key: string, hostId: string, opts: TermOptions): Entry {
    const prefs = useKeys.getState().terminal;
    const theme = this.themeFor(hostId);
    const term = new Terminal({
      fontFamily: prefs.fontFamily,
      fontSize: prefs.fontSize,
      lineHeight: 1.2,
      cursorBlink: prefs.cursorBlink,
      cursorStyle: prefs.cursorStyle,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
      overviewRulerWidth: 8, // trigger marks in the scrollbar
      theme,
      rightClickSelectsWord: false,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";

    const el = document.createElement("div");
    el.style.height = "100%";
    el.style.width = "100%";
    el.style.background = theme.background ?? "";

    const entry: Entry = {
      key,
      hostId,
      opts,
      local: !!opts.localShell,
      term,
      fit,
      search,
      el,
      opened: false,
      termId: null,
      connecting: false,
      exited: false,
      visible: false,
      lineBuf: "",
      pending: this.queued.get(key) ?? "",
      cmdStart: null,
      cmdText: null,
      has133: false,
      scanMarker: null,
      trigNotified: {},
    };
    this.queued.delete(key);

    term.onData((data) => {
      if (entry.exited) {
        if (data === "\r") void this.connect(entry);
        return;
      }
      useTermUi.getState().setSudo(key, false);
      if (data === "\t" && entry.lineBuf && this.aliasHandler && !entry.local) {
        const alias = entry.lineBuf.trim();
        if (alias && !/\s/.test(alias) && this.aliasHandler({ hostId, key, alias, erase: entry.lineBuf.length })) {
          entry.lineBuf = null;
          return;
        }
      }
      if (data.includes("\r")) {
        const typed = entry.lineBuf;
        entry.cmdStart = typed === "" ? null : Date.now();
        entry.cmdText = typed?.trim() || null;
      }
      trackLine(entry, data);
      this.send(entry, data);
      this.broadcastFrom(entry, data);
    });
    term.onResize(({ cols, rows }) => {
      if (!entry.termId) return;
      if (entry.local) void api.localTermResize(entry.termId, cols, rows);
      else void api.termResize(entry.termId, cols, rows);
    });

    // OSC 7 (file://host/path) from shell integration → the Files panel can follow `cd`.
    term.parser.registerOscHandler(7, (data) => {
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      if (m && !entry.local) {
        try {
          useFiles.getState().setTerminalCwd(hostId, decodeURIComponent(m[1]));
        } catch {
          /* malformed escape */
        }
      }
      if (!entry.has133) this.commandFinished(entry, null);
      return true;
    });
    // OSC 133;D;<exit> (shell integration v2) → command finished with exit code.
    term.parser.registerOscHandler(133, (data) => {
      const m = /^D(?:;(-?\d+))?/.exec(data);
      if (m) {
        entry.has133 = true;
        this.commandFinished(entry, m[1] != null ? Number(m[1]) : null);
      }
      return true;
    });

    // Copy on select (debounced while dragging).
    let selTimer: ReturnType<typeof setTimeout> | null = null;
    term.onSelectionChange(() => {
      if (!useKeys.getState().terminal.copyOnSelect) return;
      if (selTimer) clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        if (term.hasSelection()) void copyText(term.getSelection()).catch(() => {});
      }, 150);
    });

    // Any native paste (menu, platform shortcut) goes through the same warning.
    el.addEventListener(
      "paste",
      (ev) => {
        const text = ev.clipboardData?.getData("text/plain");
        ev.preventDefault();
        ev.stopPropagation();
        if (text) void this.pasteText(key, text);
      },
      true,
    );

    // Right-click: copy if something is selected, otherwise paste.
    el.addEventListener("contextmenu", (ev) => {
      if (!useKeys.getState().terminal.rightClickPastes) return;
      ev.preventDefault();
      if (term.hasSelection()) {
        void this.copySelection(key);
        term.clearSelection();
      } else {
        void this.pasteFromClipboard(key);
      }
    });

    return entry;
  }

  private write(e: Entry, data: string) {
    if (!e.termId) return;
    if (e.local) void api.localTermWrite(e.termId, data);
    else void api.termWrite(e.termId, data);
  }

  private send(e: Entry, data: string) {
    if (e.termId) this.write(e, data);
    else e.pending += data;
  }

  /** Broadcast: mirror typed input to the other terminals in scope. */
  private broadcastFrom(src: Entry, data: string) {
    const bc = useTermUi.getState().broadcast;
    if (bc.mode === "off") return;
    if (bc.mode === "tab" && src.hostId !== bc.hostId) return;
    for (const e of this.byKey.values()) {
      if (e === src || e.exited || !e.termId) continue;
      if (bc.mode === "tab" && e.hostId !== bc.hostId) continue;
      this.write(e, data);
    }
  }

  broadcastTargets(): number {
    const bc = useTermUi.getState().broadcast;
    if (bc.mode === "off") return 0;
    let n = 0;
    for (const e of this.byKey.values()) if (!e.exited && e.termId && (bc.mode === "all" || e.hostId === bc.hostId)) n++;
    return n;
  }

  private commandFinished(e: Entry, code: number | null) {
    const started = e.cmdStart;
    const cmd = e.cmdText;
    e.cmdStart = null;
    e.cmdText = null;
    if (started == null) return;
    const prefs = useKeys.getState().terminal;
    const took = Date.now() - started;
    if (!prefs.notifyLongCommands || took < prefs.notifyAfterSec * 1000) return;
    if (document.hasFocus() && e.visible) return; // you're looking at it
    const where = e.local ? "this computer" : (useHosts.getState().hostById(e.hostId)?.name ?? "server");
    const status = code == null ? "Finished" : code === 0 ? "✓ Finished" : `✗ Failed (exit ${code})`;
    void notify(`${status} on ${where}`, `${cmd ?? "command"} · ${fmtDuration(took)}`);
  }

  private async connect(e: Entry) {
    if (e.connecting || e.termId) return;
    e.connecting = true;
    e.exited = false;
    try {
      const termId = e.local
        ? await api.localTermOpen(e.opts.localShell!, e.term.cols, e.term.rows)
        : await api.termOpen({
            host_id: e.hostId,
            cols: e.term.cols,
            rows: e.term.rows,
            cwd: e.opts.cwd ?? null,
            container: e.opts.container ?? null,
            log: !!useHosts.getState().hostById(e.hostId)?.log_session || useKeys.getState().app.logSessions,
          });
      if (!this.byKey.has(e.key)) {
        if (e.local) void api.localTermClose(termId);
        else void api.termClose(termId); // disposed while opening
        return;
      }
      e.termId = termId;
      e.lineBuf = "";
      this.byTermId.set(termId, e);
      if (e.pending) {
        const p = e.pending;
        e.pending = "";
        this.write(e, p);
      }
    } catch (err) {
      const ce = asCoreError(err);
      e.exited = true;
      e.term.write(`\r\n\x1b[31m${ce.message}\x1b[0m\r\n\x1b[90mPress Enter to retry\x1b[0m\r\n`);
    } finally {
      e.connecting = false;
    }
  }

  onData(termId: string, b64: string) {
    const e = this.byTermId.get(termId);
    if (!e) return;
    const bytes = decodeB64(b64);
    e.term.write(bytes, () => this.runTriggers(e));
    if (!e.local) {
      // "[sudo] password for deploy:" → offer to fill it from the vault.
      const tail = this.utf8.decode(bytes.length > 400 ? bytes.subarray(bytes.length - 400) : bytes);
      if (SUDO_PROMPT.test(tail)) useTermUi.getState().setSudo(e.key, true);
      else if (tail.trim()) useTermUi.getState().setSudo(e.key, false);
    }
  }

  /** Highlight new lines that match a trigger; notify when you are elsewhere. */
  private runTriggers(e: Entry) {
    const prefs = useKeys.getState().terminal;
    if (!prefs.highlightTriggers) return;
    const triggers = compileTriggers(prefs.triggers);
    if (!triggers.length) return;
    const buf = e.term.buffer.active;
    const from = e.scanMarker && !e.scanMarker.isDisposed ? e.scanMarker.line : buf.baseY;
    const next = scanTerminal(e.term, from, triggers, (c, line) => {
      if (!c.t.notify || (document.hasFocus() && e.visible)) return;
      const now = Date.now();
      if (now - (e.trigNotified[c.t.id] ?? 0) < 30_000) return;
      e.trigNotified[c.t.id] = now;
      const where = e.local ? "this computer" : (useHosts.getState().hostById(e.hostId)?.name ?? "server");
      void notify(`Trigger on ${where}`, line.trim().slice(0, 180));
    });
    if (!e.scanMarker || e.scanMarker.isDisposed || e.scanMarker.line !== next) {
      e.scanMarker?.dispose();
      e.scanMarker = e.term.registerMarker(next - (buf.baseY + buf.cursorY)) ?? null;
    }
  }

  onExit(termId: string, code: number | null, reason: string | null) {
    const e = this.byTermId.get(termId);
    if (!e) return;
    this.byTermId.delete(termId);
    e.termId = null;
    e.exited = true;
    useTermUi.getState().setSudo(e.key, false);
    const why = reason ?? (code != null ? `exit ${code}` : "closed");
    e.term.write(`\r\n\x1b[90m[${e.local ? "shell" : "session"} ended: ${why} — press Enter to start again]\x1b[0m\r\n`);
  }

  // ------------------------------------------------------------ input helpers

  /** Type text at the prompt without pressing Enter (bracketed paste when the shell supports it). */
  typeText(key: string, text: string) {
    const e = this.byKey.get(key);
    if (e?.termId) {
      e.term.paste(text);
      e.lineBuf = null;
    } else if (e) {
      e.pending += text;
    } else {
      this.queued.set(key, (this.queued.get(key) ?? "") + text);
    }
  }

  /** Send raw input (custom keys / macros). */
  sendRaw(key: string, data: string) {
    const e = this.byKey.get(key);
    if (!e) return;
    trackLine(e, data);
    this.send(e, data);
    this.broadcastFrom(e, data);
  }

  /** Type a command and press Enter. */
  runCommand(key: string, command: string) {
    const raw = command.replace(/\r?\n/g, "\r") + "\r";
    const e = this.byKey.get(key);
    if (e) {
      e.cmdStart = Date.now();
      e.cmdText = command.split("\n")[0];
      this.send(e, raw);
      e.lineBuf = "";
    } else {
      this.queued.set(key, (this.queued.get(key) ?? "") + raw);
    }
  }

  /** Erase `erase` characters before the cursor, then type `text` (alias expansion). */
  replaceInput(key: string, erase: number, text: string) {
    const e = this.byKey.get(key);
    if (!e) return;
    if (erase > 0) this.send(e, "\x7f".repeat(erase));
    this.typeText(key, text);
  }

  async sudoFill(key: string) {
    const e = this.byKey.get(key);
    if (!e?.termId || e.local) return;
    useTermUi.getState().setSudo(key, false);
    try {
      await api.termSudoFill(e.termId);
    } catch (err) {
      e.term.write(`\r\n\x1b[33m${asCoreError(err).message}\x1b[0m\r\n`);
    }
    e.term.focus();
  }

  // ---------------------------------------------------------------- clipboard

  hasSelection(key: string): boolean {
    return !!this.byKey.get(key)?.term.hasSelection();
  }

  async copySelection(key: string): Promise<boolean> {
    const e = this.byKey.get(key);
    const sel = e?.term.getSelection();
    if (!sel) return false;
    await copyText(sel);
    return true;
  }

  async pasteFromClipboard(key: string) {
    let text: string | null = null;
    try {
      text = await readClipboard();
    } catch (err) {
      this.byKey.get(key)?.term.write(`\r\n\x1b[33m${(err as Error).message}\x1b[0m\r\n`);
      text = null;
    }
    if (text) await this.pasteText(key, text);
  }

  /** Paste with the multi-line warning (docs/03 §3.4). */
  async pasteText(key: string, text: string) {
    const e = this.byKey.get(key);
    if (!e || !text) return;
    const normalized = text.replace(/\r\n?/g, "\n");
    const lines = normalized.replace(/\n+$/, "").split("\n");
    if (lines.length > 1 && useKeys.getState().terminal.warnMultilinePaste) {
      const host = useHosts.getState().hostById(e.hostId);
      const prod = host?.env_label === "prod";
      const ok = await askConfirm({
        title: `Paste ${lines.length} lines into ${host?.name ?? "this terminal"}?`,
        body: prod ? "This is a PRODUCTION server. Each line may run as a separate command." : "Each line may run as a separate command.",
        preview: normalized.length > 4000 ? `${normalized.slice(0, 4000)}\n…` : normalized,
        confirmLabel: `Paste ${lines.length} lines`,
        danger: prod,
      });
      if (!ok) {
        e.term.focus();
        return;
      }
    }
    e.term.paste(normalized);
    e.lineBuf = null;
    e.term.focus();
  }

  // --------------------------------------------------------------- find

  find(key: string, q: string, opts: ISearchOptions & { backwards?: boolean } = {}): boolean {
    const e = this.byKey.get(key);
    if (!e || !q) return false;
    const o: ISearchOptions = {
      ...opts,
      decorations: { matchOverviewRuler: "#F2BA45", activeMatchColorOverviewRuler: "#8AB4FF", matchBackground: "#4A5570", activeMatchBackground: "#34507E" },
    };
    return opts.backwards ? e.search.findPrevious(q, o) : e.search.findNext(q, o);
  }

  clearFind(key: string) {
    const e = this.byKey.get(key);
    e?.search.clearDecorations();
    e?.term.clearSelection();
  }

  // ------------------------------------------------------------------- misc

  clearSelection(key: string) {
    this.byKey.get(key)?.term.clearSelection();
  }

  selectAll(key: string) {
    this.byKey.get(key)?.term.selectAll();
  }

  clear(key: string) {
    this.byKey.get(key)?.term.clear();
  }

  reset(key: string) {
    this.byKey.get(key)?.term.reset();
  }

  scroll(key: string, how: "top" | "bottom" | "pageUp" | "pageDown" | "lineUp" | "lineDown") {
    const t = this.byKey.get(key)?.term;
    if (!t) return;
    if (how === "top") t.scrollToTop();
    else if (how === "bottom") t.scrollToBottom();
    else if (how === "pageUp") t.scrollPages(-1);
    else if (how === "pageDown") t.scrollPages(1);
    else if (how === "lineUp") t.scrollLines(-1);
    else t.scrollLines(1);
  }

  isExited(key: string): boolean {
    return !!this.byKey.get(key)?.exited;
  }

  reconnect(key: string) {
    const e = this.byKey.get(key);
    if (e && e.exited) void this.connect(e);
  }

  setVisible(key: string, v: boolean) {
    const e = this.byKey.get(key);
    if (e) e.visible = v;
  }

  fit(key: string) {
    const e = this.byKey.get(key);
    if (!e || !e.opened || !e.el.isConnected || e.el.clientWidth === 0) return;
    try {
      e.fit.fit();
    } catch {
      /* not visible yet */
    }
  }

  focus(key: string) {
    this.byKey.get(key)?.term.focus();
  }

  /** The terminal key whose DOM contains `node` (used to know if a terminal has focus). */
  keyForElement(node: Element | null): string | null {
    if (!node) return null;
    for (const e of this.byKey.values()) if (e.el.contains(node)) return e.key;
    return null;
  }

  dispose(key: string) {
    const e = this.byKey.get(key);
    this.queued.delete(key);
    if (!e) return;
    this.byKey.delete(key);
    if (e.termId) {
      this.byTermId.delete(e.termId);
      if (e.local) void api.localTermClose(e.termId);
      else void api.termClose(e.termId);
    }
    e.term.dispose();
    e.el.remove();
  }

  disposeHost(hostId: string) {
    for (const [k, e] of [...this.byKey]) if (e.hostId === hostId) this.dispose(k);
  }
}

/** Best-effort mirror of the current input line, for alias + Tab. */
function trackLine(e: Entry, data: string) {
  if (data === "\r" || data === "\x03" || data === "\x15" || data === "\x04") e.lineBuf = "";
  else if (data === "\x7f" || data === "\b") e.lineBuf = e.lineBuf === null ? null : e.lineBuf.slice(0, -1);
  else if (PRINTABLE.test(data)) e.lineBuf = e.lineBuf === null ? null : e.lineBuf + data;
  else e.lineBuf = null; // escape sequences (arrows, history), Tab completion, multi-line input
}

export const terminalRegistry = new TerminalRegistry();
