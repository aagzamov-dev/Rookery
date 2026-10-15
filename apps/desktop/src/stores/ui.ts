import { create } from "zustand";

interface UiState {
  /** Window visible and focused (with a short grace on blur). Gates every live subscription. */
  windowActive: boolean;
  hostListOpen: boolean;
  paletteOpen: boolean;
  setWindowActive: (v: boolean) => void;
  toggleHostList: () => void;
  setPaletteOpen: (v: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  windowActive: true,
  hostListOpen: true,
  paletteOpen: false,
  setWindowActive: (windowActive) => set({ windowActive }),
  toggleHostList: () => set((s) => ({ hostListOpen: !s.hostListOpen })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}));

const BLUR_GRACE_MS = 2000;
let blurTimer: ReturnType<typeof setTimeout> | null = null;

/** Wire DOM visibility/focus into the store. Call once at startup. */
export function trackWindowActivity() {
  const update = () => {
    const active = document.visibilityState === "visible" && document.hasFocus();
    if (active) {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = null;
      useUi.getState().setWindowActive(true);
    } else if (document.visibilityState !== "visible") {
      useUi.getState().setWindowActive(false); // minimised / hidden: immediately
    } else if (!blurTimer) {
      blurTimer = setTimeout(() => {
        blurTimer = null;
        if (!document.hasFocus()) useUi.getState().setWindowActive(false);
      }, BLUR_GRACE_MS);
    }
  };
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  update();
}
