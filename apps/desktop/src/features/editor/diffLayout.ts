interface Pane {
  dom: { parentElement: { style: { flex: string } } | null };
  requestMeasure: () => void;
}

export function applyDiffRatio(view: { a: Pane; b: Pane }, ratio: number): void {
  const left = view.a.dom.parentElement;
  const right = view.b.dom.parentElement;
  if (left) left.style.flex = `${ratio} 1 0%`;
  if (right) right.style.flex = `${1 - ratio} 1 0%`;
  view.a.requestMeasure();
  view.b.requestMeasure();
}
