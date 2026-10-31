import { beforeEach, describe, expect, it } from "vitest";
import { LOG_BYTES, LOG_LINE_CHARS, streamKey, useLogs } from "./logs";
const host = "log-test";
const stream = "docker:c";
const line = "2026-10-25T10:00:00.000000001Z message";
const current = () => useLogs.getState().streams[streamKey(host, stream)];
beforeEach(() => useLogs.getState().forgetHost(host));
describe("log stream recovery", () => {
  it("keeps distinct emissions with equal timestamps, including identical messages", () => {
    useLogs.getState().push(host, stream, [line, line, line.replace("message", "other")]);
    expect(current().lines).toHaveLength(3);
  });
  it("removes only counted replay overlap and keeps new identical messages", () => {
    useLogs.getState().push(host, stream, [line, line]);
    useLogs.getState().resume(host, stream);
    useLogs.getState().push(host, stream, [line]);
    useLogs.getState().push(host, stream, [line, line, "2026-10-25T10:00:01Z later"]);
    expect(current().lines).toEqual([line, line, line, "2026-10-25T10:00:01Z later"]);
  });
  it("bounds long lines and retained memory", () => {
    useLogs.getState().push(host, stream, Array.from({ length: 1000 }, () => "x".repeat(LOG_LINE_CHARS + 1)));
    expect(current().lines.reduce((sum, value) => sum + value.length * 2, 0)).toBeLessThanOrEqual(LOG_BYTES);
    expect(current().dropped).toBeGreaterThan(0);
    expect(current().lines[0]).toContain("[line truncated]");
  });
});
