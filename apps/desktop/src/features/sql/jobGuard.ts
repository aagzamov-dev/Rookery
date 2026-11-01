import { useDatabaseFiles } from "../../stores/databaseFiles";
import { askConfirm } from "../../stores/dialogs";
import { useSql } from "../../stores/sql";

export async function allowDatabaseSessionClose(sessionIds: string[]): Promise<boolean> {
  if (!Object.values(useDatabaseFiles.getState().jobs).some((job) => job.state === "running" && sessionIds.includes(job.session_id))) return true;
  await askConfirm({ title: "Database operation is running", body: "Keep this connection open until the operation finishes, or use Cancel job in Export, Import or Backups first. Closing the operation dialog lets the job continue in the background.", confirmLabel: "Keep connection open" });
  return false;
}

export function databaseSessionsForTabs(keys: string[]): string[] {
  return Object.values(useSql.getState().sessions).filter((session) => session.tabKey && keys.includes(session.tabKey)).map((session) => session.sessionId);
}
