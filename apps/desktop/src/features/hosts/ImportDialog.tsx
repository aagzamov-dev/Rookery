import { useState } from "react";
import clsx from "clsx";
import { FileText, KeyRound, TerminalSquare } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, asCoreError } from "../../ipc/api";
import type { ImportedHost } from "../../ipc/bindings/ImportedHost";
import { isMac } from "../../keys/chord";
import { useHosts } from "../../stores/hosts";
import { Button, Modal, TextInput } from "../../ui/primitives";

type Source = "ssh_config" | "mobaxterm" | "putty";

/** Import servers from ~/.ssh/config, MobaXterm or PuTTY: preview, pick, import. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ImportedHost[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [group, setGroup] = useState("Imported");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const load = async (source: Source) => {
    setErr(null);
    let path: string | null = null;
    if (source === "mobaxterm") {
      const f = await openDialog({
        multiple: false,
        title: "MobaXterm sessions file (Sessions › Export, or MobaXterm.ini)",
        filters: [{ name: "MobaXterm", extensions: ["mxtsessions", "ini"] }],
      });
      if (typeof f !== "string") return;
      path = f;
    }
    setBusy(true);
    try {
      const l = await api.importPreview(source, path);
      setList(l);
      setPicked(new Set(l.map((h, i) => (h.exists ? -1 : i)).filter((i) => i >= 0)));
      if (l.length === 0) setErr("No SSH servers found there.");
    } catch (e) {
      setErr(asCoreError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!list) return;
    setBusy(true);
    try {
      const n = await api.importApply(
        list.filter((_, i) => picked.has(i)),
        group.trim() || null,
      );
      await useHosts.getState().load();
      setDone(n);
    } catch (e) {
      setErr(asCoreError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const source = (s: Source, icon: React.ReactNode, title: string, hint: string) => (
    <button
      disabled={busy}
      onClick={() => void load(s)}
      className="flex items-start gap-3 rounded-xl border border-line bg-panel2 p-3 text-left hover:border-accent-line disabled:opacity-50"
    >
      <span className="mt-0.5 text-accent">{icon}</span>
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold">{title}</span>
        <span className="text-xs text-muted">{hint}</span>
      </span>
    </button>
  );

  return (
    <Modal
      title="Import servers"
      onClose={onClose}
      width={680}
      footer={
        done != null ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : list && list.length > 0 ? (
          <>
            <Button variant="ghost" onClick={() => setList(null)}>
              Back
            </Button>
            <Button variant="primary" disabled={busy || picked.size === 0} onClick={() => void run()}>
              Import {picked.size} server{picked.size === 1 ? "" : "s"}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        )
      }
    >
      {done != null ? (
        <p className="m-0 leading-relaxed">
          Imported <b>{done}</b> server{done === 1 ? "" : "s"}. Logins without a key file need their password once: open the server, or edit the login in
          Hosts &amp; identities.
        </p>
      ) : !list || list.length === 0 ? (
        <div className="grid gap-2">
          {source("ssh_config", <TerminalSquare size={16} />, "OpenSSH config", "Reads ~/.ssh/config: Host, HostName, User, Port, IdentityFile.")}
          {source("mobaxterm", <FileText size={16} />, "MobaXterm sessions", "MobaXterm › Sessions › Export sessions (.mxtsessions), or MobaXterm.ini. Folders become groups.")}
          {!isMac && source("putty", <KeyRound size={16} />, "PuTTY", "Saved PuTTY sessions on this computer (SSH only).")}
          <p className="m-0 text-xs text-muted">Nothing is saved until you pick the servers and press Import. Passwords are never imported.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-muted">Put servers without a folder into group</span>
            <TextInput className="h-8 w-48" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="(no group)" />
            <button className="ml-auto text-xs text-accent" onClick={() => setPicked(picked.size === list.length ? new Set() : new Set(list.map((_, i) => i)))}>
              {picked.size === list.length ? "Select none" : "Select all"}
            </button>
          </div>
          <div className="flex max-h-[360px] flex-col overflow-auto rounded-lg border border-line">
            {list.map((h, i) => (
              <label key={i} className={clsx("flex cursor-pointer items-center gap-3 border-b border-[#303A4E] px-3 py-2 last:border-b-0 hover:bg-panel2", h.exists && "opacity-60")}>
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={picked.has(i)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(i);
                    else next.delete(i);
                    setPicked(next);
                  }}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{h.name}</span>
                <span className="truncate font-mono text-xs text-muted">
                  {h.user ? `${h.user}@` : ""}
                  {h.address}
                  {h.port !== 22 ? `:${h.port}` : ""}
                </span>
                {h.folder && <span className="truncate text-xs text-muted">{h.folder}</span>}
                {h.key_path && <KeyRound size={12} className="text-muted" aria-label="key file" />}
                {h.exists && <span className="text-[11px] text-muted">already added</span>}
              </label>
            ))}
          </div>
        </div>
      )}
      {err && <div className="rounded-lg border border-[#5A2D33] bg-[#33232A] px-3 py-2 text-xs text-prod-fg">{err}</div>}
    </Modal>
  );
}
