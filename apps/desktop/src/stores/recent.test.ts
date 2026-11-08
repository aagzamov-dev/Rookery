import { expect, it } from "vitest";
import { useRecent } from "./recent";

it("keeps the newest first, unique, and follows renames and deletes", () => {
  const r = useRecent.getState();
  r.addFile("h", "/a/x");
  r.addFile("h", "/a/y");
  r.addFile("h", "/a/x");
  expect(useRecent.getState().files.h).toEqual(["/a/x", "/a/y"]);
  r.addFolder("h", "/a");
  r.move("h", "/a", "/b");
  expect(useRecent.getState().files.h).toEqual(["/b/x", "/b/y"]);
  expect(useRecent.getState().folders.h).toEqual(["/b"]);
  r.move("h", "/b/x", null);
  expect(useRecent.getState().files.h).toEqual(["/b/y"]);
});
