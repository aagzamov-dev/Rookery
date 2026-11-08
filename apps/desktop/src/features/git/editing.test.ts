import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditorFile } from "../../ipc/bindings/EditorFile";

const { open, save } = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../../ipc/api", () => ({ api: { editorOpen: open, editorSave: save }, asCoreError: (error: Error) => error }));
vi.mock("../editor/languages", () => ({ supportFor: async () => [] }));
import { close, forgetHost, noteChange, openFile, replaceText, saveRaw, textOf } from "../editor/actions";
import { useEditor } from "../../stores/editor";
import { normalizeGitText } from "./GitView";

const file: EditorFile = { path: "/repo/file.txt", real_path: "/repo/file.txt", content: "original\n", version: { size: 13, mtime: 1, sha256: "original" }, eol: "crlf", mixed_eol: false, bom: true, read_only: false, read_only_reason: null, owned: true, mode: "644", sudo: false };
beforeEach(() => {
  open.mockReset().mockResolvedValue(file);
  save.mockReset().mockResolvedValue({ kind: "saved", version: { size: 14, mtime: 2, sha256: "updated" }, method: "atomic" });
});
afterEach(() => forgetHost("host"));

it("normalizes only BOM and CRLF when comparing with editor text", () => {
  expect(normalizeGitText("\uFEFFfirst\r\nstray\rcarriage\r\n")).toBe("first\nstray\rcarriage\n");
});

it("preserves drafts through Git/Editor round trips without switching the active editor tab", async () => {
  const doc = await openFile("host", file.path, false);
  expect(useEditor.getState().byHost.host.active).toBe(null);
  replaceText(doc.key, "Git edit\n");
  noteChange(doc.key);
  await openFile("host", file.path);
  expect(textOf(doc.key)).toBe("Git edit\n");
  replaceText(doc.key, "Editor edit\n");
  noteChange(doc.key);
  const returned = await openFile("host", file.path, false);
  expect(textOf(returned.key)).toBe("Editor edit\n");
  replaceText(returned.key, `${textOf(returned.key)}next Git edit\n`);
  noteChange(returned.key);
  expect(textOf(returned.key)).toBe("Editor edit\nnext Git edit\n");
  expect(useEditor.getState().byHost.host.docs[0].dirty).toBe(true);
});

it("saves against the opened version with its original EOL/BOM and explicit production confirmation", async () => {
  const doc = await openFile("host", file.path, false);
  replaceText(doc.key, "updated\n");
  noteChange(doc.key);
  await saveRaw(doc.key, textOf(doc.key), "normal", true);
  expect(save).toHaveBeenCalledWith("host", file.real_path, "updated\n", "crlf", true, file.version, "normal", true);
  expect(useEditor.getState().byHost.host.docs[0].dirty).toBe(false);
});

it("keeps a draft after a rejected stale save and can reopen a closed cached file", async () => {
  const doc = await openFile("host", file.path, false);
  replaceText(doc.key, "my draft\n");
  noteChange(doc.key);
  save.mockResolvedValueOnce({ kind: "conflict", theirs: "someone else's edit\n", theirs_version: { size: 20, mtime: 3, sha256: "theirs" }, deleted: false });
  expect((await saveRaw(doc.key, textOf(doc.key), "normal")).kind).toBe("conflict");
  expect(textOf(doc.key)).toBe("my draft\n");
  expect(useEditor.getState().byHost.host.docs[0].dirty).toBe(true);
  close(doc.key);
  expect(textOf(doc.key)).toBe("");
  const reopened = await openFile("host", file.path, false);
  expect(textOf(reopened.key)).toBe(file.content);
});
