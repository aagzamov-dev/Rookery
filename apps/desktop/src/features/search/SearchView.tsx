// Search tab: file contents (grep) or file names (find) in a folder on the server, with every
// filter visible. Typing searches after a pause (debounce); a new search replaces the running one.
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, CaseSensitive, ChevronRight, File as FileIcon, Folder, FolderOpen, Loader2, Regex, Search as SearchIcon, WholeWord, X } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { SearchHit } from "../../ipc/bindings/SearchHit";
import type { SearchMode } from "../../ipc/bindings/SearchMode";
import type { SearchRequest } from "../../ipc/bindings/SearchRequest";
import type { SearchResult } from "../../ipc/bindings/SearchResult";
import { useEditor } from "../../stores/editor";
import { useFiles } from "../../stores/files";
import { useTabs } from "../../stores/tabs";
import { Select, TextInput } from "../../ui/primitives";
import { openFileOrSudo, revealLine } from "../editor/actions";
import { COMPUTER_ID } from "../local/target";

const PREFS_KEY = "ui.search.prefs.v1";
const DEBOUNCE_MS = 450;
const SLOT = "search";

interface Prefs {
  mode: SearchMode;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
  excludeDirs: string;
  hidden: boolean;
  followLinks: boolean;
  folders: boolean;
  maxDepth: string;
  maxResults: number;
}

const DEFAULTS: Prefs = { mode: "content", regex: false, caseSensitive: false, wholeWord: false, include: "", exclude: "", excludeDirs: "node_modules, .git", hidden: false, followLinks: false, folders: false, maxDepth: "", maxResults: 1000 };

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null) };
  } catch {
    return DEFAULTS;
  }
}

/** "a, b  c" → ["a", "b", "c"] */
export const splitList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/** Build the request; `null` with a reason when it cannot run yet. */
export function buildRequest(hostId: string, folder: string, query: string, p: Prefs): SearchRequest | string {
  const q = query.trim();
  if (q.length < 2) return "Type at least 2 characters.";
  if (!folder.trim()) return "Choose a folder to search in.";
  const depth = p.maxDepth.trim() ? Number(p.maxDepth) : null;
  if (depth !== null && (!Number.isInteger(depth) || depth < 1 || depth > 100)) return "Depth: a whole number from 1 to 100.";
  if (p.regex && p.mode === "content") {
    try {
      new RegExp(q);
    } catch {
      return "That regular expression is not valid.";
    }
  }
  return {
    host_id: hostId,
    slot: SLOT,
    folder: folder.trim(),
    query: q,
    mode: p.mode,
    regex: p.mode === "content" && p.regex,
    case_sensitive: p.caseSensitive,
    whole_word: p.mode === "content" && p.wholeWord,
    include: splitList(p.include),
    exclude: splitList(p.exclude),
    exclude_dirs: splitList(p.excludeDirs),
    hidden: p.hidden,
    follow_links: p.followLinks,
    folders: p.mode === "names" && p.folders,
    max_depth: depth,
    max_results: p.maxResults,
  };
}

/** Split `text` around matches of the request (for highlighting); plain text when it cannot. */
export function highlight(text: string, r: Pick<SearchRequest, "query" | "regex" | "case_sensitive" | "whole_word">): { text: string; hit: boolean }[] {
  let re: RegExp;
  try {
    const src = r.regex ? r.query : r.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(r.whole_word ? `\\b(?:${src})\\b` : src, r.case_sensitive ? "g" : "gi");
  } catch {
    return [{ text, hit: false }];
  }
  const out: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m[0] === "") break;
    if (m.index! > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

export function SearchView({ hostId, visible }: { hostId: string; visible: boolean }) {
  const local = hostId === COMPUTER_ID;
  const filesPath = useFiles((s) => s.byHost[hostId]?.path ?? null);
  const editorRoot = useEditor((s) => s.roots[hostId] ?? null);
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [folder, setFolder] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ request: SearchRequest; data: SearchResult; run: number } | null>(null);
  /** Enter: search again even when nothing changed. */
  const [run, setRun] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const generation = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  const setPrefs = (p: Partial<Prefs>) =>
    setPrefsState((cur) => {
      const next = { ...cur, ...p };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* only a convenience */
      }
      return next;
    });

  // Start in the folder the Files view or the Editor shows, else home.
  useEffect(() => {
    if (!visible || folder) return;
    const start = filesPath ?? editorRoot;
    if (start) setFolder(start);
    else void api.sftpHome(hostId).then((h) => setFolder((f) => f || (typeof h === "string" ? h : "")), () => {});
  }, [visible, folder, filesPath, editorRoot, hostId]);

  useEffect(() => {
    if (visible) box.current?.querySelector("input")?.focus();
  }, [visible]);

  const request = useMemo(() => buildRequest(hostId, folder, query, prefs), [hostId, folder, query, prefs]);

  // Debounced search; a newer one makes older answers stale (and the core cancels them).
  useEffect(() => {
    if (!visible) return;
    // Back on the tab with the same search: keep the results instead of searching again.
    if (typeof request !== "string" && result && result.run === run && JSON.stringify(result.request) === JSON.stringify(request)) return;
    const gen = ++generation.current;
    if (typeof request === "string") {
      setBusy(false);
      void api.searchCancel(hostId, SLOT).catch(() => {});
      return;
    }
    const t = setTimeout(() => {
      setBusy(true);
      setError(null);
      api.searchRun(request).then(
        (data) => {
          if (gen !== generation.current) return;
          setResult({ request, data, run });
          setCollapsed({});
          setBusy(false);
        },
        (e) => {
          if (gen !== generation.current) return;
          const msg = asCoreError(e).message;
          if (msg !== "Search cancelled.") setError(msg);
          setBusy(false);
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `result` only decides whether to skip
  }, [request, visible, hostId, run]);

  // Leaving the tab stops a running search (nothing keeps working on the server).
  useEffect(() => {
    if (!visible) {
      generation.current++;
      setBusy(false);
      void api.searchCancel(hostId, SLOT).catch(() => {});
    }
  }, [visible, hostId]);

  const cancel = () => {
    generation.current++;
    setBusy(false);
    void api.searchCancel(hostId, SLOT).catch(() => {});
  };

  const groups = useMemo(() => {
    if (!result) return [];
    const map = new Map<string, SearchHit[]>();
    for (const h of result.data.hits) {
      const list = map.get(h.path);
      if (list) list.push(h);
      else map.set(h.path, [h]);
    }
    return [...map.entries()];
  }, [result]);

  const openHit = async (h: SearchHit) => {
    setError(null);
    try {
      const d = await openFileOrSudo(hostId, h.path);
      if (!d) return;
      useTabs.getState().setView(hostId, "editor");
      if (h.line) {
        const line = h.line;
        requestAnimationFrame(() => requestAnimationFrame(() => revealLine(d.key, line)));
      }
    } catch (e) {
      setError(asCoreError(e).message);
    }
  };

  const showFolder = (path: string) => {
    void useFiles.getState().open(hostId, path);
    useTabs.getState().setView(hostId, "files");
  };

  const names = prefs.mode === "names";
  const shownRequest = result?.request;
  const rel = (p: string) => (shownRequest && p.startsWith(`${shownRequest.folder.replace(/\/+$/, "")}/`) ? p.slice(shownRequest.folder.replace(/\/+$/, "").length + 1) : p);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex flex-none flex-col gap-2 border-b border-line bg-panel px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label="Search in" className="flex flex-none rounded-md border border-line p-0.5 text-xs">
            {(["content", "names"] as const).map((m) => (
              <button key={m} role="radio" aria-checked={prefs.mode === m} onClick={() => setPrefs({ mode: m })} className={clsx("rounded px-2 py-1", prefs.mode === m ? "bg-accent-bg text-text" : "text-muted hover:text-text")}>
                {m === "content" ? "Contents" : "File names"}
              </button>
            ))}
          </div>
          <div ref={box} className="relative min-w-0 flex-1">
            <SearchIcon size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <TextInput
              aria-label="Search for"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") busy ? cancel() : setQuery("");
                else if (e.key === "Enter") setRun((n) => n + 1);
              }}
              placeholder={names ? "Name, or a pattern like *.conf" : "Text to find in files"}
              className="w-full pl-8"
              mono
            />
          </div>
          <Toggle label="Match case" on={prefs.caseSensitive} onClick={() => setPrefs({ caseSensitive: !prefs.caseSensitive })}>
            <CaseSensitive size={15} />
          </Toggle>
          <Toggle label="Whole words" on={prefs.wholeWord && !names} disabled={names} onClick={() => setPrefs({ wholeWord: !prefs.wholeWord })}>
            <WholeWord size={15} />
          </Toggle>
          <Toggle label="Regular expression (extended)" on={prefs.regex && !names} disabled={names} onClick={() => setPrefs({ regex: !prefs.regex })}>
            <Regex size={15} />
          </Toggle>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <label className="flex min-w-[260px] flex-[2] items-center gap-1.5">
            <span className="flex-none text-muted">In folder</span>
            <TextInput aria-label="Folder to search in" value={folder} onChange={(e) => setFolder(e.target.value)} mono className="h-7 min-w-0 flex-1 text-xs" />
            {filesPath && filesPath !== folder && (
              <button onClick={() => setFolder(filesPath)} title={`Use the Files folder: ${filesPath}`} className="flex-none text-accent hover:underline">
                Files folder
              </button>
            )}
          </label>
          <ListField label={names ? "Names" : "Files"} hint="*.php, *.env" value={prefs.include} onChange={(v) => setPrefs({ include: v })} disabled={names && prefs.folders} />
          <ListField label="Skip files" hint="*.min.js, *.log" value={prefs.exclude} onChange={(v) => setPrefs({ exclude: v })} disabled={names && prefs.folders} />
          <ListField label="Skip folders" hint="node_modules, .git" value={prefs.excludeDirs} onChange={(v) => setPrefs({ excludeDirs: v })} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
          <Check label="Hidden files and folders" on={prefs.hidden} onChange={(v) => setPrefs({ hidden: v })} />
          <Check label="Follow symbolic links" on={prefs.followLinks} onChange={(v) => setPrefs({ followLinks: v })} />
          {names && <Check label="Find folders instead of files" on={prefs.folders} onChange={(v) => setPrefs({ folders: v })} />}
          <label className="flex items-center gap-1.5">
            Depth
            <TextInput aria-label="Folder depth" value={prefs.maxDepth} onChange={(e) => setPrefs({ maxDepth: e.target.value.replace(/\D/g, "").slice(0, 3) })} placeholder="any" className="h-6 w-14 text-xs" />
          </label>
          <label className="flex items-center gap-1.5">
            Up to
            <Select aria-label="Most results" value={prefs.maxResults} onChange={(e) => setPrefs({ maxResults: Number(e.target.value) })} className="h-6 text-xs">
              {[100, 500, 1000, 5000].map((n) => (
                <option key={n} value={n}>
                  {n} results
                </option>
              ))}
            </Select>
          </label>
          <span className="ml-auto flex items-center gap-2">
            {busy ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Searching…
                <button onClick={cancel} className="text-accent hover:underline">
                  Cancel
                </button>
              </>
            ) : typeof request === "string" ? (
              query.trim() && <span>{request}</span>
            ) : (
              result && <span>{summary(result.data, groups.length, names)}</span>
            )}
          </span>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 border-b border-line bg-[#33232A] px-3 py-2 text-xs text-[#FFA8A8]">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button aria-label="Dismiss" onClick={() => setError(null)} className="text-muted hover:text-text">
            <X size={12} />
          </button>
        </div>
      )}
      {result && (result.data.truncated || result.data.timed_out || result.data.warning_count > 0) && (
        <div className="flex flex-col gap-0.5 border-b border-line bg-panel px-3 py-1.5 text-[11px] text-muted">
          {result.data.truncated && <span>Showing the first {result.data.hits.length} results. Narrow the search (folder, file filters) to see the rest.</span>}
          {result.data.timed_out && <span>Stopped after 60 seconds: the folder is large. Pick a smaller folder or skip folders.</span>}
          {result.data.warning_count > 0 && (
            <details>
              <summary className="cursor-pointer">
                <AlertTriangle size={11} className="mr-1 inline text-[#F7CB6A]" />
                {result.data.warning_count} message{result.data.warning_count === 1 ? "" : "s"} (e.g. folders your login cannot read)
              </summary>
              {result.data.warnings.map((w, i) => (
                <div key={i} className="truncate font-mono" title={w}>
                  {w}
                </div>
              ))}
            </details>
          )}
        </div>
      )}

      <div role="list" aria-label="Search results" className="min-h-0 flex-1 overflow-auto py-1 font-mono text-xs">
        {!result && !busy && <div className="p-4 font-sans text-muted">{local ? "Search files on this computer." : "Search files on this server."} Results open in the editor at the matching line.</div>}
        {result && result.data.hits.length === 0 && !busy && <div className="p-4 font-sans text-muted">Nothing found.</div>}
        {result?.request.mode === "names"
          ? result.data.hits.map((h) => (
              <button key={h.path} role="listitem" onClick={() => (result.request.folders ? showFolder(h.path) : void openHit(h))} title={h.path} className="flex h-7 w-full items-center gap-2 px-3 text-left hover:bg-panel2">
                {result.request.folders ? <Folder size={13} className="flex-none text-accent" /> : <FileIcon size={13} className="flex-none text-muted" />}
                <span className="truncate">{rel(h.path)}</span>
              </button>
            ))
          : groups.map(([path, hits]) => (
              <div key={path} role="listitem">
                <div className="group/g flex h-7 items-center gap-1.5 px-2 hover:bg-panel2">
                  <button aria-expanded={!collapsed[path]} onClick={() => setCollapsed((c) => ({ ...c, [path]: !c[path] }))} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    <ChevronRight size={12} className={clsx("flex-none text-muted", !collapsed[path] && "rotate-90")} />
                    <FileIcon size={13} className="flex-none text-muted" />
                    <span className="truncate font-sans text-[13px] text-text" title={path}>
                      {rel(path)}
                    </span>
                    <span className="flex-none rounded bg-panel2 px-1.5 font-sans text-[11px] text-muted">{hits.length}</span>
                  </button>
                  <button aria-label={`Show ${path} in Files`} title="Show in Files" onClick={() => showFolder(path.slice(0, path.lastIndexOf("/")) || "/")} className="invisible flex-none text-muted group-hover/g:visible hover:text-text">
                    <FolderOpen size={13} />
                  </button>
                </div>
                {!collapsed[path] &&
                  hits.map((h) => (
                    <button key={`${h.line}`} onClick={() => void openHit(h)} className="flex w-full items-baseline gap-3 py-0.5 pr-3 pl-9 text-left hover:bg-panel2">
                      <span className="w-10 flex-none text-right text-muted">{h.line}</span>
                      <span className="min-w-0 flex-1 truncate whitespace-pre">
                        {highlight(h.text ?? "", result!.request).map((part, i) =>
                          part.hit ? (
                            <mark key={i} className="rounded-sm bg-[#6A5828] text-[#FFE6A3]">
                              {part.text}
                            </mark>
                          ) : (
                            <span key={i}>{part.text}</span>
                          ),
                        )}
                      </span>
                    </button>
                  ))}
              </div>
            ))}
      </div>
    </div>
  );
}

function summary(d: SearchResult, files: number, names: boolean): string {
  const n = d.hits.length;
  if (names) return `${n}${d.truncated ? "+" : ""} found`;
  return `${n}${d.truncated ? "+" : ""} match${n === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}`;
}

function Toggle({ label, on, disabled, onClick, children }: { label: string; on: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      aria-pressed={on}
      title={disabled ? `${label} (contents only)` : label}
      disabled={disabled}
      onClick={onClick}
      className={clsx("grid h-8 w-8 flex-none place-items-center rounded-md border disabled:opacity-35", on ? "border-accent-line bg-accent-bg text-text" : "border-transparent text-muted hover:bg-panel2 hover:text-text")}
    >
      {children}
    </button>
  );
}

function Check({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      {label}
    </label>
  );
}

function ListField({ label, hint, value, onChange, disabled }: { label: string; hint: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className={clsx("flex min-w-[170px] flex-1 items-center gap-1.5", disabled && "opacity-40")}>
      <span className="flex-none text-muted">{label}</span>
      <TextInput aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={hint} mono className="h-7 min-w-0 flex-1 text-xs" />
    </label>
  );
}
