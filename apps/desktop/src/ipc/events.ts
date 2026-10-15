// Single event channel from the core (`core`), dispatched into stores / terminals.
import { listen } from "@tauri-apps/api/event";
import type { CoreEvent } from "./bindings/CoreEvent";
import { useSessions } from "../stores/sessions";
import { useMetrics } from "../stores/metrics";
import { useVault } from "../stores/vault";
import { terminalRegistry } from "../features/server-tab/terminal/registry";

let started = false;

export function startCoreEvents() {
  if (started) return;
  started = true;
  void listen<CoreEvent>("core", ({ payload }) => dispatch(payload));
}

export function dispatch(ev: CoreEvent) {
  switch (ev.type) {
    case "session":
      useSessions.getState().setInfo(ev.info);
      break;
    case "term_data":
      terminalRegistry.onData(ev.term_id, ev.data);
      break;
    case "term_exit":
      terminalRegistry.onExit(ev.term_id, ev.code, ev.reason);
      break;
    case "metrics":
      useMetrics.getState().push(ev.host_id, ev.sample);
      break;
    case "collector_error":
      useMetrics.getState().setError(ev.host_id, ev.message);
      break;
    case "vault_locked":
      useVault.getState().markLocked();
      break;
    case "vault_unlocked":
      break;
  }
}
