import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

import { periodRange } from "./DockerTools";

describe("download logs period", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");

  it("relative periods end now (open end)", () => {
    expect(periodRange("1h", "", "", now)).toEqual({ since: "2026-11-07T11:00:00.000Z", until: null });
    expect(periodRange("7d", "", "", now)).toEqual({ since: "2026-10-31T12:00:00.000Z", until: null });
  });

  it("everything has no bounds", () => {
    expect(periodRange("all", "", "", now)).toEqual({ since: null, until: null });
  });

  it("custom needs start before end", () => {
    expect(periodRange("custom", "2026-11-06T10:00", "2026-11-06T09:00", now)).toBeNull();
    expect(periodRange("custom", "", "2026-11-06T09:00", now)).toBeNull();
    const r = periodRange("custom", "2026-11-06T08:00", "2026-11-06T09:00", now);
    expect(r && Date.parse(r.until!) - Date.parse(r.since!)).toBe(3_600_000);
  });
});
