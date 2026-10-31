import { beforeEach, expect, it, vi } from "vitest";
import type { GitStatus } from "../ipc/bindings/GitStatus";

const { getSetting, setSetting, status, discover } = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn(), status: vi.fn(), discover: vi.fn() }));
vi.mock("../ipc/api", () => ({ api: { settingGet: getSetting, settingSet: setSetting, gitStatus: status, gitDiscover: discover }, asCoreError: (error: Error) => error }));
import { GIT_FRESH_MS, gitKey, gitNeedsRefresh, useGit } from "./git";

const snapshot: GitStatus = { root: "/repo", branch: "main", upstream: null, ahead: 0, behind: 0, operation: null, files: [], branches: ["main"], remotes: [], stashes: [] };
beforeEach(() => {
  useGit.setState({ byHost: {}, cache: {} });
  getSetting.mockReset().mockResolvedValue(null);
  setSetting.mockReset().mockResolvedValue(undefined);
  status.mockReset().mockResolvedValue(snapshot);
  discover.mockReset().mockResolvedValue([]);
});

it("loads saved folders lazily without asking the server for repository status", async () => {
  expect(getSetting).not.toHaveBeenCalled();
  expect(status).not.toHaveBeenCalled();
  await useGit.getState().load("host", "/initial");
  expect(useGit.getState().byHost.host).toEqual({ folders: [], selected: null, initialized: false });
  expect(status).not.toHaveBeenCalled();
  expect(discover).not.toHaveBeenCalled();
  await useGit.getState().load("host", "/changed-start-folder");
  expect(getSetting).toHaveBeenCalledTimes(1);
});

it("keeps remembered folders and selection separate for each server", async () => {
  getSetting.mockResolvedValueOnce({ folders: ["/repo", "/other"], selected: "/other" });
  await useGit.getState().load("a", "/initial");
  await useGit.getState().load("b", "/initial");
  useGit.getState().select("a", "/new");
  expect(useGit.getState().byHost.a.selected).toBe("/new");
  expect(useGit.getState().byHost.b.selected).toBe(null);
  useGit.getState().remove("a", "/new");
  expect(useGit.getState().byHost.a.selected).toBe("/repo");
  expect(status).not.toHaveBeenCalled();
});

it("discovers once, preserves saved repositories and replaces the initial parent folder", async () => {
  getSetting.mockResolvedValueOnce({ folders: ["/initial", "/saved"], selected: "/initial" });
  discover.mockResolvedValueOnce(["/initial/app", "/initial/team/api"]);
  await useGit.getState().load("host", "/initial");
  await useGit.getState().initialize("host", "/initial", () => true);
  expect(useGit.getState().byHost.host).toEqual({ folders: ["/saved", "/initial/app", "/initial/team/api"], selected: "/initial/app", initialized: true });
  expect(setSetting.mock.calls[0][1].initialized).toBe(true);
  await useGit.getState().initialize("host", "/changed", () => true);
  expect(discover).toHaveBeenCalledTimes(1);
  expect(status).not.toHaveBeenCalled();
});

it("never discovers after becoming hidden while saving the first-open marker", async () => {
  let finish!: () => void;
  let visible = true;
  setSetting.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  await useGit.getState().load("host", "/initial");
  const pending = useGit.getState().initialize("host", "/initial", () => visible);
  visible = false;
  finish();
  await pending;
  expect(discover).not.toHaveBeenCalled();
  expect(useGit.getState().byHost.host.initialized).toBe(false);
  visible = true;
  await useGit.getState().initialize("host", "/initial", () => visible);
  expect(discover).toHaveBeenCalledTimes(1);
});

it("persists an empty/failed discovery attempt and does not repeat it", async () => {
  await useGit.getState().load("empty", "/initial");
  await useGit.getState().initialize("empty", "/initial", () => true);
  await useGit.getState().initialize("empty", "/initial", () => true);
  expect(discover).toHaveBeenCalledTimes(1);
  await useGit.getState().load("failed", "/initial");
  discover.mockRejectedValueOnce(new Error("Disconnected"));
  await expect(useGit.getState().initialize("failed", "/initial", () => true)).rejects.toThrow("Disconnected");
  await useGit.getState().initialize("failed", "/initial", () => true);
  expect(discover).toHaveBeenCalledTimes(2);
  expect(useGit.getState().byHost.failed.initialized).toBe(true);
});

it("restores the initialization marker and canonicalizes manually saved folders", async () => {
  getSetting.mockResolvedValueOnce({ folders: ["/repo/sub", "/repo"], selected: "/repo/sub", initialized: true });
  await useGit.getState().load("host", "/initial");
  await useGit.getState().initialize("host", "/initial", () => true);
  expect(discover).not.toHaveBeenCalled();
  await useGit.getState().refresh("host", "/repo/sub");
  expect(useGit.getState().byHost.host.folders).toEqual(["/repo"]);
  expect(useGit.getState().byHost.host.selected).toBe("/repo");
  expect(useGit.getState().cache[gitKey("host", "/repo/sub")]).toBeUndefined();
});

it("deduplicates status loads and preserves cached status on navigation and reload errors", async () => {
  let finish!: (value: GitStatus) => void;
  status.mockImplementationOnce(() => new Promise<GitStatus>((resolve) => { finish = resolve; }));
  const first = useGit.getState().refresh("host", "/repo");
  await useGit.getState().refresh("host", "/repo");
  expect(status).toHaveBeenCalledTimes(1);
  finish(snapshot);
  await first;
  useGit.getState().select("host", "/other");
  useGit.getState().select("host", "/repo");
  expect(status).toHaveBeenCalledTimes(1);
  expect(useGit.getState().cache[gitKey("host", "/repo")].status).toEqual(snapshot);
  status.mockRejectedValueOnce(new Error("Disconnected"));
  await useGit.getState().refresh("host", "/repo");
  expect(useGit.getState().cache[gitKey("host", "/repo")]).toMatchObject({ status: snapshot, loading: false, error: "Disconnected" });
});

it("invalidates only matching server repositories without making requests", async () => {
  status.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ ...snapshot, root: "/repo-other" }).mockResolvedValueOnce(snapshot);
  await useGit.getState().refresh("host", "/repo");
  await useGit.getState().refresh("host", "/repo-other");
  await useGit.getState().refresh("other", "/repo");
  useGit.getState().invalidate("host", "/repo/file");
  expect(status).toHaveBeenCalledTimes(3);
  expect(useGit.getState().cache[gitKey("host", "/repo")].revision).toBe(1);
  expect(useGit.getState().cache[gitKey("host", "/repo-other")].revision).toBe(0);
  expect(useGit.getState().cache[gitKey("other", "/repo")].revision).toBe(0);
});

it("retains invalidation during a load and stops retrying the same failed revision", async () => {
  let finish!: (value: GitStatus) => void;
  status.mockImplementationOnce(() => new Promise<GitStatus>((resolve) => { finish = resolve; }));
  const pending = useGit.getState().refresh("host", "/repo");
  useGit.getState().invalidate("host", "/repo/file");
  finish(snapshot);
  await pending;
  expect(gitNeedsRefresh(useGit.getState().cache[gitKey("host", "/repo")], false)).toBe(true);
  status.mockRejectedValueOnce(new Error("Disconnected"));
  await useGit.getState().refresh("host", "/repo");
  expect(gitNeedsRefresh(useGit.getState().cache[gitKey("host", "/repo")], false)).toBe(false);
  useGit.getState().invalidate("host");
  expect(gitNeedsRefresh(useGit.getState().cache[gitKey("host", "/repo")], false)).toBe(true);
});

it("does not lose canonical invalidation when an alias request completes", async () => {
  await useGit.getState().refresh("host", "/repo");
  let finish!: (value: GitStatus) => void;
  status.mockImplementationOnce(() => new Promise<GitStatus>((resolve) => { finish = resolve; }));
  const pending = useGit.getState().refresh("host", "/repo/sub");
  useGit.getState().invalidate("host", "/repo/file");
  finish(snapshot);
  await pending;
  const value = useGit.getState().cache[gitKey("host", "/repo")];
  expect(value.revision).toBe(1);
  expect(gitNeedsRefresh(value, false)).toBe(true);
  expect(useGit.getState().cache[gitKey("host", "/repo/sub")]).toBeUndefined();
});

it("preserves a newer canonical response over an older alias response", async () => {
  await useGit.getState().refresh("host", "/repo");
  let finish!: (value: GitStatus) => void;
  status.mockImplementationOnce(() => new Promise<GitStatus>((resolve) => { finish = resolve; }));
  const pending = useGit.getState().refresh("host", "/repo/sub");
  status.mockResolvedValueOnce({ ...snapshot, ahead: 5 });
  await useGit.getState().refresh("host", "/repo");
  finish(snapshot);
  await pending;
  expect(useGit.getState().cache[gitKey("host", "/repo")].status?.ahead).toBe(5);
});

it("checks TTL only when explicitly told the repository has been shown", () => {
  const cached = { status: snapshot, at: 100, loading: false };
  expect(gitNeedsRefresh(cached, false, 100 + GIT_FRESH_MS)).toBe(false);
  expect(gitNeedsRefresh(cached, true, 100 + GIT_FRESH_MS)).toBe(true);
  expect(gitNeedsRefresh(cached, true, 100 + GIT_FRESH_MS - 1)).toBe(false);
});
