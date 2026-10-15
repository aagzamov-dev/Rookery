import { create } from "zustand";
import type { MetricsSample } from "../ipc/bindings/MetricsSample";

/** 15 minutes at the default 3 s interval (docs/01 §5.3 memory caps). */
export const METRICS_HISTORY = 300;

export interface HostMetrics {
  last: MetricsSample | null;
  history: MetricsSample[];
  error: string | null;
}

interface MetricsState {
  byHost: Record<string, HostMetrics>;
  push: (hostId: string, s: MetricsSample) => void;
  setCached: (hostId: string, s: MetricsSample) => void;
  setError: (hostId: string, message: string) => void;
}

const empty: HostMetrics = { last: null, history: [], error: null };

export const useMetrics = create<MetricsState>((set) => ({
  byHost: {},
  push: (hostId, sample) =>
    set((st) => {
      const prev = st.byHost[hostId] ?? empty;
      const history = [...prev.history, sample];
      if (history.length > METRICS_HISTORY) history.splice(0, history.length - METRICS_HISTORY);
      return { byHost: { ...st.byHost, [hostId]: { last: sample, history, error: null } } };
    }),
  setCached: (hostId, sample) =>
    set((st) => {
      const prev = st.byHost[hostId] ?? empty;
      if (prev.last && prev.last.ts_ms >= sample.ts_ms) return st;
      return { byHost: { ...st.byHost, [hostId]: { ...prev, last: sample } } };
    }),
  setError: (hostId, message) =>
    set((st) => ({ byHost: { ...st.byHost, [hostId]: { ...(st.byHost[hostId] ?? empty), error: message } } })),
}));
