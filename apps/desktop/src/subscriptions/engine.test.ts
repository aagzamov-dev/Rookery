import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { desiredSubscriptions, key, Reconciler, type EngineInput } from "./engine";
import type { ServerViews, Tab } from "../stores/tabs";

const views = (): ServerViews => ({
  active: "terminal",
  opened: ["terminal"],
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
    ...over,
  };
}

describe("desiredSubscriptions", () => {
  it("runs metrics only for the active server tab", () => {
    expect([...desiredSubscriptions(input())]).toEqual([key("a", "metrics")]);
    expect([...desiredSubscriptions(input({ activeTabId: "server:b" }))]).toEqual([key("b", "metrics")]);
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
});

describe("Reconciler", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("subscribes once, unsubscribes when hidden, resubscribes when shown", async () => {
    let n = 0;
    const sub = vi.fn(async () => ({ sub_id: `s${++n}`, cached: null }));
    const unsub = vi.fn(async () => {});
    const r = new Reconciler(sub, unsub);

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

  it("cancels a subscription that becomes unwanted while pending", async () => {
    const sub = vi.fn(async () => ({ sub_id: "s1", cached: null }));
    const unsub = vi.fn(async () => {});
    const r = new Reconciler(sub, unsub);
    r.apply(new Set([key("a", "metrics")]));
    r.apply(new Set()); // hidden before subscribe resolved
    await flush();
    expect(unsub).toHaveBeenCalledWith("s1");
    expect(r.snapshot()).toEqual([]);
  });
});
