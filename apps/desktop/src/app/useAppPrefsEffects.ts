import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../ipc/api";
import { terminalRegistry } from "../features/server-tab/terminal/registry";
import { useLocalShells } from "../features/local/LocalTab";
import { useKeys } from "../stores/keys";
import { useTabs } from "../stores/tabs";
import { activeTerminalKey } from "../keys/dispatcher";

/** Side effects of app preferences: the system-wide hotkey and session-log cleanup. */
export function useAppPrefsEffects() {
  const hotkey = useKeys((s) => s.app.globalHotkey);
  const loaded = useKeys((s) => s.loaded);
  const retention = useKeys((s) => s.app.logRetentionDays);

  useEffect(() => {
    if (!loaded) return;
    void api.globalHotkeySet(hotkey).catch((e) => console.warn("global hotkey:", e));
  }, [hotkey, loaded]);

  // Once per start: drop old session logs.
  useEffect(() => {
    if (loaded) void api.logsCleanup(retention).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Hotkey brought the window forward: focus the terminal, or open a local one if nothing is open.
  useEffect(() => {
    const un = listen("rookery://hotkey", () => {
      const tabs = useTabs.getState();
      if (tabs.tabs.length === 0) {
        const shell = useLocalShells.getState().shells?.[0];
        if (shell) tabs.openLocal(shell.id, shell.label);
        return;
      }
      requestAnimationFrame(() => {
        const key = activeTerminalKey(null);
        if (key) terminalRegistry.focus(key);
      });
    });
    return () => void un.then((f) => f());
  }, []);
}
