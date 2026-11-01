import { beforeEach, expect, it, vi } from "vitest";
const confirm = vi.hoisted(() => vi.fn());
vi.mock("../../stores/dialogs", () => ({ askConfirm: confirm }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn().mockResolvedValue(false) }));
import { allowDatabaseSessionClose, databaseSessionsForTabs } from "./jobGuard";
import { useDatabaseFiles } from "../../stores/databaseFiles";
import { useSql } from "../../stores/sql";
beforeEach(() => { useDatabaseFiles.setState({ jobs: {}, dismissed: {} }); confirm.mockReset().mockResolvedValue(true); });
it("blocks connection closure until the running operation is explicitly cancelled or finishes", async () => {
  useDatabaseFiles.getState().received({ id: "guard", session_id: "session", state: "running", stage: "Export", started_at: 0, bytes: 0, total: null, elapsed_ms: 0, error: null, log: [] });
  expect(await allowDatabaseSessionClose(["other"])).toBe(true);
  expect(await allowDatabaseSessionClose(["session"])).toBe(false);
  expect(confirm).toHaveBeenCalledOnce();
  useDatabaseFiles.getState().received({ ...useDatabaseFiles.getState().jobs.guard, state: "cancelled" });
  expect(await allowDatabaseSessionClose(["session"])).toBe(true);
});
it("maps tab keys to their SQL sessions", () => {
  useSql.setState({ sessions: {} });
  useSql.getState().opened({ session_id: "session", engine: "postgres", server_version: "16", read_only: false, database: "db", conn_key: "test" }, "tab");
  expect(databaseSessionsForTabs(["tab"])).toEqual(["session"]);
  expect(databaseSessionsForTabs(["other"])).toEqual([]);
});
