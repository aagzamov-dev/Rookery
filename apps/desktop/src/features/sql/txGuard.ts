// Before something would drop open SQL transactions (closing a tab, locking the app,
// switching database), ask: Commit / Rollback / Cancel (docs/07 §6).
import { api, asCoreError } from "../../ipc/api";
import { askChoice, askConfirm } from "../../stores/dialogs";
import { useHosts } from "../../stores/hosts";
import { useSql, type SqlSessionMeta } from "../../stores/sql";
import { useTabs } from "../../stores/tabs";

/** A readable name for the tab / view that owns a session. */
export function sessionLabel(m: SqlSessionMeta): string {
  const key = m.tabKey ?? "";
  if (key.startsWith("host:")) {
    const h = useHosts.getState().hosts.find((x) => x.id === key.slice(5));
    return `${h?.name ?? "server"} · ${m.database ?? "database"}`;
  }
  const t = useTabs.getState().tabs.find((x) => x.id === key);
  if (t?.kind === "db") {
    const c = t.target.kind === "saved" ? useSql.getState().conns.find((x) => x.id === (t.target as { id: string }).id) : undefined;
    return c?.name ?? t.title;
  }
  return m.database ?? "database";
}

/** Sessions with uncommitted changes, optionally only those of some tab keys. */
export function openTransactions(tabKeys?: string[]): SqlSessionMeta[] {
  return Object.values(useSql.getState().sessions).filter((m) => m.txOpen && (!tabKeys || (m.tabKey != null && tabKeys.includes(m.tabKey))));
}

/**
 * Ask what to do with open transactions before `action` ("closing this tab", "locking").
 * Returns true to go on (after committing or rolling back), false to stop.
 */
export async function settleTransactions(metas: SqlSessionMeta[], action: string): Promise<boolean> {
  if (metas.length === 0) return true;
  const list = metas.map((m) => `• ${sessionLabel(m)}${m.txRows ? ` · ${m.txRows} rows` : ""}`).join("\n");
  const choice = await askChoice({
    title: "Uncommitted changes",
    body: `${list}\n\nBefore ${action}: commit the changes, or roll them back?`,
    choices: [
      { id: "rollback", label: "Roll back" },
      { id: "commit", label: "Commit", variant: "primary" },
    ],
  });
  if (!choice) return false;
  for (const m of metas) {
    try {
      await api.sqlTx(m.sessionId, choice as "commit" | "rollback");
    } catch (e) {
      // Commit failed (e.g. a constraint): stop, so nothing is lost silently.
      await askConfirm({ title: `${choice === "commit" ? "Commit" : "Rollback"} failed`, body: `${sessionLabel(m)}: ${asCoreError(e).message}`, confirmLabel: "OK" });
      return false;
    }
  }
  return true;
}
