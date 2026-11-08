import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { archiveKind, copyName, extractName, nameError, within } from "./fileActions";

describe("file names", () => {
  it("accepts names without an extension and dot files", () => {
    for (const name of ["Dockerfile", "Makefile", ".env", "a.b.c", "with space", "файл"]) expect(nameError(name)).toBeNull();
  });
  it("rejects separators, dot names and edge spaces", () => {
    for (const name of ["", ".", "..", "a/b", "a\\b", "a\0b", " lead", "trail "]) expect(nameError(name)).not.toBeNull();
  });
  it("names copies before the extension", () => {
    expect(copyName("report.txt")).toBe("report copy.txt");
    expect(copyName("Dockerfile")).toBe("Dockerfile copy");
    expect(copyName(".env")).toBe(".env copy");
  });
});

describe("archives", () => {
  it("detects zip and tar.gz", () => {
    expect(archiveKind("a.ZIP")).toBe("zip");
    expect(archiveKind("a.tar.gz")).toBe("targz");
    expect(archiveKind("a.tgz")).toBe("targz");
    expect(archiveKind("a.gz")).toBeNull();
  });
  it("extracts into a folder named after the archive", () => {
    expect(extractName("site.zip")).toBe("site");
    expect(extractName("backup.tar.gz")).toBe("backup");
    expect(extractName(".zip")).toBe("extracted");
  });
});

it("within matches the path itself and children only", () => {
  expect(within("/srv/app", "/srv/app")).toBe(true);
  expect(within("/srv/app/x", "/srv/app")).toBe(true);
  expect(within("/srv/app2", "/srv/app")).toBe(false);
});

it("views inside a renamed folder follow it; inside a deleted one they go up", async () => {
  const { relocate } = await import("./fileActions");
  expect(relocate("/srv/app/src", { from: "/srv/app", to: "/srv/web" })).toBe("/srv/web/src");
  expect(relocate("/srv/app", { from: "/srv/app", to: null })).toBe("/srv");
  expect(relocate("/srv/app2", { from: "/srv/app", to: null })).toBeNull();
});
