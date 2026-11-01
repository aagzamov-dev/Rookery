// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { SqlOpened } from "../../ipc/bindings/SqlOpened";
const ipc = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock("../../ipc/api", () => ({ api: { sqlOpen: ipc.open, sqlClose: ipc.close }, asCoreError: (e: Error) => e }));
vi.mock("./SqlTab", () => ({ SqlTab: () => <div>Connected editor</div> }));
import { DbTab, tabPasswords } from "./DbTab";
import { useSql } from "../../stores/sql";
import { useTabs } from "../../stores/tabs";

it("closes late opens and reconnects correctly after StrictMode effect replay", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pending: ((opened: SqlOpened) => void)[] = [];
  ipc.open.mockImplementation(() => new Promise<SqlOpened>((resolve) => pending.push(resolve)));
  ipc.close.mockResolvedValue(undefined);
  useSql.setState({ sessions: {}, conns: [] });
  useTabs.setState({ deferred: {} });
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  const opened = (id: string): SqlOpened => ({ session_id: id, engine: "postgres", server_version: "test", read_only: false, database: "test", conn_key: "fixture" });
  try {
    await act(async () => root.render(<StrictMode><DbTab tab={{ id: "fixture", kind: "db", target: { kind: "url", url: "postgres://localhost/test" }, title: "test" }} active /></StrictMode>));
    expect(pending).toHaveLength(2);
    await act(async () => { pending[0](opened("stale")); pending[1](opened("live")); await Promise.resolve(); });
    expect(ipc.close).toHaveBeenCalledWith("stale");
    expect(useSql.getState().sessions.live).toBeDefined();
    expect(useSql.getState().sessions.stale).toBeUndefined();
    await act(async () => root.unmount());
    expect(ipc.close).toHaveBeenCalledWith("live");
  } finally { element.remove(); tabPasswords.clear(); vi.unstubAllGlobals(); }
});
