import { create } from "zustand";
import type { TableCellUpdate } from "../../ipc/bindings/TableCellUpdate";
import { useSql } from "../../stores/sql";
import { kindOf } from "./classify";
import { splitSql } from "./split";

export type TransactionChange =
  | { kind: "cell"; update: TableCellUpdate }
  | { kind: "sql"; queryId: string; statement: number; sql: string; affected: number | null };

interface ReviewState {
  bySession: Record<string, TransactionChange[]>;
  recordCell: (sessionId: string, update: TableCellUpdate) => void;
}

export const useTransactionReview = create<ReviewState>((set) => ({
  bySession: {},
  recordCell: (sessionId, update) => set((s) => ({
    bySession: { ...s.bySession, [sessionId]: [...(s.bySession[sessionId] ?? []), { kind: "cell", update }] },
  })),
}));

const unsubscribe = useSql.subscribe((state, previous) => {
  const next = { ...useTransactionReview.getState().bySession };
  let changed = false;
  for (const sessionId of Object.keys(next)) {
    const session = state.sessions[sessionId];
    if (!session || session.state === "lost" || session.state === "closed" || (previous.sessions[sessionId]?.txOpen && !session.txOpen)) {
      delete next[sessionId];
      changed = true;
    }
  }
  for (const run of Object.values(state.runs)) {
    const old = previous.runs[run.queryId];
    const session = state.sessions[run.sessionId];
    if (old === run || !session?.txOpen) continue;
    const statements = splitSql(run.sql, session.engine === "mysql" ? "mysql" : "postgres").statements;
    const completed = run.sets.filter((s) => s.done && !s.error);
    const boundary = completed.reduce((last, s) => {
      const statement = statements[s.stmt];
      return statement && kindOf(statement) === "tx" ? Math.max(last, s.stmt) : last;
    }, -1);
    for (const result of completed) {
      const statement = statements[result.stmt];
      if (!statement || result.stmt <= boundary || old?.sets.some((s) => s.index === result.index && s.done)) continue;
      const kind = kindOf(statement);
      if (kind !== "write" && kind !== "ddl" && statement.words[0]?.toUpperCase() !== "ROLLBACK") continue;
      const entries = next[run.sessionId] ?? [];
      if (entries.some((entry) => entry.kind === "sql" && entry.queryId === run.queryId && entry.statement === result.stmt)) continue;
      next[run.sessionId] = [...entries, { kind: "sql", queryId: run.queryId, statement: result.stmt, sql: statement.text, affected: result.affected }];
      changed = true;
    }
  }
  if (changed) useTransactionReview.setState({ bySession: next });
});

if (import.meta.hot) import.meta.hot.dispose(unsubscribe);
