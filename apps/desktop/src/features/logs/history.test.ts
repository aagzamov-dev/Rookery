import { expect, it } from "vitest";
import { fileHistoryInRange, yesterdayRange } from "./history";

it("selects yesterday using local calendar midnights", () => {
  const { since, until } = yesterdayRange(new Date(2026, 10, 1, 17));
  expect(since).toEqual(new Date(2026, 9, 31));
  expect(until).toEqual(new Date(2026, 10, 1));
});

it("filters timestamped lines and continuations with an exclusive end", () => {
  const from = +new Date("2026-10-31T00:00:00Z");
  const until = +new Date("2026-11-01T00:00:00Z");
  expect(fileHistoryInRange(["orphan", "2026-10-30T23:59:59Z old", "2026-10-31T00:00:00Z first", "  stack trace", "2026-11-01T00:00:00Z new"], from, until)).toEqual({ lines: ["2026-10-31T00:00:00Z first", "  stack trace"], recognized: true });
  expect(fileHistoryInRange(["unstructured undated log"], from, until)).toEqual({ lines: [], recognized: false });
});

it("caps matching history after filtering out newer lines", () => {
  const lines = [...Array.from({ length: 2500 }, (_, i) => `2026-10-31T12:00:00Z old ${i}`), ...Array.from({ length: 3000 }, (_, i) => `2026-11-01T12:00:00Z new ${i}`)];
  const selected = fileHistoryInRange(lines, +new Date("2026-10-31T00:00:00Z"), +new Date("2026-11-01T00:00:00Z"));
  expect(selected.lines).toHaveLength(2000);
  expect(selected.lines[0]).toContain("old 500");
  expect(selected.lines.at(-1)).toContain("old 2499");
});
