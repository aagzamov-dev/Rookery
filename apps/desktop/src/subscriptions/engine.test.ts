import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { desiredSubscriptions, key, parseKey, Reconciler, type EngineInput, type ReconcilerHooks } from "./engine";
import type { ServerViews, Tab, View } from "../stores/tabs";

const views = (active: View = "terminal"): ServerViews => ({
  active,
  opened: [active],
  terminals: [],
  activeTerminal: null,
  termCounter: 0,
});

function input(over: Partial<EngineInput> = {}): EngineInput {
  const tabs: Tab[] = [
    { id: "server:a", kind: "server", hostId: "a" },
    { id: "server:b", kind: "server", hostId: "b" },
    { id: "page:dashboard", kind: "page", page: "dashboard" },
  ];
  return {
    tabs,
    activeTabId: "server:a",
    views: { a: views(), b: views() },
    sessionStates: { a: "connected", b: "connected" },
    windowActive: true,
    unlocked: true,
    dockerSelected: {},
    fileTarget: {},
    ...over,
  };
}

const sorted = (s: Set<string>) => [...s].sort();

describe("desiredSubscriptions", () => {
  it("runs metrics only for the active server tab", () => {
    expect(sorted(desiredSubscriptions(input()))).toEqual([key("a", "metrics")]);
    expect(sorted(desiredSubscriptions(input({ activeTabId: "server:b" })))).toEqual([key("b", "metrics")]);
  });

  it("runs nothing on a page tab (dashboard renders from the DB)", () => {
    expect(desiredSubscriptions(input({ activeTabId: "page:dashboard" })).size).toBe(0);
  });

  it("runs nothing when the window is inactive or the app is locked", () => {
    expect(desiredSubscriptions(input({ windowActive: false })).size).toBe(0);
    expect(desiredSubscriptions(input({ unlocked: false })).size).toBe(0);
  });

  it("waits until the session is connected", () => {
    expect(desiredSubscriptions(input({ sessionStates: { a: "connecting" } })).size).toBe(0);
    expect(desiredSubscriptions(input({ sessionStates: { a: "error" } })).size).toBe(0);
  });

  it("starts Docker list + stats only while the Docker view is visible", () => {
    const docker = input({ views: { a: views("docker"), b: views() } });
    expect(sorted(desiredSubscriptions(docker))).toEqual(sorted(new Set([key("a", "metrics"), key("a", "docker"), key("a", "docker.stats")])));
    // Docker opened on b but b is in the background → nothing for b
    const bg = input({ views: { a: views(), b: views("docker") } });
    expect(sorted(desiredSubscriptions(bg))).toEqual([key("a", "metrics")]);
  });

  it("follows container logs only while the logs panel is open in the visible Docker view", () => {
    const withLogs = input({ views: { a: views("docker"), b: views() }, dockerSelected: { a: "shop-app-1" } });
    expect(desiredSubscriptions(withLogs).has(key("a", "docker.logs", "shop-app-1"))).toBe(true);
    const otherView = input({ views: { a: views("terminal"), b: views() }, dockerSelected: { a: "shop-app-1" } });
    expect(desiredSubscriptions(otherView).has(key("a", "docker.logs", "shop-app-1"))).toBe(false);
  });

  it("tails a log file only in the Logs view", () => {
    const logs = input({ views: { a: views("logs"), b: views() }, fileTarget: { a: "/var/log/nginx/error.log" } });
    expect(desiredSubscriptions(logs).has(key("a", "file.tail", "/var/log/nginx/error.log"))).toBe(true);
  });

  it("parses keys whose param contains separators", () => {
    expect(parseKey(key("h1", "file.tail", "/var/log/a|b.log"))).toEqual({ hostId: "h1", source: "file.tail", param: "/var/log/a|b.log" });
  });
});

describe("Reconciler", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const hooks: ReconcilerHooks = {
    paramsFor: (_h, source, param) => (source === "docker.logs" ? { container: param, since: "2026-10-15T08:00:00Z" } : undefined),
    onCached: vi.fn(),
    onError: vi.fn(),
  };

  it("subscribes once, unsubscribes when hidden, resubscribes when shown", async () => {
    let n = 0;
    const sub = vi.fn(async () => ({ sub_id: `s${++n}`, cached: null }));
    const unsub = vi.fn(async () => {});
    const r = new Reconciler(sub, unsub, hooks);

    r.apply(new Set([key("a", "metrics")]));
    r.apply(new Set([key("a", "metrics")])); // no duplicate while pending
    await flush();
    expect(sub).toHaveBeenCalledTimes(1);

    r.apply(new Set()); // tab switched away
    expect(unsub).toHaveBeenCalledWith("s1");

    r.apply(new Set([key("a", "metrics")])); // back again
    await flush();
    expect(sub).toHaveBeenCalledTimes(2);
    expect(r.snapshot()).toEqual([key("a", "metrics")]);
  });

  it("passes params (container + since for gap fill)", async () => {
    const sub = vi.fn(async () => ({ sub_id: "s1", cached: null }));
    const r = new Reconciler(sub, vi.fn(async () => {}), hooks);
    r.apply(new Set([key("a", "docker.logs", "shop-app-1")]));
    await flush();
    expect(sub).toHaveBeenCalledWith("a", "docker.logs", { container: "shop-app-1", since: "2026-10-15T08:00:00Z" });
  });

  it("cancels a subscription that becomes unwanted while pending", async () => {
    const sub = vi.fn(async () => ({ sub_id: "s1", cached: null }));
    const unsub = vi.fn(async () => {});
    const r = new Reconciler(sub, unsub, hooks);
    r.apply(new Set([key("a", "metrics")]));
    r.apply(new Set()); // hidden before subscribe resolved
    await flush();
    expect(unsub).toHaveBeenCalledWith("s1");
    expect(r.snapshot()).toEqual([]);
  });
});
