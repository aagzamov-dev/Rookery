import { describe, expect, it } from "vitest";
import { DEFAULT_TRIGGERS } from "../../../stores/keys";
import { blend, compileTriggers, matchLine, triggerError } from "./triggers";

describe("terminal triggers", () => {
  const compiled = compileTriggers(DEFAULT_TRIGGERS);

  it("default patterns catch errors and warnings, not ordinary words", () => {
    expect(matchLine("2026-10-16 ERROR db connection refused", compiled)?.t.id).toBe("errors");
    expect(matchLine("Traceback (most recent call last):", compiled)?.t.id).toBe("errors");
    expect(matchLine("WARN disk almost full", compiled)?.t.id).toBe("warnings");
    expect(matchLine("errors=0 warnings=0 all good", compiled)).toBeNull();
    expect(matchLine("TERRORIST-free zone", compiled)).toBeNull(); // word boundary
  });

  it("skips invalid or disabled patterns and reports the error", () => {
    const list = compileTriggers([
      { id: "bad", pattern: "(", color: "red", notify: false, enabled: true, caseSensitive: false },
      { id: "off", pattern: "x", color: "red", notify: false, enabled: false, caseSensitive: false },
      { id: "ok", pattern: "timeout", color: "blue", notify: false, enabled: true, caseSensitive: false },
    ]);
    expect(list.map((c) => c.t.id)).toEqual(["ok"]);
    expect(matchLine("TIMEOUT after 30s", list)?.t.id).toBe("ok"); // case-insensitive
    expect(triggerError("(")).toBeTruthy();
    expect(triggerError("\\bok\\b")).toBeNull();
  });

  it("tints toward the trigger colour", () => {
    expect(blend("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(blend("#171D29", "#FF7A7A", 0)).toBe("#171d29");
  });
});
