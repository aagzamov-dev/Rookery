// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
import { api } from "./api";
import { useDialogs } from "../stores/dialogs";
import { DialogHost } from "../ui/DialogHost";

let root: Root;
let element: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ipc.invoke.mockReset().mockImplementation(async (command: string) => command === "hosts_list" ? [{ id: "host", name: "Saved production", env_label: "prod" }] : undefined);
  useDialogs.setState({ current: null, queue: [] });
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  await act(async () => root.render(<DialogHost />));
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it.each([
  ["sftp_mkdir", () => api.sftpMkdir("host", "/new")],
  ["sftp_archive", () => api.sftpArchive("host", "/file", "file.zip", "zip", "job")],
  ["sftp_create_file", () => api.sftpCreateFile("host", "/Dockerfile")],
  ["sftp_duplicate", () => api.sftpDuplicate("host", "/a.txt", "/a copy.txt")],
  ["sftp_rename", () => api.sftpRename("host", "/old", "/new")],
  ["sftp_upload", () => api.sftpUpload("host", ["/local"], "/remote")],
  ["edit_upload", () => api.editUpload("host", "/file", false)],
  ["docker_action", () => api.dockerAction("host", "container", "restart")],
  ["process_kill", () => api.processKill("host", 42, false)],
  ["shell_integration_install", () => api.shellIntegrationInstall("host")],
] as const)("%s: cancellation sends zero mutations; acceptance sends one confirmed mutation", async (command, operation) => {
  let pending!: Promise<unknown>;
  await act(async () => { pending = operation().catch((error: unknown) => error); });
  expect(document.body.textContent).toContain("PRODUCTION server Saved production");
  expect(ipc.invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(0);
  await click("Cancel"); await pending;
  expect(ipc.invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(0);
  await act(async () => { pending = operation(); });
  await click("Apply change"); await pending;
  const mutations = ipc.invoke.mock.calls.filter(([name]) => name === command);
  expect(mutations).toHaveLength(1);
  expect(mutations[0][1]).toMatchObject({ hostId: "host", confirmed: true });
});
