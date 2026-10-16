// SQL sessions and query results (docs/07). Rows arrive as `sql_result` events in chunks.
import { create } from "zustand";
import { api } from "../ipc/api";
import type { CoreEvent } from "../ipc/bindings/CoreEvent";
import type { DbConnection } from "../ipc/bindings/DbConnection";
import type { DbEngine } from "../ipc/bindings/DbEngine";
import type { ResultColumn } from "../ipc/bindings/ResultColumn";
import type { SqlOpened } from "../ipc/bindings/SqlOpened";
import type { SqlPrefill } from "../ipc/bindings/SqlPrefill";

type SqlResultEv = Extract<CoreEvent, { type: "sql_result" }>;
type SqlSessionEv = Extract<CoreEvent, { type: "sql_session" }>;

export interface SqlSessionMeta {
  sessionId: string;
  /** The SQL tab / view that owns it (`host:<id>` or a database tab id). */
  tabKey?: string;
  engine: DbEngine;
  version: string;
  /** connected | lost | closed (idle; the next run reconnects) */
  state: string;
  readOnly: boolean;
  /** Opened read-only (PROD / "Open read-only"): writes need "Allow changes". */
  protected: boolean;
  txOpen: boolean;
  txRows: number;
  writesUntil: number | null;
  database: string | null;
  message: string | null;
  /** Query history key (saved connection id, `host:…` or `url:…`). */
  connKey: string;
}

export interface SqlResultSet {
  index: number;
  stmt: number;
  columns: ResultColumn[] | null;
  rows: (string | null)[][];
  done: boolean;
  affected: number | null;
  elapsedMs: number | null;
  truncated: boolean;
  error: string | null;
  /** Char offset of the error in the text that was run. */
  errorPos: number | null;
}

export interface SqlRun {
  queryId: string;
  sessionId: string;
  /** What was run and where it starts in the editor (to place error marks). */
  sql: string;
  offset: number;
  rowLimit: number | null;
  sets: SqlResultSet[];
  notices: string[];
  finished: boolean;
  startedAt: number;
}

interface SqlState {
  /** Saved connections (passwords stay in the vault; `has_password` tells if one is saved). */
  conns: DbConnection[];
  connsLoaded: boolean;
  loadConns: () => Promise<void>;
  /** password: undefined = keep, "" = forget, value = set. passwordRef: the password from a .env. */
  saveConn: (c: DbConnection, password?: string, passwordRef?: string) => Promise<DbConnection>;
  deleteConn: (id: string) => Promise<void>;
  /** Editor text per SQL tab key; kept on this device only (`ui.sql.drafts`). */
  drafts: Record<string, string>;
  draftsLoaded: boolean;
  loadDrafts: () => Promise<void>;
  setDraft: (key: string, text: string) => void;
  sessions: Record<string, SqlSessionMeta>;
  runs: Record<string, SqlRun>;
  opened: (o: SqlOpened, tabKey?: string) => void;
  onSession: (ev: SqlSessionEv) => void;
  startRun: (r: Omit<SqlRun, "sets" | "notices" | "finished" | "startedAt">) => void;
  onResult: (ev: SqlResultEv) => void;
  forgetSession: (sessionId: string) => void;
  forgetRun: (queryId: string) => void;
  /** Docker "Open in SQL": fills the server's Database view form once (per host id). */
  serverPrefill: Record<string, SqlPrefill>;
  setServerPrefill: (hostId: string, p: SqlPrefill | null) => void;
}

/** Result events may arrive before `startRun` (the invoke returns after the task started). */
const early: Record<string, SqlResultEv[]> = {};

function applyResult(run: SqlRun, ev: SqlResultEv): SqlRun {
  if (ev.notice) return { ...run, notices: [...run.notices, ev.notice] };
  if (ev.finished) return { ...run, finished: true };
  const sets = run.sets.slice();
  let i = sets.findIndex((s) => s.index === ev.index);
  if (i < 0) {
    sets.push({ index: ev.index, stmt: ev.stmt, columns: null, rows: [], done: false, affected: null, elapsedMs: null, truncated: false, error: null, errorPos: null });
    i = sets.length - 1;
  }
  const s = sets[i];
  sets[i] = {
    ...s,
    columns: ev.columns ?? s.columns,
    rows: ev.rows.length ? s.rows.concat(ev.rows) : s.rows,
    done: ev.done,
    affected: ev.affected ?? s.affected,
    elapsedMs: ev.elapsed_ms ?? s.elapsedMs,
    truncated: ev.truncated || s.truncated,
    error: ev.error ?? s.error,
    errorPos: ev.error_pos ?? s.errorPos,
  };
  return { ...run, sets };
}

const DRAFTS_KEY = "ui.sql.drafts";
const DRAFT_MAX = 200_000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useSql = create<SqlState>((set, get) => ({
  conns: [],
  connsLoaded: false,

  loadConns: async () => {
    const conns = await api.sqlConnsList();
    set({ conns, connsLoaded: true });
  },

  saveConn: async (c, password, passwordRef) => {
    const saved = await api.sqlConnSave(c, password, passwordRef);
    await get().loadConns();
    return saved;
  },

  deleteConn: async (id) => {
    await api.sqlConnDelete(id);
    await get().loadConns();
  },

  drafts: {},
  draftsLoaded: false,

  loadDrafts: async () => {
    if (get().draftsLoaded) return;
    const saved = await api.settingGet<Record<string, string>>(DRAFTS_KEY).catch(() => null);
    set((s) => ({ drafts: { ...(saved ?? {}), ...s.drafts }, draftsLoaded: true }));
  },

  setDraft: (key, text) => {
    set((s) => ({ drafts: { ...s.drafts, [key]: text.slice(0, DRAFT_MAX) } }));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void api.settingSet(DRAFTS_KEY, get().drafts).catch(() => {}), 800);
  },

  sessions: {},
  runs: {},

  opened: (o, tabKey) =>
    set((s) => ({
      sessions: {
        ...s.sessions,
        [o.session_id]: {
          sessionId: o.session_id,
          tabKey,
          engine: o.engine,
          version: o.server_version,
          state: "connected",
          readOnly: o.read_only,
          protected: o.read_only,
          txOpen: false,
          txRows: 0,
          writesUntil: null,
          database: o.database,
          message: null,
          connKey: o.conn_key,
        },
      },
    })),

  onSession: (ev) =>
    set((s) => {
      const cur = s.sessions[ev.session_id];
      if (!cur) return s; // closed tab / another page's session
      return {
        sessions: {
          ...s.sessions,
          [ev.session_id]: {
            ...cur,
            state: ev.state,
            readOnly: ev.read_only,
            protected: ev.protected,
            txOpen: ev.tx_open,
            txRows: ev.tx_rows,
            writesUntil: ev.writes_until,
            database: ev.database ?? cur.database,
            message: ev.message,
          },
        },
      };
    }),

  startRun: (r) => {
    let run: SqlRun = { ...r, sets: [], notices: [], finished: false, startedAt: Date.now() };
    for (const ev of early[r.queryId] ?? []) run = applyResult(run, ev);
    delete early[r.queryId];
    set((s) => ({ runs: { ...s.runs, [r.queryId]: run } }));
  },

  onResult: (ev) => {
    const run = get().runs[ev.query_id];
    if (!run) {
      (early[ev.query_id] ??= []).push(ev);
      return;
    }
    set((s) => ({ runs: { ...s.runs, [ev.query_id]: applyResult(run, ev) } }));
  },

  forgetSession: (sessionId) =>
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[sessionId];
      return { sessions };
    }),

  forgetRun: (queryId) =>
    set((s) => {
      const runs = { ...s.runs };
      delete runs[queryId];
      return { runs };
    }),

  serverPrefill: {},
  setServerPrefill: (hostId, p) =>
    set((s) => {
      const serverPrefill = { ...s.serverPrefill };
      if (p) serverPrefill[hostId] = p;
      else delete serverPrefill[hostId];
      return { serverPrefill };
    }),
}));
