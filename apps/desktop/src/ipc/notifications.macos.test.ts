import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
vi.mock("../keys/chord", async (importOriginal) => ({ ...await importOriginal<typeof import("../keys/chord")>(), isMac: true }));
vi.mock("../features/server-tab/terminal/registry", () => ({ terminalRegistry: {} }));
import { desktopNotifications } from "./notifications";
import { dispatch } from "./events";
import { useDatabaseFiles } from "../stores/databaseFiles";
import { useNotifications } from "../stores/notifications";
import type { DatabaseJob } from "./bindings/DatabaseJob";
const job = (id: string, state: string): DatabaseJob => ({ id, state, session_id: "session", stage: "test", started_at: 0, bytes: 0, total: null, elapsed_ms: 129000, error: null, log: [] });
beforeEach(() => {
  vi.resetAllMocks();
  native.invoke.mockImplementation(async (command: string) => command === "desktop_notification_permission" ? true : undefined);
  useDatabaseFiles.setState({ jobs: {}, dismissed: {} });
  useNotifications.setState({ items: [], permission: "unknown", requesting: false, deliveryError: null });
});
it.each([true, false])("uses the same awaited native route for test and completion while focused=%s", async (focused) => {
  vi.stubGlobal("document", { hasFocus: () => focused });
  const id = `mac-${focused}`;
  await useNotifications.getState().test();
  dispatch({ type: "database_job", job: job(id, "running") });
  dispatch({ type: "database_job", job: job(id, "done") });
  dispatch({ type: "database_job", job: job(id, "done") });
  await vi.waitFor(() => expect(native.invoke.mock.calls.filter(([command]) => command === "desktop_notification_send")).toHaveLength(2));
  expect(useNotifications.getState().items).toHaveLength(2);
  expect(native.invoke).not.toHaveBeenCalledWith("desktop_notification_request_permission");
  vi.unstubAllGlobals();
});
it("retains the inbox and exposes a native submission failure", async () => {
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "desktop_notification_send") throw new Error("macOS rejected the notification request");
    return true;
  });
  dispatch({ type: "database_job", job: job("rejected", "done") });
  await vi.waitFor(() => expect(useNotifications.getState().deliveryError).toBe("macOS rejected the notification request"));
  expect(useNotifications.getState().items).toHaveLength(1);
});
it("refreshes revoked permission without requesting permission from completion", async () => {
  native.invoke.mockResolvedValue(false);
  useNotifications.setState({ permission: "granted" });
  dispatch({ type: "database_job", job: job("revoked", "done") });
  await vi.waitFor(() => expect(useNotifications.getState().permission).toBe("denied"));
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith("desktop_notification_permission");
  expect(useNotifications.getState().items).toHaveLength(1);
});
it("requests real macOS permission only through the explicit enable action", async () => {
  native.invoke.mockImplementation(async (command: string) => command === "desktop_notification_request_permission");
  await useNotifications.getState().enable();
  expect(native.invoke).toHaveBeenCalledWith("desktop_notification_request_permission");
  expect(useNotifications.getState().permission).toBe("granted");
});
it("returns native command rejections to callers", async () => {
  native.invoke.mockRejectedValue("Notification unavailable");
  await expect(desktopNotifications.send({ title: "Test", body: "Details" })).rejects.toBe("Notification unavailable");
});
