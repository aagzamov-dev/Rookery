// The Editor's folder tree (docs/08 §1): click a folder to expand it, double-click to go into it,
// the path on top to go back up; right-click for more. The top folder is remembered per server.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerLeftUp,
  File as FileIcon,
  FilePlus2,
  Folder,
  FolderInput,
  FolderOpen,
  FolderSearch,
  Home,
  Link2,
  Loader2,
  MoreVertical,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  SquareTerminal,
  Upload,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { entryMenu, folderMenu, onFilesChanged, relocate, type FileCtx } from "../files/fileActions";
import { ArchiveJobs } from "../files/ArchiveJobs";
import { isMac } from "../../keys/chord";
import { COMPUTER_ID, normalizeLocalPath } from "../local/target";
import { api, asCoreError } from "../../ipc/api";
import { copyText } from "../../ipc/clipboard";
import type { FileEntry } from "../../ipc/bindings/FileEntry";
import { askText } from "../../stores/dialogs";
import { useEditor } from "../../stores/editor";
import { parentPath, pathRoot, useFiles } from "../../stores/files";
import { useTabs } from "../../stores/tabs";
import { useContextMenu, type MenuItem } from "../../ui/ContextMenu";
import { terminalRegistry } from "../server-tab/terminal/registry";
import { shellQuote } from "../files/quote";
import { crumbs } from "./lang";

type Listing = FileEntry[] | "loading" | { error: string };

const cleanDir = (path: string) => { const p = normalizeLocalPath(path); const root = pathRoot(p); const clean = p.replace(/\/+$/, ""); return clean.length < root.length ? root : clean; };

function Tool({ label, onClick, disabled, children }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 flex-none place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

export function FileTree({ hostId, visible, activePath, onOpen, onOpenPath, onQuickOpen }: {
  hostId: string;
  visible: boolean;
  activePath: string | null;
  onOpen: (path: string) => void;
  onOpenPath: () => void;
  onQuickOpen: () => void;
}) {
  const filesPath = useFiles((s) => s.byHost[hostId]?.path ?? null);
  const loaded = useEditor((s) => s.loaded);
  const remembered = useEditor((s) => s.roots[hostId] ?? null);
  const pins = useEditor((s) => s.pins[hostId]) ?? [];
  const [root, setRootState] = useState<string | null>(null);
  const [back, setBack] = useState<string[]>([]);
  const [lists, setLists] = useState<Record<string, Listing>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const menu = useContextMenu();
  const [note, setNote] = useState<string | null>(null);
  const ctx: FileCtx = { hostId, note: setNote };
  const self = useRef<HTMLDivElement>(null);
  const active = useRef(visible);
  active.current = visible;

  const load = useCallback(
    async (dir: string) => {
      if (!active.current) return false;
      setLists((l) => ({ ...l, [dir]: Array.isArray(l[dir]) ? l[dir] : "loading" }));
      try {
        const entries = await api.sftpList(hostId, dir);
        setLists((l) => ({ ...l, [dir]: entries }));
        return true;
      } catch (e) {
        setLists((l) => ({ ...l, [dir]: { error: asCoreError(e).message } }));
        return false;
      }
    },
    [hostId],
  );

  /** Show `dir` at the top (remembered for this server). */
  const rootRef = useRef<string | null>(null);
  const go = useCallback(
    (dir: string, remember = true) => {
      if (!active.current) return;
      const d = cleanDir(dir);
      const cur = rootRef.current;
      if (cur && cur !== d && remember) setBack((b) => [...b.slice(-29), cur]);
      rootRef.current = d;
      setRootState(d);
      setOpen({});
      void load(d);
      useEditor.getState().setRoot(hostId, d);
    },
    [hostId, load],
  );

  // Start at the remembered folder, else where the Files view is, else home.
  useEffect(() => {
    if (root || !visible || !loaded) return;
    if (remembered) go(remembered, false);
    else if (filesPath) go(filesPath, false);
    else void api.sftpHome(hostId).then((h) => go(h, false), () => go("/", false));
  }, [root, visible, loaded, remembered, filesPath, hostId, go]);

  const goBack = () => {
    const prev = back[back.length - 1];
    if (!prev) return;
    setBack((b) => b.slice(0, -1));
    go(prev, false);
  };
  const goHome = () => void api.sftpHome(hostId).then((h) => go(h));
  const goTo = async () => {
    const p = await askText({ title: "Go to folder", label: hostId === COMPUTER_ID ? "Folder on this computer (absolute)" : "Folder on the server (absolute)", value: root ?? "/", confirmLabel: "Go" });
    if (p) go(p);
  };
  const refresh = () => {
    if (!root) return;
    void load(root);
    for (const p of Object.keys(open)) if (open[p]) void load(p);
  };

  // Something changed a folder (here or in Files): reload it if it is shown.
  const listsRef = useRef(lists);
  listsRef.current = lists;
  useEffect(
    () =>
      onFilesChanged((h, dirs, moved) => {
        if (h !== hostId) return;
        const next = rootRef.current && moved ? relocate(rootRef.current, moved) : null;
        if (next) return go(next, false); // the folder on top was renamed or deleted
        for (const d of dirs) if (listsRef.current[d] !== undefined) void load(d);
      }),
    [hostId, load, go],
  );

  /** After New file / New folder: open the file, or show the folder expanded. */
  const afterCreate = (path: string, kind: "file" | "folder") => {
    const dir = parentPath(path);
    if (dir !== rootRef.current) setOpen((o) => ({ ...o, [dir]: true }));
    if (kind === "file") onOpen(path);
  };

  const upload = async (dir: string) => {
    const picked = await openDialog({ multiple: true, title: `Upload to ${dir}` });
    const list = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
    if (list.length) await api.sftpUpload(hostId, list, dir).catch((x) => setNote(asCoreError(x).message));
  };

  /** ⋮ in the header and right-click on empty space: the folder shown on top. */
  const rootItems = (): MenuItem[] =>
    root
      ? folderMenu(ctx, root, {
          afterCreate,
          more: [
            ...(hostId !== COMPUTER_ID ? [{ label: "Upload files…", icon: <Upload size={13} />, onClick: () => void upload(root) }] : []),
            { label: "Refresh", icon: <RefreshCw size={13} />, onClick: refresh },
            { label: "cd here in terminal", icon: <SquareTerminal size={13} />, onClick: () => cdInTerminal(root) },
            { label: "Copy path", icon: <Copy size={13} />, onClick: () => void copyText(root) },
          ],
        })
      : [];

  const toggle = async (e: FileEntry) => {
    if (open[e.path]) return setOpen((o) => ({ ...o, [e.path]: false }));
    if (e.kind === "link" && !(await load(e.path))) {
      // Not a folder: a link to a file.
      setLists((l) => {
        const n = { ...l };
        delete n[e.path];
        return n;
      });
      return onOpen(e.path);
    }
    setOpen((o) => ({ ...o, [e.path]: true }));
    if (e.kind !== "link") void load(e.path);
  };

  /** Double-click: go into a folder (a link only if it is one). */
  const enter = async (e: FileEntry) => {
    if (e.kind === "file") return;
    if (e.kind === "link") {
      try {
        await api.sftpList(hostId, e.path);
      } catch {
        return; // a link to a file: the click already opened it
      }
    }
    go(e.path);
  };

  const cdInTerminal = (dir: string) => {
    const tabs = useTabs.getState();
    if (hostId === COMPUTER_ID) { tabs.addTerminal(hostId, { cwd: dir }); return; }
    const key = tabs.views[hostId]?.activeTerminal ?? tabs.addTerminal(hostId);
    if (!key) return;
    tabs.setView(hostId, "terminal");
    terminalRegistry.runCommand(key, `cd ${shellQuote(dir)}`);
    terminalRegistry.focus(key);
  };

  const itemsFor = (e: FileEntry): MenuItem[] => {
    const pinned = pins.includes(e.path);
    const folderish = e.kind !== "file";
    return entryMenu(ctx, e, {
      afterCreate,
      top: [
        ...(folderish ? [{ label: "Show only this folder", icon: <FolderInput size={13} />, onClick: () => void enter(e) }] : []),
        ...(e.kind !== "dir" ? [{ label: "Open", icon: <FileIcon size={13} />, onClick: () => onOpen(e.path) }] : []),
        ...(e.kind !== "dir"
          ? [{ label: pinned ? "Unpin" : "Pin", icon: pinned ? <PinOff size={13} /> : <Pin size={13} />, onClick: () => useEditor.getState().togglePin(hostId, e.path) }]
          : []),
      ],
      more: [
        ...(e.kind === "dir" ? [{ label: "Refresh", icon: <RefreshCw size={13} />, onClick: () => void load(e.path) }] : []),
        { label: "cd here in terminal", icon: <SquareTerminal size={13} />, onClick: () => cdInTerminal(e.kind === "dir" ? e.path : parentPath(e.path)) },
      ],
    });
  };

  const onKeyDown = (k: KeyboardEvent) => {
    if (k.altKey && k.key === "ArrowLeft") {
      k.preventDefault();
      goBack();
    } else if (k.altKey && k.key === "ArrowUp" && root && root !== "/") {
      k.preventDefault();
      go(parentPath(root));
    }
  };

  const pad = (depth: number) => ({ paddingLeft: 12 + depth * 14 });
  const rows = (dir: string, depth: number): ReactNode => {
    const l = lists[dir];
    if (l === undefined || l === "loading")
      return (
        <div style={pad(depth)} className="flex h-6 items-center gap-1.5 text-xs text-muted">
          <Loader2 size={11} className="animate-spin" /> Loading…
        </div>
      );
    if (!Array.isArray(l))
      return (
        <div style={pad(depth)} className="py-1 pr-2 text-xs text-prod-fg">
          {l.error}
        </div>
      );
    if (l.length === 0)
      return (
        <div style={pad(depth)} className="h-6 text-xs leading-6 text-muted">
          Empty
        </div>
      );
    return l.map((e) => (
      <div key={e.path}>
        <div className="group/t relative">
        <button
          onClick={() => (e.kind === "file" ? onOpen(e.path) : void toggle(e))}
          onDoubleClick={() => void enter(e)}
          onContextMenu={menu.open(() => itemsFor(e))}
          title={e.kind === "file" ? e.path : `${e.path}\nDouble-click to show only this folder`}
          style={{ paddingLeft: 6 + depth * 14 }}
          className={clsx(
            "flex h-6 w-full items-center gap-1 pr-7 text-left text-[13px] outline-none group-hover/t:bg-panel2 focus-visible:bg-panel2",
            activePath === e.path ? "bg-accent-bg text-text" : e.name.startsWith(".") ? "text-muted" : "text-text",
          )}
        >
          <span className="grid w-3.5 flex-none place-items-center text-muted">{e.kind !== "file" && (open[e.path] ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}</span>
          {e.kind === "dir" ? (
            open[e.path] ? (
              <FolderOpen size={13} className="flex-none text-accent" />
            ) : (
              <Folder size={13} className="flex-none text-accent" fill="#34507E" />
            )
          ) : e.kind === "link" ? (
            <Link2 size={13} className="flex-none text-[#7FDBCA]" />
          ) : (
            <FileIcon size={13} className="flex-none text-muted" />
          )}
          <span className="truncate">{e.name}</span>
        </button>
        <button
          aria-label={`Actions for ${e.name}`}
          title="Actions"
          onClick={menu.below(() => itemsFor(e))}
          className="absolute top-0 right-0.5 grid h-6 w-6 place-items-center rounded text-muted opacity-0 group-hover/t:opacity-100 hover:bg-line hover:text-text focus-visible:opacity-100"
        >
          <MoreVertical size={13} />
        </button>
        </div>
        {open[e.path] && rows(e.path, depth + 1)}
      </div>
    ));
  };

  // The path on top: every part is a button; long paths keep the first and the last two.
  const parts = root ? crumbs(root) : [];
  const hidden = parts.length > 4 ? parts.slice(1, parts.length - 2) : [];
  const shown = hidden.length ? [parts[0], null, ...parts.slice(-2)] : parts;

  return (
    <div ref={self} onKeyDown={onKeyDown} className="flex w-64 flex-none flex-col border-r border-line bg-panel">
      <div className="flex h-9 flex-none items-center gap-0.5 border-b border-line px-1.5">
        <Tool label="Back (Alt+←)" onClick={goBack} disabled={back.length === 0}>
          <ArrowLeft size={13} />
        </Tool>
        <Tool label="Up one folder (Alt+↑)" onClick={() => root && go(parentPath(root))} disabled={!root || root === "/"}>
          <CornerLeftUp size={13} />
        </Tool>
        <Tool label="Home folder" onClick={goHome}>
          <Home size={13} />
        </Tool>
        <Tool label="Go to folder…" onClick={() => void goTo()}>
          <FolderSearch size={13} />
        </Tool>
        <span className="flex-1" />
        <Tool label="Reload folders" onClick={refresh}>
          <RefreshCw size={12} />
        </Tool>
        <Tool label={`Quick open: recent files and names (${isMac ? "⌘P" : "Ctrl+P"})`} onClick={onQuickOpen}>
          <Search size={13} />
        </Tool>
        <Tool label="Open file by path… (Ctrl+O)" onClick={onOpenPath}>
          <FilePlus2 size={13} />
        </Tool>
        <Tool label="New file, new folder, upload…" onClick={menu.below(rootItems)} disabled={!root}>
          <MoreVertical size={13} />
        </Tool>
      </div>
      <nav aria-label="Folder path" className="flex h-7 flex-none items-center overflow-hidden border-b border-line px-1.5 font-mono text-[11px]">
        {shown.map((c, i) =>
          c === null ? (
            <button
              key="more"
              title={hidden.map((h) => h[1]).join("\n")}
              onClick={menu.open(() => hidden.map(([name, path]) => ({ label: name, icon: <Folder size={13} />, onClick: () => go(path) })))}
              className="flex-none rounded px-1 text-muted hover:bg-panel2 hover:text-text"
            >
              …
            </button>
          ) : (
            <span key={c[1]} className={clsx("flex min-w-0 items-center", i === shown.length - 1 ? "flex-none" : "")}>
              {i > 1 && <span className="flex-none px-0.5 text-line">/</span>}
              <button
                onClick={() => c[1] !== root && go(c[1])}
                title={c[1]}
                className={clsx("truncate rounded px-1 py-0.5 hover:bg-panel2", i === shown.length - 1 ? "font-medium text-text" : "text-muted hover:text-text")}
              >
                {c[0]}
              </button>
            </span>
          ),
        )}
      </nav>
      {pins.length > 0 && (
        <div className="flex flex-none flex-col border-b border-line py-1">
          <span className="px-3 pb-0.5 text-[10px] font-semibold tracking-wide text-muted uppercase">Pinned</span>
          {pins.map((p) => (
            <div key={p} className={clsx("group/p flex h-6 items-center gap-1.5 pr-1 pl-3 text-[13px] hover:bg-panel2", activePath === p && "bg-accent-bg")}>
              <Pin size={11} className="flex-none text-accent" />
              <button onClick={() => onOpen(p)} title={p} className="min-w-0 flex-1 truncate text-left outline-none">
                {p.slice(p.lastIndexOf("/") + 1)} <span className="text-[11px] text-muted">{parentPath(p)}</span>
              </button>
              <button aria-label={`Unpin ${p}`} onClick={() => useEditor.getState().togglePin(hostId, p)} className="invisible grid h-5 w-5 place-items-center rounded text-muted group-hover/p:visible hover:text-text">
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto py-1" onContextMenu={menu.open(rootItems)}>
        {root && rows(root, 0)}
      </div>
      {note && (
        <div role="alert" className="flex flex-none items-start gap-2 border-t border-line px-3 py-2 text-xs text-muted">
          <span className="min-w-0 flex-1 break-words">{note}</span>
          <button onClick={() => setNote(null)} className="flex-none text-accent">
            OK
          </button>
        </div>
      )}
      {hostId !== COMPUTER_ID && <ArchiveJobs hostId={hostId} />}
      {menu.node}
    </div>
  );
}
