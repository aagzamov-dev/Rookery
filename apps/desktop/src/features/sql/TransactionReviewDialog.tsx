import { useState } from "react";
import clsx from "clsx";
import { useSql } from "../../stores/sql";
import { Button, Modal } from "../../ui/primitives";
import { DiffView } from "../editor/Dialogs";
import { useTransactionReview, type TransactionChange } from "./transactionReview";

const EMPTY: TransactionChange[] = [];

export function TransactionReviewDialog({ sessionId, label, fontFamily, onClose }: { sessionId: string; label: string; fontFamily: string; onClose: () => void }) {
  const changes = useTransactionReview((s) => s.bySession[sessionId]) ?? EMPTY;
  const meta = useSql((s) => s.sessions[sessionId]);
  const [selected, setSelected] = useState(0);
  const change = changes[selected] ?? changes[changes.length - 1];
  return (
    <Modal title={`Review uncommitted changes · ${label}`} width={1120} onClose={onClose} footer={<Button className="h-10 px-4 text-sm" onClick={onClose}>Close review</Button>}>
      <p className="m-0 text-sm text-muted">{meta?.txRows ?? 0} affected rows · Changes are shown in the order they were applied. Nothing is committed by opening this review.</p>
      {changes.length === 0 ? <p className="m-0 text-sm text-muted">No change details were recorded for this transaction. Changes applied before this feature loaded are not available here.</p> : <>
        <div className="flex max-h-32 flex-col gap-1 overflow-auto">
          {changes.map((entry, index) => <button key={index} onClick={() => setSelected(index)} className={clsx("rounded-md px-3 py-2 text-left text-sm", selected === index ? "bg-accent-bg" : "hover:bg-panel2")}>
            {index + 1}. {entry.kind === "cell" ? `${entry.update.schema}.${entry.update.table} · ${entry.update.column}` : `SQL · ${entry.sql.slice(0, 120)}`}
          </button>)}
        </div>
        {change?.kind === "cell" && <>
          <div className="font-mono text-xs break-all text-muted">{change.update.keys.map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join(" · ")}</div>
          <div className="grid grid-cols-2 text-xs text-muted"><span>Before{change.update.original === null ? " · NULL" : ""}</span><span>After{change.update.value === null ? " · NULL" : ""}</span></div>
          <div className="flex min-h-0 flex-col" style={{ ["--ed-font" as string]: fontFamily, ["--ed-size" as string]: "13px" }}>
            <DiffView autoHeight left={change.update.original ?? ""} right={change.update.value ?? ""} lang="text" />
          </div>
        </>}
        {change?.kind === "sql" && <>
          <pre className="m-0 max-h-[50vh] overflow-auto rounded-lg border border-line bg-term p-3 text-sm whitespace-pre-wrap" style={{ fontFamily }}>{change.sql}</pre>
          <p className="m-0 text-xs text-muted">{change.affected ?? 0} affected rows. SQL statements are recorded as executed; row-level before/after values are available for table-viewer edits.</p>
        </>}
      </>}
    </Modal>
  );
}
