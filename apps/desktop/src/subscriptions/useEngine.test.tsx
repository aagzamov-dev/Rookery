// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn(), sync: vi.fn() }));
vi.mock("../ipc/api", () => ({ api: { subscribe: ipc.subscribe, unsubscribe: ipc.unsubscribe, syncWindowVisible: ipc.sync }, asCoreError: (error: Error) => error }));
import { useSubscriptionEngine } from "./useEngine";
import { useTabs } from "../stores/tabs";
import { useSessions } from "../stores/sessions";
import { useDocker } from "../stores/docker";
import { useKeys } from "../stores/keys";
import { useUi } from "../stores/ui";
import { useVault } from "../stores/vault";
import type { View } from "../stores/tabs";

function Engine() { useSubscriptionEngine(); return null; }
let element: HTMLDivElement;
let root: Root;
const view = (active: View) => ({ active, opened: [active], terminals: [], activeTerminal: null, termCounter: 0 });
async function update(action: () => void) { await act(async () => { action(); await Promise.resolve(); }); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ipc.subscribe.mockReset().mockImplementation(async () => ({ sub_id: String(ipc.subscribe.mock.calls.length), cached: null }));
  ipc.unsubscribe.mockReset().mockResolvedValue(undefined);
  ipc.sync.mockReset().mockResolvedValue(undefined);
  useTabs.setState({ tabs: [{ id: "server:host", kind: "server", hostId: "host" }], activeTabId: "server:host", views: { host: view("overview") } });
  useSessions.setState({ byHost: { host: { host_id: "host", state: "connected", latency_ms: null, error: null, leases: 1 } } });
  useVault.setState({ status: { initialised: true, unlocked: true, pin_set: false, pin_disabled: false, pin_length: null, pin_attempts_left: null } });
  useKeys.setState((s) => ({ loaded: true, app: { ...s.app, metricsIntervalMs: 3000 } }));
  useUi.setState({ windowActive: true });
  useDocker.setState({ byHost: {} });
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

it("limits automatic snapshots to visible Overview with live metrics on", async () => {
  await update(() => root.render(<Engine />));
  expect(ipc.sync).toHaveBeenLastCalledWith(true, "host");
  await update(() => useTabs.setState({ views: { host: view("files") } }));
  expect(ipc.sync).toHaveBeenLastCalledWith(false, null);
  await update(() => useTabs.setState({ views: { host: view("overview") } }));
  expect(ipc.sync).toHaveBeenLastCalledWith(true, "host");
  await update(() => useUi.setState({ windowActive: false }));
  expect(ipc.sync).toHaveBeenLastCalledWith(false, null);
  await update(() => useUi.setState({ windowActive: true }));
  await update(() => useKeys.setState((s) => ({ app: { ...s.app, metricsIntervalMs: 0 } })));
  expect(ipc.sync).toHaveBeenLastCalledWith(false, null);
  expect(ipc.unsubscribe).toHaveBeenCalled();
});

it("restarts blocked Docker once after explicit Reload removes the host entry", async () => {
  useTabs.setState({ views: { host: view("docker") } });
  useDocker.getState().setList("host", [], "permission denied");
  await update(() => root.render(<Engine />));
  expect(ipc.subscribe.mock.calls.filter(([, source]) => source === "docker")).toHaveLength(0);
  await update(() => useDocker.getState().forget("host"));
  expect(ipc.subscribe.mock.calls.filter(([, source]) => source === "docker")).toHaveLength(1);
  expect(ipc.subscribe.mock.calls.filter(([, source]) => source === "docker.stats")).toHaveLength(0);
});

it("keeps local discovery lazy and pauses computer collectors on disable, hide and restore", async () => {
  const id = "__computer__";
  useTabs.setState({ tabs: [{ id: `server:${id}`, kind: "computer", hostId: id }], activeTabId: `server:${id}`, views: { [id]: view("files") }, deferred: {} });
  useKeys.setState((s) => ({ app: { ...s.app, showThisComputer: true, metricsIntervalMs: 5000 } }));
  await update(() => root.render(<Engine />));
  expect(ipc.subscribe).not.toHaveBeenCalled();
  expect(ipc.sync).not.toHaveBeenCalledWith(true, id);
  await update(() => useTabs.setState({ views: { [id]: view("overview") } }));
  expect(ipc.subscribe).toHaveBeenCalledExactlyOnceWith(id, "metrics", { interval_ms: 5000 });
  await update(() => useKeys.setState((s) => ({ app: { ...s.app, showThisComputer: false } })));
  expect(ipc.unsubscribe).toHaveBeenCalledTimes(1);
  const requests = ipc.subscribe.mock.calls.length;
  await update(() => useTabs.setState({ views: { [id]: view("docker") } }));
  expect(ipc.subscribe).toHaveBeenCalledTimes(requests);
  await update(() => useKeys.setState((s) => ({ app: { ...s.app, showThisComputer: true } })));
  expect(ipc.subscribe).toHaveBeenCalledTimes(requests + 1);
  expect(ipc.subscribe).toHaveBeenLastCalledWith(id, "docker", undefined);
  await update(() => useUi.setState({ windowActive: false }));
  await update(() => useTabs.setState({ deferred: { [id]: true }, views: { [id]: view("overview") } }));
  await update(() => useUi.setState({ windowActive: true }));
  expect(ipc.subscribe).toHaveBeenCalledTimes(requests + 1);
});
