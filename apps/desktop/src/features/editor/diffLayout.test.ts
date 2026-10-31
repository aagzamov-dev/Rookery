import { expect, it, vi } from "vitest";
import { applyDiffRatio } from "./diffLayout";

it("resizes existing pane DOM without replacing document, selection, history or scroll state", () => {
  const pane = () => ({ dom: { parentElement: { style: { flex: "1 1 0%" } } }, requestMeasure: vi.fn(), state: { text: "unsaved draft", selection: 7, history: ["previous draft"] }, scrollTop: 240 });
  const view = { a: pane(), b: pane() };
  const original = view.b;
  const state = original.state;
  applyDiffRatio(view, 0.35);
  expect(view.a.dom.parentElement.style.flex).toBe("0.35 1 0%");
  expect(view.b.dom.parentElement.style.flex).toBe("0.65 1 0%");
  expect(view.b).toBe(original);
  expect(view.b.state).toBe(state);
  expect(view.b.state).toEqual({ text: "unsaved draft", selection: 7, history: ["previous draft"] });
  expect(view.b.scrollTop).toBe(240);
  expect(view.a.requestMeasure).toHaveBeenCalledTimes(1);
  expect(view.b.requestMeasure).toHaveBeenCalledTimes(1);
});
