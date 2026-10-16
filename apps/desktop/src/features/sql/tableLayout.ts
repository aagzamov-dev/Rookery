// Per-table grid layout (column order, hidden columns, widths, page size), kept on this
// device only (`ui.sql.tables` is in LOCAL_SETTING_KEYS). Keyed `<connKey>|<schema>.<table>`.
import { create } from "zustand";
import { api } from "../../ipc/api";

export interface TableLayout {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
  pageSize: number;
  at: number;
}

const KEY = "ui.sql.tables";
const MAX_TABLES = 300;
export const PAGE_SIZES = [100, 200, 500, 1000];
export const EMPTY_LAYOUT: TableLayout = { order: [], hidden: [], widths: {}, pageSize: 200, at: 0 };

interface LayoutState {
  layouts: Record<string, TableLayout>;
  loaded: boolean;
  load: () => Promise<void>;
  update: (key: string, patch: Partial<TableLayout>) => void;
  reset: (key: string) => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
const persist = (layouts: Record<string, TableLayout>) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    // Keep the most recently used tables only.
    const keep = Object.entries(layouts)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_TABLES);
    void api.settingSet(KEY, Object.fromEntries(keep)).catch(() => {});
  }, 600);
};

export const useTableLayouts = create<LayoutState>((set, get) => ({
  layouts: {},
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    const saved = await api.settingGet<Record<string, TableLayout>>(KEY).catch(() => null);
    set((s) => ({ layouts: { ...(saved ?? {}), ...s.layouts }, loaded: true }));
  },
  update: (key, patch) => {
    const layouts = { ...get().layouts, [key]: { ...EMPTY_LAYOUT, ...get().layouts[key], ...patch, at: Date.now() } };
    set({ layouts });
    persist(layouts);
  },
  reset: (key) => {
    const layouts = { ...get().layouts };
    delete layouts[key];
    set({ layouts });
    persist(layouts);
  },
}));

/** Display order of the result's columns: saved order first, new columns after; hidden ones left out. */
export function columnOrder(names: string[], layout: TableLayout): number[] {
  const index = new Map(names.map((n, i) => [n, i]));
  const seen = new Set<string>();
  const out: number[] = [];
  for (const n of [...layout.order, ...names]) {
    if (seen.has(n) || !index.has(n)) continue;
    seen.add(n);
    if (!layout.hidden.includes(n)) out.push(index.get(n)!);
  }
  return out;
}

/** Move a column from one display position to another; returns the new saved order (names). */
export function moveColumn(names: string[], order: number[], from: number, to: number): string[] {
  const shown = order.map((i) => names[i]);
  const [m] = shown.splice(from, 1);
  shown.splice(to, 0, m);
  // Hidden columns keep their relative place at the end.
  return [...shown, ...names.filter((n) => !shown.includes(n))];
}
