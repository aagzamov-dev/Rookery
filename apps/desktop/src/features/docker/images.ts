// Pure helpers for the Docker Images tab (list order, filters, totals, labels).
import type { DockerImage } from "../../ipc/bindings/DockerImage";
import type { ImageTagIds } from "../../ipc/bindings/ImageTagIds";

/** One list row: an image id can appear once per tag. */
export const imageKey = (i: DockerImage) => `${i.id}|${i.repository}|${i.tag}`;

export const isUntagged = (i: DockerImage) => i.repository === "<none>" || i.tag === "<none>";

/** Newest first; equal times keep a stable order by reference. */
export function sortNewest(images: DockerImage[]): DockerImage[] {
  return [...images].sort((a, b) => b.created_at - a.created_at || a.reference.localeCompare(b.reference));
}

/** No container (running or stopped) uses it; dangling images are included. */
export const isUnused = (i: DockerImage) => i.containers.length === 0;

/** Search in repository, tag and id (the id also matches by prefix with or without `sha256:`). */
export function filterImages(images: DockerImage[], query: string, unusedOnly: boolean): DockerImage[] {
  const q = query.trim().toLowerCase().replace(/^sha256:/, "");
  return images.filter((i) => {
    if (unusedOnly && !isUnused(i)) return false;
    if (!q) return true;
    return i.repository.toLowerCase().includes(q) || i.tag.toLowerCase().includes(q) || `${i.repository}:${i.tag}`.toLowerCase().includes(q) || i.id.toLowerCase().includes(q);
  });
}

/** Disk size of the images: an image shown under several tags counts once. */
export function totalSize(images: DockerImage[]): number {
  const seen = new Set<string>();
  let sum = 0;
  for (const i of images) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    sum += i.size;
  }
  return sum;
}

export const shortId = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);

/** `repository:tag`, or "untagged" for images without one. */
export const imageName = (i: DockerImage) => (isUntagged(i) ? (i.repository !== "<none>" ? i.repository : "untagged") : `${i.repository}:${i.tag}`);

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n;
  let u = -1;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

/** "3 days ago" for a unix time in seconds. */
export function agoText(createdAt: number, now = Date.now()): string {
  if (!createdAt) return "unknown";
  const s = Math.max(0, Math.floor(now / 1000 - createdAt));
  const units: [number, string][] = [
    [365 * 86400, "year"],
    [30 * 86400, "month"],
    [7 * 86400, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [secs, name] of units) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

const two = (n: number) => String(n).padStart(2, "0");

/** `<host>-images-<yyyymmdd>.tar` (or `.tar.gz`), safe as a file name. */
export function exportFileName(hostName: string, gzip: boolean, d = new Date()): string {
  const host = hostName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
  return `${host}-images-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}.${gzip ? "tar.gz" : "tar"}`;
}

/** Docker refuses to remove images that containers use: which of the chosen ones are those. */
export function inUse(images: DockerImage[]): DockerImage[] {
  return images.filter((i) => !isUnused(i));
}

/** Unique `docker rmi` / `docker save` references of the chosen rows. */
export const uniqueRefs = (images: DockerImage[]): string[] => [...new Set(images.map((i) => i.reference))];

/**
 * The file to write for what the save dialog returned, never invented silently:
 * - tar: must end in `.tar`;
 * - gzip: `.tar.gz` / `.tgz` as chosen; a bare `.gz` becomes `.tar.gz` (`changed`, so the caller
 *   checks that this file does not exist, the OS dialog did not ask about it);
 * - anything else is an error.
 */
export function archivePath(path: string, gzip: boolean): { path: string; changed: boolean } | { error: string } {
  const p = path.toLowerCase();
  if (!gzip) return p.endsWith(".tar") ? { path, changed: false } : { error: "Name the file with a .tar ending, or choose Save .tar.gz." };
  if (p.endsWith(".tar.gz") || p.endsWith(".tgz")) return { path, changed: false };
  if (p.endsWith(".gz")) return { path: `${path.slice(0, -3)}.tar.gz`, changed: true };
  return { error: "Name the file with a .tar.gz ending." };
}

/** `docker.io/library/nginx:latest` → `nginx:latest`, the way `docker image ls` writes names. */
export function normalizeRef(ref: string): string {
  let r = ref.trim().replace(/^(?:index\.)?docker\.io\//, "");
  if (/^library\/[^/]+$/.test(r)) r = r.slice("library/".length);
  return r;
}

/** An imported name that a different image on the server already has. */
export interface Overwrite {
  tag: string;
  existing: DockerImage;
}

/** The names of the archive that images on the server already have, each once, with the existing row. */
function takenNames(tags: string[], images: DockerImage[]): Overwrite[] {
  const byName = new Map<string, DockerImage>();
  for (const i of images) if (!isUntagged(i) && !byName.has(`${i.repository}:${i.tag}`)) byName.set(`${i.repository}:${i.tag}`, i);
  const seen = new Set<string>();
  const out: Overwrite[] = [];
  for (const raw of tags) {
    const tag = normalizeRef(raw);
    const existing = byName.get(tag);
    if (existing && !seen.has(tag)) {
      seen.add(tag);
      out.push({ tag, existing });
    }
  }
  return out;
}

/**
 * The server's image is the very image the archive carries. The core only lists ids for a name when the
 * archive's own lists agree about it and every pairing was proven by hashing the file; a name without
 * an entry (forged, disagreeing or unverifiable) is never "unchanged".
 */
const isSameImage = (o: Overwrite, tagIds: ImageTagIds[]): boolean => {
  const ids = tagIds.filter((t) => normalizeRef(t.tag) === o.tag).flatMap((t) => t.ids);
  return ids.includes(o.existing.id.replace(/^sha256:/, ""));
};

/**
 * Which of the archive's names are taken by a DIFFERENT image already on the server (untagged rows
 * have no name to take). A name whose server image is verified to be the same one is not here: see
 * `unchangedTags`. Without verified ids every taken name counts, the safe side.
 */
export function overwrittenTags(tags: string[], images: DockerImage[], tagIds: ImageTagIds[] = []): Overwrite[] {
  return takenNames(tags, images).filter((o) => !isSameImage(o, tagIds));
}

/** Names the server already has as exactly this image: importing changes nothing for them. */
export function unchangedTags(tags: string[], images: DockerImage[], tagIds: ImageTagIds[] = []): string[] {
  return takenNames(tags, images).filter((o) => isSameImage(o, tagIds)).map((o) => o.tag);
}

export const overwriteWarning = (o: Overwrite): string => `${o.tag} already exists. Importing gives this name to the new image; the old one stays but becomes untagged.`;

/** What `docker load` reported for one image: a name, or `sha256:<id>` for an untagged image. */
export const loadedLabel = (loaded: string): string => (loaded.startsWith("sha256:") ? `untagged image ${shortId(loaded)}` : loaded);

const isLoaded = (i: DockerImage, loaded: string[]): boolean =>
  loaded.some((l) => (l.startsWith("sha256:") ? i.id.startsWith(l.slice("sha256:".length)) : !isUntagged(i) && `${i.repository}:${i.tag}` === normalizeRef(l)));

/** Rows `docker load` just reported, in the list's order. */
export const importedImages = (images: DockerImage[], loaded: string[]): DockerImage[] => images.filter((i) => isLoaded(i, loaded));

/** The imported rows first (in list order), then the rest: a new import is not lost among older-built images. */
export function pinImported(images: DockerImage[], loaded: string[]): DockerImage[] {
  if (loaded.length === 0) return images;
  const mine = importedImages(images, loaded);
  const ids = new Set(mine.map(imageKey));
  return [...mine, ...images.filter((i) => !ids.has(imageKey(i)))];
}
