import { describe, expect, it } from "vitest";
import type { DockerImage } from "../../ipc/bindings/DockerImage";
import { unchangedTags, importedImages, loadedLabel, normalizeRef, overwriteWarning, overwrittenTags, pinImported, agoText, exportFileName, filterImages, formatBytes, imageName, inUse, isUnused, sortNewest, totalSize, uniqueRefs, archivePath, imageKey } from "./images";

const img = (over: Partial<DockerImage>): DockerImage => ({
  id: "a".repeat(64),
  repository: "nginx",
  tag: "latest",
  reference: "nginx:latest",
  size: 100,
  created_at: 1000,
  containers: [],
  ...over,
});

describe("image list helpers", () => {
  const old = img({ id: "1".repeat(64), reference: "app:1", repository: "app", tag: "1", created_at: 100, size: 10 });
  const fresh = img({ id: "2".repeat(64), reference: "app:2", repository: "app", tag: "2", created_at: 300, size: 20, containers: ["web-1"] });
  const dangling = img({ id: "3".repeat(64), repository: "<none>", tag: "<none>", reference: "333333333333", created_at: 200, size: 5 });

  it("sorts newest first without touching the input", () => {
    const input = [old, fresh, dangling];
    expect(sortNewest(input).map((i) => i.created_at)).toEqual([300, 200, 100]);
    expect(input[0]).toBe(old);
  });

  it("filters unused images, dangling ones included", () => {
    expect(filterImages([old, fresh, dangling], "", true).map((i) => i.reference)).toEqual(["app:1", "333333333333"]);
    expect(isUnused(fresh)).toBe(false);
  });

  it("searches repository, tag and id", () => {
    const all = [old, fresh, dangling];
    expect(filterImages(all, "APP:2", false)).toEqual([fresh]);
    expect(filterImages(all, "latest", false)).toEqual([]);
    expect(filterImages(all, "sha256:3333", false)).toEqual([dangling]);
    expect(filterImages(all, "  ", false)).toHaveLength(3);
    expect(filterImages(all, "app", true)).toEqual([old]);
  });

  it("counts an image shown under several tags once in the total", () => {
    const tagged = [img({ reference: "a:1", size: 50 }), img({ reference: "a:2", size: 50 }), fresh];
    expect(totalSize(tagged)).toBe(70);
    expect(totalSize([])).toBe(0);
  });

  it("names untagged images and picks unique references", () => {
    expect(imageName(dangling)).toBe("untagged");
    expect(imageName(fresh)).toBe("app:2");
    expect(imageName(img({ repository: "repo", tag: "<none>" }))).toBe("repo");
    expect(uniqueRefs([old, old, fresh])).toEqual(["app:1", "app:2"]);
    expect(inUse([old, fresh])).toEqual([fresh]);
  });

  it("formats sizes and times", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(77_800_000)).toBe("77.8 MB");
    expect(formatBytes(1_500_000_000)).toBe("1.5 GB");
    expect(formatBytes(192_000_000)).toBe("192 MB");
    const now = Date.UTC(2026, 10, 20) ;
    expect(agoText(now / 1000 - 3 * 86400, now)).toBe("3 days ago");
    expect(agoText(now / 1000 - 86400, now)).toBe("1 day ago");
    expect(agoText(now / 1000 - 3 * 3600, now)).toBe("3 hours ago");
    expect(agoText(now / 1000 - 20, now)).toBe("just now");
    expect(agoText(now / 1000 - 400 * 86400, now)).toBe("1 year ago");
    expect(agoText(0, now)).toBe("unknown");
  });

  it("builds a safe default file name", () => {
    const d = new Date(2026, 10, 5);
    expect(exportFileName("prod web/1", false, d)).toBe("prod-web-1-images-20261105.tar");
    expect(exportFileName("", true, d)).toBe("server-images-20261105.tar.gz");
  });

  it("never invents a file name", () => {
    expect(archivePath("/x/a.tar", false)).toEqual({ path: "/x/a.tar", changed: false });
    expect(archivePath("/x/a.TAR", false)).toEqual({ path: "/x/a.TAR", changed: false });
    expect(archivePath("/x/a", false)).toHaveProperty("error");
    expect(archivePath("/x/a.tar.gz", false)).toHaveProperty("error");
    expect(archivePath("/x/a.tar.gz", true)).toEqual({ path: "/x/a.tar.gz", changed: false });
    expect(archivePath("/x/a.tgz", true)).toEqual({ path: "/x/a.tgz", changed: false });
    expect(archivePath("/x/a.gz", true)).toEqual({ path: "/x/a.tar.gz", changed: true });
    expect(archivePath("/x/a.GZ", true)).toEqual({ path: "/x/a.tar.gz", changed: true });
    expect(archivePath("/x/a.tar", true)).toHaveProperty("error");
    expect(archivePath("/x/a", true)).toHaveProperty("error");
  });

  it("keeps digest-only rows of different repositories apart", () => {
    const a = img({ repository: "reg/a", tag: "<none>", reference: "aaaaaaaaaaaa" });
    const b = img({ repository: "reg/b", tag: "<none>", reference: "aaaaaaaaaaaa" });
    expect(imageKey(a)).not.toBe(imageKey(b));
    expect(imageKey(a)).toBe(imageKey({ ...a }));
  });
});

describe("importing: names that would be taken over", () => {
  const web = img({ id: "1".repeat(64), repository: "myapp", tag: "latest", reference: "myapp:latest" });
  const api = img({ id: "2".repeat(64), repository: "registry.local:5000/team/api", tag: "v3", reference: "registry.local:5000/team/api:v3" });
  const dangling = img({ id: "3".repeat(64), repository: "<none>", tag: "<none>", reference: "333333333333" });
  const repoOnly = img({ id: "4".repeat(64), repository: "myapp", tag: "<none>", reference: "444444444444" });

  it("finds the archive names an image already has", () => {
    const r = overwrittenTags(["myapp:latest", "myapp:2", "registry.local:5000/team/api:v3"], [web, api, dangling]);
    expect(r.map((o) => o.tag)).toEqual(["myapp:latest", "registry.local:5000/team/api:v3"]);
    expect(r[0].existing).toBe(web);
  });

  it("says nothing for new names, untagged archives and untagged rows", () => {
    expect(overwrittenTags(["myapp:2"], [web])).toEqual([]);
    expect(overwrittenTags([], [web, api])).toEqual([]);
    expect(overwrittenTags(["myapp:<none>", "<none>:<none>"], [dangling, repoOnly])).toEqual([]);
    expect(overwrittenTags(["myapp:latest"], [])).toEqual([]);
  });

  it("tells each name once and ignores case-different names (names are case-sensitive)", () => {
    expect(overwrittenTags(["myapp:latest", "myapp:latest"], [web])).toHaveLength(1);
    expect(overwrittenTags(["MyApp:latest"], [web])).toEqual([]);
  });

  it("matches docker.io spellings of the same name", () => {
    expect(normalizeRef("docker.io/library/myapp:latest")).toBe("myapp:latest");
    expect(normalizeRef("docker.io/acme/web:1")).toBe("acme/web:1");
    expect(normalizeRef("library/a/b:1")).toBe("library/a/b:1");
    expect(overwrittenTags(["docker.io/library/myapp:latest"], [web])).toHaveLength(1);
  });

  it("treats a name as unchanged only when the proven id is the server's id", () => {
    const ids = [{ tag: "myapp:latest", ids: ["9".repeat(64), "1".repeat(64)] }];
    expect(overwrittenTags(["myapp:latest"], [web], ids)).toEqual([]);
    expect(unchangedTags(["myapp:latest"], [web], ids)).toEqual(["myapp:latest"]);
    // another image holds the name: still a warning
    const other = { ...web, id: "7".repeat(64) };
    expect(overwrittenTags(["myapp:latest"], [other], ids)).toHaveLength(1);
    expect(unchangedTags(["myapp:latest"], [other], ids)).toEqual([]);
    // ids proven for a different name do not count, and no ids (not verified) keep the warning
    expect(overwrittenTags(["myapp:latest"], [web], [{ tag: "other:1", ids: ["1".repeat(64)] }])).toHaveLength(1);
    expect(overwrittenTags(["myapp:latest"], [web], [])).toHaveLength(1);
    expect(unchangedTags(["myapp:latest"], [web])).toEqual([]);
    // a sha256: prefix on the server side and docker.io spellings still match
    expect(unchangedTags(["docker.io/library/myapp:latest"], [{ ...web, id: `sha256:${"1".repeat(64)}` }], ids)).toEqual(["myapp:latest"]);
  });

  it("keeps the warning for a name the core could not prove (e.g. the archive's two lists disagree)", () => {
    // The core leaves such a name out of tag_ids even though its id would match the server's image.
    const proven = [{ tag: "other:1", ids: ["1".repeat(64)] }];
    expect(overwrittenTags(["myapp:latest"], [web], proven).map((o) => o.tag)).toEqual(["myapp:latest"]);
    expect(unchangedTags(["myapp:latest"], [web], proven)).toEqual([]);
    expect(unchangedTags(["myapp:latest", "other:1"], [web, img({ id: "1".repeat(64), repository: "other", tag: "1", reference: "other:1" })], proven)).toEqual(["other:1"]);
  });

  it("words the warning with the name", () => {
    expect(overwriteWarning({ tag: "myapp:latest", existing: web })).toBe("myapp:latest already exists. Importing gives this name to the new image; the old one stays but becomes untagged.");
  });

  it("puts what docker load reported first", () => {
    const old = img({ id: "5".repeat(64), repository: "old", tag: "1", reference: "old:1", created_at: 9000 });
    const list = [old, web, api, dangling];
    expect(importedImages(list, ["myapp:latest", `sha256:${"3".repeat(12)}`]).map((i) => i.reference)).toEqual(["myapp:latest", "333333333333"]);
    expect(pinImported(list, ["registry.local:5000/team/api:v3"]).map((i) => i.reference)).toEqual(["registry.local:5000/team/api:v3", "old:1", "myapp:latest", "333333333333"]);
    expect(pinImported(list, [])).toBe(list);
    expect(pinImported(list, ["nothing:here"])).toEqual(list);
  });

  it("labels untagged loads by id", () => {
    expect(loadedLabel("myapp:latest")).toBe("myapp:latest");
    expect(loadedLabel(`sha256:${"ab".repeat(32)}`)).toBe("untagged image abababababab");
  });
});
