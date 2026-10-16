// Open the connection dialog from anywhere (sidebar, database tab "Save", server view, palette).
import { create } from "zustand";
import type { DbConnection } from "../../ipc/bindings/DbConnection";
import { ConnectionDialog, type ConnDraft } from "./ConnectionDialog";

interface DialogState {
  draft: ConnDraft | null;
  onSaved?: (c: DbConnection) => void;
  open: (draft: ConnDraft, onSaved?: (c: DbConnection) => void) => void;
  close: () => void;
}

export const useConnDialog = create<DialogState>((set) => ({
  draft: null,
  open: (draft, onSaved) => set({ draft, onSaved }),
  close: () => set({ draft: null, onSaved: undefined }),
}));

export function ConnDialogHost() {
  const draft = useConnDialog((s) => s.draft);
  const onSaved = useConnDialog((s) => s.onSaved);
  const close = useConnDialog((s) => s.close);
  if (!draft) return null;
  return <ConnectionDialog draft={draft} onClose={close} onSaved={onSaved} />;
}
