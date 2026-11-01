import { expect, it, vi } from "vitest";
vi.mock("../../ipc/api", () => ({ api: {} }));
import { joinPath, parentPath } from "../../stores/files";
import { crumbs } from "../editor/lang";
import { isAbsolutePath, normalizeLocalPath } from "./target";

it("navigates drive and UNC roots while preserving literal POSIX backslashes", () => {
  expect(parentPath("C:/")).toBe("C:/");
  expect(parentPath("C:/Users")).toBe("C:/");
  expect(parentPath("C:\\Users\\person")).toBe("C:/Users");
  expect(parentPath("//server/share/folder")).toBe("//server/share/");
  expect(parentPath("\\\\server\\share\\folder")).toBe("//server/share/");
  expect(joinPath("C:/", "folder")).toBe("C:/folder");
  expect(crumbs("C:/Users/person")).toEqual([["C:/", "C:/"], ["Users", "C:/Users"], ["person", "C:/Users/person"]]);
  expect(crumbs("//server/share/folder")).toEqual([["//server/share/", "//server/share/"], ["folder", "//server/share/folder"]]);
  expect(parentPath("/srv/a\\b/file")).toBe("/srv/a\\b");
  expect(crumbs("/srv/a\\b/file")).toContainEqual(["a\\b", "/srv/a\\b"]);
  expect(normalizeLocalPath("/srv/a\\b")).toBe("/srv/a\\b");
  expect(isAbsolutePath("C:\\Users")).toBe(true);
  expect(isAbsolutePath("C:relative")).toBe(false);
});
