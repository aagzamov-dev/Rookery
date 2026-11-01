import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ isPermissionGranted: vi.fn(), sendNotification: vi.fn(), requestPermission: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => native);
vi.mock("../keys/chord", async (importOriginal) => ({ ...await importOriginal<typeof import("../keys/chord")>(), isMac: false }));
vi.mock("../features/server-tab/terminal/registry", () => ({ terminalRegistry: {} }));
import { dispatch } from "./events";
import { useDatabaseFiles } from "../stores/databaseFiles";
import { useNotifications } from "../stores/notifications";
import type { DatabaseJob } from "./bindings/DatabaseJob";
const job = (id: string, state: string): DatabaseJob => ({ id, state, session_id: "session", stage: "test", started_at: 0, bytes: 0, total: null, elapsed_ms: 129000, error: null, log: [] });
beforeEach(() => {
  vi.resetAllMocks();
  native.isPermissionGranted.mockResolvedValue(true);
  useDatabaseFiles.setState({ jobs: {}, dismissed: {} });
  useNotifications.setState({ items: [] });
});
it("delivers a native completion once through the core event dispatcher", async () => {
  dispatch({ type: "database_job", job: job("dispatch", "running") });
  dispatch({ type: "database_job", job: job("dispatch", "done") });
  dispatch({ type: "database_job", job: job("dispatch", "done") });
  await vi.waitFor(() => expect(native.sendNotification).toHaveBeenCalledOnce());
  expect(useNotifications.getState().items).toHaveLength(1);
});
it("recovers a known running completion from status without replaying history", async () => {
  dispatch({ type: "database_job", job: job("recover", "running") });
  useDatabaseFiles.getState().received(job("recover", "done"));
  useDatabaseFiles.getState().received(job("history", "done"));
  dispatch({ type: "database_job", job: job("recover", "done") });
  dispatch({ type: "database_job", job: job("history", "done") });
  await vi.waitFor(() => expect(native.sendNotification).toHaveBeenCalledOnce());
  expect(useNotifications.getState().items).toHaveLength(1);
});
