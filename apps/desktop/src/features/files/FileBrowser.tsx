import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import {
  ArrowUp,
  Check,
  Clock,
  Copy,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderPlus,
  FilePlus,
  FolderUp,
  Home,
  Link2,
  Loader2,
  MoreVertical,
  RefreshCw,
  SquareTerminal,
  Upload,
  FileEdit,
  FileCode2,
} from "lucide-react";
import { COMPUTER_ID } from "../local/target";
import { crumbs as pathCrumbs } from "../editor/lang";
import { openInEditor } from "../editor/actions";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { copyText } from "../../ipc/clipboard";
import { api, asCoreError } from "../../ipc/api";
import type { FileEntry } from "../../ipc/bindings/FileEntry";
import { SHELL_INTEGRATION_PREVIEW } from "./shellIntegration";
import { askConfirm } from "../../stores/dialogs";
import { parentPath, useFiles } from "../../stores/files";
import { useHosts } from "../../stores/hosts";
import { useTabs } from "../../stores/tabs";
import { terminalRegistry, } from "../server-tab/terminal/registry";
import { shellQuote } from "./quote";
import { bytes } from "../../ui/format";
import { TransfersStrip } from "./TransfersStrip";
import { ArchiveJobs } from "./ArchiveJobs";
import { useRecent } from "../../stores/recent";
import { createIn, entryMenu, folderMenu, selectionMenu, type FileCtx } from "./fileActions";
import { useContextMenu, type MenuItem } from "../../ui/ContextMenu";

interface Props {
  hostId: string;
  /** Only the visible browser loads data and accepts dropped files. */
  visible: boolean;
  variant: "panel" | "full";
}

const fmtDate = (s: number) => {
  if (!s) return "";
  const d = new Date(s * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
};

const fmtMode = (m: number | null) => {
  if (m == null) return "";
  const p = m & 0o777;
  return [6, 3, 0].map((sh) => ((p >> sh) & 4 ? "r" : "-") + ((p >> sh) & 2 ? "w" : "-") + ((p >> sh) & 1 ? "x" : "-")).join("");
};

export function FileBrowser({ hostId, visible, variant }: Props) {
  const local = hostId === COMPUTER_ID;
  const st = useFiles((s) => s.byHost[hostId]);
  const openDir = useFiles((s) => s.open);
  const patch = useFiles((s) => s.patch);
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const rootRef = useRef<HTMLDivElement>(null);
  const active = useRef(visible);
  active.current = visible;
  const [dropping, setDropping] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** Selected rows of the folder shown: click one, Ctrl/⌘-click to add, Shift-click for a range. */
  const [selection, setSelection] = useState<{ directory: string; paths: string[]; anchor: string } | null>(null);
  const selectOne = (directory: string, p: string) => setSelection({ directory, paths: [p], anchor: p });
  const menu = useContextMenu();
  const ctx: FileCtx = { hostId, note: setNote };

  /** Copies the plain path (no `cd`, no quotes) so you can type `cd ` and paste. */
  const copyPath = async (p: string) => {
    try {
      await copyText(p);
    } catch (x) {
      setNote((x as Error).message);
      return;
    }
    setCopied(p);
    setTimeout(() => setCopied((c) => (c === p ? null : c)), 1500);
  };

  const path = st?.path ?? null;
  const recentFolders = useRecent((s) => s.folders[hostId]);
  useEffect(() => {
    if (path && visible) useRecent.getState().addFolder(hostId, path);
  }, [path, visible, hostId]);
  const listing = path ? st?.listings[path] : undefined;
  const showHidden = st?.showHidden ?? false;

  // First show: open the terminal's folder (if following), the host's start folder, or home.
  useEffect(() => {
    useFiles.getState().setVisible(hostId, variant, visible);
    if (!visible) return;
    const cur = useFiles.getState().byHost[hostId];
    if (cur?.path) void openDir(hostId, (cur.follow && cur.terminalCwd) || cur.path); // cached unless stale
    else void openDir(hostId, (cur?.follow && cur.terminalCwd) || host?.start_folder || null);
    return () => useFiles.getState().setVisible(hostId, variant, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, hostId]);

  // Drag files from your computer onto the browser to upload into the current folder.
  useEffect(() => {
    if (!visible || local) return;
    let off: (() => void) | undefined;
    let disposed = false;
    const inside = (pos: { x: number; y: number }) => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return false;
      const x = pos.x / window.devicePixelRatio;
      const y = pos.y / window.devicePixelRatio;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "over") setDropping(inside(p.position));
        else if (p.type === "leave") setDropping(false);
        else if (p.type === "drop") {
          setDropping(false);
          const dir = useFiles.getState().byHost[hostId]?.path;
          if (dir && inside(p.position) && p.paths.length) void api.sftpUpload(hostId, p.paths, dir).catch((x) => setNote(asCoreError(x).message));
        }
      })
      .then((u) => { if (disposed) u(); else off = u; });
    return () => { disposed = true; off?.(); };
  }, [visible, hostId]);

  const entries = useMemo(() => (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith(".")), [listing, showHidden]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: entries.length, getScrollElement: () => scrollRef.current, estimateSize: () => panel ? 28 : 32, overscan: 10 });
  const picked = selection?.directory === path ? entries.filter((e) => selection.paths.includes(e.path)) : [];
  const selected = picked.length === 1 ? picked[0] : undefined;
  const isPicked = (p: string) => picked.some((e) => e.path === p);
  const clickRow = (ev: React.MouseEvent, e: FileEntry) => {
    if (!path) return;
    const cur = selection?.directory === path ? selection : null;
    if ((ev.metaKey || ev.ctrlKey) && cur) {
      const paths = cur.paths.includes(e.path) ? cur.paths.filter((p) => p !== e.path) : [...cur.paths, e.path];
      setSelection({ directory: path, paths, anchor: e.path });
    } else if (ev.shiftKey && cur) {
      const a = entries.findIndex((x) => x.path === cur.anchor);
      const b = entries.findIndex((x) => x.path === e.path);
      if (a < 0 || b < 0) return selectOne(path, e.path);
      setSelection({ directory: path, paths: entries.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path), anchor: cur.anchor });
    } else selectOne(path, e.path);
  };
  const multiMenu = () => selectionMenu(ctx, picked, () => setSelection(null));

  const go = (p: string) => active.current && void openDir(hostId, p);
  const refresh = () => active.current && path && void openDir(hostId, path, true);

  const activate = async (e: FileEntry) => {
    if (e.kind === "dir") return go(e.path);
    if (e.kind === "link") {
      // Try as a folder first; fall back to editing.
      try {
        await api.sftpList(hostId, e.path);
        return go(e.path);
      } catch {
        /* not a folder */
      }
    }
    return editInRookery(e, true);
  };

  /**
   * Double-click / Enter on a file: the Editor view (safe save, merge, history). Files it can't
   * edit (binary, not UTF-8, too big) open with this PC's program instead, as before.
   */
  const editInRookery = async (e: FileEntry, fallback = false) => {
    setNote(null);
    try {
      await openInEditor(hostId, e.path);
    } catch (x) {
      const msg = asCoreError(x).message;
      if (/larger than|too large/i.test(msg)) { setNote(msg); return; }
      if (fallback && /binary|UTF-8/i.test(msg)) return editLocally(e);
      setNote(`${msg} You can still use “Edit locally”.`);
    }
  };

  const editLocally = async (e: FileEntry) => {
    setNote(null);
    if (local) { await openPath(e.path).catch((e: unknown) => setNote(asCoreError(e).message)); return; }
    try {
      const local = await api.editOpen(hostId, e.path);
      useFiles.getState().setEdit({ hostId, remote: e.path, local, state: "open", message: null, at: Date.now() });
      setNote("Local saves stay on this computer. Use Review upload in Files to send changes to the server.");
      await openPath(local);
    } catch (x) {
      setNote(asCoreError(x).message);
    }
  };

  const download = async (e: FileEntry) => {
    const target = await saveDialog({ defaultPath: e.name, title: `Download ${e.name}` });
    if (!target) return;
    await api.sftpDownload(hostId, e.path, target).catch((x) => setNote(asCoreError(x).message));
  };

  const upload = async (directory = false) => {
    if (!path) return;
    const picked = await openDialog({ multiple: true, directory, title: directory ? `Upload folder to ${path}` : `Upload to ${path}` });
    const list = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
    if (list.length) await api.sftpUpload(hostId, list, path).catch((x) => setNote(asCoreError(x).message));
  };

  /** New file / folder from the toolbar or the list background: select it once created. */
  const create = async (kind: "file" | "folder") => {
    if (!path) return;
    const dir = path;
    const made = await createIn(ctx, dir, kind);
    if (made) selectOne(dir, made);
  };

  /** ⋮ and right-click on a row. */
  const itemsFor = (e: FileEntry): MenuItem[] =>
    entryMenu(ctx, e, {
      top: [
        ...(e.kind !== "dir" ? [{ label: "Edit in Rookery", icon: <FileCode2 size={13} />, onClick: () => void editInRookery(e) }] : []),
        ...(e.kind === "file" ? [{ label: local ? "Open with default app" : "Edit locally…", icon: <FileEdit size={13} />, onClick: () => void editLocally(e) }] : []),
        ...(!local && e.kind === "file" ? [{ label: "Download…", icon: <Download size={13} />, onClick: () => void download(e) }] : []),
      ],
      more: [{ label: "cd here in terminal", icon: <SquareTerminal size={13} />, onClick: () => cdInTerminal(e.kind === "dir" ? e.path : parentPath(e.path)) }],
    });

  const cdInTerminal = (p: string) => {
    if (local) { useTabs.getState().addTerminal(hostId, { cwd: p }); return; }
    const views = useTabs.getState().views[hostId];
    const key = views?.activeTerminal ?? useTabs.getState().addTerminal(hostId);
    if (!key) return;
    useTabs.getState().setView(hostId, "terminal");
    terminalRegistry.runCommand(key, `cd ${shellQuote(p)}`);
    terminalRegistry.focus(key);
  };

  const enableFollow = async () => {
    const ok = await askConfirm({
      title: "Let Files follow your terminal?",
      body: `${host?.env_label === "prod" ? "This is a PRODUCTION server. " : ""}Adds a few lines to ~/.bashrc and ~/.zshrc on this server so your prompt reports its folder. Rookery never polls for it. Takes effect in new terminals.`,
      preview: SHELL_INTEGRATION_PREVIEW,
      confirmLabel: "Add to shell config",
    });
    if (!ok) return;
    try {
      const n = await api.shellIntegrationInstall(hostId, true);
      setNote(`Added to ${n} shell config file${n === 1 ? "" : "s"}. Open a new terminal (+) and Files will follow your cd.`);
    } catch (x) {
      setNote(asCoreError(x).message);
    }
  };

  const crumbs = useMemo(() => {
    if (!path) return [];
    return pathCrumbs(path).map(([name, path]) => ({ name, path }));
  }, [path]);

  const panel = variant === "panel";

  return (
    <div ref={rootRef} aria-disabled={!visible} style={{ pointerEvents: visible ? undefined : "none" }} className={clsx("relative flex h-full min-h-0 flex-col", panel ? "bg-panel" : "bg-bg")}>
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
        {panel && <span className="mr-1 px-1 text-[13px] font-semibold">Files</span>}
        <Tool label="Up one folder" onClick={() => path && go(parentPath(path))} disabled={!path || path === "/"}>
          <ArrowUp size={14} />
        </Tool>
        <Tool label="Home folder" onClick={() => st?.home && go(st.home)} disabled={!st?.home}>
          <Home size={14} />
        </Tool>
        <Tool
          label="Recent folders"
          disabled={!recentFolders?.length}
          onClick={menu.below(() => (recentFolders ?? []).filter((p) => p !== path).slice(0, 15).map((p) => ({ label: p, icon: <Folder size={13} />, onClick: () => go(p) })))}
        >
          <Clock size={14} />
        </Tool>
        <Tool label="Refresh" onClick={refresh} disabled={!path}>
          <RefreshCw size={13} className={st?.loading ? "animate-spin" : ""} />
        </Tool>
        <Tool label="New file" onClick={() => void create("file")} disabled={!path}>
          <FilePlus size={14} />
        </Tool>
        <Tool label="New folder" onClick={() => void create("folder")} disabled={!path}>
          <FolderPlus size={14} />
        </Tool>
        {!local && <Tool label="Upload files" onClick={() => void upload()} disabled={!path}>
          <Upload size={14} />
        </Tool>}
        {!local && <Tool label="Upload a folder" onClick={() => void upload(true)} disabled={!path}>
          <FolderUp size={14} />
        </Tool>}
        <Tool label={showHidden ? "Hide hidden files" : "Show hidden files"} onClick={() => patch(hostId, { showHidden: !showHidden })}>
          {showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
        </Tool>
        {!local && selected?.kind === "file" && (
          <Tool label={`Download ${selected.name}`} onClick={() => void download(selected)}>
            <Download size={14} />
          </Tool>
        )}
        {selected && (
          <Tool label={`Actions for ${selected.name}`} onClick={menu.below(() => itemsFor(selected))}>
            <MoreVertical size={14} />
          </Tool>
        )}
        {picked.length > 1 && (
          <>
            <span className="px-1 text-xs text-muted">{picked.length} selected</span>
            <Tool label={`Actions for ${picked.length} selected items`} onClick={menu.below(multiMenu)}>
              <MoreVertical size={14} />
            </Tool>
          </>
        )}
        {!local && panel && (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted" title="Follow the folder of this server's terminal">
            <input type="checkbox" checked={st?.follow ?? true} onChange={(e) => patch(hostId, { follow: e.target.checked })} className="accent-accent" />
            Follow terminal
          </label>
        )}
      </div>

      {/* breadcrumb */}
      <div className="flex items-center gap-0.5 overflow-x-auto border-b border-line px-3 py-1.5 font-mono text-xs whitespace-nowrap text-muted">
        {crumbs.map((c, i) => (
          <span key={c.path} className="flex items-center">
            {i > 1 && <span className="px-0.5">/</span>}
            <button onClick={() => go(c.path)} className={clsx("rounded px-1 hover:bg-panel2 hover:text-text", i === crumbs.length - 1 && "text-text")}>
              {c.name}
            </button>
          </span>
        ))}
        {!path && st?.loading && <span>{local ? "Opening local folder…" : "Opening SFTP…"}</span>}
        {path && (
          <button
            aria-label="Copy folder path"
            title={copied === path ? "Copied" : "Copy folder path"}
            onClick={() => void copyPath(path)}
            className={clsx(
              "ml-auto flex h-6 flex-none items-center gap-1.5 rounded-md px-2 font-sans text-[11px]",
              copied === path ? "text-ok" : "text-muted hover:bg-panel2 hover:text-text",
            )}
          >
            {copied === path ? <Check size={12} /> : <Copy size={12} />}
            {copied === path ? "Copied" : "Copy path"}
          </button>
        )}
      </div>

      {!local && panel && st?.follow && st.terminalCwd === null && (
        <div className="flex items-center gap-2 border-b border-line bg-[#22304A] px-3 py-1.5 text-[11px] text-muted">
          <span className="flex-1">Files can follow your cd once shell integration is on.</span>
          <button onClick={() => void enableFollow()} className="text-accent">
            Turn on
          </button>
        </div>
      )}

      {/* list */}
      {st?.error ? (
        <div className="p-4 text-xs text-[#FFA8A8]">{st.error}</div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-1" role="grid" aria-label="Files" aria-rowcount={entries.length} onContextMenu={path ? menu.open(() => folderMenu(ctx, path, { more: [{ label: "Refresh", icon: <RefreshCw size={13} />, onClick: refresh }] })) : undefined}>
          {!panel && (
            <div className="grid grid-cols-[minmax(0,1fr)_90px_110px_100px_120px] gap-x-3 px-2.5 py-1.5 text-[11px] tracking-wider text-muted uppercase">
              <span>Name</span>
              <span className="text-right">Size</span>
              <span className="text-right">Modified</span>
              <span>Mode</span>
              <span />
            </div>
          )}
          <div style={{ height: virtual.getTotalSize(), position: "relative", minWidth: panel ? undefined : 640 }}>
          {virtual.getVirtualItems().map((item) => {
            const e = entries[item.index];
            return (
            <div
              key={e.path}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
              role="row"
              aria-rowindex={item.index + 1}
              aria-selected={isPicked(e.path)}
              tabIndex={0}
              onClick={(ev) => clickRow(ev, e)}
              onMouseDown={(ev) => ev.shiftKey && ev.preventDefault() /* no text selection on Shift-click */}
              onDoubleClick={() => void activate(e)}
              onContextMenu={(ev) => {
                // Right-click inside a multi-selection acts on all of it; elsewhere on this row.
                if (picked.length > 1 && isPicked(e.path)) return menu.open(multiMenu)(ev);
                if (path) selectOne(path, e.path);
                menu.open(() => itemsFor(e))(ev);
              }}
              onKeyDown={(k) => {
                if (k.key === "Enter") void activate(e);
                if (k.key === "Escape" && picked.length) setSelection(null);
                if (k.key === "ArrowDown" || k.key === "ArrowUp") {
                  k.preventDefault();
                  const next = Math.max(0, Math.min(entries.length - 1, item.index + (k.key === "ArrowDown" ? 1 : -1)));
                  if (path && entries[next]) selectOne(path, entries[next].path);
                  virtual.scrollToIndex(next);
                  requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLElement>(`[aria-rowindex="${next + 1}"]`)?.focus());
                }
              }}
              className={clsx(
                "group/r items-center gap-x-3 rounded-[5px] px-2 hover:bg-panel2 focus:bg-accent-bg focus:outline-none",
                isPicked(e.path) && "bg-accent-bg",
                panel ? "flex h-7" : "grid h-8 grid-cols-[minmax(0,1fr)_90px_110px_100px_120px]",
              )}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {e.kind === "dir" ? (
                  <Folder size={14} className="flex-none text-accent" fill="#34507E" />
                ) : e.kind === "link" ? (
                  <Link2 size={14} className="flex-none text-[#7FDBCA]" />
                ) : (
                  <FileIcon size={14} className="flex-none text-muted" />
                )}
                <span className="truncate">{e.name}</span>
              </span>
              <span className={clsx("text-right text-xs text-muted", panel && "w-16 flex-none group-hover/r:hidden")}>{e.kind === "dir" ? "" : bytes(e.size)}</span>
              {!panel && <span className="text-right text-xs text-muted">{fmtDate(e.mtime)}</span>}
              {!panel && <span className="font-mono text-[11px] text-muted">{fmtMode(e.mode)}</span>}
              <span className={clsx("flex justify-end gap-0.5", panel ? "hidden flex-none group-hover/r:flex group-focus-within/r:flex" : "invisible group-hover/r:visible group-focus-within/r:visible")}>
                {e.kind === "dir" ? (
                  <RowBtn label="cd here in terminal" onClick={() => cdInTerminal(e.path)}>
                    <SquareTerminal size={13} />
                  </RowBtn>
                ) : (
                  <>
                    <RowBtn label="Edit in Rookery" onClick={() => void editInRookery(e)}>
                      <FileCode2 size={13} />
                    </RowBtn>
                    <RowBtn label={local ? "Open with default app" : "Edit locally (review before upload)"} onClick={() => void editLocally(e)}>
                      <FileEdit size={13} />
                    </RowBtn>
                    {!local && <RowBtn label="Download" onClick={() => void download(e)}>
                      <Download size={13} />
                    </RowBtn>}
                  </>
                )}
                <RowBtn label={copied === e.path ? "Copied" : "Copy path"} onClick={() => void copyPath(e.path)}>
                  {copied === e.path ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                </RowBtn>
                <RowBtn label={`Actions for ${e.name}`} onClick={menu.below(() => itemsFor(e))}>
                  <MoreVertical size={13} />
                </RowBtn>
              </span>
            </div>
          ); })}
          </div>
          {listing && entries.length === 0 && <div className="px-3 py-4 text-xs text-muted">Empty folder</div>}
          {!listing && st?.loading && (
            <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted">
              <Loader2 size={13} className="animate-spin" /> Loading…
            </div>
          )}
        </div>
      )}

      {note && (
        <div className="flex items-start gap-2 border-t border-line px-3 py-2 text-xs text-muted">
          <span className="flex-1">{note}</span>
          <button onClick={() => setNote(null)} className="text-accent">
            OK
          </button>
        </div>
      )}
      {!local && <ArchiveJobs hostId={hostId} />}
      {!local && <TransfersStrip hostId={hostId} />}
      {menu.node}
      {dropping && (
        <div className="pointer-events-none absolute inset-1 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-[#1B2230CC] text-accent">
          Drop to upload into {path}
        </div>
      )}
    </div>
  );
}

function Tool({ label, onClick, disabled, children }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} disabled={disabled} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text">
      {children}
    </button>
  );
}

function RowBtn({ label, onClick, children }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-line hover:text-text"
    >
      {children}
    </button>
  );
}
