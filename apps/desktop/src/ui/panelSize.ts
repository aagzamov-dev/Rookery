export const HOST_LIST_MIN = 104;
export const HOST_LIST_MAX = 520;

export function clampPanelWidth(value: number, min: number, max: number, viewport = Infinity, viewportRatio = 1): number {
  const upper = Math.max(min, Math.min(max, viewport * viewportRatio));
  return Math.max(min, Math.min(upper, Number.isFinite(value) ? value : min));
}

export function clampSplitRatio(value: number): number {
  return Math.max(0.2, Math.min(0.8, Number.isFinite(value) ? value : 0.5));
}

export function storedNumber(key: string, fallback: number): number {
  try {
    const saved = localStorage.getItem(key);
    const value = saved === null ? NaN : Number(saved);
    return Number.isFinite(value) ? value : fallback;
  } catch { return fallback; }
}

export function saveNumber(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)); } catch {}
}
