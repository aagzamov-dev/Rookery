import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => native);
vi.mock("../keys/chord", async (importOriginal) => ({ ...await importOriginal<typeof import("../keys/chord")>(), isMac: false }));
import { useNotifications } from "./notifications";
import { useDatabaseFiles } from "./databaseFiles";
import type { DatabaseJob } from "../ipc/bindings/DatabaseJob";
const job = (id: string, state: string): DatabaseJob => ({ id, state, session_id: "session", stage: "test", started_at: 0, bytes: 0, total: null, elapsed_ms: 1, error: null, log: [] });
beforeEach(() => {
  vi.resetAllMocks(); native.isPermissionGranted.mockResolvedValue(false);
  useNotifications.setState({ items: [], permission: "unknown", requesting: false });
  useDatabaseFiles.setState({ jobs: {}, dismissed: {} });
});
it("keeps an inbox without asking OS permission from events", async () => {
  useNotifications.getState().add("Completed", "Details", "event");
  await vi.waitFor(() => expect(native.isPermissionGranted).toHaveBeenCalled());
  expect(native.requestPermission).not.toHaveBeenCalled();
  expect(native.sendNotification).not.toHaveBeenCalled();
  expect(useNotifications.getState().items).toHaveLength(1);
});
it("requests permission only through enable and reports denial", async () => {
  native.requestPermission.mockResolvedValue("denied");
  await useNotifications.getState().enable();
  expect(native.requestPermission).toHaveBeenCalledOnce();
  expect(useNotifications.getState().permission).toBe("denied");
});
it("sends native notifications when already allowed and bounds the inbox", async () => {
  native.isPermissionGranted.mockResolvedValue(true);
  for (let i = 0; i < 105; i++) useNotifications.getState().add("Completed", "Details", String(i));
  await vi.waitFor(() => expect(native.sendNotification).toHaveBeenCalledTimes(105));
  expect(useNotifications.getState().items).toHaveLength(100);
});
it("notifies each live terminal job once without notifying status hydration", () => {
  for (const state of ["done", "failed", "cancelled"]) {
    const id = `live-${state}`;
    useDatabaseFiles.getState().received(job(id, "running"), true);
    useDatabaseFiles.getState().received(job(id, state), true);
    useDatabaseFiles.getState().received(job(id, state), true);
  }
  useDatabaseFiles.getState().received(job("hydrated", "done"));
  expect(useNotifications.getState().items).toHaveLength(3);
});
it("allows dismissing only terminal progress and ignores stale running updates", () => {
  useDatabaseFiles.getState().received(job("dismiss", "running"));
  useDatabaseFiles.getState().dismiss("dismiss");
  expect(useDatabaseFiles.getState().dismissed.dismiss).toBeUndefined();
  useDatabaseFiles.getState().received(job("dismiss", "done"));
  useDatabaseFiles.getState().dismiss("dismiss");
  useDatabaseFiles.getState().received(job("dismiss", "running"));
  expect(useDatabaseFiles.getState().dismissed.dismiss).toBe(true);
  expect(useDatabaseFiles.getState().jobs.dismiss.state).toBe("done");
});
it("reports a known running job completion once even when a status response beats the event", () => {
  useDatabaseFiles.getState().received(job("race", "running"), true);
  useDatabaseFiles.getState().received(job("race", "done"));
  useDatabaseFiles.getState().received(job("race", "done"), true);
  useDatabaseFiles.getState().received(job("old", "done"));
  useDatabaseFiles.getState().received(job("old", "done"), true);
  expect(useNotifications.getState().items).toHaveLength(1);
});
it("preserves job insertion order and retains running jobs when history is trimmed", () => {
  useDatabaseFiles.getState().received(job("keep-running", "running"));
  for (let i = 0; i < 25; i++) useDatabaseFiles.getState().received(job(`history-${i}`, "done"));
  useDatabaseFiles.getState().received(job("new-running", "running"));
  expect(Object.values(useDatabaseFiles.getState().jobs).at(-1)?.id).toBe("new-running");
  expect(useDatabaseFiles.getState().jobs["keep-running"].state).toBe("running");
  expect(Object.keys(useDatabaseFiles.getState().jobs)).toHaveLength(22);
});
it("redacts native payloads while the vault is locked", async () => {
  native.isPermissionGranted.mockResolvedValue(true);
  useNotifications.getState().add("Sensitive server title", "Sensitive details", "locked");
  await vi.waitFor(() => expect(native.sendNotification).toHaveBeenCalledWith({ title: "Rookery notification", body: "Open Rookery to view the notification." }));
});
it("requests permission for an explicit test and sends through the shared inbox", async () => {
  native.requestPermission.mockResolvedValue("granted");
  native.isPermissionGranted.mockResolvedValueOnce(false).mockResolvedValue(true);
  await useNotifications.getState().test();
  await vi.waitFor(() => expect(native.sendNotification).toHaveBeenCalledOnce());
  expect(native.requestPermission).toHaveBeenCalledOnce();
  expect(useNotifications.getState().permission).toBe("granted");
  expect(useNotifications.getState().items[0].title).toBe("Rookery test notification");
});
it("tests already granted permission without requesting again", async () => {
  native.isPermissionGranted.mockResolvedValue(true);
  await useNotifications.getState().test();
  await vi.waitFor(() => expect(native.sendNotification).toHaveBeenCalledOnce());
  expect(native.requestPermission).not.toHaveBeenCalled();
});
it.each(["denied", "unavailable"])("keeps the test in the inbox when permission is %s", async (permission) => {
  if (permission === "denied") native.requestPermission.mockResolvedValue("denied");
  else native.isPermissionGranted.mockRejectedValue(new Error("Unavailable"));
  await useNotifications.getState().test();
  expect(useNotifications.getState().permission).toBe(permission);
  expect(useNotifications.getState().items).toHaveLength(1);
  expect(native.sendNotification).not.toHaveBeenCalled();
});
