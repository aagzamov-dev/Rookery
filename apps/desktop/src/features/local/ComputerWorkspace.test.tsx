// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({ shells: vi.fn(), attach: vi.fn(), files: vi.fn() }));
vi.mock("../../ipc/api", () => ({ api: { localShells: ipc.shells }, asCoreError: (e: Error) => e }));
vi.mock("../files/FileBrowser", () => ({ FileBrowser: ({ visible }: { visible: boolean }) => { ipc.files(visible); return <div>Local file browser</div>; } }));
vi.mock("../server-tab/terminal/TerminalPane", () => ({ TerminalPane: () => <div>Local terminal</div> }));
vi.mock("../server-tab/terminal/registry", () => ({ terminalRegistry: { broadcastTargets: () => 0 } }));
import { ServerTab } from "../server-tab/ServerTab";
import { useTabs } from "../../stores/tabs";
import { useKeys, DEFAULT_APP_PREFS } from "../../stores/keys";
import { useVault } from "../../stores/vault";
import { useUi } from "../../stores/ui";
import { useSessions } from "../../stores/sessions";
import { COMPUTER_ID, COMPUTER_TAB_ID } from "./target";

it("opens one cohesive computer workspace with lazy views and no remote-only tabs", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ipc.shells.mockResolvedValue([{ id: "test", label: "Test shell", program: "test", args: [] }]);
  useKeys.setState({ loaded: true, app: DEFAULT_APP_PREFS });
  useTabs.setState({ tabs: [], activeTabId: null, views: {}, deferred: {} });
  useVault.setState({ status: { initialised: true, unlocked: true, pin_set: false, pin_disabled: false, pin_length: null, pin_attempts_left: null } });
  useUi.setState({ windowActive: true });
  useSessions.setState({ attach: ipc.attach });
  useTabs.getState().openServer(COMPUTER_ID, "overview");
  useTabs.getState().openServer(COMPUTER_ID, "overview");
  expect(useTabs.getState().tabs).toEqual([{ id: COMPUTER_TAB_ID, kind: "computer", hostId: COMPUTER_ID }]);
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  const click = async (name: string) => {
    const button = [...element.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.trim() === name);
    if (!button) throw new Error(`Missing view ${name}`);
    await act(async () => { button.click(); await Promise.resolve(); });
  };
  try {
    await act(async () => root.render(<StrictMode><ServerTab hostId={COMPUTER_ID} active onEditHost={() => {}} /></StrictMode>));
    expect([...element.querySelectorAll('[role="tab"]')].map((e) => e.textContent?.trim())).toEqual(["Overview", "Terminal", "Files", "Editor", "Git", "Docker", "Database"]);
    expect(ipc.attach).not.toHaveBeenCalled();
    expect(ipc.files).not.toHaveBeenCalled();
    expect(ipc.shells).not.toHaveBeenCalled();
    await click("Files");
    expect(ipc.files).toHaveBeenLastCalledWith(true);
    await click("Overview");
    expect(element.textContent).toContain("Local file browser");
    expect(ipc.files).toHaveBeenLastCalledWith(false);
    await click("Terminal");
    expect(ipc.shells).toHaveBeenCalledTimes(1);
    expect(ipc.attach).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); }
});
