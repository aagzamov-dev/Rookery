import { create } from "zustand";
import { api, asCoreError, type CoreError } from "../ipc/api";
import type { SessionInfo } from "../ipc/bindings/SessionInfo";

interface SessionsState {
  byHost: Record<string, SessionInfo>;
  attachIds: Record<string, string>;
  attaching: Record<string, boolean>;
  errors: Record<string, CoreError | null>;
  setInfo: (info: SessionInfo) => void;
  /** Take the tab's lease (connects). Safe to call repeatedly. */
  attach: (hostId: string) => Promise<void>;
  detach: (hostId: string) => Promise<void>;
  clearError: (hostId: string) => void;
}

export const useSessions = create<SessionsState>((set, get) => ({
  byHost: {},
  attachIds: {},
  attaching: {},
  errors: {},

  setInfo: (info) => set((s) => ({ byHost: { ...s.byHost, [info.host_id]: info } })),

  attach: async (hostId) => {
    const s = get();
    if (s.attachIds[hostId] || s.attaching[hostId]) return;
    set((st) => ({ attaching: { ...st.attaching, [hostId]: true }, errors: { ...st.errors, [hostId]: null } }));
    try {
      const id = await api.sessionAttach(hostId);
      set((st) => ({ attachIds: { ...st.attachIds, [hostId]: id } }));
    } catch (e) {
      set((st) => ({ errors: { ...st.errors, [hostId]: asCoreError(e) } }));
    } finally {
      set((st) => ({ attaching: { ...st.attaching, [hostId]: false } }));
    }
  },

  detach: async (hostId) => {
    const id = get().attachIds[hostId];
    if (!id) return;
    set((st) => {
      const attachIds = { ...st.attachIds };
      delete attachIds[hostId];
      return { attachIds };
    });
    await api.sessionDetach(id);
  },

  clearError: (hostId) => set((st) => ({ errors: { ...st.errors, [hostId]: null } })),
}));
