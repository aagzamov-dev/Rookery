import { useEffect, useState } from "react";
import clsx from "clsx";
import { Check, Copy, Download, FolderOpen, FolderSync, KeyRound, Laptop, RefreshCw, Upload, X } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, asCoreError } from "../../ipc/api";
import type { BackupInfo } from "../../ipc/bindings/BackupInfo";
import type { ImportMode } from "../../ipc/bindings/ImportMode";
import { backupFileName, summaryText, useBackup } from "../../stores/backup";
import { askConfirm, askText } from "../../stores/dialogs";
import { ago } from "../../stores/sync";
import { Button, TextInput } from "../../ui/primitives";

/**
 * Backup & sync. One encrypted file format for both:
 * - sync folder: each device writes its own file into a folder that Google Drive / OneDrive /
 *   Dropbox syncs, and merges the others' (newest edit wins, deletions travel);
 * - backup file: save it, send it anywhere (Telegram, USB…), import it on the other device.
 */
export function BackupPage() {
  const status = useBackup((s) => s.status);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    void useBackup.getState().load();
  }, []);

  if (!status) return null;
  const say = (text: string, bad = false) => setMsg({ text, bad });
  const fail = (e: unknown) => say(asCoreError(e).message, true);

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <FolderSync size={20} className="text-accent" />
        <h1 className="m-0 text-xl font-semibold">Backup &amp; sync</h1>
      </div>
      <p className="-mt-3 m-0 max-w-2xl text-[13px] leading-relaxed text-muted">
        Servers, groups, logins with their passwords and keys, snippets, shortcuts and settings — encrypted with your sync password before they leave
        this computer. Dashboard data and open tabs stay on each device.
      </p>
      {msg && (
        <div className={clsx("flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px]", msg.bad ? "border-[#5A2D33] bg-[#33232A] text-prod-fg" : "border-accent-line bg-accent-bg")}>
          <span className="flex-1">{msg.text}</span>
          <button aria-label="Dismiss" onClick={() => setMsg(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      <PasswordCard hasPassword={status.has_password} onDone={say} onError={fail} />
      <SyncCard onDone={say} onError={fail} />
      <FileCard onDone={say} onError={fail} />
    </div>
  );
}

type Notify = { onDone: (text: string) => void; onError: (e: unknown) => void };

function Card({ icon, title, hint, children, right }: { icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="flex flex-col rounded-xl border border-line bg-panel">
      <div className="flex items-start gap-3 border-b border-line px-4 py-3">
        <span className="mt-0.5 text-accent">{icon}</span>
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="font-semibold">{title}</span>
          {hint && <span className="text-xs leading-relaxed text-muted">{hint}</span>}
        </span>
        {right}
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">{children}</div>
    </section>
  );
}

function PasswordCard({ hasPassword, onDone, onError }: { hasPassword: boolean } & Notify) {
  const [editing, setEditing] = useState(!hasPassword);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setEditing(!hasPassword), [hasPassword]);
  const ok = a.length >= 8 && a === b;

  return (
    <Card
      icon={<KeyRound size={16} />}
      title="Sync password"
      hint="Use the same password on every device. It is saved in this device's vault, so syncing never asks for it. Rookery cannot recover it — keep it in your password manager."
      right={hasPassword && !editing ? <span className="flex items-center gap-1 text-xs text-ok"><Check size={13} /> Saved</span> : undefined}
    >
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!ok) return;
            setBusy(true);
            try {
              await api.backupSetPassword(a);
              setA("");
              setB("");
              await useBackup.getState().load();
              onDone("Sync password saved.");
            } catch (err) {
              onError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextInput type="password" autoComplete="new-password" aria-label="Sync password" placeholder="Sync password (8+ characters)" className="w-60" value={a} onChange={(e) => setA(e.target.value)} />
          <TextInput type="password" autoComplete="new-password" aria-label="Repeat sync password" placeholder="Repeat" className="w-44" value={b} onChange={(e) => setB(e.target.value)} />
          <Button variant="primary" type="submit" disabled={!ok || busy}>
            Save password
          </Button>
          {hasPassword && (
            <Button variant="ghost" type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
          {b && a !== b && <span className="text-xs text-[#F7CB6A]">Passwords differ</span>}
        </form>
      ) : (
        <div className="flex items-center gap-3 text-[13px] text-muted">
          <span className="flex-1">Changing it means setting the same new password on your other devices too.</span>
          <Button onClick={() => setEditing(true)}>Change…</Button>
        </div>
      )}
    </Card>
  );
}

function SyncCard({ onDone, onError }: Notify) {
  const status = useBackup((s) => s.status)!;
  const cfg = status.config;
  const [name, setName] = useState(cfg.device_name);
  useEffect(() => setName(cfg.device_name), [cfg.device_name]);
  const save = (folder: string | null, auto: boolean, deviceName = name) =>
    api.backupSetConfig(folder, auto, deviceName).then(useBackup.getState().setStatus).catch(onError);
  const now = Date.now();

  return (
    <Card
      icon={<FolderSync size={16} />}
      title="Sync between your devices"
      hint="Pick a folder that Google Drive, OneDrive or Dropbox syncs — the same one on each computer. Every device writes its own encrypted file there and merges the others: newest edit wins, deletions sync too."
      right={
        cfg.folder ? (
          <Button
            variant="primary"
            className="h-8"
            disabled={status.syncing || !status.has_password}
            onClick={() =>
              api
                .backupSyncNow()
                .then((s) => {
                  useBackup.getState().setStatus(s);
                  onDone(s.last_summary ? `Synced · ${summaryText(s.last_summary)}` : "Synced.");
                })
                .catch(onError)
            }
          >
            <RefreshCw size={13} className={clsx(status.syncing && "animate-spin")} /> Sync now
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 text-[13px] text-muted">Folder</span>
        <span className={clsx("min-w-0 flex-1 truncate rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-xs", !cfg.folder && "text-muted")} title={cfg.folder ?? ""}>
          {cfg.folder ?? "Not set — sync is off"}
        </span>
        <Button
          onClick={async () => {
            const picked = await openDialog({ directory: true, multiple: false, title: "Choose the sync folder (inside Google Drive, OneDrive, Dropbox…)" });
            if (typeof picked === "string") void save(picked, cfg.auto);
          }}
        >
          <FolderOpen size={13} /> {cfg.folder ? "Change…" : "Choose folder…"}
        </Button>
        {cfg.folder && (
          <Button variant="ghost" onClick={() => void save(null, cfg.auto)}>
            Turn off
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 text-[13px] text-muted">This device</span>
        <TextInput
          aria-label="Device name"
          className="w-60"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() !== cfg.device_name && void save(cfg.folder, cfg.auto, name)}
        />
        <label className="ml-2 flex cursor-pointer items-center gap-2 text-[13px]">
          <input type="checkbox" className="accent-accent" checked={cfg.auto} onChange={(e) => void save(cfg.folder, e.target.checked)} />
          Sync automatically
        </label>
      </div>
      {cfg.folder && !status.has_password && <p className="m-0 text-xs text-[#F7CB6A]">Set the sync password above to start syncing.</p>}
      {cfg.folder && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-bg px-3 py-2.5 text-xs">
          <span className={status.last_error ? "text-prod-fg" : "text-muted"}>
            {status.syncing
              ? "Syncing…"
              : status.last_error
                ? `Last sync failed: ${status.last_error}`
                : status.last_sync_at
                  ? `Last sync ${ago(status.last_sync_at, now)}${status.last_summary ? ` · ${summaryText(status.last_summary)}` : ""}`
                  : cfg.auto
                    ? "Waiting for the first sync…"
                    : "Not synced yet"}
          </span>
          {status.last_summary?.notes.map((n) => (
            <span key={n} className="text-[#F7CB6A]">
              {n}
            </span>
          ))}
          <span className="mt-1 font-semibold text-muted">Other devices in this folder</span>
          {status.peers.length === 0 ? (
            <span className="text-muted">None yet — choose the same folder on your other computer.</span>
          ) : (
            status.peers.map((p) => (
              <span key={p.device_id} className="flex items-center gap-2">
                <Laptop size={12} className="text-muted" />
                <span>{p.device_name}</span>
                <span className="text-muted">wrote {ago(p.written_at, now)}</span>
                {p.error && <span className="text-prod-fg">· {p.error}</span>}
              </span>
            ))
          )}
        </div>
      )}
    </Card>
  );
}

function FileCard({ onDone, onError }: Notify) {
  const status = useBackup((s) => s.status)!;
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, setPending] = useState<{ path: string; password: string | null; info: BackupInfo } | null>(null);
  const [busy, setBusy] = useState(false);

  const exportFile = async () => {
    const path = await saveDialog({
      title: "Save backup",
      defaultPath: backupFileName(status.config.device_name),
      filters: [{ name: "Rookery backup", extensions: ["rookerybackup"] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      await api.backupExport(path, null);
      setSaved(path);
      onDone("Backup saved. Send it any way you like — it is encrypted with your sync password.");
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const pickImport = async () => {
    const picked = await openDialog({ multiple: false, title: "Import backup", filters: [{ name: "Rookery backup", extensions: ["rookerybackup"] }] });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      let password: string | null = null;
      for (;;) {
        try {
          const info = await api.backupInspect(picked, password);
          setPending({ path: picked, password, info });
          return;
        } catch (e) {
          const err = asCoreError(e);
          if (err.kind !== "wrong_password" && !/sync password/.test(err.message)) throw e;
          password = await askText({
            title: password ? "Wrong password — try again" : "Password for this backup",
            label: "Backup password (the sync password of the device that made it)",
            value: "",
            confirmLabel: "Open",
            secret: true,
          });
          if (!password) return;
        }
      }
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (mode: ImportMode) => {
    if (!pending) return;
    if (mode === "replace") {
      const ok = await askConfirm({
        title: "Replace everything on this device?",
        body: "Servers, logins, snippets and settings here are replaced by the backup. Anything that is only on this device is lost.",
        confirmLabel: "Replace everything",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const sum = await api.backupImport(pending.path, pending.password, mode);
      setPending(null);
      onDone(`Imported · ${summaryText(sum)}${sum.notes.length ? ` · ${sum.notes.join(" · ")}` : ""}`);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      icon={<Download size={16} />}
      title="Backup file"
      hint="One encrypted file with everything. Keep it as a backup, or send it to your other computer by Telegram, mail or USB and import it there."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy || !status.has_password} onClick={() => void exportFile()} title={status.has_password ? "" : "Set the sync password first"}>
          <Download size={13} /> Save backup…
        </Button>
        <Button disabled={busy} onClick={() => void pickImport()}>
          <Upload size={13} /> Import backup…
        </Button>
        {!status.has_password && <span className="text-xs text-muted">Set the sync password to save backups.</span>}
      </div>

      {saved && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-bg px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate font-mono" title={saved}>
            {saved}
          </span>
          <Button className="h-7" onClick={() => void revealItemInDir(saved).catch(onError)}>
            <FolderOpen size={12} /> Show in folder
          </Button>
          <Button className="h-7" onClick={() => void api.fileCopyToClipboard(saved).then(() => onDone("File copied — paste it into Telegram or any chat.")).catch(onError)}>
            <Copy size={12} /> Copy file
          </Button>
        </div>
      )}

      {pending && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-accent-line bg-accent-bg px-3 py-3 text-[13px]">
          <span>
            Backup from <b>{pending.info.device_name}</b>, {new Date(pending.info.created_at).toLocaleString()}: {pending.info.hosts} servers · {pending.info.groups} groups ·{" "}
            {pending.info.identities} logins · {pending.info.snippets} snippets
          </span>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void runImport("merge")} title="Adds what is new, keeps the newest version of each item">
              Merge into this device
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void runImport("replace")}>
              Replace everything
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
