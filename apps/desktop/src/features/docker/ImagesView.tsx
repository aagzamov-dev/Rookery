// Docker → Images: list with the containers using each image, multi-select, delete, download as
// .tar / .tar.gz and clean up. Loaded when the tab is first opened; not kept live.
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Box, Download, Eraser, Loader2, RotateCw, Search, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import { askChoice, askConfirm } from "../../stores/dialogs";
import { useDockerImages, useDockerSudo, useImageImports } from "../../stores/docker";
import { useHosts } from "../../stores/hosts";
import { COMPUTER_ID } from "../local/target";
import { ImageExportStatus, ImageImportStatus, SudoButton, SudoDialog } from "./DockerTools";
import {
  agoText,
  archivePath,
  exportFileName,
  filterImages,
  formatBytes,
  imageKey,
  imageName,
  importedImages,
  inUse,
  isUnused,
  isUntagged,
  overwriteWarning,
  overwrittenTags,
  unchangedTags,
  pinImported,
  shortId,
  sortNewest,
  totalSize,
  uniqueRefs,
} from "./images";

export type DockerTab = "containers" | "images";

/** "Containers | Images" switch in the Docker header. */
export function DockerTabs({ value, onChange }: { value: DockerTab; onChange: (tab: DockerTab) => void }) {
  return (
    <div role="tablist" aria-label="Docker" className="flex h-7 items-center rounded-md border border-line bg-bg p-0.5">
      {(["containers", "images"] as const).map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={value === t}
          onClick={() => onChange(t)}
          className={clsx("h-6 rounded px-2.5 text-xs font-semibold", value === t ? "bg-accent-bg text-text" : "text-muted hover:text-text")}
        >
          {t === "containers" ? "Containers" : "Images"}
        </button>
      ))}
    </div>
  );
}

const COLS = "grid-cols-[20px_minmax(0,1.8fr)_104px_84px_116px_72px]";
/** Most images in one download (the core enforces the same limit). */
const DOWNLOAD_MAX = 100;

export function ImagesView({ hostId, visible: active = true, onTab }: { hostId: string; visible?: boolean; onTab: (tab: DockerTab) => void }) {
  const d = useDockerImages((s) => s.byHost[hostId]);
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const [q, setQ] = useState("");
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<"delete" | "prune" | "download" | "import" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"sudo" | null>(null);
  const remote = hostId !== COMPUTER_ID;
  const prod = host?.env_label === "prod";
  const where = remote ? (host?.name ?? "this server") : "this computer";

  // First open, and again whenever the list was forgotten ("Reload images", or a sudo change after an error).
  useEffect(() => {
    if (active && !d) void useDockerImages.getState().load(hostId);
  }, [active, d, hostId]);

  // What the last import loaded stays at the top (its images are often older builds, so "newest first" would bury them).
  const recent = useImageImports((s) => s.recent[hostId]);
  const images = useMemo(() => pinImported(sortNewest(d?.images ?? []), recent ?? []), [d?.images, recent]);
  const importedKeys = useMemo(() => new Set(importedImages(images, recent ?? []).map(imageKey)), [images, recent]);
  const unusedCount = images.filter(isUnused).length;
  // The Unused toggle hides once nothing is unused, so the filter must switch off with it.
  const onlyUnused = unusedOnly && unusedCount > 0;
  const shown = useMemo(() => filterImages(images, q, onlyUnused), [images, q, onlyUnused]);
  // Only rows that are visible count as selected: what the actions act on is what the user sees.
  const picked = useMemo(() => shown.filter((i) => sel.has(imageKey(i))), [shown, sel]);
  const allShown = shown.length > 0 && picked.length === shown.length;

  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = picked.length > 0 && !allShown;
  }, [picked.length, allShown]);

  const toggle = (key: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const toggleAll = () =>
    setSel((s) => {
      const n = new Set(s);
      for (const i of shown) {
        if (allShown) n.delete(imageKey(i));
        else n.add(imageKey(i));
      }
      return n;
    });

  const reload = () => {
    setErr(null);
    void useDockerImages.getState().load(hostId);
  };

  const docker = () => (useDockerSudo.getState().byHost[hostId]?.enabled ? "sudo docker" : "docker");

  const remove = async () => {
    const chosen = picked;
    const refs = uniqueRefs(chosen);
    if (refs.length === 0) return;
    const used = inUse(chosen);
    const chosenIds = new Set(chosen.map(imageKey));
    const otherTags = chosen.some((c) => images.some((i) => i.id === c.id && !chosenIds.has(imageKey(i))));
    const lines: string[] = [];
    lines.push(`${refs.length === 1 ? "This image is" : `These ${refs.length} images are`} deleted from ${where}. Containers are not touched.`);
    if (used.length > 0) {
      lines.push(
        `In use: ${used.map((i) => `${imageName(i)} (${i.containers.join(", ")})`).join("; ")}. Docker will refuse to delete an image while a container uses it (nothing is forced). Remove those containers first.`,
      );
    }
    if (otherTags) lines.push("Some of these images have other tags: deleting a tag only removes that tag until the last one is gone.");
    const what = `${refs.length} ${refs.length === 1 ? "image" : "images"}`;
    const ok = await askConfirm({
      title: prod ? `Delete ${what} on PRODUCTION server ${host?.name}?` : `Delete ${what}?`,
      body: lines.join(" "),
      preview: refs.map((r) => `${docker()} rmi ${r}`).join("\n"),
      confirmLabel: refs.length === 1 ? "Delete image" : `Delete ${refs.length} images`,
      danger: true,
      typeToConfirm: prod ? host?.name : undefined,
    });
    if (!ok) return;
    setErr(null);
    setNote(null);
    setBusy("delete");
    try {
      const r = await api.dockerImagesRemove(hostId, refs, ok);
      if (r.failed.length > 0) {
        setErr(`Deleted ${r.removed.length} of ${refs.length}. Could not delete:\n${r.failed.map((f) => `${f.reference}: ${f.message}`).join("\n")}`);
      } else {
        setNote(`Deleted ${r.removed.length} ${r.removed.length === 1 ? "image" : "images"}.`);
      }
      setSel(new Set());
    } catch (e) {
      setErr(asCoreError(e).message);
    } finally {
      setBusy(null);
      void useDockerImages.getState().load(hostId); // also after failures: some may have gone
    }
  };

  const cleanUp = async () => {
    const choice = await askChoice({
      title: `Clean up images on ${where}`,
      focusCancel: true,
      body: [
        prod ? `This is a PRODUCTION server (${host?.name}). ` : "",
        `Remove dangling images (docker image prune -f): untagged images no container uses. `,
        `Remove all unused images (docker image prune -a -f): every image no container uses, tagged ones too; images of stopped containers stay. `,
        `Deleted images must be pulled or loaded again to use them.`,
      ].join(""),
      choices: [
        { id: "dangling", label: "Remove dangling images", variant: "danger" },
        { id: "all", label: "Remove all unused images", variant: "danger" },
      ],
    });
    if (choice !== "dangling" && choice !== "all") return;
    if (prod) {
      const ok = await askConfirm({
        title: `Clean up images on PRODUCTION server ${host?.name}?`,
        body: choice === "all" ? "Every image no container uses is deleted, tagged ones too." : "Untagged images no container uses are deleted.",
        preview: `${docker()} image prune ${choice === "all" ? "-a " : ""}-f`,
        confirmLabel: "Clean up",
        danger: true,
        typeToConfirm: host?.name,
      });
      if (!ok) return;
    }
    setErr(null);
    setNote(null);
    setBusy("prune");
    try {
      const r = await api.dockerImagesPrune(hostId, choice === "all", true);
      setNote(`Clean up finished: reclaimed ${r.reclaimed}.`);
      setSel(new Set());
    } catch (e) {
      setErr(asCoreError(e).message);
    } finally {
      setBusy(null);
      void useDockerImages.getState().load(hostId);
    }
  };

  const download = async () => {
    const chosen = picked;
    const refs = uniqueRefs(chosen);
    if (refs.length === 0) return;
    if (refs.length > DOWNLOAD_MAX) {
      setErr(`Download at most ${DOWNLOAD_MAX} images at once (${refs.length} are selected).`);
      return;
    }
    const bytes = totalSize(chosen);
    const choice = await askChoice({
      title: `Download ${refs.length} ${refs.length === 1 ? "image" : "images"}`,
      body: `About ${formatBytes(bytes)} of images, saved as one archive that docker load -i can read. ${
        remote
          ? "They are sent over SSH, so large images take a while and load the server's disk and network. "
          : ""
      }.tar.gz is compressed on this computer (smaller file, slower to write).`,
      choices: [
        { id: "tar", label: "Save .tar", variant: "primary" },
        { id: "gz", label: "Save .tar.gz", variant: "outline" },
      ],
    });
    if (choice !== "tar" && choice !== "gz") return;
    const gzip = choice === "gz";
    setErr(null);
    setNote(null);
    setBusy("download");
    try {
      const path = await saveDialog({
        defaultPath: exportFileName(remote ? (host?.name ?? "server") : "computer", gzip),
        filters: [{ name: gzip ? "Compressed Docker image archive" : "Docker image archive", extensions: gzip ? ["gz", "tgz"] : ["tar"] }],
      });
      if (!path) return;
      const target = archivePath(path, gzip);
      if ("error" in target) {
        setErr(target.error);
        return;
      }
      // The OS dialog asked about `path`; a corrected name was never confirmed, so it must not exist yet.
      if (target.changed && (await api.editorStat(COMPUTER_ID, target.path)).exists) {
        setErr(`${target.path} already exists. Choose a different name.`);
        return;
      }
      await api.dockerImagesExport({ host_id: hostId, refs, expected_bytes: bytes, path: target.path });
      // Progress shows under the header.
    } catch (e) {
      setErr(asCoreError(e).message);
    } finally {
      setBusy(null);
    }
  };

  // The file picker, the file scan and the checks take a while: an answer for another server, or for a view that is gone, must not open a dialog.
  const alive = useRef(true);
  const hostNow = useRef(hostId);
  hostNow.current = hostId;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const importing = useImageImports((s) => Object.values(s.jobs).some((j) => j.host_id === hostId && j.state === "running"));

  const importFile = async () => {
    const startedFor = hostId;
    const stale = () => !alive.current || hostNow.current !== startedFor;
    setErr(null);
    setNote(null);
    setBusy("import");
    try {
      const path = await openDialog({
        multiple: false,
        title: "Docker image file (made with docker save)",
        filters: [{ name: "Docker image archive", extensions: ["tar", "gz", "tgz"] }],
      });
      if (typeof path !== "string" || stale()) return;
      // Looked at on this computer first: nothing is sent before the user has seen what is in the file.
      const info = await api.dockerImageArchiveInspect(path);
      if (stale()) return;
      // A fresh list, so "already exists" is about what is on the server now.
      await useDockerImages.getState().load(hostId);
      if (stale()) return;
      const fresh = useDockerImages.getState().byHost[hostId];
      const space = remote ? await api.dockerImageImportCheck(hostId, info.file_bytes, info.tar_bytes) : null;
      if (stale()) return;
      if (space?.problem) {
        setErr(space.problem);
        return;
      }
      const name = path.split(/[\\/]/).pop() ?? path;
      const clashes = overwrittenTags(info.tags, fresh?.images ?? [], info.tag_ids);
      const same = unchangedTags(info.tags, fresh?.images ?? [], info.tag_ids);
      const lines: string[] = [];
      lines.push(`${name}: ${formatBytes(info.file_bytes)}${info.gzip ? `, about ${formatBytes(info.tar_bytes)} unpacked` : ""}.`);
      lines.push(
        info.tags.length > 0
          ? `Images in this file: ${info.tags.join(", ")}.`
          : "This file has no image names: its images are loaded without a name and show as untagged.",
      );
      if (info.unreadable_names > 0) {
        lines.push(`${info.unreadable_names} ${info.unreadable_names === 1 ? "name" : "names"} in this file could not be read, so the images may get names that are not listed here.`);
      }
      for (const c of clashes) lines.push(overwriteWarning(c));
      if (same.length > 0) lines.push(`Already on ${where} as this same image: ${same.join(", ")}.`);
      if (remote) {
        lines.push(`The file is uploaded over SSH to ${space?.upload_dir ?? "the server"}, loaded into Docker, and the uploaded copy is deleted afterwards. Large files take a while and load the server's disk and network.`);
      } else {
        lines.push("Free disk space on this computer is not checked.");
      }
      if (space?.warning) lines.push(space.warning);
      if (fresh?.error) lines.push("The image list could not be refreshed, so names that already exist may be missing from the warnings above.");
      const tmp = `${space?.upload_dir ?? "/var/tmp"}/rookery-import-<id>.tar${info.gzip ? ".gz" : ""}`;
      const ok = await askConfirm({
        title: prod ? `Import images into PRODUCTION server ${host?.name}?` : `Import images into ${where}?`,
        body: lines.join(" "),
        preview: remote ? `upload ${name} to ${tmp}\n${docker()} load -i ${tmp}` : `docker load -i ${/\s/.test(path) ? `'${path}'` : path}`,
        confirmLabel: "Import",
        danger: clashes.length > 0,
        typeToConfirm: prod ? host?.name : undefined,
      });
      if (!ok || stale()) return;
      // What was confirmed travels with the request: the core refuses if the file is different by then.
      await api.dockerImagesImport({ host_id: hostId, path, file_bytes: info.file_bytes, tags: info.tags, tag_ids: info.tag_ids }, ok);
      // Progress shows under the header; the list reloads when the job ends.
    } catch (e) {
      setErr(asCoreError(e).message);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const loading = !d || (d.at === null && d.loading);
  const failedFirst = !!d?.error && images.length === 0;
  const sudoLink = remote && (
    <button className="underline" onClick={() => setDialog("sudo")}>
      Use sudo…
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 bg-bg p-3">
      <section aria-label="Images" className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-2.5">
          <DockerTabs value="images" onChange={onTab} />
          {d?.at && !failedFirst && (
            <span className="text-xs text-muted">
              {images.length} {images.length === 1 ? "image" : "images"} · {formatBytes(totalSize(images))}
            </span>
          )}
          {unusedCount > 0 && (
            <button
              aria-pressed={onlyUnused}
              onClick={() => setUnusedOnly(!onlyUnused)}
              className={clsx("h-6 rounded-full px-2.5 text-xs", onlyUnused ? "bg-accent-bg text-text" : "border border-line text-muted hover:text-text")}
            >
              Unused {unusedCount}
            </button>
          )}
          {d?.error && !failedFirst && (
            <span className="text-xs text-[#F7CB6A]">
              {d.error}
              {sudoLink && <> · {sudoLink}</>}
            </span>
          )}
          <label className="ml-auto flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-muted">
            <Search size={12} />
            <input aria-label="Filter images" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} className="w-32 bg-transparent text-xs text-text outline-none" />
          </label>
          <button
            aria-label="Refresh images"
            title="Refresh images"
            onClick={reload}
            disabled={!d || d.loading || !!busy}
            className="grid h-7 w-7 place-items-center rounded-md border border-line text-muted hover:text-text disabled:opacity-50"
          >
            {d?.loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          </button>
          <button
            onClick={() => void importFile()}
            disabled={!d?.at || failedFirst || !!busy || importing}
            title={importing ? "An import to this server is still running" : "Load images from a .tar or .tar.gz file made with docker save"}
            className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-muted hover:text-text disabled:opacity-50"
          >
            {busy === "import" ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} Import…
          </button>
          <button
            onClick={() => void cleanUp()}
            disabled={!d?.at || failedFirst || !!busy}
            title="Remove dangling or all unused images"
            className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-muted hover:text-text disabled:opacity-50"
          >
            {busy === "prune" ? <Loader2 size={12} className="animate-spin" /> : <Eraser size={12} />} Clean up…
          </button>
          {remote && <SudoButton hostId={hostId} onOpen={() => setDialog("sudo")} />}
        </div>
        <ImageExportStatus hostId={hostId} />
        <ImageImportStatus hostId={hostId} />
        {picked.length > 0 && (
          <div className="flex items-center gap-2 border-b border-line bg-panel2 px-3.5 py-1.5 text-xs">
            <span className="text-muted">
              {picked.length} selected · {formatBytes(totalSize(picked))}
            </span>
            <button className="text-accent" onClick={() => setSel(new Set())}>
              Clear
            </button>
            <span className="ml-auto flex items-center gap-2">
              <button
                onClick={() => void download()}
                disabled={!!busy}
                className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-muted hover:text-text disabled:opacity-50"
              >
                {busy === "download" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Download ({picked.length})
              </button>
              <button
                onClick={() => void remove()}
                disabled={!!busy}
                className="flex h-7 items-center gap-1.5 rounded-md border border-[#5A2D33] px-2 text-xs text-[#FFA8A8] hover:bg-[#33232A] disabled:opacity-50"
              >
                {busy === "delete" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Delete ({picked.length})
              </button>
            </span>
          </div>
        )}
        {err && <div className="flex items-start gap-2 border-b border-[#5A2D33] bg-[#33232A] px-3.5 py-2 text-xs text-[#FFA8A8]">
          <span className="min-w-0 flex-1 whitespace-pre-line break-words">{err}</span>
          <button aria-label="Dismiss" onClick={() => setErr(null)} className="flex-none text-[#FFA8A8]">
            <X size={12} />
          </button>
        </div>}
        {note && (
          <div className="flex items-center gap-2 border-b border-line bg-panel2 px-3.5 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate">{note}</span>
            <button aria-label="Dismiss" onClick={() => setNote(null)} className="text-muted hover:text-text">
              <X size={12} />
            </button>
          </div>
        )}

        {loading ? (
          <div className="grid flex-1 place-items-center text-muted">
            <span className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Loading images…
            </span>
          </div>
        ) : failedFirst ? (
          <div className="grid flex-1 place-items-center p-6">
            <div className="max-w-md text-center">
              <Box size={26} className="mx-auto mb-3 text-muted" />
              <p className="m-0 leading-relaxed text-muted">{d?.error}</p>
              <div className="mt-3 flex justify-center gap-2">
                {remote && (
                  <button className="flex items-center gap-1.5 rounded-md border border-accent-line bg-accent-bg px-3 py-1.5" onClick={() => setDialog("sudo")}>
                    <ShieldCheck size={13} className="text-accent" /> Use sudo…
                  </button>
                )}
                <button className="rounded-md border border-line px-3 py-1.5" onClick={() => useDockerImages.getState().forget(hostId)}>
                  Reload images
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="min-w-[640px]">
              <div className={clsx("grid items-center gap-x-3 px-3.5 py-2 text-[11px] tracking-wider text-muted uppercase", COLS)}>
                <input
                  ref={selectAll}
                  type="checkbox"
                  aria-label="Select all visible images"
                  title="Select all visible images"
                  checked={allShown}
                  disabled={shown.length === 0}
                  onChange={toggleAll}
                />
                <span>Image</span>
                <span>ID</span>
                <span className="text-right">Size</span>
                <span>Created</span>
                <span>Use</span>
              </div>
              {shown.map((i) => {
                const key = imageKey(i);
                const on = sel.has(key);
                return (
                  <div
                    key={key}
                    onClick={() => toggle(key)}
                    className={clsx("grid h-[42px] cursor-pointer items-center gap-x-3 border-b border-[#303A4E] px-3.5", COLS, on ? "bg-[#26385A]" : "hover:bg-panel2")}
                  >
                    <input type="checkbox" aria-label={`Select ${i.reference}`} checked={on} onChange={() => toggle(key)} onClick={(e) => e.stopPropagation()} />
                    <span className={clsx("truncate", isUntagged(i) ? "text-muted" : "font-medium")} title={isUntagged(i) ? (i.repository !== "<none>" ? `${i.repository} (no tag)` : "untagged") : imageName(i)}>
                      {imageName(i)}
                    </span>
                    <span className="truncate font-mono text-xs text-muted" title={i.id}>
                      {shortId(i.id)}
                    </span>
                    <span className="text-right font-mono text-xs tabular-nums">{formatBytes(i.size)}</span>
                    <span className="truncate text-xs text-muted" title={i.created_at ? new Date(i.created_at * 1000).toLocaleString() : undefined}>
                      {agoText(i.created_at)}
                    </span>
                    <span>
                      {!isUnused(i) ? (
                        <span title={`Used by: ${i.containers.join(", ")}`} className="inline-flex h-5 items-center rounded-full border border-accent-line bg-accent-bg px-2 text-[11px] text-text">
                          In use
                        </span>
                      ) : (
                        importedKeys.has(key) && (
                          <span title="Loaded by the last import" className="inline-flex h-5 items-center rounded-full border border-line px-2 text-[11px] text-muted">
                            Imported
                          </span>
                        )
                      )}
                    </span>
                  </div>
                );
              })}
              {images.length === 0 && <div className="px-4 py-6 text-center text-muted">No images.</div>}
              {images.length > 0 && shown.length === 0 && (
                <div className="px-4 py-6 text-center text-muted">
                  No images match{onlyUnused ? " the Unused filter" : ""}
                  {q.trim() ? ` “${q.trim()}”` : ""}.{" "}
                  <button
                    className="underline"
                    onClick={() => {
                      setQ("");
                      setUnusedOnly(false);
                    }}
                  >
                    Show all
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
      {dialog === "sudo" && <SudoDialog hostId={hostId} onClose={() => setDialog(null)} />}
    </div>
  );
}
