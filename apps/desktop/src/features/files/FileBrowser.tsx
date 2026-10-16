import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  ArrowUp,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderPlus,
  FolderUp,
  Home,
  Link2,
  Loader2,
  Pencil,
  RefreshCw,
  SquareTerminal,
  Trash2,
  Upload,
  FileEdit,
  FileCode2,
} from "lucide-react";
import { openInEditor } from "../editor/actions";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { copyText } from "../../ipc/clipboard";
import { api, asCoreError } from "../../ipc/api";
import type { FileEntry } from "../../ipc/bindings/FileEntry";
import { SHELL_INTEGRATION_PREVIEW } from "./shellIntegration";
import { askConfirm, askText } from "../../stores/dialogs";
import { joinPath, parentPath, useFiles } from "../../stores/files";
import { useHosts } from "../../stores/hosts";
import { useTabs } from "../../stores/tabs";
import { terminalRegistry, } from "../server-tab/terminal/registry";
import { shellQuote } from "./quote";
import { bytes } from "../../ui/format";
import { TransfersStrip } from "./TransfersStrip";

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
  const st = useFiles((s) => s.byHost[hostId]);
  const openDir = useFiles((s) => s.open);
  const patch = useFiles((s) => s.patch);
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const rootRef = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

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
  const listing = path ? st?.listings[path] : undefined;
  const showHidden = st?.showHidden ?? false;

  // First show: open the terminal's folder (if following), the host's start folder, or home.
  useEffect(() => {
    if (!visible) return;
    const cur = useFiles.getState().byHost[hostId];
    if (cur?.path) void openDir(hostId, cur.path); // cached unless stale
    else void openDir(hostId, (cur?.follow && cur.terminalCwd) || host?.start_folder || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, hostId]);

  // Drag files from your computer onto the browser to upload into the current folder.
  useEffect(() => {
    if (!visible) return;
    let off: (() => void) | undefined;
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
      .then((u) => (off = u));
    return () => off?.();
  }, [visible, hostId]);

  const entries = useMemo(() => (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith(".")), [listing, showHidden]);

  const go = (p: string) => void openDir(hostId, p);
  const refresh = () => path && void openDir(hostId, path, true);

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
      if (fallback && /binary|UTF-8|larger than/i.test(msg)) return editLocally(e);
      setNote(`${msg} You can still use “Edit locally”.`);
    }
  };

  const editLocally = async (e: FileEntry) => {
    setNote(null);
    try {
      const local = await api.editOpen(hostId, e.path);
      useFiles.getState().setEdit({ hostId, remote: e.path, local, state: "open", message: null, at: Date.now() });
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

  const mkdir = async () => {
    if (!path) return;
    const name = await askText({ title: "New folder", label: `Inside ${path}`, value: "", confirmLabel: "Create" });
    if (!name) return;
    try {
      await api.sftpMkdir(hostId, joinPath(path, name));
      refresh();
    } catch (x) {
      setNote(asCoreError(x).message);
    }
  };

  const rename = async (e: FileEntry) => {
    const dot = e.kind === "file" ? e.name.lastIndexOf(".") : -1;
    const name = await askText({ title: `Rename ${e.name}`, label: "New name", value: e.name, confirmLabel: "Rename", selectUntil: dot > 0 ? dot : undefined });
    if (!name || name === e.name) return;
    try {
      await api.sftpRename(hostId, e.path, joinPath(parentPath(e.path), name));
      refresh();
    } catch (x) {
      setNote(asCoreError(x).message);
    }
  };

  const remove = async (e: FileEntry) => {
    const dir = e.kind === "dir";
    const prod = host?.env_label === "prod";
    const ok = await askConfirm({
      title: dir ? `Delete folder ${e.name}?` : `Delete ${e.name}?`,
      body: `${dir ? "The folder and everything inside it" : "The file"} will be removed from ${host?.name ?? "the server"}. This cannot be undone.${prod ? " This is a PRODUCTION server." : ""}`,
      preview: e.path,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.sftpDelete(hostId, e.path, dir, dir);
      refresh();
    } catch (x) {
      setNote(asCoreError(x).message);
    }
  };

  const cdInTerminal = (p: string) => {
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
      body: "Adds a few lines to ~/.bashrc and ~/.zshrc on this server so your prompt reports its folder. Rookery never polls for it. Takes effect in new terminals.",
      preview: SHELL_INTEGRATION_PREVIEW,
      confirmLabel: "Add to shell config",
    });
    if (!ok) return;
    try {
      const n = await api.shellIntegrationInstall(hostId);
      setNote(`Added to ${n} shell config file${n === 1 ? "" : "s"}. Open a new terminal (+) and Files will follow your cd.`);
    } catch (x) {
      setNote(asCoreError(x).message);
    }
  };

  const crumbs = useMemo(() => {
    if (!path) return [];
    const parts = path.split("/").filter(Boolean);
    return [{ name: "/", path: "/" }, ...parts.map((p, i) => ({ name: p, path: "/" + parts.slice(0, i + 1).join("/") }))];
  }, [path]);

  const panel = variant === "panel";

  return (
    <div ref={rootRef} className={clsx("relative flex h-full min-h-0 flex-col", panel ? "bg-panel" : "bg-bg")}>
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
        {panel && <span className="mr-1 px-1 text-[13px] font-semibold">Files</span>}
        <Tool label="Up one folder" onClick={() => path && go(parentPath(path))} disabled={!path || path === "/"}>
          <ArrowUp size={14} />
        </Tool>
        <Tool label="Home folder" onClick={() => st?.home && go(st.home)} disabled={!st?.home}>
          <Home size={14} />
        </Tool>
        <Tool label="Refresh" onClick={refresh} disabled={!path}>
          <RefreshCw size={13} className={st?.loading ? "animate-spin" : ""} />
        </Tool>
        <Tool label="New folder" onClick={() => void mkdir()} disabled={!path}>
          <FolderPlus size={14} />
        </Tool>
        <Tool label="Upload files" onClick={() => void upload()} disabled={!path}>
          <Upload size={14} />
        </Tool>
        <Tool label="Upload a folder" onClick={() => void upload(true)} disabled={!path}>
          <FolderUp size={14} />
        </Tool>
        <Tool label={showHidden ? "Hide hidden files" : "Show hidden files"} onClick={() => patch(hostId, { showHidden: !showHidden })}>
          {showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
        </Tool>
        {panel && (
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
        {!path && st?.loading && <span>Opening SFTP…</span>}
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

      {panel && st?.follow && st.terminalCwd === null && (
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
        <div className="min-h-0 flex-1 overflow-y-auto p-1" role="grid" aria-label="Files">
          {!panel && (
            <div className="grid grid-cols-[minmax(0,1fr)_90px_110px_100px_120px] gap-x-3 px-2.5 py-1.5 text-[11px] tracking-wider text-muted uppercase">
              <span>Name</span>
              <span className="text-right">Size</span>
              <span className="text-right">Modified</span>
              <span>Mode</span>
              <span />
            </div>
          )}
          {entries.map((e) => (
            <div
              key={e.path}
              role="row"
              tabIndex={0}
              onDoubleClick={() => void activate(e)}
              onKeyDown={(k) => k.key === "Enter" && void activate(e)}
              className={clsx(
                "group/r items-center gap-x-3 rounded-[5px] px-2 hover:bg-panel2 focus:bg-accent-bg focus:outline-none",
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
              <span className={clsx("flex justify-end gap-0.5", panel ? "hidden flex-none group-hover/r:flex" : "invisible group-hover/r:visible")}>
                {e.kind === "dir" ? (
                  <RowBtn label="cd here in terminal" onClick={() => cdInTerminal(e.path)}>
                    <SquareTerminal size={13} />
                  </RowBtn>
                ) : (
                  <>
                    <RowBtn label="Edit in Rookery" onClick={() => void editInRookery(e)}>
                      <FileCode2 size={13} />
                    </RowBtn>
                    <RowBtn label="Edit locally (saves upload back)" onClick={() => void editLocally(e)}>
                      <FileEdit size={13} />
                    </RowBtn>
                    <RowBtn label="Download" onClick={() => void download(e)}>
                      <Download size={13} />
                    </RowBtn>
                  </>
                )}
                <RowBtn label={copied === e.path ? "Copied" : "Copy path"} onClick={() => void copyPath(e.path)}>
                  {copied === e.path ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                </RowBtn>
                <RowBtn label="Rename" onClick={() => void rename(e)}>
                  <Pencil size={12} />
                </RowBtn>
                <RowBtn label="Delete" onClick={() => void remove(e)}>
                  <Trash2 size={12} />
                </RowBtn>
              </span>
            </div>
          ))}
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
      <TransfersStrip hostId={hostId} />
      {dropping && (
        <div className="pointer-events-none absolute inset-1 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-[#1B2230CC] text-accent">
          Drop to upload into {path}
        </div>
      )}
    </div>
  );
}

function Tool({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} disabled={disabled} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text">
      {children}
    </button>
  );
}

function RowBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-line hover:text-text"
    >
      {children}
    </button>
  );
}
