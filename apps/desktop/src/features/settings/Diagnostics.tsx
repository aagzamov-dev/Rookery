import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, asCoreError } from "../../ipc/api";
import { useSql } from "../../stores/sql";
import { useLogs } from "../../stores/logs";
import { useFiles } from "../../stores/files";
import { Button, Modal } from "../../ui/primitives";
import { Section } from "./SettingsMore";
import { version } from "../../../package.json";

export function Diagnostics() {
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const prepare = () => {
    const sql = useSql.getState();
    const logs = Object.values(useLogs.getState().streams);
    setError(null);
    setReport(JSON.stringify({
      format: "rookery-diagnostics-v1", version, createdAt: new Date().toISOString(),
      sql: {
        sessions: Object.values(sql.sessions).map((s) => ({ engine: s.engine, state: s.state, readOnly: s.readOnly, transactionOpen: s.txOpen })),
        retainedRuns: Object.keys(sql.runs).length,
        unfinishedRuns: Object.values(sql.runs).filter((r) => !r.finished).length,
      },
      logs: { streams: logs.length, retainedLines: logs.reduce((n, s) => n + s.lines.length, 0), dropped: logs.reduce((n, s) => n + (s.dropped ?? 0), 0) },
      transfers: Object.values(useFiles.getState().transfers).map((t) => ({ upload: t.upload, state: t.state, bytes: t.bytes, total: t.total })),
    }, null, 2));
  };
  const exportReport = async () => {
    if (!report) return;
    setSaving(true);
    setError(null);
    try {
      const path = await save({ defaultPath: "rookery-diagnostics.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) { await api.fileWriteText(path, report); setReport(null); }
    } catch (e) { setError(asCoreError(e).message); }
    finally { setSaving(false); }
  };
  return <Section title="Diagnostics">
    <div className="flex flex-wrap items-center gap-3 p-3">
      <p className="min-w-0 flex-1 text-xs text-muted">Review connection states and buffer counts before saving. Query text, credentials, hostnames, paths, and log contents are excluded.</p>
      <Button onClick={prepare}>Review diagnostic report</Button>
    </div>
    {report && <Modal title="Review diagnostics" onClose={() => { if (!saving) setReport(null); }} footer={<Button disabled={saving} onClick={() => void exportReport()}>{saving ? "Saving…" : "Save JSON"}</Button>}>
      <pre className="max-h-[55vh] overflow-auto rounded bg-bg p-3 text-xs whitespace-pre-wrap">{report}</pre>
      {error && <p role="alert" className="text-prod-fg">{error}</p>}
    </Modal>}
  </Section>;
}
