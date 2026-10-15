import { create } from "zustand";
import { api } from "../ipc/api";
import type { VaultStatus } from "../ipc/bindings/VaultStatus";

interface VaultState {
  status: VaultStatus | null;
  /** User chose "Skip for now" on the set-PIN step (this run only). */
  pinSkipped: boolean;
  load: () => Promise<void>;
  setStatus: (s: VaultStatus) => void;
  skipPin: () => void;
  markLocked: () => void;
  lock: () => Promise<void>;
}

export const useVault = create<VaultState>((set, get) => ({
  status: null,
  pinSkipped: false,
  load: async () => set({ status: await api.vaultStatus() }),
  setStatus: (status) => set({ status }),
  skipPin: () => set({ pinSkipped: true }),
  markLocked: () => {
    const s = get().status;
    if (s) set({ status: { ...s, unlocked: false } });
  },
  lock: async () => set({ status: await api.vaultLock(false) }),
}));

/** The lock screen is shown while locked, or right after unlock until a PIN is set or skipped. */
export function needsLockScreen(s: VaultStatus | null, pinSkipped: boolean): boolean {
  if (!s) return true;
  if (!s.unlocked) return true;
  return (!s.pin_set || s.pin_disabled) && !pinSkipped;
}
