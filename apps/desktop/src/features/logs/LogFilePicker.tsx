import { useEffect, useState } from "react";
import { ArrowUp, FileText, Folder, Loader2 } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { FileEntry } from "../../ipc/bindings/FileEntry";
import { parentPath } from "../../stores/files";
import { Button, Modal, TextInput } from "../../ui/primitives";

export function LogFilePicker({ hostId, initialPath, onPick, onClose }: { hostId: string; initialPath: string; onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(initialPath);
  const [draft, setDraft] = useState(initialPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEntries([]);
    void api.sftpList(hostId, path).then((files) => {
      if (!cancelled) setEntries(files);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(asCoreError(cause).message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [hostId, path]);

  const go = (next: string) => {
    setPath(next);
    setDraft(next);
  };

  return (
    <Modal title="Select a log file" onClose={onClose} width={640}>
      <form className="flex items-center gap-2" onSubmit={(event) => {
        event.preventDefault();
        const next = draft.trim();
        if (next.startsWith("/")) go(next);
      }}>
        <Button type="button" aria-label="Up one folder" title="Up one folder" disabled={path === "/"} onClick={() => go(parentPath(path))}>
          <ArrowUp size={14} />
        </Button>
        <TextInput className="min-w-0 flex-1" mono aria-label="Folder path" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <Button type="submit">Open</Button>
      </form>
      <div className="h-[min(50vh,400px)] overflow-y-auto rounded-lg border border-line bg-bg p-1">
        {loading ? (
          <div role="status" className="flex items-center gap-2 p-3 text-xs text-muted"><Loader2 size={14} className="animate-spin" /> Loading files…</div>
        ) : error ? (
          <div role="alert" className="p-3 text-xs text-prod-fg">{error}</div>
        ) : (
          <>
            {entries.filter((entry) => entry.kind === "dir" || entry.kind === "file").map((entry) => (
              <button
                key={entry.path}
                type="button"
                title={entry.path}
                onClick={() => entry.kind === "dir" ? go(entry.path) : onPick(entry.path)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-panel2 focus:bg-accent-bg"
              >
                {entry.kind === "dir" ? <Folder size={14} className="flex-none text-accent" /> : <FileText size={14} className="flex-none text-muted" />}
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
            {entries.length === 0 && <div className="p-3 text-xs text-muted">Empty folder</div>}
          </>
        )}
      </div>
      <p className="m-0 text-xs text-muted">Open a folder, then click a file to follow its log.</p>
    </Modal>
  );
}
