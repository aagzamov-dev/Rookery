import { create } from "zustand";
import { clampPanelWidth, HOST_LIST_MAX, HOST_LIST_MIN, saveNumber, storedNumber } from "../ui/panelSize";

interface UiState {
  /** Window visible and focused (with a short grace on blur). Gates every live subscription. */
  windowActive: boolean;
  hostListOpen: boolean;
  hostListWidth: number;
  /** Sidebar list: servers (SSH) or database connections (SQL). Starts on SSH every time. */
  sidebar: "ssh" | "sql";
  paletteOpen: boolean;
  setSidebar: (v: "ssh" | "sql") => void;
  setWindowActive: (v: boolean) => void;
  toggleHostList: () => void;
  setHostListWidth: (width: number) => void;
  setPaletteOpen: (v: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  windowActive: true,
  hostListOpen: true,
  hostListWidth: clampPanelWidth(storedNumber("ui.panel.hosts", 252), HOST_LIST_MIN, HOST_LIST_MAX),
  sidebar: "ssh",
  paletteOpen: false,
  setSidebar: (sidebar) => set({ sidebar }),
  setWindowActive: (windowActive) => set({ windowActive }),
  toggleHostList: () => set((s) => ({ hostListOpen: !s.hostListOpen })),
  setHostListWidth: (width) => {
    const next = clampPanelWidth(width, HOST_LIST_MIN, HOST_LIST_MAX);
    saveNumber("ui.panel.hosts", next);
    set({ hostListWidth: next });
  },
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
