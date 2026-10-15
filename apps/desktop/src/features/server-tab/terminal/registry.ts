// xterm instances live here, outside React, so switching tabs/views never
// destroys a terminal or its scrollback (docs/01-ARCHITECTURE.md §5.2).
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { api, asCoreError } from "../../../ipc/api";

export const SCROLLBACK = 10_000;

export const slateBlueTheme: ITheme = {
  background: "#171D29",
  foreground: "#D3D9E4",
  cursor: "#8AB4FF",
  cursorAccent: "#171D29",
  selectionBackground: "#34507E",
  black: "#2A3345",
  red: "#FF7A7A",
  green: "#57C994",
  yellow: "#F2BA45",
  blue: "#8AB4FF",
  magenta: "#C792EA",
  cyan: "#7FDBCA",
  white: "#D3D9E4",
  brightBlack: "#8390A8",
  brightRed: "#FF8A8A",
  brightGreen: "#86E0B6",
  brightYellow: "#F7CB6A",
  brightBlue: "#BCD3FF",
  brightMagenta: "#DDB6F2",
  brightCyan: "#A3EFE0",
  brightWhite: "#E6EAF2",
};

export interface TermOptions {
  cwd?: string;
  container?: string;
}

interface Entry {
  key: string;
  hostId: string;
  opts: TermOptions;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  opened: boolean;
  termId: string | null;
  connecting: boolean;
  exited: boolean;
}

const decoder = (b64: string) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

class TerminalRegistry {
  private byKey = new Map<string, Entry>();
  private byTermId = new Map<string, Entry>();

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
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
      theme: slateBlueTheme,
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

    const entry: Entry = { key, hostId, opts, term, fit, search, el, opened: false, termId: null, connecting: false, exited: false };

    term.onData((data) => {
      if (entry.exited) {
        if (data === "\r") void this.connect(entry);
        return;
      }
      if (entry.termId) void api.termWrite(entry.termId, data);
    });
    term.onResize(({ cols, rows }) => {
      if (entry.termId) void api.termResize(entry.termId, cols, rows);
    });
    return entry;
  }

  private async connect(e: Entry) {
    if (e.connecting || e.termId) return;
    e.connecting = true;
    e.exited = false;
    try {
      const termId = await api.termOpen({
        host_id: e.hostId,
        cols: e.term.cols,
        rows: e.term.rows,
        cwd: e.opts.cwd ?? null,
        container: e.opts.container ?? null,
      });
      if (!this.byKey.has(e.key)) {
        void api.termClose(termId); // disposed while opening
        return;
      }
      e.termId = termId;
      this.byTermId.set(termId, e);
    } catch (err) {
      const ce = asCoreError(err);
      e.exited = true;
      e.term.write(`\r\n\x1b[31m${ce.message}\x1b[0m\r\n\x1b[90mPress Enter to retry\x1b[0m\r\n`);
    } finally {
      e.connecting = false;
    }
  }

  onData(termId: string, b64: string) {
    this.byTermId.get(termId)?.term.write(decoder(b64));
  }

  onExit(termId: string, code: number | null, reason: string | null) {
    const e = this.byTermId.get(termId);
    if (!e) return;
    this.byTermId.delete(termId);
    e.termId = null;
    e.exited = true;
    const why = reason ?? (code != null ? `exit ${code}` : "closed");
    e.term.write(`\r\n\x1b[90m[session ended: ${why} — press Enter to reconnect]\x1b[0m\r\n`);
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

  paste(key: string, text: string) {
    this.byKey.get(key)?.term.paste(text);
  }

  dispose(key: string) {
    const e = this.byKey.get(key);
    if (!e) return;
    this.byKey.delete(key);
    if (e.termId) {
      this.byTermId.delete(e.termId);
      void api.termClose(e.termId);
    }
    e.term.dispose();
    e.el.remove();
  }

  disposeHost(hostId: string) {
    for (const [k, e] of [...this.byKey]) if (e.hostId === hostId) this.dispose(k);
  }
}

export const terminalRegistry = new TerminalRegistry();
