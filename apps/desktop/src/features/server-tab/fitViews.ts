/** Which views fit: all of them, else a prefix plus the active one (it never hides in the ⋯ menu). */
export function fitViews(widths: number[], avail: number, active: number, more: number): number[] {
  const all = widths.map((_, i) => i);
  if (widths.reduce((a, b) => a + b, 0) <= avail) return all;
  let used = more + (widths[active] ?? 0);
  const shown: number[] = [];
  for (const i of all) {
    if (i === active) continue;
    if (used + widths[i] > avail) break;
    used += widths[i];
    shown.push(i);
  }
  if (active >= 0) shown.push(active);
  return shown.sort((a, b) => a - b);
}
