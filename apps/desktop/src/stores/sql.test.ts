import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../ipc/api", () => ({ api: {} }));
import { useSql } from "./sql";
import type { CoreEvent } from "../ipc/bindings/CoreEvent";
const event = (id: string): Extract<CoreEvent, { type: "sql_result" }> => ({
  type: "sql_result", query_id: id, index: 0, stmt: 0, columns: null, rows: [["1"]], done: false,
  affected: null, elapsed_ms: null, truncated: false, error: null, error_pos: null, notice: null, finished: false,
});
const start = (id: string) => useSql.getState().startRun({ queryId: id, sessionId: "session", sql: "select 1", offset: 0, rowLimit: 100 });
beforeEach(() => useSql.setState({ sessions: {}, runs: {} }));
describe("SQL result lifecycle", () => {
  it("retains events arriving before invoke returns", () => {
    useSql.getState().onResult(event("early"));
    useSql.getState().onResult({ ...event("early"), rows: [], finished: true });
    start("early");
    expect(useSql.getState().runs.early.finished).toBe(true);
    expect(useSql.getState().runs.early.sets[0].rows).toEqual([["1"]]);
  });
  it("marks overflowing early delivery incomplete and ignores late chunks", () => {
    for (let i = 0; i < 100; i++) useSql.getState().onResult({ ...event("overflow"), notice: "server notice" });
    start("overflow");
    const run = useSql.getState().runs.overflow;
    expect(run.finished).toBe(true);
    expect(run.sets[0].error).toContain("overflowed");
    useSql.getState().onResult(event("overflow"));
    expect(useSql.getState().runs.overflow.sets[0].rows).toEqual([]);
  });
  it("releases results when the owning session closes", () => {
    start("closed");
    useSql.getState().onResult(event("closed"));
    useSql.getState().forgetSession("session");
    useSql.getState().onResult(event("closed"));
    expect(useSql.getState().runs).toEqual({});
  });
});
it("ignores a status snapshot older than the latest session event", () => {
  useSql.getState().opened({ session_id: "session", engine: "postgres", server_version: "16", read_only: true, database: "test", conn_key: "test" });
  const state: Extract<CoreEvent, { type: "sql_session" }> = { type: "sql_session", revision: 2, session_id: "session", state: "lost", tx_open: false, tx_rows: 0, read_only: true, protected: true, writes_until: null, database: "test", message: "Connection lost" };
  useSql.getState().onSession(state);
  useSql.getState().onSession({ ...state, revision: 1, state: "connected", tx_open: true });
  expect(useSql.getState().sessions.session.state).toBe("lost");
  expect(useSql.getState().sessions.session.txOpen).toBe(false);
});
