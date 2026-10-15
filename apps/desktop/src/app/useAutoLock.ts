import { useEffect } from "react";
import { useVault } from "../stores/vault";

const IDLE_MS = 10 * 60 * 1000;

/** Lock after 10 min without input (docs/03 §9). The lock shortcut lives in the key dispatcher. */
export function useAutoLock() {
  useEffect(() => {
    let last = Date.now();
    const bump = () => (last = Date.now());
    const timer = setInterval(() => {
      const unlocked = useVault.getState().status?.unlocked;
      if (unlocked && Date.now() - last > IDLE_MS) void useVault.getState().lock();
    }, 15_000);
    window.addEventListener("mousemove", bump, { passive: true });
    window.addEventListener("mousedown", bump);
    window.addEventListener("keydown", bump, true);
    return () => {
      clearInterval(timer);
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("mousedown", bump);
      window.removeEventListener("keydown", bump, true);
    };
  }, []);
}
