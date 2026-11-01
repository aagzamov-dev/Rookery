// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseFileInfo } from "../../ipc/bindings/DatabaseFileInfo";
import type { DatabaseJob } from "../../ipc/bindings/DatabaseJob";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../../stores/dialogs", () => ({ askConfirm: mocks.confirm }));
import { DatabaseFiles } from "./DatabaseFiles";
import { tableKey, tableTotals } from "./dumpSelection";
import { useSql } from "../../stores/sql";
import { useDatabaseFiles } from "../../stores/databaseFiles";

const details: DatabaseFileInfo = {
  target: "test-user@127.0.0.1:5432/shop", database: "shop", engine: "postgres", production: false, server_files: false,
  tables: [{ schema: "public", name: "users", kind: "r", data_bytes: 1024 * 1024, index_bytes: 512 * 1024 }, { schema: "public", name: "audit", kind: "r", data_bytes: 4 * 1024 * 1024, index_bytes: 1024 * 1024 }],
};
let root: Root;
let element: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockReset().mockImplementation(async (command: string) => command === "database_file_info" ? details : command === "database_file_start" ? "job" : []);
  mocks.confirm.mockReset().mockResolvedValue(true);
  useDatabaseFiles.setState({ jobs: {} });
  useSql.setState({ sessions: {} });
  useSql.getState().opened({ session_id: "session", engine: "postgres", server_version: "PostgreSQL 16", read_only: false, database: "shop", conn_key: "fixture" }, "tab");
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  await act(async () => root.render(<DatabaseFiles sessionId="session" enabled />));
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function button(label: string, last = false) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((node) => node.textContent?.trim() === label);
  const found = last ? buttons.at(-1) : buttons[0]; expect(found).toBeDefined(); return found!;
}
async function click(label: string, last = false) {
  if (["Export", "Import", "Backups"].includes(label) && !document.querySelector('[role="dialog"]')) {
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="More SQL actions"]')!.click());
  }
  await act(async () => button(label, last).click());
}
async function input(selector: string, value: string) {
  const node = document.querySelector<HTMLInputElement>(selector); expect(node).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node!.dispatchEvent(new Event("input", { bubbles: true }));
    node!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function calls(command: string) { return mocks.invoke.mock.calls.filter(([name]) => name === command); }

it("makes no requests while closed, and reads table sizes only for an explicit Export", async () => {
  expect(mocks.invoke).not.toHaveBeenCalled();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="More SQL actions"]')!.click());
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
  await act(async () => button("Export").click());
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(calls("database_file_info")[0][1]).toEqual({ sessionId: "session", includeTables: true });
  expect(document.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(2);
  expect(document.body.textContent).toContain("selected data + indexes ≈ 6.5 MB");
  await click("Close"); await click("Import");
  expect(calls("database_file_info")[1][1]).toEqual({ sessionId: "session", includeTables: false });
  await click("Close"); await click("Backups");
  expect(calls("database_file_info")[2][1]).toEqual({ sessionId: "session", includeTables: false });
  expect(calls("database_backups")).toHaveLength(1);
});

it("exports exact reviewed modes and Clear / Select all affect every table", async () => {
  await click("Export"); await click("Clear");
  expect(document.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(0);
  await click("Select all");
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Export mode for public.audit"]')!;
  await act(async () => { select.value = "structure"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await input('input[placeholder="Choose a file…"]', "/tmp/shop.dump");
  expect(button("Export", true).disabled).toBe(false);
  await click("Export", true);
  expect(calls("database_file_start")).toHaveLength(1);
  expect(calls("database_file_start")[0][1]).toEqual({ sessionId: "session", confirmed: false, operation: { kind: "export", file: { location: "local", path: "/tmp/shop.dump" }, tables: [{ schema: "public", name: "users", mode: "data" }, { schema: "public", name: "audit", mode: "structure" }] } });
  expect(calls("sql_run")).toHaveLength(0);
});

it("requires trusted input, edit mode and PROD confirmation; cancelling sends no import", async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === "database_file_info" ? { ...details, production: true } : []);
  await click("Import"); await input('input[placeholder="Choose a file…"]', "/tmp/trusted.sql");
  expect(button("Import", true).disabled).toBe(true);
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  mocks.confirm.mockResolvedValueOnce(false);
  await click("Import", true);
  expect(calls("database_file_start")).toHaveLength(0);
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ typeToConfirm: "shop", body: expect.stringContaining(details.target) }));
  await click("Import", true);
  expect(calls("database_file_start")[0][1]).toMatchObject({ confirmed: true, operation: { kind: "import" } });
  await act(async () => useSql.setState((state) => ({ sessions: { ...state.sessions, session: { ...state.sessions.session, readOnly: true } } })));
  expect(button("Import", true).disabled).toBe(true);
});

it("does not continue metadata requests after hiding a tab during status loading", async () => {
  let resolve!: (jobs: DatabaseJob[]) => void;
  mocks.invoke.mockImplementation((command: string) => command === "database_file_status" ? new Promise<DatabaseJob[]>((done) => { resolve = done; }) : Promise.resolve(details));
  await click("Export");
  await act(async () => root.render(<DatabaseFiles sessionId="session" enabled={false} />));
  await act(async () => resolve([]));
  expect(calls("database_file_info")).toHaveLength(0);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("does not load backups after a pending context request when the modal closes", async () => {
  let resolve!: (info: DatabaseFileInfo) => void;
  mocks.invoke.mockImplementation((command: string) => command === "database_file_info" ? new Promise<DatabaseFileInfo>((done) => { resolve = done; }) : Promise.resolve([]));
  await click("Backups");
  await click("Close");
  await act(async () => resolve(details));
  expect(calls("database_backups")).toHaveLength(0);
});

it("uses pushed progress, local elapsed-time updates and explicit cancellation without polling", async () => {
  vi.useFakeTimers(); await click("Export");
  const job: DatabaseJob = { id: "running", session_id: "session", state: "running", stage: "Native export", bytes: 2048, total: null, elapsed_ms: 0, started_at: Date.now(), error: null, log: ["[0.0s] running · Native export"] };
  await act(async () => useDatabaseFiles.getState().received(job));
  const count = mocks.invoke.mock.calls.length;
  await act(async () => vi.advanceTimersByTime(2000));
  expect(mocks.invoke.mock.calls).toHaveLength(count);
  expect(document.body.textContent).toContain("2.0 s");
  await click("Cancel job"); expect(calls("database_file_cancel")[0][1]).toEqual({ jobId: "running" });
  await click("Close · job continues");
  await act(async () => vi.advanceTimersByTime(2000));
  expect(calls("database_file_status")).toHaveLength(1);
});

it("counts only data-selected storage and keeps dotted identifiers distinct", () => {
  expect(tableKey({ schema: "a.b", name: "c" })).not.toBe(tableKey({ schema: "a", name: "b.c" }));
  expect(tableTotals(details.tables, [{ schema: "public", name: "users", mode: "data" }, { schema: "public", name: "audit", mode: "structure" }])).toEqual({ data: 5 * 1024 * 1024, index: 1.5 * 1024 * 1024, selected: 1.5 * 1024 * 1024 });
});


it("closes the actions menu when the tab becomes inactive without making requests", async () => {
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="More SQL actions"]')!.click());
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => root.render(<DatabaseFiles sessionId="session" enabled active={false} />));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("preserves export draft across focus loss and accepts a native picker result", async () => {
  const { save } = await import("@tauri-apps/plugin-dialog");
  let resolve!: (path: string) => void;
  vi.mocked(save).mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
  await click("Export"); await input('input[placeholder="Search tables…"]', "users");
  await click("Browse…");
  const count = mocks.invoke.mock.calls.length;
  await act(async () => root.render(<DatabaseFiles sessionId="session" enabled active requestsActive={false} />));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => resolve("/tmp/picked.dump"));
  expect(document.querySelector<HTMLInputElement>('input[placeholder="Choose a file…"]')!.value).toBe("/tmp/picked.dump");
  expect(button("Export", true).disabled).toBe(true);
  await act(async () => root.render(<DatabaseFiles sessionId="session" enabled active requestsActive />));
  expect(document.querySelector<HTMLInputElement>('input[placeholder="Search tables…"]')!.value).toBe("users");
  expect(button("Export", true).disabled).toBe(false);
  expect(mocks.invoke).toHaveBeenCalledTimes(count);
});

it("finishes preparation without chained metadata requests while unfocused", async () => {
  let resolve!: (jobs: DatabaseJob[]) => void;
  mocks.invoke.mockImplementation((command: string) => command === "database_file_status" ? new Promise<DatabaseJob[]>((done) => { resolve = done; }) : Promise.resolve(details));
  await click("Export");
  await act(async () => root.render(<DatabaseFiles sessionId="session" enabled requestsActive={false} />));
  await act(async () => resolve([]));
  expect(calls("database_file_info")).toHaveLength(0);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain("Preparing…");
});

it("confirms PROD SSH exports even when the destination is this computer", async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === "database_file_info" ? { ...details, production: true, server_files: true } : []);
  await click("Export"); await input('input[placeholder="Choose a file…"]', "/tmp/prod.dump");
  mocks.confirm.mockResolvedValueOnce(false); await click("Export", true);
  expect(calls("database_file_start")).toHaveLength(0);
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ typeToConfirm: "shop", body: expect.stringContaining("Run the dump on") }));
});

it("separates pending PROD confirmation from access checks and pushed job diagnostics", async () => {
  let confirm!: (value: boolean) => void;
  let started!: (value: string) => void;
  mocks.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { confirm = resolve; }));
  mocks.invoke.mockImplementation((command: string) => command === "database_file_info" ? Promise.resolve({ ...details, production: true, server_files: true }) : command === "database_file_start" ? new Promise<string>((resolve) => { started = resolve; }) : Promise.resolve([]));
  await click("Export"); await input('input[placeholder="Choose a file…"]', "/tmp/prod.dump");
  await click("Export", true);
  expect(document.body.textContent).toContain("Awaiting confirmation. The job has not started.");
  expect(document.body.textContent).not.toContain("Preparing");
  expect(calls("database_file_start")).toHaveLength(0);
  await act(async () => confirm(true));
  expect(document.body.textContent).toContain("Checking database access and table selection");
  expect(calls("database_file_start")[0][1]).toMatchObject({ confirmed: true });
  await act(async () => useDatabaseFiles.getState().received({ id: "job", session_id: "session", state: "running", stage: "Running native dump", started_at: Date.now(), elapsed_ms: 0, bytes: 0, total: null, error: null, log: ["[0.0s] running · Running native dump", "[0.1s] stderr: Database authentication failed."] }));
  const count = mocks.invoke.mock.calls.length;
  expect(document.querySelector('[aria-label="Database operation log"]')?.textContent).toContain("stderr: Database authentication failed");
  expect(document.body.textContent).not.toContain("Checking database access");
  expect(document.querySelector("progress")).toBeNull();
  expect(mocks.invoke.mock.calls).toHaveLength(count);
  await act(async () => started("job"));
});

it("offers MySQL SQL / gzip SQL and changes generated file suffixes without changing manual paths", async () => {
  const { save } = await import("@tauri-apps/plugin-dialog");
  vi.mocked(save).mockImplementation(async (options) => `/tmp/${options?.defaultPath}`);
  mocks.invoke.mockImplementation(async (command: string) => command === "database_file_info" ? { ...details, engine: "mysql" } : []);
  await click("Export");
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Export format"]')!;
  expect(select.value).toBe("sql_gzip");
  await click("Browse…");
  const path = document.querySelector<HTMLInputElement>('input[placeholder="Choose a file…"]')!;
  expect(path.value).toMatch(/\.sql\.gz$/);
  await act(async () => { select.value = "sql"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(path.value).toMatch(/\.sql$/);
  await act(async () => { select.value = "sql_gzip"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(path.value).toMatch(/\.sql\.gz$/);
  await input('input[placeholder="Choose a file…"]', "/tmp/custom.backup");
  await act(async () => { select.value = "sql"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(path.value).toBe("/tmp/custom.backup");
  await click("Export", true);
  expect(calls("database_file_start")[0][1]).toMatchObject({ operation: { kind: "export", format: "sql", file: { path: "/tmp/custom.backup" } } });
});

it("auto-selects gzip SQL imports and restores plain SQL selection when the typed suffix changes", async () => {
  await click("Import");
  await input('input[placeholder="Choose a file…"]', "/tmp/fixture.sql.gz");
  const select = document.querySelector<HTMLSelectElement>('select option[value="sql_gzip"]')!.parentElement as HTMLSelectElement;
  expect(select.value).toBe("sql_gzip");
  await input('input[placeholder="Choose a file…"]', "/tmp/fixture.sql");
  expect(select.value).toBe("sql");
});

it("blocks recognized manual filename suffixes that disagree with the export format", async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === "database_file_info" ? { ...details, engine: "mysql" } : []);
  await click("Export");
  await input('input[placeholder="Choose a file…"]', "/tmp/manual.sql");
  expect(button("Export", true).disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(".sql.gz");
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Export format"]')!;
  await act(async () => { select.value = "sql"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(button("Export", true).disabled).toBe(false);
  await input('input[placeholder="Choose a file…"]', "/tmp/manual.sql.gz");
  expect(button("Export", true).disabled).toBe(true);
});

it.each(["Close", "X", "Escape"])("keeps the running job alive when the modal closes with %s", async (method) => {
  await click("Export");
  const job: DatabaseJob = { id: "background", session_id: "session", state: "running", stage: "Export", bytes: 0, total: null, elapsed_ms: 0, started_at: Date.now(), error: null, log: [] };
  await act(async () => useDatabaseFiles.getState().received(job));
  expect(document.querySelector('[aria-label="Dismiss database operation"]')).toBeNull();
  if (method === "Close") await click("Close · job continues");
  else if (method === "Escape") await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  else await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close"]')!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(calls("database_file_cancel")).toHaveLength(0);
  expect(useDatabaseFiles.getState().jobs.background.state).toBe("running");
});

it("dismisses terminal progress without removing the completed job", async () => {
  await click("Export");
  await act(async () => useDatabaseFiles.getState().received({ id: "finished", session_id: "session", state: "done", stage: "Export", bytes: 0, total: null, elapsed_ms: 0, started_at: 0, error: null, log: [] }));
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss database operation"]')!.click());
  expect(document.querySelector('[aria-label="Dismiss database operation"]')).toBeNull();
  expect(useDatabaseFiles.getState().jobs.finished.state).toBe("done");
});
it("shows the running operation even if older terminal history arrives later", async () => {
  await click("Export");
  const base = { session_id: "session", stage: "Export", bytes: 0, total: null, elapsed_ms: 0, error: null, log: [] };
  await act(async () => {
    useDatabaseFiles.getState().received({ ...base, id: "current", state: "running", started_at: 20 });
    useDatabaseFiles.getState().received({ ...base, id: "previous", state: "done", started_at: 10 });
    useDatabaseFiles.getState().dismiss("previous");
  });
  expect(document.querySelector('[aria-label="Dismiss database operation"]')).toBeNull();
  await click("Cancel job");
  expect(calls("database_file_cancel")[0][1]).toEqual({ jobId: "current" });
});
