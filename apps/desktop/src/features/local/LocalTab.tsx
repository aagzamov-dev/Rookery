import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../../ipc/api";
import type { LocalShell } from "../../ipc/bindings/LocalShell";
import { TerminalPane } from "../server-tab/terminal/TerminalPane";

let shellsPending: Promise<void> | null = null;

/** Shells installed on this computer (asked once). */
export const useLocalShells = create<{ shells: LocalShell[] | null; load: () => Promise<void> }>((set, get) => ({
  shells: null,
  load: async () => {
    if (get().shells) return;
    if (shellsPending) return shellsPending;
    shellsPending = api.localShells().catch(() => []).then((shells) => { set({ shells }); }).finally(() => { shellsPending = null; });
    return shellsPending;
  },
}));

/** A local terminal tab (PowerShell, cmd, WSL, Git Bash, zsh…). No server, no SSH. */
export function LocalTab({ tabId, shellId, active }: { tabId: string; shellId: string; active: boolean }) {
  return (
    <div className="absolute inset-0" style={{ display: active ? "block" : "none" }}>
      <div className="relative h-full w-full">
        <TerminalPane termKey={tabId} hostId={tabId} visible={active} opts={{ localShell: shellId }} />
      </div>
    </div>
  );
}

export function useLoadLocalShells() {
  useEffect(() => {
    void useLocalShells.getState().load();
  }, []);
}
