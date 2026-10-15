export function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export const rate = (n: number | null | undefined) => (n == null ? "—" : `${bytes(n)}/s`);

export const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n)}%`);

export function uptime(s: number | null | undefined): string {
  if (!s) return "—";
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d`;
  const h = Math.floor(s / 3600);
  if (h > 0) return `${h}h`;
  return `${Math.floor(s / 60)}m`;
}
