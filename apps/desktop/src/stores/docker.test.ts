import { describe, expect, it } from "vitest";
import type { Container } from "../ipc/bindings/Container";
import type { ContainerStats } from "../ipc/bindings/ContainerStats";
import { statsFor, type HostDocker } from "./docker";

const stat = (id: string, name: string, cpu: number): ContainerStats => ({ id, name, cpu_pct: cpu, mem_pct: 0, mem_usage: "1MiB / 1GiB" });
const host = (stats: ContainerStats[]): HostDocker => ({ containers: [], error: null, at: 1, selected: null, stats: Object.fromEntries(stats.map((s) => [s.id, s])) });

describe("statsFor", () => {
  it("prefers the id over a stale entry with the same name (recreated container)", () => {
    const c = { id: "bbbbbbbbbbbb0000", name: "shop-app-1" } as Container;
    const d = host([stat("aaaaaaaaaaaa", "shop-app-1", 99), stat("bbbbbbbbbbbb", "shop-app-1", 5)]);
    expect(statsFor(d, c)?.cpu_pct).toBe(5);
  });

  it("falls back to the name", () => {
    const c = { id: "cccc", name: "db" } as Container;
    expect(statsFor(host([stat("zzzz", "db", 1)]), c)?.cpu_pct).toBe(1);
  });
});
