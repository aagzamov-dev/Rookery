// Followed logs, kept while hidden so re-showing a log is instant (docs/01 §5.3 rule 1).
import { create } from "zustand";

export const LOG_RING = 5_000;
export const LOG_BYTES = 4 * 1024 * 1024;
export const LOG_LINE_CHARS = 32 * 1024;
const replay = new Map<string, { timestamp: string; counts: Map<string, number> }>();
const timestampKey = (ts: string) => ts.replace(/(?:\.(\d+))?Z$/, (_, digits: string | undefined) => `.${(digits ?? "").padEnd(9, "0")}Z`);

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?/;

export interface LogStream {
  lines: string[];
  /** Last Docker timestamp seen — resubscribing uses it with --since (gap fill). */
  lastTs: string | null;
  ended: string | null;
  dropped?: number;
}

interface LogsState {
  streams: Record<string, LogStream>;
  /** Log file followed in each server's Logs view. */
  fileTarget: Record<string, string | null>;
  paused: Record<string, boolean>;
  setPaused: (hostId: string, stream: string, paused: boolean) => void;
  setFileTarget: (hostId: string, path: string | null) => void;
  resume: (hostId: string, stream: string) => void;
  push: (hostId: string, stream: string, lines: string[]) => void;
  end: (hostId: string, stream: string, reason: string) => void;
  clear: (hostId: string, stream: string) => void;
  forgetHost: (hostId: string) => void;
}

export const streamKey = (hostId: string, stream: string) => `${hostId}|${stream}`;

const empty = (): LogStream => ({ lines: [], lastTs: null, ended: null });

export const useLogs = create<LogsState>((set) => ({
  streams: {},
  fileTarget: {},
  paused: {},
  setPaused: (hostId, stream, paused) => set((s) => ({ paused: { ...s.paused, [streamKey(hostId, stream)]: paused } })),
  setFileTarget: (hostId, path) => set((s) => ({ fileTarget: { ...s.fileTarget, [hostId]: path } })),
  resume: (hostId, stream) => {
    const k = streamKey(hostId, stream);
    const current = useLogs.getState().streams[k];
    if (!current?.lastTs) return;
    const timestamp = timestampKey(current.lastTs);
    const counts = new Map<string, number>();
    for (const line of current.lines) {
      const ts = TS_RE.exec(line)?.[1];
      if (ts && timestampKey(ts) === timestamp) counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    replay.set(k, { timestamp, counts });
  },
  push: (hostId, stream, incoming) =>
    set((s) => {
      const k = streamKey(hostId, stream);
      const prev = s.streams[k] ?? empty();
      let lastTs = prev.lastTs;
      const fresh: string[] = [];
      let dropped = prev.dropped ?? 0;
      for (const raw of incoming) {
        const line = raw.length > LOG_LINE_CHARS ? `${raw.slice(0, LOG_LINE_CHARS)} … [line truncated]` : raw;
        if (line !== raw) dropped++;
        const m = TS_RE.exec(line);
        if (m) {
          const timestamp = timestampKey(m[1]);
          const overlap = replay.get(k);
          if (overlap && timestamp <= overlap.timestamp) {
            if (timestamp < overlap.timestamp) continue;
            const count = overlap.counts.get(line) ?? 0;
            if (count > 0) { overlap.counts.set(line, count - 1); continue; }
          } else if (overlap) replay.delete(k);
          if (!lastTs || timestamp > timestampKey(lastTs)) lastTs = m[1];
        }
        fresh.push(line);
      }
      if (fresh.length === 0) return s;
      const lines = prev.lines.concat(fresh);
      let size = lines.reduce((total, line) => total + line.length * 2, 0);
      let cut = 0;
      while (cut < lines.length && (lines.length - cut > LOG_RING || size > LOG_BYTES)) {
        size -= lines[cut++].length * 2;
      }
      dropped += cut;
      return { streams: { ...s.streams, [k]: { lines: cut ? lines.slice(cut) : lines, lastTs, ended: null, dropped } } };
    }),
  end: (hostId, stream, reason) =>
    set((s) => {
      const k = streamKey(hostId, stream);
      return { streams: { ...s.streams, [k]: { ...(s.streams[k] ?? empty()), ended: reason } } };
    }),
  clear: (hostId, stream) =>
    set((s) => {
      const k = streamKey(hostId, stream);
      replay.delete(k);
      return { streams: { ...s.streams, [k]: empty() } };
    }),
  forgetHost: (hostId) =>
    set((s) => {
      for (const key of replay.keys()) if (key.startsWith(`${hostId}|`)) replay.delete(key);
      const fileTarget = { ...s.fileTarget };
      delete fileTarget[hostId];
      return { fileTarget, streams: Object.fromEntries(Object.entries(s.streams).filter(([k]) => !k.startsWith(`${hostId}|`))) };
    }),
}));

export type Level = "error" | "warn" | "info" | null;

const ERR = /\b(ERROR|ERR|FATAL|CRIT(ICAL)?|EMERG(ENCY)?|ALERT|PANIC|EXCEPTION)\b|\bfailed\b|Traceback/i;
const WARN = /\b(WARN(ING)?|DEPRECATED)\b/i;
const INFO = /\b(INFO|NOTICE)\b/;

export function levelOf(line: string): Level {
  if (ERR.test(line)) return "error";
  if (WARN.test(line)) return "warn";
  if (INFO.test(line)) return "info";
  return null;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Split a Docker line into a short time and the message. */
export function splitTs(line: string): { time: string | null; text: string } {
  const m = TS_RE.exec(line);
  if (!m) return { time: null, text: line };
  const d = new Date(m[1]);
  const time = isNaN(d.getTime()) ? m[1].slice(11, 19) : timeFormat.format(d);
  return { time, text: line.slice(m[0].length) };
}
