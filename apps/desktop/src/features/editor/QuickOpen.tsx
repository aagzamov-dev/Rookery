// Quick open (Ctrl+P in the editor): recent files at once, file names under the folder shown in
// the tree as you type (find, debounced). Enter or click opens; Esc closes.
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Clock, File as FileIcon, Loader2 } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import { useRecent } from "../../stores/recent";
import { Modal, TextInput } from "../../ui/primitives";

const SLOT = "quick";
const EMPTY: string[] = [];

export function QuickOpen({ hostId, folder, onOpen, onClose }: { hostId: string; folder: string | null; onOpen: (path: string) => void; onClose: () => void }) {
  const recent = useRecent((s) => s.files[hostId]) ?? EMPTY;
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const generation = useRef(0);

  const q = query.trim();
  const recentMatches = q ? recent.filter((p) => p.toLowerCase().includes(q.toLowerCase())) : recent;
  const items = [...recentMatches.map((path) => ({ path, recent: true })), ...(found ?? []).filter((p) => !recentMatches.includes(p)).map((path) => ({ path, recent: false }))];

  useEffect(() => {
    const gen = ++generation.current;
    setIndex(0);
    if (q.length < 2 || !folder) {
      setFound(null);
      setBusy(false);
      void api.searchCancel(hostId, SLOT).catch(() => {});
      return;
    }
    const t = setTimeout(() => {
      setBusy(true);
      setError(null);
      api
        .searchRun({ host_id: hostId, slot: SLOT, folder, query: q, mode: "names", regex: false, case_sensitive: false, whole_word: false, include: [], exclude: [], exclude_dirs: ["node_modules", ".git"], hidden: false, follow_links: false, folders: false, max_depth: folder === "/" ? 3 : 12, max_results: 100 })
        .then(
          (r) => gen === generation.current && setFound(r.hits.map((h) => h.path)),
          (e) => {
            const msg = asCoreError(e).message;
            if (gen === generation.current && msg !== "Search cancelled.") setError(msg);
          },
        )
        .finally(() => gen === generation.current && setBusy(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q, folder, hostId]);

  // Closing stops a running search on the server.
  useEffect(() => () => void api.searchCancel(hostId, SLOT).catch(() => {}), [hostId]);

  const pick = (path: string | undefined) => {
    if (!path) return;
    onClose();
    onOpen(path);
  };

  const rel = (p: string) => (folder && p.startsWith(`${folder.replace(/\/+$/, "")}/`) ? p.slice(folder.replace(/\/+$/, "").length + 1) : p);

  return (
    <Modal title="Open file" onClose={onClose} width={620}>
      <div className="flex flex-col gap-2">
        <TextInput
          autoFocus
          aria-label="File name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(items[index]?.path);
            }
          }}
          placeholder={folder ? `File name in ${folder}` : "File name"}
          mono
        />
        <div role="listbox" aria-label="Files" className="max-h-[360px] min-h-[120px] overflow-auto rounded-md border border-line font-mono text-xs">
          {items.map((it, i) => (
            <button
              key={`${it.recent}:${it.path}`}
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(it.path)}
              title={it.path}
              className={clsx("flex h-7 w-full items-center gap-2 px-2.5 text-left", i === index ? "bg-accent-bg" : "hover:bg-panel2")}
            >
              {it.recent ? <Clock size={12} className="flex-none text-muted" /> : <FileIcon size={12} className="flex-none text-muted" />}
              <span className="truncate">{it.recent ? it.path : rel(it.path)}</span>
            </button>
          ))}
          {!items.length && !busy && <div className="p-3 font-sans text-muted">{q.length < 2 ? "Recently opened files appear here. Type 2 or more letters to find files by name." : "No files found."}</div>}
        </div>
        <div className="flex h-4 items-center gap-2 text-[11px] text-muted">
          {busy && (
            <>
              <Loader2 size={11} className="animate-spin" /> Searching names…
            </>
          )}
          {error && <span className="text-[#FFA8A8]">{error}</span>}
          {!busy && !error && found && found.length >= 100 && <span>First 100 files; type more of the name to narrow it.</span>}
        </div>
      </div>
    </Modal>
  );
}
