import { afterEach, expect, it, vi } from "vitest";
import { clampPanelWidth, clampSplitRatio, HOST_LIST_MAX, HOST_LIST_MIN, saveNumber, storedNumber } from "./panelSize";

afterEach(() => vi.unstubAllGlobals());

it("keeps panel widths within configurable bounds and the viewport cap", () => {
  expect(clampPanelWidth(20, 180, 480, 1200, 0.45)).toBe(180);
  expect(clampPanelWidth(700, 180, 480, 800, 0.45)).toBe(360);
  expect(clampPanelWidth(104, HOST_LIST_MIN, HOST_LIST_MAX)).toBe(104);
  expect(clampPanelWidth(10, HOST_LIST_MIN, HOST_LIST_MAX)).toBe(104);
  expect(clampPanelWidth(900, HOST_LIST_MIN, HOST_LIST_MAX)).toBe(520);
  expect(clampPanelWidth(NaN, 180, 480)).toBe(180);
  expect(clampPanelWidth(480, 180, 428 - 240, 960, 0.5)).toBe(188);
});

it("persists and restores divider values and survives unavailable storage", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  expect(storedNumber("ui.panel.git-changes", 300)).toBe(300);
  saveNumber("ui.panel.git-changes", 216);
  saveNumber("ui.split.git-diff", 0.64);
  expect(storedNumber("ui.panel.git-changes", 300)).toBe(216);
  expect(storedNumber("ui.split.git-diff", 0.5)).toBe(0.64);
  values.set("broken", "not a number");
  expect(storedNumber("broken", 252)).toBe(252);
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
  expect(storedNumber("anything", 300)).toBe(300);
  expect(() => saveNumber("anything", 300)).not.toThrow();
});

it("keeps both diff panes visible and resets invalid ratios safely", () => {
  expect(clampSplitRatio(0)).toBe(0.2);
  expect(clampSplitRatio(1)).toBe(0.8);
  expect(clampSplitRatio(0.63)).toBe(0.63);
  expect(clampSplitRatio(NaN)).toBe(0.5);
});
