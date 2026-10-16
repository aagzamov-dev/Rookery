// Single event channel from the core (`core`), dispatched into stores / terminals.
import { listen } from "@tauri-apps/api/event";
import type { CoreEvent } from "./bindings/CoreEvent";
import { useDocker } from "../stores/docker";
import { editKey, useFiles } from "../stores/files";
import { useLogs } from "../stores/logs";
import { useSessions } from "../stores/sessions";
import { useMetrics } from "../stores/metrics";
import { useVault } from "../stores/vault";
import { useSync } from "../stores/sync";
import { onDataChanged, useBackup } from "../stores/backup";
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
    case "docker_list":
      useDocker.getState().setList(ev.host_id, ev.containers, ev.error);
      break;
    case "docker_stats":
      useDocker.getState().setStats(ev.host_id, ev.stats);
      break;
    case "log_lines":
      useLogs.getState().push(ev.host_id, ev.stream, ev.lines);
      break;
    case "log_ended":
      useLogs.getState().end(ev.host_id, ev.stream, ev.reason);
      break;
    case "transfer": {
      const f = useFiles.getState();
      f.setTransfer(ev.transfer);
      // Refresh the folder an upload landed in (cheap, one listing).
      if (ev.transfer.upload && ev.transfer.state === "done") {
        const dir = ev.transfer.remote.slice(0, ev.transfer.remote.lastIndexOf("/")) || "/";
        if (f.byHost[ev.transfer.host_id]?.path === dir) void f.open(ev.transfer.host_id, dir, true);
      }
      break;
    }
    case "edit_sync": {
      const f = useFiles.getState();
      const prev = f.edits[editKey(ev.host_id, ev.remote)];
      f.setEdit({
        hostId: ev.host_id,
        remote: ev.remote,
        local: prev?.local ?? "",
        state: ev.state as "uploaded" | "conflict" | "error",
        message: ev.message,
        at: Date.now(),
      });
      break;
    }
    case "backup_status":
      useBackup.getState().setStatus(ev.status);
      break;
    case "data_changed":
      void onDataChanged(ev.summary);
      break;
    case "sync_progress":
      useSync.getState().onProgress(ev.job_id, ev.host_id, ev.state, ev.snapshot);
      break;
    case "sync_done":
      useSync.getState().onDone(ev.job_id, ev.auto, ev.summary);
      break;
    case "vault_locked":
      useVault.getState().markLocked();
      break;
    case "vault_unlocked":
      break;
  }
}
