import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { Snapshot } from "../ipc/bindings/Snapshot";
import { emptyGroup, emptyHost } from "./hosts";
import { ageClass, DEFAULT_THRESHOLDS, effectiveRefresh, hostsInTab, needsAttention, switchTargets, UNGROUPED } from "./sync";

const group = (id: string, parent: string | null = null, patch = {}) => ({ ...emptyGroup(), id, name: id, parent_id: parent, ...patch });
const host = (id: string, groupId: string | null, patch = {}) => ({ ...emptyHost(), id, name: id, group_id: groupId, ...patch });
const global = { mode: "auto" as const, interval_s: 300, collect: "basic_docker" as const, desktop: true, mobile: true, wifi_only: true };

const snap = (patch: Partial<Snapshot>): Snapshot => ({
  host_id: "h",
  taken_at: 0,
  state: "ok",
  error: null,
  last_ok_at: 0,
  metrics: null,
  prev_cpu_pct: null,
  os: null,
  docker: null,
  failed_services: null,
  duration_ms: null,
  ...patch,
});

const metrics = (cpu: number, disk = 10, ramPct = 10) => ({
  ts_ms: 0,
  cpu_pct: cpu,
  ram_used_bytes: ramPct,
  ram_total_bytes: 100,
  disk_pct: disk,
  disk_used_bytes: 0,
  disk_total_bytes: 0,
  load1: 0,
  load5: 0,
  load15: 0,
  uptime_s: 0,
  net_rx_bps: null,
  net_tx_bps: null,
});

describe("dashboard scope", () => {
  const groups = [group("prod"), group("eu", "prod"), group("lab")];
  const hosts = [host("a", "prod"), host("b", "eu"), host("c", "lab"), host("d", null), host("e", "deleted-group")];

  it("group tabs include sub-groups; ungrouped catches missing groups", () => {
    expect(hostsInTab("prod", hosts, groups).map((h) => h.id)).toEqual(["a", "b"]);
    expect(hostsInTab(UNGROUPED, hosts, groups).map((h) => h.id)).toEqual(["d", "e"]);
    expect(hostsInTab("all", hosts, groups)).toHaveLength(5);
  });

  it("the switch on All writes every group (+ ungrouped), on a group its subtree", () => {
    expect(switchTargets("all", groups, true).sort()).toEqual(["eu", "lab", "prod", UNGROUPED].sort());
    expect(switchTargets("prod", groups, false).sort()).toEqual(["eu", "prod"]);
  });
});

describe("effective refresh", () => {
  it("walks host → group → parent → global", () => {
    const groups = [group("p", null, { refresh: { ...emptyGroup().refresh, mode: "manual", interval_s: 60 } }), group("c", "p")];
    const e = effectiveRefresh(host("h", "c"), groups, global);
    expect(e).toMatchObject({ mode: "manual", interval_s: 60, collect: "basic_docker", source: "group" });
    const own = effectiveRefresh(host("h", "c", { refresh: { ...emptyHost().refresh, mode: "auto", interval_s: 30 } }), groups, global);
    expect(own).toMatchObject({ mode: "auto", interval_s: 30, source: "host" });
    expect(effectiveRefresh(host("h", null), [], global).source).toBe("global");
  });
});

describe("needs attention", () => {
  const hosts = [host("h", null)];
  const at = (s: Snapshot) => needsAttention(hosts, { h: s }, DEFAULT_THRESHOLDS, 10 * 3_600_000).map((a) => a.kind);

  it("CPU only after two high syncs in a row", () => {
    expect(at(snap({ metrics: metrics(95), prev_cpu_pct: 20 }))).toEqual([]);
    expect(at(snap({ metrics: metrics(95), prev_cpu_pct: 90 }))).toEqual(["cpu"]);
  });

  it("disk, memory, containers and services", () => {
    const kinds = at(
      snap({
        metrics: metrics(5, 92, 95),
        docker: { total: 3, running: 1, exited: 0, unhealthy: ["web"], restarting: ["worker"], top: [], error: null },
        failed_services: ["nginx.service"],
      }),
    );
    expect(kinds.sort()).toEqual(["container", "container", "disk", "ram", "service"].sort());
  });

  it("offline only after the threshold", () => {
    const now = 10 * 3_600_000;
    expect(at(snap({ state: "failed", last_ok_at: now - 10 * 60_000 }))).toEqual([]);
    expect(at(snap({ state: "failed", last_ok_at: now - 2 * 3_600_000 }))).toEqual(["offline"]);
    expect(at(snap({ state: "failed", last_ok_at: null }))).toEqual(["offline"]);
  });

  it("cards fade with age", () => {
    const now = 1_000_000_000;
    expect(ageClass(now - 60_000, now)).toBe("fresh");
    expect(ageClass(now - 30 * 60_000, now)).toBe("stale");
    expect(ageClass(now - 3 * 3_600_000, now)).toBe("old");
    expect(ageClass(null, now)).toBe("never");
  });
});
