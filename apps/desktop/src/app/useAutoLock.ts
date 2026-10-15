import { useEffect } from "react";
import { useVault } from "../stores/vault";

const IDLE_MS = 10 * 60 * 1000;

/** Lock after 10 min idle and on Ctrl/⌘+L (docs/03 §9). */
export function useAutoLock() {
  useEffect(() => {
    let last = Date.now();
    const bump = () => (last = Date.now());
    const onKey = (e: KeyboardEvent) => {
      bump();
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        void useVault.getState().lock();
      }
    };
    const timer = setInterval(() => {
      const unlocked = useVault.getState().status?.unlocked;
      if (unlocked && Date.now() - last > IDLE_MS) void useVault.getState().lock();
    }, 15_000);
    window.addEventListener("mousemove", bump, { passive: true });
    window.addEventListener("mousedown", bump);
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearInterval(timer);
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("mousedown", bump);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
}
