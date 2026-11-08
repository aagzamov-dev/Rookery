import { expect, it } from "vitest";
import { fitViews } from "./fitViews";

const w = [90, 100, 60, 70, 70, 50, 70, 90, 80, 100, 60, 80]; // 12 views

it("shows everything when it fits", () => {
  expect(fitViews(w, 2000, 1, 36)).toHaveLength(12);
});

it("keeps a prefix and always the active view, in order", () => {
  expect(fitViews(w, 400, 1, 36)).toEqual([0, 1, 2, 3]);
  // Active view far right: it stays, the prefix shrinks to make room.
  expect(fitViews(w, 400, 10, 36)).toEqual([0, 1, 2, 10]);
  // Very narrow: only the active one.
  expect(fitViews(w, 50, 3, 36)).toEqual([3]);
});
