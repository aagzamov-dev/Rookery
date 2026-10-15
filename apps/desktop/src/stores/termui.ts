// Small per-terminal UI state: sudo prompt button, find bar, broadcast mode.
import { create } from "zustand";

export type BroadcastMode = "off" | "tab" | "all";

interface TermUiState {
  sudoPrompt: Record<string, boolean>;
  findOpen: Record<string, boolean>;
  /** Last search per terminal, so F3 / Shift+F3 work with the bar closed. */
  lastFind: Record<string, { q: string; caseSensitive: boolean; regex: boolean }>;
  setLastFind: (key: string, v: { q: string; caseSensitive: boolean; regex: boolean }) => void;
  /** Typing in one terminal goes to: this server tab's terminals, or every open terminal. */
  broadcast: { mode: BroadcastMode; hostId: string | null };
  setSudo: (key: string, v: boolean) => void;
  setFind: (key: string, v: boolean) => void;
  setBroadcast: (mode: BroadcastMode, hostId: string | null) => void;
}

export const useTermUi = create<TermUiState>((set, get) => ({
  sudoPrompt: {},
  findOpen: {},
  lastFind: {},
  setLastFind: (key, v) => set((s) => ({ lastFind: { ...s.lastFind, [key]: v } })),
  broadcast: { mode: "off", hostId: null },
  setSudo: (key, v) => {
    if (!!get().sudoPrompt[key] === v) return;
    set((s) => ({ sudoPrompt: { ...s.sudoPrompt, [key]: v } }));
  },
  setFind: (key, v) => set((s) => ({ findOpen: { ...s.findOpen, [key]: v } })),
  setBroadcast: (mode, hostId) => set({ broadcast: { mode, hostId } }),
}));
