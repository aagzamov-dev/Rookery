import { useId, useState } from "react";
import clsx from "clsx";
import { ChevronRight, FileCode2, Folder, Minus, Plus, X } from "lucide-react";
import type { GitFile } from "../../ipc/bindings/GitFile";
import { buildChangeTree, type ChangeNode, type ChangeView } from "./tree";

interface Props {
  label: string;
  files: GitFile[];
  staged: boolean;
  mode: ChangeView;
  selectedPath?: string;
  selectedStaged?: boolean;
  disabled: boolean;
  onSelect: (file: GitFile) => void;
  onStage: (file: GitFile) => void;
  onDiscard: (file: GitFile) => void;
  onAll?: () => void;
  onFolder?: (path: string, files: GitFile[]) => void;
  /** Discard every change in a folder (Changes section only). */
  onDiscardFolder?: (path: string, files: GitFile[]) => void;
}

export function ChangeSection({ label, files, staged, mode, selectedPath, selectedStaged, disabled, onSelect, onStage, onDiscard, onAll, onFolder, onDiscardFolder }: Props) {
  const [expanded, setExpanded] = useState(true);
  const id = useId();
  const row = (file: GitFile, name: string) => (
    <div key={`file:${file.path}`} className={clsx("flex h-7 min-w-0 items-center gap-0.5 rounded-sm pr-1", selectedPath === file.path && selectedStaged === staged ? "bg-accent-bg" : "hover:bg-panel2")}>
      <button aria-label={`Open ${label.toLowerCase()} diff ${file.path}`} title={file.original_path ? `${file.original_path} → ${file.path}` : file.path} className="flex h-7 min-w-0 flex-1 items-center gap-1.5 pl-2 text-left text-xs" onClick={() => onSelect(file)}><FileCode2 size={13} className="shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate">{name}</span><span className={clsx("shrink-0 font-mono text-[11px]", file.conflicted ? "text-bad" : "text-accent")}>{staged ? file.index : file.worktree}</span></button>
      <button disabled={disabled} aria-label={file.conflicted ? `Mark ${file.path} resolved` : `${staged ? "Unstage" : "Stage"} ${file.path}`} title={file.conflicted ? "Mark resolved (stage saved file)" : staged ? "Unstage file" : "Stage saved file"} className="grid h-6 w-6 shrink-0 place-items-center rounded text-accent hover:bg-line focus-visible:outline-accent" onClick={() => onStage(file)}>{staged ? <Minus size={17} className="shrink-0" /> : <Plus size={17} className="shrink-0" />}</button>
      {!staged && !file.conflicted && <button disabled={disabled} aria-label={`Discard ${file.path}`} title="Discard changes" className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted hover:bg-line hover:text-bad focus-visible:outline-accent" onClick={() => onDiscard(file)}><X size={14} className="shrink-0" /></button>}
    </div>
  );
  const nodes = (items: ChangeNode[], depth = 0) => items.map((item) => item.kind === "file" ? row(item.file, item.name) : (
    <div key={`folder:${item.path}`} className="relative min-w-0">
    <details open className="min-w-0 [&[open]>summary>.folder-chevron]:rotate-90">
      <summary title={item.path} aria-label={`${label} folder ${item.path}`} className={clsx("flex h-6 min-w-0 cursor-pointer list-none items-center gap-1 rounded py-0 pl-1 text-xs text-muted hover:bg-panel2 [&::-webkit-details-marker]:hidden", onDiscardFolder ? "pr-14" : "pr-7")} onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const folder = event.currentTarget.parentElement;
        if (folder instanceof HTMLDetailsElement) folder.open = event.key === "ArrowRight";
      }}><ChevronRight size={12} className="folder-chevron shrink-0" /><Folder size={13} className="shrink-0" /><span className="min-w-0 flex-1 truncate">{item.name}</span></summary>
      <div className="min-w-0" style={{ paddingLeft: depth < 5 ? 10 : 0 }}>{nodes(item.children, depth + 1)}</div>
    </details>
    {onFolder && <button type="button" disabled={disabled} aria-label={`${staged ? "Unstage" : "Stage"} folder ${item.path}`} title={`${staged ? "Unstage" : "Stage"} all changes in ${item.path}`} className="absolute right-1 top-0 grid h-6 w-6 shrink-0 place-items-center rounded text-accent hover:bg-line focus-visible:outline-accent" onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onFolder(item.path, files.filter((file) => file.path.startsWith(`${item.path}/`))); }}>{staged ? <Minus size={17} className="shrink-0" /> : <Plus size={17} className="shrink-0" />}</button>}
    {onDiscardFolder && <button type="button" disabled={disabled} aria-label={`Discard folder ${item.path}`} title={`Discard all changes in ${item.path}…`} className="absolute right-7 top-0 grid h-6 w-6 shrink-0 place-items-center rounded text-muted hover:bg-line hover:text-bad focus-visible:outline-accent" onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onDiscardFolder(item.path, files.filter((file) => file.path.startsWith(`${item.path}/`))); }}><X size={14} className="shrink-0" /></button>}
    </div>
  ));

  return (
    <section className="border-b border-line">
      <div className="flex h-7 items-center gap-1 bg-panel2 px-1.5"><button aria-expanded={expanded} aria-controls={id} className="flex h-7 min-w-0 flex-1 items-center gap-1 text-left text-xs font-semibold" onClick={() => setExpanded((value) => !value)}><ChevronRight size={13} className={clsx("shrink-0", expanded && "rotate-90")} /><span className="truncate">{label}</span><span className="ml-1 font-normal text-muted">{files.length}</span></button>{onAll && files.length > 0 && <button disabled={disabled} className="h-6 shrink-0 rounded px-1 text-[11px] text-accent hover:bg-line" onClick={onAll}>{staged ? "Unstage all" : "Stage all"}</button>}</div>
      <div id={id} hidden={!expanded} className="min-w-0 px-1 py-0.5">{mode === "tree" ? nodes(buildChangeTree(files)) : files.map((file) => row(file, file.path))}</div>
    </section>
  );
}
