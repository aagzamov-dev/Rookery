import { COMPUTER_ID } from "../local/target";
import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button, Field, Modal, TextInput } from "../../ui/primitives";
import { FolderPicker } from "./FolderPicker";

export function AddRepositoryDialog({ hostId, initialPath, onPick, onClose, onRemove }: { hostId: string; initialPath: string; onPick: (path: string) => void; onClose: () => void; onRemove?: () => void }) {
  const [path, setPath] = useState(initialPath);
  const [browsing, setBrowsing] = useState(false);
  if (browsing) return <FolderPicker hostId={hostId} initialPath={path || "~"} onPick={onPick} onClose={() => setBrowsing(false)} />;
  return (
    <Modal title="Add a repository" onClose={onClose} width={540}>
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (path.trim()) onPick(path.trim()); }}>
        <Field label={hostId === COMPUTER_ID ? "Folder on this computer" : "Folder on this server"} hint="Enter an absolute path or ~/path, or browse for a folder."><TextInput autoFocus mono aria-label="Repository folder path" placeholder="/path/to/repository" value={path} onChange={(event) => setPath(event.target.value)} /></Field>
        <div className="flex items-center gap-2"><Button type="button" onClick={() => setBrowsing(true)}><FolderOpen size={15} /> Browse {hostId === COMPUTER_ID ? "computer" : "server"}</Button><Button type="button" className="ml-auto" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={!path.trim()}>Add repository</Button></div>
        {onRemove && <button type="button" className="mt-1 self-start text-xs text-muted hover:text-text" onClick={onRemove}>Remove current repository from saved list</button>}
      </form>
    </Modal>
  );
}
