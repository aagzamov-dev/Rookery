// File actions shared by the Files view and the Editor's folder tree: the ⋮ / right-click menu,
// create / rename / duplicate / delete, ZIP and tar.gz (servers only). One implementation, so both
// places behave the same, refresh each other, and keep open editor tabs and pins in step.
import { create } from "zustand";
import { Archive, ArchiveRestore, Copy, CopyPlus, FilePlus, FileText, FolderPlus, KeyRound, Pencil, Play, Trash2 } from "lucide-react";
import { api, asCoreError, type ArchiveMode } from "../../ipc/api";
import type { FileEntry } from "../../ipc/bindings/FileEntry";
import { copyText } from "../../ipc/clipboard";
import { askConfirm, askText } from "../../stores/dialogs";
import { useEditor } from "../../stores/editor";
import { joinPath, parentPath, useFiles } from "../../stores/files";
import { useHosts } from "../../stores/hosts";
import { useRecent } from "../../stores/recent";
import type { MenuItem } from "../../ui/ContextMenu";
import { bytes } from "../../ui/format";
import { close as closeDoc, openFile } from "../editor/actions";
import { COMPUTER_ID } from "../local/target";
import { makeExecutable, usePermissions } from "./Permissions";
import { useLogs } from "../../stores/logs";
import { useTabs } from "../../stores/tabs";

export interface FileCtx {
  hostId: string;
  /** Show a message (errors, "nothing was replaced", …) where the user is looking. */
  note: (message: string) => void;
}

// ------------------------------------------------------------------ names

/** Mirrors the core's check: one name, no separators, not `.`/`..`, no spaces at the ends.
 *  Names without an extension (`Dockerfile`) and dot files (`.env`) are fine. */
export function nameError(name: string): string | null {
  if (!name) return "Enter a name.";
  if (name === "." || name === "..") return "“.” and “..” cannot be used as names.";
  if (/[/\\\0]/.test(name)) return "Enter a name without slashes.";
  if (name.trim() !== name) return "Remove the spaces at the start or end of the name.";
  if (new TextEncoder().encode(name).length > 255) return "The name is too long.";
  return null;
}

/** `zip` for .zip, `targz` for .tar.gz / .tgz, else null. */
export function archiveKind(name: string): "zip" | "targz" | null {
  const n = name.toLowerCase();
  if (n.endsWith(".zip")) return "zip";
  if (n.endsWith(".tar.gz") || n.endsWith(".tgz")) return "targz";
  return null;
}

/** Folder name for extracting `name` (archive extension removed). */
export function extractName(name: string): string {
  const base = name.replace(/\.(zip|tar\.gz|tgz)$/i, "");
  return base && base !== name ? base : "extracted";
}

/** `report.txt` → `report copy.txt`; `Dockerfile` → `Dockerfile copy`; `.env` → `.env copy`. */
export function copyName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} copy${name.slice(dot)}` : `${name} copy`;
}

/** Whether `p` is `base` or inside it. */
export const within = (p: string, base: string) => p === base || p.startsWith(`${base.replace(/\/+$/, "")}/`);

// ------------------------------------------------------------- refreshing

/** A folder that was renamed (`to`) or deleted (`to: null`). */
export interface Moved { from: string; to: string | null }
type Listener = (hostId: string, dirs: string[], moved?: Moved) => void;
const listeners = new Set<Listener>();

/** The Editor tree subscribes to reload folders the Files view changed (and the other way round). */
export function onFilesChanged(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Where a view showing `path` should go after `moved`, or null when it is not affected. */
export function relocate(path: string, moved: Moved): string | null {
  if (!within(path, moved.from)) return null;
  return moved.to === null ? parentPath(moved.from) : moved.to + path.slice(moved.from.length);
}

/** Folders whose contents changed: refresh what is shown, drop stale cached listings.
 *  `moved`: a folder was renamed or deleted, so views inside it follow it (or go up). */
export function filesChanged(hostId: string, dirs: string[], moved?: Moved) {
  const files = useFiles.getState();
  const st = files.byHost[hostId];
  if (st) {
    const listings = Object.fromEntries(Object.entries(st.listings).filter(([d]) => !dirs.includes(d) && !(moved && within(d, moved.from))));
    files.patch(hostId, { listings });
    const next = st.path && moved ? relocate(st.path, moved) : null;
    if (next) files.patch(hostId, { path: next });
    const path = next ?? st.path;
    if (path && (next || dirs.includes(path)) && st.visible) void files.open(hostId, path, true);
  }
  for (const l of listeners) l(hostId, dirs, moved);
}

// ------------------------------------------------------- editor tabs, pins

const docsUnder = (hostId: string, path: string) =>
  (useEditor.getState().byHost[hostId]?.docs ?? []).filter((d) => within(d.path, path) || within(d.realPath, path));

/** Refuse when an affected editor tab has unsaved changes (they would be lost or point nowhere). */
function blockedByUnsaved(ctx: FileCtx, path: string, what: string): boolean {
  const dirty = docsUnder(ctx.hostId, path).filter((d) => d.dirty);
  if (!dirty.length) return false;
  ctx.note(`${dirty.map((d) => d.name).join(", ")} ${dirty.length === 1 ? "has" : "have"} unsaved changes in the editor. Save or close ${dirty.length === 1 ? "it" : "them"} before you ${what}.`);
  return true;
}

function movePins(hostId: string, from: string, to: string | null) {
  const pins = useEditor.getState().pins[hostId] ?? [];
  if (!pins.some((p) => within(p, from))) return;
  const next = pins.flatMap((p) => (!within(p, from) ? [p] : to === null ? [] : [to + p.slice(from.length)]));
  useEditor.getState().setPins(hostId, next);
}

/** After a rename: reopen the affected tabs at their new paths (they were all saved). */
async function moveDocs(hostId: string, from: string, to: string) {
  const h = useEditor.getState().byHost[hostId];
  const docs = docsUnder(hostId, from);
  const active = h?.active;
  for (const d of docs) {
    const base = within(d.path, from) ? d.path : d.realPath;
    closeDoc(d.key);
    await openFile(hostId, to + base.slice(from.length), d.key === active, d.sudo).catch(() => {});
  }
}

// ----------------------------------------------------------------- actions

const hostOf = (hostId: string) => useHosts.getState().hosts.find((h) => h.id === hostId);
const where = (hostId: string) => (hostId === COMPUTER_ID ? "this computer" : (hostOf(hostId)?.name ?? "the server"));
const cancelled = (e: unknown) => asCoreError(e).message === "Change cancelled.";

/** New empty file or folder inside `dir`. Returns the new path. */
export async function createIn(ctx: FileCtx, dir: string, kind: "file" | "folder"): Promise<string | null> {
  const name = await askText({ title: kind === "file" ? "New file" : "New folder", label: `Inside ${dir}`, value: "", confirmLabel: "Create" });
  if (name === null) return null;
  const error = nameError(name);
  if (error) {
    ctx.note(error);
    return null;
  }
  const path = joinPath(dir, name);
  try {
    if (kind === "file") await api.sftpCreateFile(ctx.hostId, path);
    else await api.sftpMkdir(ctx.hostId, path);
  } catch (e) {
    if (!cancelled(e)) ctx.note(asCoreError(e).message);
    return null;
  }
  filesChanged(ctx.hostId, [dir]);
  return path;
}

export async function renameEntry(ctx: FileCtx, e: FileEntry): Promise<string | null> {
  if (blockedByUnsaved(ctx, e.path, "rename it")) return null;
  const dot = e.kind === "file" ? e.name.lastIndexOf(".") : -1;
  const name = await askText({ title: `Rename ${e.name}`, label: "New name", value: e.name, confirmLabel: "Rename", selectUntil: dot > 0 ? dot : undefined });
  if (name === null || name === e.name) return null;
  const error = nameError(name);
  if (error) {
    ctx.note(error);
    return null;
  }
  // Checked again: a tab may have been edited while the dialog was open.
  if (blockedByUnsaved(ctx, e.path, "rename it")) return null;
  const dir = parentPath(e.path);
  const to = joinPath(dir, name);
  try {
    await api.sftpRename(ctx.hostId, e.path, to);
  } catch (x) {
    if (!cancelled(x)) ctx.note(asCoreError(x).message);
    return null;
  }
  movePins(ctx.hostId, e.path, to);
  useRecent.getState().move(ctx.hostId, e.path, to);
  await moveDocs(ctx.hostId, e.path, to);
  filesChanged(ctx.hostId, [dir], e.kind === "dir" ? { from: e.path, to } : undefined);
  return to;
}

export async function duplicateEntry(ctx: FileCtx, e: FileEntry): Promise<string | null> {
  const dot = copyName(e.name).lastIndexOf(".");
  const name = await askText({ title: `Duplicate ${e.name}`, label: "Name of the copy (same folder)", value: copyName(e.name), confirmLabel: "Duplicate", selectUntil: dot > 0 ? dot : undefined });
  if (name === null) return null;
  const error = nameError(name);
  if (error) {
    ctx.note(error);
    return null;
  }
  const dir = parentPath(e.path);
  const to = joinPath(dir, name);
  try {
    await api.sftpDuplicate(ctx.hostId, e.path, to);
  } catch (x) {
    if (!cancelled(x)) ctx.note(asCoreError(x).message);
    return null;
  }
  filesChanged(ctx.hostId, [dir]);
  return to;
}

export async function deleteEntry(ctx: FileCtx, e: FileEntry): Promise<boolean> {
  if (blockedByUnsaved(ctx, e.path, "delete it")) return false;
  const dir = e.kind === "dir";
  const prod = hostOf(ctx.hostId)?.env_label === "prod";
  const ok = await askConfirm({
    title: dir ? `Delete folder ${e.name}?` : `Delete ${e.name}?`,
    body: `${dir ? "The folder and everything inside it" : "The file"} will be removed from ${where(ctx.hostId)}. This cannot be undone.${prod ? " This is a PRODUCTION server." : ""}`,
    preview: e.path,
    confirmLabel: "Delete",
    danger: true,
    typeToConfirm: prod ? e.name : undefined,
  });
  if (!ok) return false;
  if (blockedByUnsaved(ctx, e.path, "delete it")) return false;
  try {
    await api.sftpDelete(ctx.hostId, e.path, dir, dir, true);
  } catch (x) {
    ctx.note(asCoreError(x).message);
    filesChanged(ctx.hostId, [parentPath(e.path)]);
    return false;
  }
  for (const d of docsUnder(ctx.hostId, e.path)) closeDoc(d.key);
  movePins(ctx.hostId, e.path, null);
  useRecent.getState().move(ctx.hostId, e.path, null);
  filesChanged(ctx.hostId, [parentPath(e.path)], dir ? { from: e.path, to: null } : undefined);
  return true;
}

/** Delete several entries of one folder after one confirmation that lists them. */
export async function deleteMany(ctx: FileCtx, entries: FileEntry[]): Promise<boolean> {
  if (entries.length === 0) return false;
  if (entries.length === 1) return deleteEntry(ctx, entries[0]);
  for (const e of entries) if (blockedByUnsaved(ctx, e.path, "delete it")) return false;
  const prod = hostOf(ctx.hostId)?.env_label === "prod";
  const folders = entries.filter((e) => e.kind === "dir").length;
  const label = `${entries.length} items`;
  const ok = await askConfirm({
    title: `Delete ${label}?`,
    body: `These will be removed from ${where(ctx.hostId)}${folders ? `, including everything inside ${folders === 1 ? "the folder" : `the ${folders} folders`}` : ""}. This cannot be undone.${prod ? " This is a PRODUCTION server." : ""}`,
    preview: entries.map((e) => (e.kind === "dir" ? `${e.path}/` : e.path)).join("\n"),
    confirmLabel: `Delete ${label}`,
    danger: true,
    typeToConfirm: prod ? label : undefined,
  });
  if (!ok) return false;
  const failed: string[] = [];
  for (const e of entries) {
    if (blockedByUnsaved(ctx, e.path, "delete it")) {
      failed.push(e.name);
      continue;
    }
    const dir = e.kind === "dir";
    try {
      await api.sftpDelete(ctx.hostId, e.path, dir, dir, true);
    } catch (x) {
      failed.push(`${e.name}: ${asCoreError(x).message}`);
      continue;
    }
    for (const d of docsUnder(ctx.hostId, e.path)) closeDoc(d.key);
    movePins(ctx.hostId, e.path, null);
    useRecent.getState().move(ctx.hostId, e.path, null);
    if (dir) filesChanged(ctx.hostId, [], { from: e.path, to: null });
  }
  filesChanged(ctx.hostId, [...new Set(entries.map((e) => parentPath(e.path)))]);
  if (failed.length) ctx.note(`Not deleted: ${failed.join("; ")}`);
  return failed.length === 0;
}

/** Menu for several selected entries. */
export function selectionMenu(ctx: FileCtx, entries: FileEntry[], onDone: () => void): MenuItem[] {
  return [
    { kind: "label", label: `${entries.length} selected` },
    { label: "Copy paths", icon: <Copy size={13} />, onClick: () => void copyText(entries.map((e) => e.path).join("\n")).catch((x: unknown) => ctx.note((x as Error).message)) },
    { kind: "separator" },
    { label: `Delete ${entries.length} items…`, icon: <Trash2 size={13} />, danger: true, onClick: () => void deleteMany(ctx, entries).then((ok) => ok && onDone()) },
  ];
}

// ------------------------------------------------------------ ZIP, tar.gz

export interface ArchiveJob {
  id: string;
  hostId: string;
  label: string;
  state: "running" | "failed";
  error: string | null;
}

interface ArchiveJobs {
  jobs: ArchiveJob[];
  put: (job: ArchiveJob) => void;
  drop: (id: string) => void;
}

export const useArchiveJobs = create<ArchiveJobs>((set) => ({
  jobs: [],
  put: (job) => set((s) => ({ jobs: [...s.jobs.filter((j) => j.id !== job.id), job] })),
  drop: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
}));

const BIG = 1024 ** 3;

/** "This folder is 3.2 GB" check before packing a folder. False = the user said no. */
async function sizeOk(hostId: string, e: FileEntry): Promise<boolean> {
  const size = e.kind === "dir" ? null : e.size;
  const usage = (await api.sftpUsage(hostId, e.path).catch(() => null)) ?? { size, free: null };
  const total = usage.size ?? size;
  const free = usage.free;
  const tooBig = total !== null && free !== null && total > free;
  if (total !== null && total < BIG && !tooBig) return true;
  return askConfirm({
    title: `Archive ${e.name}?`,
    body:
      total === null
        ? "Its size could not be measured within 20 seconds, so it is probably large. The archive is written beside it and uses disk space on the server until you delete it."
        : `It is ${bytes(total)}${free !== null ? `; ${bytes(free)} is free in this folder` : ""}. ${tooBig ? "The archive may not fit: it could fill the disk. " : ""}The archive is written beside it and uses disk space on the server until you delete it.`,
    preview: e.path,
    confirmLabel: "Create archive",
    danger: tooBig,
  });
}

/** Pack (`zip` / `targz`) or extract (`unzip` / `untargz`) beside the entry, in the background. */
export async function archiveEntry(ctx: FileCtx, e: FileEntry, mode: ArchiveMode): Promise<void> {
  const extract = mode === "unzip" || mode === "untargz";
  const ext = mode === "zip" ? ".zip" : ".tar.gz";
  const suggested = extract ? extractName(e.name) : `${e.name}${ext}`;
  const name = await askText({
    title: extract ? `Extract ${e.name}` : `${mode === "zip" ? "ZIP" : "tar.gz"} ${e.name}`,
    label: extract ? "New folder beside the archive" : "Archive name in this folder",
    value: suggested,
    confirmLabel: extract ? "Extract" : "Create archive",
    selectUntil: extract ? undefined : e.name.length,
  });
  if (name === null) return;
  const destination = !extract && !name.toLowerCase().endsWith(mode === "zip" ? ".zip" : ".tar.gz") && !(mode === "targz" && name.toLowerCase().endsWith(".tgz")) ? `${name}${ext}` : name;
  const error = nameError(destination);
  if (error) {
    ctx.note(error);
    return;
  }
  if (!extract && !(await sizeOk(ctx.hostId, e))) return;
  const id = crypto.randomUUID();
  const jobs = useArchiveJobs.getState();
  jobs.put({ id, hostId: ctx.hostId, label: `${extract ? "Extracting" : "Archiving"} ${e.name} → ${destination}`, state: "running", error: null });
  const dir = parentPath(e.path);
  try {
    await api.sftpArchive(ctx.hostId, e.path, destination, mode, id);
    useArchiveJobs.getState().drop(id);
  } catch (x) {
    const message = asCoreError(x).message;
    if (cancelled(x) || message.startsWith("Cancelled")) useArchiveJobs.getState().drop(id);
    else useArchiveJobs.getState().put({ id, hostId: ctx.hostId, label: `${extract ? "Extract" : "Archive"} ${e.name} failed`, state: "failed", error: message });
  }
  filesChanged(ctx.hostId, [dir]);
}

// ------------------------------------------------------------------- menu

export interface MenuExtras {
  /** First items (Open, Download, …) from the view. */
  top?: MenuItem[];
  /** Before Delete (cd here in terminal, Pin, …). */
  more?: MenuItem[];
  /** Where to put a new file/folder made from a folder's menu (default: that folder). */
  afterCreate?: (path: string, kind: "file" | "folder") => void;
}

/** The ⋮ / right-click menu for one entry. */
export function entryMenu(ctx: FileCtx, e: FileEntry, extras: MenuExtras = {}): MenuItem[] {
  const remote = ctx.hostId !== COMPUTER_ID;
  const dir = e.kind === "dir";
  const kind = e.kind === "file" ? archiveKind(e.name) : null;
  const create = (k: "file" | "folder") => () => void createIn(ctx, e.path, k).then((p) => p && extras.afterCreate?.(p, k));
  const items: MenuItem[] = [...(extras.top ?? [])];
  if (dir) {
    items.push(
      { label: "New file…", icon: <FilePlus size={13} />, onClick: create("file") },
      { label: "New folder…", icon: <FolderPlus size={13} />, onClick: create("folder") },
    );
  }
  if (items.length) items.push({ kind: "separator" });
  items.push({ label: "Rename…", icon: <Pencil size={13} />, onClick: () => void renameEntry(ctx, e) });
  if (e.kind === "file") items.push({ label: "Duplicate…", icon: <CopyPlus size={13} />, onClick: () => void duplicateEntry(ctx, e) });
  items.push({ label: "Copy path", icon: <Copy size={13} />, onClick: () => void copyText(e.path).catch((x: unknown) => ctx.note((x as Error).message)) });
  if (e.kind !== "link") {
    items.push({ label: "Permissions…", icon: <KeyRound size={13} />, onClick: () => usePermissions.getState().open(ctx, e) });
    if (e.kind === "file" && e.mode !== null && (e.mode & 0o111) === 0) items.push({ label: "Make executable", icon: <Play size={13} />, onClick: () => void makeExecutable(ctx, e) });
  }
  if (remote && e.kind === "file") {
    items.push({
      label: "Follow in Logs",
      icon: <FileText size={13} />,
      onClick: () => {
        useLogs.getState().setFileTarget(ctx.hostId, e.path);
        useTabs.getState().setView(ctx.hostId, "logs");
      },
    });
  }
  if (remote && e.kind !== "link") {
    items.push({ kind: "separator" });
    if (kind) items.push({ label: "Extract here…", icon: <ArchiveRestore size={13} />, onClick: () => void archiveEntry(ctx, e, kind === "zip" ? "unzip" : "untargz") });
    items.push(
      { label: "ZIP…", icon: <Archive size={13} />, onClick: () => void archiveEntry(ctx, e, "zip") },
      { label: "tar.gz…", icon: <Archive size={13} />, onClick: () => void archiveEntry(ctx, e, "targz") },
    );
  }
  if (extras.more?.length) items.push({ kind: "separator" }, ...extras.more);
  items.push({ kind: "separator" }, { label: dir ? "Delete folder…" : "Delete…", icon: <Trash2 size={13} />, danger: true, onClick: () => void deleteEntry(ctx, e) });
  return items;
}

/** Items for a folder's background / header ⋮ (the folder itself is not renamed or deleted here). */
export function folderMenu(ctx: FileCtx, dir: string, extras: Pick<MenuExtras, "more" | "afterCreate"> = {}): MenuItem[] {
  const create = (k: "file" | "folder") => () => void createIn(ctx, dir, k).then((p) => p && extras.afterCreate?.(p, k));
  return [
    { label: "New file…", icon: <FilePlus size={13} />, onClick: create("file") },
    { label: "New folder…", icon: <FolderPlus size={13} />, onClick: create("folder") },
    ...(extras.more?.length ? [{ kind: "separator" as const }, ...extras.more] : []),
  ];
}

