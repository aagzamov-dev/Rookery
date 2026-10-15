// Running a snippet on a server tab: variables → PROD guard → type into the terminal.
import type { RunMode } from "../../ipc/bindings/RunMode";
import type { Snippet } from "../../ipc/bindings/Snippet";
import { askConfirm, askVars } from "../../stores/dialogs";
import { useHosts } from "../../stores/hosts";
import { appliesTo, isWorkflow, useSnippets, workflowCommand } from "../../stores/snippets";
import { shellQuote } from "../files/quote";
import { useTabs } from "../../stores/tabs";
import { terminalRegistry } from "../server-tab/terminal/registry";
import { fillCommand, syncVars } from "./vars";

/** Ask for variables (if any). Returns the final command, or null if cancelled. */
export async function resolveCommand(s: Snippet, hostName?: string): Promise<string | null> {
  const base = isWorkflow(s) ? workflowCommand(s) : s.command;
  const vars = syncVars(base, s.vars);
  const ask = vars.filter((v) => v.ask);
  const values: Record<string, string> = Object.fromEntries(vars.map((v) => [v.name, v.default ?? ""]));
  if (ask.length > 0) {
    const got = await askVars({
      title: `${s.alias ?? s.name}${hostName ? ` on ${hostName}` : ""}`,
      command: isWorkflow(s) ? s.steps.join("\n") : s.command,
      vars: ask.map((v) => ({ name: v.name, value: v.default ?? "" })),
    });
    if (!got) return null;
    Object.assign(values, got);
  }
  return fillCommand(base, values);
}

/** Run a container-scoped snippet inside a container, in a new terminal of the server tab. */
export async function runInContainer(s: Snippet, hostId: string, container: string): Promise<void> {
  const host = useHosts.getState().hostById(hostId);
  const command = await resolveCommand(s, `${container} on ${host?.name ?? "server"}`);
  if (command == null) return;
  if (s.ask_prod && host?.env_label === "prod") {
    const ok = await askConfirm({ title: `Run in ${container} on PROD — ${host.name}?`, preview: command, confirmLabel: "Run on production", danger: true });
    if (!ok) return;
  }
  const key = useTabs.getState().addTerminal(hostId, { title: `${s.alias ?? s.name} @ ${container}` });
  if (!key) return;
  terminalRegistry.runCommand(key, `docker exec -it ${container} sh -lc ${shellQuote(command)}`);
  setTimeout(() => terminalRegistry.focus(key), 50);
}

/**
 * Run a snippet on a server. `mode` overrides the snippet's own run mode
 * (the palette's Ctrl+Enter = paste only).
 */
export async function runSnippet(s: Snippet, hostId: string, mode?: RunMode): Promise<void> {
  const host = useHosts.getState().hostById(hostId);
  const command = await resolveCommand(s, host?.name);
  if (command == null) return;
  const runMode = mode ?? s.run_mode;

  if (s.ask_prod && host?.env_label === "prod" && runMode !== "paste") {
    const ok = await askConfirm({
      title: `Run on PROD — ${host.name}?`,
      body: "This snippet asks for confirmation on production servers.",
      preview: command,
      confirmLabel: "Run on production",
      danger: true,
    });
    if (!ok) return;
  }

  const tabs = useTabs.getState();
  tabs.openServer(hostId);
  tabs.setView(hostId, "terminal");
  const views = useTabs.getState().views[hostId];
  let key = views?.activeTerminal ?? null;
  if (runMode === "new_terminal" || !key) {
    key = useTabs.getState().addTerminal(hostId, { title: s.alias ?? s.name });
  }
  if (!key) return;
  if (runMode === "paste") terminalRegistry.typeText(key, command);
  else terminalRegistry.runCommand(key, command);
  terminalRegistry.focus(key);
}

/** Snippets that apply to a host, in library order. */
export function snippetsForHost(hostId: string | null): Snippet[] {
  const { list } = useSnippets.getState();
  const { groups, hostById } = useHosts.getState();
  const host = hostId ? hostById(hostId) : undefined;
  return list.filter((s) => appliesTo(s, host, groups));
}

/** Used by alias + Tab in the terminal. */
export function findAlias(hostId: string, alias: string): Snippet | undefined {
  return snippetsForHost(hostId).find((s) => s.alias === alias);
}
