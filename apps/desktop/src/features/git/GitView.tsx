import { COMPUTER_ID } from "../local/target";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, GitBranch, List, ListTree, Loader2, Plus, RefreshCw } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { GitAction } from "../../ipc/bindings/GitAction";
import type { GitDiff } from "../../ipc/bindings/GitDiff";
import type { GitFile } from "../../ipc/bindings/GitFile";
import { askConfirm, askText } from "../../stores/dialogs";
import { useEditor } from "../../stores/editor";
import { gitKey, gitNeedsRefresh, useGit } from "../../stores/git";
import { useHosts } from "../../stores/hosts";
import { Button, IconButton, Select } from "../../ui/primitives";
import { ResizablePanel } from "../../ui/ResizablePanel";
import { DiffView } from "../editor/Dialogs";
import { noteChange, openFile, openInEditor, replaceText, saveRaw, stateOf, textOf } from "../editor/actions";
import { langOf } from "../editor/lang";
import { AddRepositoryDialog } from "./AddRepositoryDialog";
import { ChangeSection } from "./ChangeSection";
import { useGitHistory } from "./history";
import { changeView, discardPlan, discardPreview, type ChangeView } from "./tree";

interface Selection { folder: string; file: GitFile; staged: boolean }
interface LoadedDiff { key: string; folder: string; path: string; staged: boolean; data: GitDiff; docKey: string | null }
const stagedFile = (file: GitFile) => !file.conflicted && file.index !== "." && file.index !== "?";
const changedFile = (file: GitFile) => !file.conflicted && file.worktree !== ".";
const filePaths = (files: GitFile[], unstage = false) => [...new Set(files.flatMap((file) => unstage && file.original_path ? [file.path, file.original_path] : [file.path]))];
export const normalizeGitText = (text: string) => text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

export function GitView({ hostId, visible }: { hostId: string; visible: boolean }) {
  const host = useHosts((s) => s.hosts.find((item) => item.id === hostId));
  const config = useGit((s) => s.byHost[hostId]);
  const folder = config?.selected ?? null;
  const cached = useGit((s) => folder ? s.cache[gitKey(hostId, folder)] : undefined);
  const status = cached?.status;
  const editor = useEditor((s) => s.byHost[hostId]);
  const [adding, setAdding] = useState(false);
  const [viewMode, setViewMode] = useState<ChangeView>(() => { try { return changeView(localStorage.getItem("ui.git.changesView")); } catch { return "tree"; } });
  const [initializing, setInitializing] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loaded, setLoaded] = useState<LoadedDiff | null>(null);
  const [right, setRight] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const live = useRef(visible);
  live.current = visible;
  const working = useRef(false);
  const diffCache = useRef<LoadedDiff | null>(null);
  const commitInput = useRef<HTMLTextAreaElement>(null);
  const shownRepository = useRef<string | null>(null);
  const hasDirty = !!editor?.docs.some((item) => item.dirty && (item.realPath.startsWith(`${status?.root ?? folder}/`) || item.path.startsWith(`${status?.root ?? folder}/`)));
  const retainedDraft = selection && status ? editor?.docs.find((item) => item.dirty && item.path === `${status.root}/${selection.file.path}`) : undefined;
  const selected = selection?.folder === folder ? retainedDraft ? selection.file : status?.files.find((file) => file.path === selection.file.path) : undefined;
  const sameDiff = loaded?.folder === folder && loaded?.path === selected?.path && loaded?.staged === selection?.staged;
  const expectedKey = hasDirty && sameDiff ? loaded?.key : selected && selection ? JSON.stringify([folder, selected.path, selection.staged, cached?.version ?? cached?.at]) : null;
  const current = loaded?.key === expectedKey ? loaded : null;
  const doc = current?.docKey ? editor?.docs.find((item) => item.key === current.docKey) : undefined;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    if (!status || !selection || selection.folder !== folder || retainedDraft) return;
    const file = status.files.find((item) => item.path === selection.file.path);
    if (!file) setSelection(null);
    else if (!selection.staged && !changedFile(file) && stagedFile(file)) setSelection({ ...selection, file, staged: true });
    else if (selection.staged && !stagedFile(file) && changedFile(file)) setSelection({ ...selection, file, staged: false });
  }, [cached?.at, folder, selection, retainedDraft, status]);

  const loadFolders = async () => {
    setConfigError(null);
    try { await useGit.getState().load(hostId, host?.start_folder ?? null); }
    catch (cause) { setConfigError(asCoreError(cause).message); }
  };
  useEffect(() => {
    if (visible && !config) void loadFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, visible, !!config]);

  useEffect(() => {
    if (!visible || !config || config.initialized) return;
    setInitializing(true);
    void useGit.getState().initialize(hostId, host?.start_folder ?? null, () => live.current).catch((cause: unknown) => {
      setConfigError(asCoreError(cause).message);
    }).finally(() => setInitializing(false));
  }, [hostId, host?.start_folder, visible, config?.initialized]);

  useEffect(() => {
    if (!visible) { shownRepository.current = null; return; }
    if (!config?.initialized || initializing || !folder || busy || hasDirty) return;
    const key = gitKey(hostId, folder);
    const value = useGit.getState().cache[key];
    if (value?.loading) return;
    const shown = shownRepository.current !== key;
    shownRepository.current = key;
    if (gitNeedsRefresh(value, shown)) void useGit.getState().refresh(hostId, folder);
  }, [hostId, visible, folder, config?.initialized, initializing, busy, hasDirty, cached?.revision, cached?.loading]);

  useEffect(() => {
    if (!visible || !folder || !selected || !selection || !status) return;
    if (hasDirty && loaded?.folder === folder && loaded.path === selected.path && loaded.staged === selection.staged) {
      if (loaded.docKey) setRight(textOf(loaded.docKey));
      return;
    }
    if (useGit.getState().cache[gitKey(hostId, folder)]?.loading) return;
    if (!selection.staged && !changedFile(selected) && stagedFile(selected) || selection.staged && !stagedFile(selected) && changedFile(selected)) return;
    const key = JSON.stringify([folder, selected.path, selection.staged, cached?.version ?? cached?.at]);
    const show = (value: LoadedDiff) => {
      setLoaded(value);
      setRight(value.docKey ? textOf(value.docKey) : normalizeGitText(value.data.right));
      setDiffLoading(false);
      setDiffError(null);
    };
    if (diffCache.current?.key === key && (!diffCache.current.docKey || (stateOf(diffCache.current.docKey) && useEditor.getState().byHost[hostId]?.docs.some((item) => item.key === diffCache.current?.docKey)))) { show(diffCache.current); return; }
    let cancelled = false;
    setLoaded(null);
    setDiffError(null);
    setDiffLoading(true);
    void (async () => {
      const data = await api.gitDiff(hostId, folder, selected, selection.staged);
      if (cancelled) return;
      const editable = !selection.staged && !selected.conflicted && selected.worktree !== "D" && !data.notice;
      const opened = editable ? await openFile(hostId, `${status.root}/${selected.path}`, false) : null;
      if (cancelled) return;
      const value = { key, folder, path: selected.path, staged: selection.staged, data, docKey: opened?.key ?? null };
      diffCache.current = value;
      show(value);
    })().catch((cause: unknown) => {
      if (!cancelled) { setDiffError(asCoreError(cause).message); setDiffLoading(false); }
    });
    return () => { cancelled = true; };
  }, [hostId, folder, selected, selection, visible, hasDirty, cached?.loading, cached?.version, cached?.at, status?.root]);

  useEffect(() => {
    const input = commitInput.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight + 2, 74)}px`;
  }, [message, !!status]);

  const dirtyFiles = () => useEditor.getState().byHost[hostId]?.docs.filter((item) => item.dirty && status && item.realPath.startsWith(`${status.root}/`)) ?? [];
  const warnDirty = () => {
    const dirty = dirtyFiles();
    if (!dirty.length) return false;
    setNotice(`Save unsaved edits first: ${dirty.map((item) => item.name).join(", ")}. Drafts stay available in Git and Editor when you switch files or repositories.`);
    return true;
  };
  const refresh = async () => {
    if (folder && live.current && !working.current && !warnDirty()) await useGit.getState().refresh(hostId, folder);
  };
  const selectFolder = (path: string) => {
    useGit.getState().select(hostId, path);
    setAdding(false);
    setNotice(null);
  };

  /** `confirm` replaces the default confirmation text (folder discard lists its files). */
  const mutate = async (action: GitAction, label: string, destructive = false, confirm?: { body: string; preview: string; typeToConfirm?: string }) => {
    if (!folder || !status || !live.current || working.current || cached?.loading) return;
    const target = folder;
    working.current = true;
    setBusy(true);
    setNotice(null);
    try {
      if (action.kind !== "fetch" && action.kind !== "push" && action.kind !== "stash_drop" && action.kind !== "unstage" && warnDirty()) return;
      const production = host?.env_label === "prod";
      let confirmed = false;
      if (production || destructive) {
        confirmed = await askConfirm({
          title: `${label}${production ? ` on PROD — ${host.name}` : ""}?`,
          body: confirm?.body ?? (action.kind === "discard" ? `This permanently discards the selected file's changes on ${hostId === COMPUTER_ID ? "this computer" : "the server"}. Untracked files are deleted.` : action.kind === "stash_drop" ? "This permanently deletes this stash." : production ? "This operation changes the production repository or its remote." : "This changes the working tree. Uncommitted work may be affected."),
          preview: confirm?.preview ?? `${status.root}\n${label}`,
          typeToConfirm: confirm?.typeToConfirm,
          confirmLabel: label,
          danger: production || destructive,
        });
        if (!confirmed) return;
      }
      if (!live.current || useGit.getState().byHost[hostId]?.selected !== target) return;
      try {
        const output = await api.gitAction(hostId, target, action, confirmed);
        setNotice(output.trim() || `${label} completed.`);
        if (action.kind === "commit") setMessage("");
        if (action.kind === "discard" || action.kind === "discard_paths" || action.kind === "switch" || action.kind === "create_branch" || action.kind === "pull" || action.kind.startsWith("stash_") && action.kind !== "stash_drop" || action.kind === "abort_merge" || action.kind === "abort_rebase" || action.kind === "continue_rebase" || action.kind === "commit") {
          setSelection(null);
          diffCache.current = null;
        }
      } catch (cause) { setNotice(asCoreError(cause).message); }
      useGit.getState().invalidate(hostId, status.root);
      if (live.current && !dirtyFiles().length) await useGit.getState().refresh(hostId, target);
    } finally { working.current = false; setBusy(false); }
  };

  /** Revert every unstaged change in a folder: exactly the files listed in the confirmation. */
  const discardFolder = async (path: string, children: GitFile[]) => {
    const plan = discardPlan(children);
    const count = plan.tracked.length + plan.untracked.length;
    if (!count) return;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const where = hostId === COMPUTER_ID ? "this computer" : "the server";
    const parts = [
      plan.tracked.length ? `${plan.tracked.length} changed file${plan.tracked.length === 1 ? "" : "s"} go back to the last staged or committed version` : "",
      plan.untracked.length ? `${plan.untracked.length} new (untracked) file${plan.untracked.length === 1 ? " is" : "s are"} deleted` : "",
    ].filter(Boolean);
    await mutate({ kind: "discard_paths", ...plan }, `Discard ${count} change${count === 1 ? "" : "s"} in ${path}`, true, {
      body: `This permanently discards changes on ${where} and cannot be undone: ${parts.join("; ")}. Staged changes are kept. Only the files listed are touched.`,
      preview: discardPreview(path, plan),
      typeToConfirm: count >= 10 || host?.env_label === "prod" ? name : undefined,
    });
  };

  const save = async (stage: boolean) => {
    if (!doc || !folder || !selected || !live.current || working.current) return;
    const key = doc.key;
    const path = selected.path;
    const target = folder;
    const text = textOf(key);
    let saved = false;
    working.current = true;
    setBusy(true);
    setNotice(null);
    try {
      let confirmed = false;
      if (host?.env_label === "prod") {
        confirmed = await askConfirm({ title: `Save ${doc.name} on PROD — ${host.name}?`, body: "This writes the edited working-tree file on the production server. Staging asks for its own confirmation.", preview: doc.realPath, confirmLabel: "Save file", danger: true });
        if (!confirmed) return;
      }
      if (!live.current || useGit.getState().byHost[hostId]?.selected !== target) return;
      const outcome = await saveRaw(key, text, "normal", confirmed);
      if (outcome.kind === "saved") {
        saved = true;
        setNotice(stage ? "File saved. Review staging confirmation next." : "File saved. Stage it when ready.");
      } else if (outcome.kind === "conflict") {
        setNotice("The file changed. Nothing was overwritten. Your draft is preserved; open it in Editor to compare and resolve the changes.");
      } else { setNotice(`${outcome.message} Your draft is preserved. Open it in Editor to review saving with sudo.`); }
    } catch (cause) { setNotice(asCoreError(cause).message); }
    finally { working.current = false; setBusy(false); }
    if (!saved || !live.current || useGit.getState().byHost[hostId]?.selected !== target) return;
    if (stage && selectionRef.current?.folder === target && selectionRef.current.file.path === path && textOf(key) === text && !useEditor.getState().byHost[hostId]?.docs.find((item) => item.key === key)?.dirty) {
      await mutate({ kind: "stage", paths: [path] }, `Stage ${path}`);
    } else if (!dirtyFiles().length) { await useGit.getState().refresh(hostId, target); }
  };

  const createBranch = async () => {
    const branch = await askText({ title: "Create branch", label: "New branch name (created from the current HEAD)", value: "", confirmLabel: "Create branch" });
    if (branch?.trim()) await mutate({ kind: "create_branch", branch: branch.trim() }, `Create branch ${branch.trim()}`);
  };
  const stash = async () => {
    const value = await askText({ title: "Stash changes", label: "Message (includes tracked and untracked files)", value: "", confirmLabel: "Stash" });
    if (value !== null) await mutate({ kind: "stash_create", message: value }, "Stash changes");
  };
  const push = async () => {
    if (!status) return;
    if (status.upstream) return mutate({ kind: "push", remote: null }, "Push");
    if (status.remotes.length === 0) { setNotice("No Git remote is configured. Add a remote in the terminal before publishing this branch."); return; }
    const remote = await askText({ title: "Publish branch", label: `Remote (${status.remotes.join(", ")}) — publishes ${status.branch} and sets its upstream`, value: status.remotes.includes("origin") ? "origin" : status.remotes[0], confirmLabel: "Publish branch" });
    if (remote === null) return;
    if (!status.remotes.includes(remote.trim())) { setNotice("Choose one of this repository's configured remotes."); return; }
    await mutate({ kind: "push", remote: remote.trim() }, `Publish ${status.branch} to ${remote.trim()}`);
  };
  const edit = async () => {
    if (!status || !selected || !live.current) return;
    try { await openInEditor(hostId, `${status.root}/${selected.path}`); }
    catch (cause) { setNotice(asCoreError(cause).message); }
  };

  const disabled = busy || !!cached?.loading;
  const staged = status?.files.filter(stagedFile) ?? [];
  const changed = status?.files.filter(changedFile) ?? [];
  const conflicts = status?.files.filter((file) => file.conflicted) ?? [];
  const editable = !!doc && !doc.readOnly && !selection?.staged && !!selected && changedFile(selected);
  const fileList = (label: string, files: GitFile[], index: boolean) => <ChangeSection
    label={label} files={files} staged={index} mode={viewMode} selectedPath={selected?.path} selectedStaged={selection?.staged} disabled={disabled}
    onSelect={(file) => setSelection({ folder: folder!, file, staged: index })}
    onStage={(file) => void mutate({ kind: index ? "unstage" : "stage", paths: filePaths([file], index) }, file.conflicted ? `Mark ${file.path} resolved` : `${index ? "Unstage" : "Stage"} ${file.path}`)}
    onDiscard={(file) => void mutate({ kind: "discard", path: file.path, untracked: file.index === "?" }, `Discard ${file.path}`, true)}
    onAll={label === "Conflicts" ? undefined : () => void mutate({ kind: index ? "unstage" : "stage", paths: filePaths(files, index) }, `${index ? "Unstage" : "Stage"} all`)}
    onFolder={label === "Conflicts" ? undefined : (path, children) => void mutate({ kind: index ? "unstage" : "stage", paths: filePaths(children, index) }, `${index ? "Unstage" : "Stage"} folder ${path}`)}
    onDiscardFolder={label === "Changes" ? (path, children) => void discardFolder(path, children) : undefined}
  />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <Select aria-label="Repository" className="min-w-0 max-w-[560px] flex-1 font-mono text-xs" value={folder ?? ""} disabled={busy || initializing || !config?.folders.length} onChange={(event) => selectFolder(event.target.value)}>
          {!folder && <option value="">{initializing ? "Finding repositories…" : "Select a repository"}</option>}{config?.folders.map((path) => <option key={path} value={path}>{path}</option>)}
        </Select>
        <IconButton label="Add repository" className="h-9 w-9 shrink-0 border border-line bg-panel2 text-text" disabled={busy || initializing} onClick={() => setAdding(true)}><Plus size={22} strokeWidth={2.3} className="shrink-0" /></IconButton>
        <span className="ml-auto text-xs text-muted">{cached?.loading ? "Updating…" : cached?.at ? `${cached.error || (cached.revision ?? 0) !== (cached.loadedRevision ?? 0) ? "Stale · cached" : "Cached"} ${new Date(cached.at).toLocaleTimeString()}` : "Not loaded"}</span>
        <Button disabled={disabled || !folder} onClick={() => void refresh()}>{cached?.loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Reload</Button>
      </div>
      {(configError || cached?.error || notice) && <div role="status" className="max-h-36 shrink-0 overflow-auto whitespace-pre-wrap break-words border-b border-line px-3 py-2 text-xs text-warn">{[configError, cached?.error, notice].filter(Boolean).join("\n")}{configError && !config && <Button onClick={() => void loadFolders()}>Retry</Button>}</div>}
      {!folder ? <div role="status" className="grid flex-1 place-items-center p-6 text-muted">{initializing ? "Checking the configured folder and nearby repositories…" : "Add a repository with the + button to get started."}</div> : !status ? <div role="status" className="grid flex-1 place-items-center text-muted">{cached?.loading ? "Loading repository…" : `Reload to inspect this repository. Git must be installed on ${hostId === COMPUTER_ID ? "this computer" : "the server"}.`}</div> : <>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <GitBranch size={14} className="text-accent" /><Select aria-label="Switch branch" className="max-w-56" value={status.branch} disabled={disabled || !!status.operation} onChange={(event) => void mutate({ kind: "switch", branch: event.target.value }, `Switch to ${event.target.value}`)}><option value={status.branch}>{status.branch}</option>{status.branches.filter((branch) => branch !== status.branch).map((branch) => <option key={branch} value={branch}>{branch}</option>)}</Select>
          <Button disabled={disabled || !!status.operation} onClick={() => void createBranch()}>New branch</Button><span className="mr-auto text-xs text-muted">{status.upstream ?? "No upstream"} · ↑{status.ahead} ↓{status.behind}</span><Button disabled={disabled} onClick={() => void mutate({ kind: "fetch" }, "Fetch")}>Fetch</Button><Button disabled={disabled || !!status.operation} title="Fast-forward only" onClick={() => void mutate({ kind: "pull" }, "Pull (fast-forward only)")}>Pull</Button><Button disabled={disabled || status.branch === "(detached)"} onClick={() => void push()}>{status.upstream ? "Push" : "Publish branch"}</Button>
        </div>
        {status.operation && <div className="flex items-center gap-2 border-b border-line bg-prod-bg px-3 py-2 text-xs text-prod-fg"><span className="flex-1">{status.operation === "merge" ? "Merge" : "Rebase"} in progress. Resolve and save files in Editor, then stage them.</span>{status.operation === "rebase" && <Button disabled={disabled || conflicts.length > 0} onClick={() => void mutate({ kind: "continue_rebase" }, "Continue rebase")}>Continue rebase</Button>}<Button disabled={disabled} onClick={() => void mutate({ kind: status.operation === "merge" ? "abort_merge" : "abort_rebase" }, `Abort ${status.operation}`, true)}>Abort {status.operation}</Button></div>}
        <div className="flex min-h-0 flex-1">
          <ResizablePanel id="git-changes" label="Resize Git changes panel" initialWidth={300} minWidth={180} maxWidth={520} maxViewportRatio={0.5} minRemainingWidth={240}>
          <div className="flex h-full min-h-0 flex-col border-r border-line bg-panel">
            <div className="flex shrink-0 flex-col gap-2 border-b border-line p-3"><textarea ref={commitInput} rows={1} aria-label="Commit message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Commit message" className="max-h-[74px] min-h-[34px] resize-none overflow-y-auto rounded-md border border-line bg-bg px-2 py-1.5 text-xs leading-5 outline-none focus:border-accent-line" /><div className="flex items-center gap-1"><Button className="min-w-0 flex-1" variant="primary" disabled={disabled || (staged.length === 0 && status.operation !== "merge") || conflicts.length > 0 || !message.trim()} onClick={() => void mutate({ kind: "commit", message }, "Commit staged changes")} title="Commit staged changes"><span className="truncate">Commit staged changes</span></Button><IconButton label={viewMode === "tree" ? "Show flat list" : "Show folder tree"} aria-pressed={viewMode === "tree"} className="h-8 w-8 shrink-0" onClick={() => { const next = viewMode === "tree" ? "list" : "tree"; setViewMode(next); try { localStorage.setItem("ui.git.changesView", next); } catch {} }}>{viewMode === "tree" ? <List size={18} className="shrink-0" /> : <ListTree size={18} className="shrink-0" />}</IconButton></div></div>
            <div className="min-h-0 flex-1 overflow-y-auto">{fileList("Staged", staged, true)}{conflicts.length > 0 && fileList("Conflicts", conflicts, false)}{fileList("Changes", changed, false)}{status.files.length === 0 && <div className="p-4 text-xs text-muted">Working tree clean</div>}</div>
            <details className="group shrink-0 border-t border-line bg-panel2"><summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 text-xs font-semibold"><ChevronRight size={14} className="transition-transform group-open:rotate-90" />Stashes<span className="text-muted">{status.stashes.length}</span></summary><div className="max-h-[30vh] overflow-y-auto border-t border-line bg-panel"><div className="p-2"><Button className="w-full" disabled={disabled || !!status.operation || status.files.length === 0} onClick={() => void stash()}>Stash changes</Button></div>{status.stashes.map((entry) => <div key={entry.reference} className="border-t border-line p-3"><div className="break-words text-xs"><span className="font-mono text-accent">{entry.reference}</span> {entry.subject}</div><div className="mt-2 flex gap-2">{(["apply", "pop", "drop"] as const).map((kind) => <button key={kind} className="min-h-7 px-1 text-xs text-muted hover:text-text" disabled={disabled || (!!status.operation && kind !== "drop")} onClick={() => void mutate({ kind: `stash_${kind}`, reference: entry.reference }, `${kind[0].toUpperCase() + kind.slice(1)} ${entry.reference}`, kind === "drop")}>{kind[0].toUpperCase() + kind.slice(1)}</button>)}</div></div>)}</div></details>
          </div>
          </ResizablePanel>
          <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
            {selected ? <>
              <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-all font-mono text-xs">{selected.path}{doc?.dirty ? " · unsaved" : ""}</span>{editable && <><Button disabled={disabled || !doc?.dirty} onClick={() => void save(false)}>Save</Button><Button variant="primary" disabled={disabled} onClick={() => void save(true)}>Save & stage</Button></>}<Button disabled={busy} onClick={() => void edit()}>Open in editor</Button>{selected.index !== "?" && status && <><Button onClick={() => useGitHistory.getState().show({ hostId, root: status.root, path: selected.path, tab: "history" })}>History</Button><Button onClick={() => useGitHistory.getState().show({ hostId, root: status.root, path: selected.path, tab: "blame" })}>Blame</Button></>}</div>

              {doc?.readOnlyReason && <p className="m-0 text-xs text-warn">{doc.readOnlyReason}</p>}{doc?.mixedEol && <p className="m-0 text-xs text-warn">Mixed line endings. Saving uses {doc.eol.toUpperCase()}.</p>}
              {selected.conflicted && <p className="m-0 text-xs text-warn">Resolve conflict markers in Editor, save, return and reload, then Resolve to stage the saved file.</p>}
              {diffLoading || !current && !diffError ? <div role="status" className="p-3 text-muted">Loading diff…</div> : diffError ? <div role="alert" className="p-3 text-prod-fg">{diffError}</div> : current?.data.notice ? <div className="p-3 text-muted">{current.data.notice}</div> : current ? <DiffView resizeId="git-diff" labels={{ left: selected.conflicted ? "Ours" : selection?.staged ? "HEAD" : "Index", right: selected.conflicted ? "Theirs" : selection?.staged ? "Staged · read-only" : editable ? "Working tree · editable (save before staging)" : "Working tree · read-only" }} key={current.key} left={normalizeGitText(current.data.left)} right={right} lang={langOf(selected.path)} onRight={editable && !busy ? (text) => { replaceText(doc!.key, text); noteChange(doc!.key); setRight(text); } : undefined} /> : null}
            </> : <div className="grid flex-1 place-items-center text-xs text-muted">Select a file to compare or edit its changes.</div>}
          </div>
        </div>
      </>}
      {adding && visible && <AddRepositoryDialog hostId={hostId} initialPath={folder ?? host?.start_folder ?? ""} onPick={selectFolder} onClose={() => setAdding(false)} onRemove={folder ? () => { useGit.getState().remove(hostId, folder); setAdding(false); setSelection(null); } : undefined} />}
    </div>
  );
}
