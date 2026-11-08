// Permissions dialog (chmod of one file or folder, never recursive) and "Make executable".
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, asCoreError } from "../../ipc/api";
import type { FileEntry } from "../../ipc/bindings/FileEntry";
import { Button, Modal, TextInput } from "../../ui/primitives";
import { COMPUTER_ID } from "../local/target";
import { filesChanged, type FileCtx } from "./fileActions";
import { parentPath } from "../../stores/files";

/** Octal text ("755", "0644") → bits, or null. */
export function parseMode(text: string): number | null {
  const t = text.trim();
  if (!/^[0-7]{3,4}$/.test(t)) return null;
  return parseInt(t, 8);
}

/** `rwxr-x---` for the low 9 bits. */
export const modeString = (m: number) => [6, 3, 0].map((sh) => ((m >> sh) & 4 ? "r" : "-") + ((m >> sh) & 2 ? "w" : "-") + ((m >> sh) & 1 ? "x" : "-")).join("");

/** Add execute wherever read is allowed (`644` → `755`, `600` → `700`). */
export const withExec = (m: number) => m | ((m & 0o444) >> 2);

/** Shown above everything; opened from the file menus. */
export const usePermissions = create<{ target: { hostId: string; entry: FileEntry; note: (m: string) => void } | null; open: (ctx: FileCtx, entry: FileEntry) => void; close: () => void }>((set) => ({
  target: null,
  open: (ctx, entry) => set({ target: { hostId: ctx.hostId, entry, note: ctx.note } }),
  close: () => set({ target: null }),
}));

export async function makeExecutable(ctx: FileCtx, e: FileEntry) {
  const mode = (e.mode ?? 0o644) & 0o7777;
  try {
    await api.sftpChmod(ctx.hostId, e.path, withExec(mode));
    filesChanged(ctx.hostId, [parentPath(e.path)]);
  } catch (x) {
    const m = asCoreError(x).message;
    if (m !== "Change cancelled.") ctx.note(m);
  }
}

const WHO = [
  ["Owner", 6],
  ["Group", 3],
  ["Others", 0],
] as const;

export function PermissionsHost() {
  const target = usePermissions((s) => s.target);
  if (!target) return null;
  return <PermissionsDialog key={`${target.hostId}|${target.entry.path}`} {...target} onClose={() => usePermissions.getState().close()} />;
}

function PermissionsDialog({ hostId, entry, note, onClose }: { hostId: string; entry: FileEntry; note: (m: string) => void; onClose: () => void }) {
  const start = (entry.mode ?? 0) & 0o7777;
  const [mode, setMode] = useState(start);
  const [text, setText] = useState(start.toString(8).padStart(3, "0"));
  const [owner, setOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (hostId === COMPUTER_ID) return;
    void api.sftpOwner(hostId, entry.path).then(([u, g]) => setOwner(`${u} : ${g}`), () => setOwner(null));
  }, [hostId, entry.path]);

  const set = (m: number) => {
    setMode(m);
    setText(m.toString(8).padStart(3, "0"));
  };

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.sftpChmod(hostId, entry.path, mode);
      filesChanged(hostId, [parentPath(entry.path)]);
      onClose();
    } catch (x) {
      const m = asCoreError(x).message;
      if (m === "Change cancelled.") return;
      setErr(m);
      note(m);
    } finally {
      setBusy(false);
    }
  };

  const dir = entry.kind === "dir";
  return (
    <Modal
      title={`Permissions of ${entry.name}`}
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || mode === start} onClick={() => void apply()}>
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <div className="font-mono text-xs break-all text-muted">{entry.path}</div>
        {owner && (
          <div className="text-xs text-muted">
            Owner : group <span className="font-mono text-text">{owner}</span>
          </div>
        )}
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted">
              <th className="text-left font-normal" />
              <th className="font-normal">Read</th>
              <th className="font-normal">Write</th>
              <th className="font-normal">{dir ? "Open (x)" : "Execute"}</th>
            </tr>
          </thead>
          <tbody>
            {WHO.map(([label, sh]) => (
              <tr key={label}>
                <td className="py-1">{label}</td>
                {[4, 2, 1].map((bit) => (
                  <td key={bit} className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`${label} ${bit === 4 ? "read" : bit === 2 ? "write" : "execute"}`}
                      checked={!!(mode & (bit << sh))}
                      onChange={(e) => set(e.target.checked ? mode | (bit << sh) : mode & ~(bit << sh))}
                      className="accent-accent"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted">Octal</span>
          <TextInput
            aria-label="Octal permissions"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const m = parseMode(e.target.value);
              if (m !== null) setMode(m);
            }}
            mono
            className="h-7 w-20 text-xs"
          />
          <span className="font-mono text-muted">{modeString(mode)}</span>
        </label>
        {mode & 0o7000 ? <p className="m-0 text-xs text-[#F7CB6A]">Special bits (setuid, setgid or sticky) are set.</p> : null}
        {dir && !(mode & 0o100) && <p className="m-0 text-xs text-[#F7CB6A]">Without Owner “Open (x)” you cannot list or enter this folder.</p>}
        <p className="m-0 text-[11px] text-muted">Changes only this {dir ? "folder, not what is inside it" : "file"}.</p>
        {err && <p className="m-0 text-xs text-[#FFA8A8]">{err}</p>}
      </div>
    </Modal>
  );
}
