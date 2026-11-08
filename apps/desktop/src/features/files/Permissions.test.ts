import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { modeString, parseMode, withExec } from "./Permissions";

it("parses octal and shows rwx", () => {
  expect(parseMode("755")).toBe(0o755);
  expect(parseMode("0644")).toBe(0o644);
  expect(parseMode("8")).toBeNull();
  expect(parseMode("75")).toBeNull();
  expect(modeString(0o750)).toBe("rwxr-x---");
});

it("make executable adds x where read is allowed", () => {
  expect(withExec(0o644)).toBe(0o755);
  expect(withExec(0o600)).toBe(0o700);
  expect(withExec(0o640)).toBe(0o750);
});
