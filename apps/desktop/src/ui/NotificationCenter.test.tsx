// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DesktopNotificationPermission, NotificationCenter } from "./NotificationCenter";
import { useVault } from "../stores/vault";
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn().mockResolvedValue(false), requestPermission: vi.fn(), sendNotification: vi.fn() }));
it.each(["locked", "PIN setup"])("removes its portal and focus trap for %s and stays closed on unlock", async (reason) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useVault.setState({ status: null, pinSkipped: true });
  const status = { initialised: true, unlocked: true, pin_set: true, pin_disabled: false, pin_length: 6, pin_attempts_left: 5 };
  useVault.setState({ status: status });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<NotificationCenter />));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      if (reason === "locked") useVault.getState().markLocked();
      else useVault.setState({ status: { ...status, pin_set: false }, pinSkipped: false });
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const unlock = document.createElement("input"); document.body.append(unlock); unlock.focus();
    expect(document.activeElement).toBe(unlock);
    await act(async () => useVault.setState({ status: status }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    unlock.remove();
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

it("offers the explicit test button in Settings and runs the shared test action", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { useNotifications } = await import("../stores/notifications");
  const originalTest = useNotifications.getState().test;
  const test = vi.fn().mockResolvedValue(undefined);
  useNotifications.setState({ permission: "denied", requesting: false, test });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DesktopNotificationPermission showTest />));
    const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === "Test notification")!;
    expect(container.textContent).toContain("Allow Rookery notifications");
    await act(async () => button.click());
    expect(test).toHaveBeenCalledOnce();
    await act(async () => useNotifications.setState({ requesting: true }));
    expect(button.disabled).toBe(true);
    await act(async () => useNotifications.setState({ deliveryError: "macOS rejected the notification request" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("macOS rejected the notification request");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useNotifications.setState({ test: originalTest, permission: "unknown", requesting: false, deliveryError: null });
    vi.unstubAllGlobals();
  }
});
