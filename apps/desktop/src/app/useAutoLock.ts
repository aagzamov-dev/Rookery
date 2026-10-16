import { useEffect } from "react";
import { useKeys } from "../stores/keys";
import { useVault } from "../stores/vault";

/** Lock after Settings › Security › "Lock after" minutes without input (0 = never). The lock shortcut lives in the key dispatcher. */
export function useAutoLock() {
  useEffect(() => {
    let last = Date.now();
    const bump = () => (last = Date.now());
    const timer = setInterval(() => {
      const minutes = useKeys.getState().app.autoLockMin;
      const unlocked = useVault.getState().status?.unlocked;
      if (minutes > 0 && unlocked && Date.now() - last > minutes * 60_000) void useVault.getState().lock();
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
