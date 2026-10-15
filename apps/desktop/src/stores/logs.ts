// Followed logs, kept while hidden so re-showing a log is instant (docs/01 §5.3 rule 1).
import { create } from "zustand";

export const LOG_RING = 5_000;

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?/;

export interface LogStream {
  lines: string[];
  /** Last Docker timestamp seen — resubscribing uses it with --since (gap fill). */
  lastTs: string | null;
  ended: string | null;
}

interface LogsState {
  streams: Record<string, LogStream>;
  /** Log file followed in each server's Logs view. */
  fileTarget: Record<string, string | null>;
  setFileTarget: (hostId: string, path: string | null) => void;
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
  setFileTarget: (hostId, path) => set((s) => ({ fileTarget: { ...s.fileTarget, [hostId]: path } })),
  push: (hostId, stream, incoming) =>
    set((s) => {
      const k = streamKey(hostId, stream);
      const prev = s.streams[k] ?? empty();
      let lastTs = prev.lastTs;
      const fresh: string[] = [];
      for (const line of incoming) {
        const m = TS_RE.exec(line);
        if (m) {
          // `docker logs --since` is inclusive: drop lines we already have.
          if (lastTs && m[1] <= lastTs) continue;
          lastTs = m[1];
        }
        fresh.push(line);
      }
      if (fresh.length === 0) return s;
      const lines = prev.lines.concat(fresh);
      if (lines.length > LOG_RING) lines.splice(0, lines.length - LOG_RING);
      return { streams: { ...s.streams, [k]: { lines, lastTs, ended: null } } };
    }),
  end: (hostId, stream, reason) =>
    set((s) => {
      const k = streamKey(hostId, stream);
      return { streams: { ...s.streams, [k]: { ...(s.streams[k] ?? empty()), ended: reason } } };
    }),
  clear: (hostId, stream) =>
    set((s) => {
      const k = streamKey(hostId, stream);
      const prev = s.streams[k] ?? empty();
      return { streams: { ...s.streams, [k]: { ...prev, lines: [] } } };
    }),
  forgetHost: (hostId) =>
    set((s) => {
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

/** Split a Docker line into a short time and the message. */
export function splitTs(line: string): { time: string | null; text: string } {
  const m = TS_RE.exec(line);
  if (!m) return { time: null, text: line };
  const d = new Date(m[1]);
  const time = isNaN(d.getTime()) ? m[1].slice(11, 19) : d.toLocaleTimeString([], { hour12: false });
  return { time, text: line.slice(m[0].length) };
}
