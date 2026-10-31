import { useEffect, useState } from "react";
import { ArrowUp, Folder, Loader2 } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { FileEntry } from "../../ipc/bindings/FileEntry";
import { parentPath } from "../../stores/files";
import { Button, Modal, TextInput } from "../../ui/primitives";

export function FolderPicker({ hostId, initialPath, onPick, onClose }: { hostId: string; initialPath: string; onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(initialPath.startsWith("/") ? initialPath : "");
  const [draft, setDraft] = useState(path);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      if (!path) {
        const home = await api.sftpHome(hostId);
        const initial = initialPath.startsWith("~/") ? `${home.replace(/\/+$/, "")}/${initialPath.slice(2)}` : home;
        if (!cancelled) { setPath(initial); setDraft(initial); }
        return;
      }
      const files = await api.sftpList(hostId, path);
      if (!cancelled) setEntries(files.filter((entry) => entry.kind === "dir"));
    })().catch((cause: unknown) => {
      if (!cancelled) setError(asCoreError(cause).message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [hostId, path]);

  const go = (next: string) => { setPath(next); setDraft(next); };
  return (
    <Modal title="Select a repository folder" onClose={onClose} width={620}>
      <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (draft.trim().startsWith("/")) go(draft.trim()); }}>
        <Button type="button" aria-label="Up one folder" disabled={!path || path === "/" || loading} onClick={() => go(parentPath(path))}><ArrowUp size={14} /></Button>
        <TextInput mono className="min-w-0 flex-1" aria-label="Remote folder path" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <Button type="submit" disabled={loading}>Open</Button>
      </form>
      <div className="h-[min(50vh,360px)] overflow-auto rounded-lg border border-line bg-bg p-1">
        {loading ? <div role="status" className="flex items-center gap-2 p-3 text-muted"><Loader2 size={14} className="animate-spin" /> Loading folders…</div> : error ? <div role="alert" className="p-3 text-prod-fg">{error}</div> : entries.map((entry) => (
          <button type="button" key={entry.path} onClick={() => go(entry.path)} className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-panel2"><Folder size={14} className="text-accent" /><span className="truncate">{entry.name}</span></button>
        ))}
        {!loading && !error && entries.length === 0 && <div className="p-3 text-muted">No subfolders</div>}
      </div>
      <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!path || loading || !!error} onClick={() => onPick(path)}>Use this folder</Button></div>
    </Modal>
  );
}
