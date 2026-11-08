// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { undoDepth } from "@codemirror/commands";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host } from "../../ipc/bindings/Host";
import type { GitFile } from "../../ipc/bindings/GitFile";
import type { GitStatus } from "../../ipc/bindings/GitStatus";
import type { EditorFile } from "../../ipc/bindings/EditorFile";

const ipc = vi.hoisted(() => ({ status: vi.fn(), diff: vi.fn(), action: vi.fn(), open: vi.fn(), save: vi.fn(), settings: vi.fn(), discover: vi.fn() }));
vi.mock("../../ipc/api", () => ({ api: { gitStatus: ipc.status, gitDiff: ipc.diff, gitAction: ipc.action, editorOpen: ipc.open, editorSave: ipc.save, settingGet: ipc.settings, settingSet: async () => {}, gitDiscover: ipc.discover }, asCoreError: (cause: unknown) => ({ message: cause instanceof Error ? cause.message : String(cause) }) }));
vi.mock("../editor/languages", () => ({ supportFor: async () => [] }));
import { GitView } from "./GitView";
import { DialogHost } from "../../ui/DialogHost";
import { useDialogs } from "../../stores/dialogs";
import { GIT_FRESH_MS, gitKey, useGit } from "../../stores/git";
import { useHosts } from "../../stores/hosts";
import { useEditor } from "../../stores/editor";
import { forgetHost, noteChange, replaceText, textOf } from "../editor/actions";

const host: Host = { id: "host", name: "Test server", address: "127.0.0.1", port: 22, env_label: "dev", group_id: null, tags: [], identity_id: null, jump_host_id: null, theme: null, start_view: "terminal", start_folder: "/repo", auto_reconnect: false, keepalive_s: 30, log_session: false, refresh: { mode: "inherit", interval_s: null, collect: null, desktop: null, mobile: null, wifi_only: null }, sort: 0, created_at: 0, updated_at: 0 };
const file = (path: string, index = ".", worktree = "M", original: string | null = null): GitFile => ({ path, index, worktree, original_path: original, conflicted: false });
const snapshot = (files: GitFile[]): GitStatus => ({ root: "/repo", branch: "main", upstream: "origin/main", ahead: 0, behind: 0, operation: null, files, branches: ["main"], remotes: ["origin"], stashes: [] });
let container: HTMLDivElement;
let root: Root;
let current: GitStatus;

async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
async function render(visible = true) { await act(async () => { root.render(<><GitView hostId="host" visible={visible} /><DialogHost /></>); }); await flush(); }
function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string, scope?: ParentNode) { await act(async () => { button(label, scope).click(); }); await flush(); }
function rightEditor(): EditorView {
  const element = container.querySelector<HTMLElement>(".cm-merge-b");
  const view = element && EditorView.findFromDOM(element);
  if (!view) throw new Error("Missing working-tree editor");
  return view;
}
function seed(files: GitFile[], age = 0) {
  current = snapshot(files);
  useGit.setState({ byHost: { host: { folders: ["/repo"], selected: "/repo", initialized: true } }, cache: { [gitKey("host", "/repo")]: { status: current, at: Date.now() - age, loading: false, revision: 0, loadedRevision: 0, attemptedRevision: 0, version: 1 } } });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useHosts.setState({ hosts: [host] });
  useDialogs.setState({ current: null, queue: [] });
  seed([file("src/app.ts")]);
  ipc.status.mockReset().mockImplementation(async () => current);
  ipc.action.mockReset().mockResolvedValue("");
  ipc.diff.mockReset().mockResolvedValue({ left: "base\n", right: "server\n", notice: null });
  ipc.open.mockReset().mockImplementation(async (_host: string, path: string): Promise<EditorFile> => ({ path, real_path: path, content: "server\n", version: { size: 7, mtime: 1, sha256: "server" }, eol: "lf", mixed_eol: false, bom: false, read_only: false, read_only_reason: null, owned: true, mode: "644", sudo: false }));
  ipc.save.mockReset();
  ipc.settings.mockReset().mockResolvedValue(null);
  ipc.discover.mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => root.unmount());
  forgetHost("host");
  container.remove();
  document.querySelectorAll('[role="dialog"]').forEach((element) => element.remove());
  vi.unstubAllGlobals();
});

it("folder stage confirms PROD cancel/accept once, includes nested files and leaves disclosure open", async () => {
  useHosts.setState({ hosts: [{ ...host, env_label: "prod" }] });
  seed([file("src/app.ts"), file("src/nested/deep.ts"), file("src-other/skip.ts")]);
  await render();
  const folder = button("Stage folder src").parentElement!.querySelector("details")!;
  await act(async () => button("Stage folder src").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  expect(folder.open).toBe(true);
  await click("Stage folder src");
  await click("Cancel", document.querySelector('[role="dialog"]')!);
  expect(ipc.action).not.toHaveBeenCalled();
  expect(folder.open).toBe(true);
  await click("Stage folder src");
  await click("Stage folder src", document.querySelector('[role="dialog"]')!);
  expect(ipc.action).toHaveBeenCalledExactlyOnceWith("host", "/repo", { kind: "stage", paths: ["src/app.ts", "src/nested/deep.ts"] }, true);
  expect(ipc.status).toHaveBeenCalledTimes(1);
  expect(folder.open).toBe(true);
});

it("folder unstage retains rename sources outside the folder and excludes prefix siblings", async () => {
  seed([file("src/renamed.ts", "R", ".", "elsewhere/old.ts"), file("src/nested/a.ts", "M", "."), file("src-other/skip.ts", "M", ".")]);
  await render();
  await click("Unstage folder src");
  expect(ipc.action).toHaveBeenCalledExactlyOnceWith("host", "/repo", { kind: "unstage", paths: ["src/renamed.ts", "elsewhere/old.ts", "src/nested/a.ts"] }, false);
});

it("save-and-stage confirms each PROD write separately without refreshing between confirmations", async () => {
  useHosts.setState({ hosts: [{ ...host, env_label: "prod" }] });
  ipc.save.mockResolvedValue({ kind: "saved", version: { size: 6, mtime: 2, sha256: "draft" }, method: "atomic" });
  await render();
  await click("Open changes diff src/app.ts");
  const view = rightEditor();
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "draft\n" } }));
  await click("Save & stage");
  expect(ipc.save).not.toHaveBeenCalled();
  await click("Save file", document.querySelector('[role="dialog"]')!);
  expect(ipc.save).toHaveBeenCalledExactlyOnceWith("host", "/repo/src/app.ts", "draft\n", "lf", false, { size: 7, mtime: 1, sha256: "server" }, "normal", true);
  expect(ipc.status).not.toHaveBeenCalled();
  expect(ipc.action).not.toHaveBeenCalled();
  await click("Stage src/app.ts", document.querySelector('[role="dialog"]')!);
  expect(ipc.action).toHaveBeenCalledExactlyOnceWith("host", "/repo", { kind: "stage", paths: ["src/app.ts"] }, true);
  expect(ipc.status).toHaveBeenCalledTimes(1);
});

it("invalidates without hidden requests and checks TTL only on returning to the visible view", async () => {
  seed([file("src/app.ts")], GIT_FRESH_MS + 1);
  await render(false);
  await act(async () => useGit.getState().invalidate("host"));
  expect(ipc.status).not.toHaveBeenCalled();
  expect(ipc.diff).not.toHaveBeenCalled();
  await render(true);
  expect(ipc.status).toHaveBeenCalledTimes(1);
  await act(async () => useGit.setState((state) => ({ cache: { ...state.cache, [gitKey("host", "/repo")]: { ...state.cache[gitKey("host", "/repo")], at: Date.now() - GIT_FRESH_MS - 1 } } })));
  await click("Show flat list");
  expect(ipc.status).toHaveBeenCalledTimes(1);
  await render(false);
  await render(true);
  expect(ipc.status).toHaveBeenCalledTimes(2);
});

it("does not loop on failed refreshes and consumes a newer in-flight invalidation once", async () => {
  let finish!: (value: GitStatus) => void;
  ipc.status.mockImplementationOnce(() => new Promise<GitStatus>((resolve) => { finish = resolve; }));
  await render();
  await act(async () => useGit.getState().invalidate("host"));
  await act(async () => useGit.getState().invalidate("host"));
  expect(ipc.status).toHaveBeenCalledTimes(1);
  await act(async () => finish(current));
  await flush();
  expect(ipc.status).toHaveBeenCalledTimes(2);
  ipc.status.mockRejectedValueOnce(new Error("Disconnected"));
  await act(async () => useGit.getState().invalidate("host"));
  await flush();
  expect(ipc.status).toHaveBeenCalledTimes(3);
  await click("Show flat list");
  await flush();
  expect(ipc.status).toHaveBeenCalledTimes(3);
  expect(container.textContent).toContain("Stale · cached");
});

it("keeps dirty drafts, cursor and undo across hide/show, Editor roundtrip and diff resizing", async () => {
  await render();
  await click("Open changes diff src/app.ts");
  const view = rightEditor();
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Git draft\n" }, selection: { anchor: 4 } }));
  const history = undoDepth(view.state);
  await act(async () => useGit.getState().invalidate("host", "/repo/src/app.ts"));
  await render(false);
  await render(true);
  expect(ipc.status).not.toHaveBeenCalled();
  expect(ipc.diff).toHaveBeenCalledTimes(1);
  expect(rightEditor()).toBe(view);
  expect(view.state.selection.main.head).toBe(4);
  expect(undoDepth(view.state)).toBe(history);
  const split = container.querySelector<HTMLElement>('[role="separator"][aria-label="Resize diff panes"]')!;
  await act(async () => split.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(rightEditor()).toBe(view);
  expect(view.state.selection.main.head).toBe(4);
  expect(undoDepth(view.state)).toBe(history);
  await render(false);
  const doc = useEditor.getState().byHost.host.docs[0];
  await act(async () => { replaceText(doc.key, "Editor draft\n"); noteChange(doc.key); });
  await render(true);
  expect(rightEditor()).toBe(view);
  expect(view.state.doc.toString()).toBe("Editor draft\n");
  await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: "back in Git\n" } }));
  expect(textOf(doc.key)).toBe("Editor draft\nback in Git\n");
});

it("opens a newly selected cached file after an in-flight status refresh fails", async () => {
  let fail!: (cause: Error) => void;
  ipc.status.mockImplementationOnce(() => new Promise<GitStatus>((_resolve, reject) => { fail = reject; }));
  await render();
  await click("Reload");
  await click("Open changes diff src/app.ts");
  expect(ipc.diff).not.toHaveBeenCalled();
  await act(async () => fail(new Error("Disconnected")));
  await flush();
  expect(ipc.status).toHaveBeenCalledTimes(1);
  expect(ipc.diff).toHaveBeenCalledTimes(1);
  expect(rightEditor().state.doc.toString()).toBe("server\n");
});

it("retains edits made while an earlier clean status request completes", async () => {
  let finish!: (value: GitStatus) => void;
  await render();
  await click("Open changes diff src/app.ts");
  const view = rightEditor();
  ipc.status.mockImplementationOnce(() => new Promise<GitStatus>((resolve) => { finish = resolve; }));
  await click("Reload");
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "new draft\n" }, selection: { anchor: 4 } }));
  await act(async () => finish(snapshot([file("src/app.ts", "M", ".")])));
  await flush();
  expect(ipc.diff).toHaveBeenCalledTimes(1);
  expect(rightEditor().state.doc.toString()).toBe("new draft\n");
  expect(useEditor.getState().byHost.host.docs[0].dirty).toBe(true);
  expect(ipc.status).toHaveBeenCalledTimes(1);
  expect(rightEditor()).toBe(view);
  expect(view.state.selection.main.head).toBe(4);
});

it("folder discard lists the files, sends nothing on cancel and exactly the listed files on accept", async () => {
  seed([file("src/app.ts"), file("src/new.ts", "?", "?"), file("src/staged.ts", "M", "."), file("src-other/skip.ts")]);
  await render();
  await click("Discard folder src");
  expect(document.body.textContent).toContain("revert  src/app.ts");
  expect(document.body.textContent).toContain("delete  src/new.ts");
  expect(document.body.textContent).not.toContain("src-other/skip.ts");
  expect(document.body.textContent).toContain("Staged changes are kept");
  await click("Cancel", document.body);
  expect(ipc.action).not.toHaveBeenCalled();
  await click("Discard folder src");
  await click("Discard 2 changes in src", document.body);
  expect(ipc.action).toHaveBeenCalledTimes(1);
  expect(ipc.action.mock.calls[0][2]).toEqual({ kind: "discard_paths", tracked: ["src/app.ts"], untracked: ["src/new.ts"] });
  expect(ipc.action.mock.calls[0][3]).toBe(true);
});

it("folder discard of many files needs the folder name typed", async () => {
  seed(Array.from({ length: 12 }, (_, i) => file(`lib/f${i}.ts`)));
  await render();
  await click("Discard folder lib");
  expect(button("Discard 12 changes in lib", document.body).disabled).toBe(true);
  expect(ipc.action).not.toHaveBeenCalled();
});
