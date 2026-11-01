export const HISTORY_LINES = 2000;
export const HISTORY_BYTES = 2 * 1024 * 1024;

export function yesterdayRange(now = new Date()): { since: Date; until: Date } {
  const until = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const since = new Date(until);
  since.setDate(since.getDate() - 1);
  return { since, until };
}

export function fileHistoryInRange(lines: string[], since: number, until: number): { lines: string[]; recognized: boolean } {
  let timestamp: number | null = null;
  let recognized = false;
  const selected: string[] = [];
  for (const line of lines) {
    const match = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(line);
    if (match) {
      const parsed = Date.parse(match[1].replace(" ", "T"));
      timestamp = Number.isFinite(parsed) ? parsed : null;
      recognized ||= timestamp !== null;
    }
    if (timestamp !== null && timestamp >= since && timestamp < until) selected.push(line);
  }
  return { lines: selected.slice(-HISTORY_LINES), recognized };
}

export function dateInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
