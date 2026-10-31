import { beforeEach, expect, it, vi } from "vitest";
const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../ipc/api", () => ({ api: { sftpList: list }, asCoreError: (error: Error) => error }));
import { useFiles } from "./files";
import type { FileEntry } from "../ipc/bindings/FileEntry";
beforeEach(() => { useFiles.getState().forget("host"); list.mockReset(); });
it("does not replace newer navigation with an older listing", async () => {
  let resolveOld!: (value: FileEntry[]) => void;
  list.mockImplementationOnce(() => new Promise<FileEntry[]>((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce([]);
  const old = useFiles.getState().open("host", "/old");
  await useFiles.getState().open("host", "/new");
  resolveOld([]);
  await old;
  expect(useFiles.getState().byHost.host.path).toBe("/new");
  expect(useFiles.getState().byHost.host.loading).toBe(false);
  expect(useFiles.getState().byHost.host.listings["/old"]).toBeUndefined();
});
it("does not resurrect a closed file browser when a request completes", async () => {
  let resolve!: (value: FileEntry[]) => void;
  list.mockImplementationOnce(() => new Promise<FileEntry[]>((done) => { resolve = done; }));
  const pending = useFiles.getState().open("host", "/old");
  useFiles.getState().forget("host");
  resolve([]);
  await pending;
  expect(useFiles.getState().byHost.host).toBeUndefined();
});
