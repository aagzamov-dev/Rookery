import { useEffect, useState } from "react";
import { useHosts } from "../stores/hosts";
import { trackWindowActivity } from "../stores/ui";
import { needsLockScreen, useVault } from "../stores/vault";
import { LockScreen } from "./LockScreen";
import { Shell } from "./Shell";

export function App() {
  const status = useVault((s) => s.status);
  const pinSkipped = useVault((s) => s.pinSkipped);
  const load = useVault((s) => s.load);
  const loadHosts = useHosts((s) => s.load);
  const [everUnlocked, setEverUnlocked] = useState(false);

  useEffect(() => {
    void load();
    trackWindowActivity();
  }, [load]);

  useEffect(() => {
    if (status?.unlocked && !everUnlocked) {
      setEverUnlocked(true);
      void loadHosts();
    }
  }, [status?.unlocked, everUnlocked, loadHosts]);

  if (!status) return <div className="h-full bg-bg" />;

  // The shell stays mounted under the lock screen so tabs, terminals and
  // scrollback survive locking (subscriptions are stopped by the core).
  return (
    <>
      {everUnlocked && <Shell />}
      {needsLockScreen(status, pinSkipped) && <LockScreen />}
    </>
  );
}
