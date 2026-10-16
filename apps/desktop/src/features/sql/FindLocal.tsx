import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { LocalDb } from "../../ipc/bindings/LocalDb";
import { useSql } from "../../stores/sql";
import { Button, Modal } from "../../ui/primitives";
import { useConnDialog } from "./connDialog";
import { openConn } from "./DbList";
import { isLocalAddress } from "./shortcuts";

const engineName = (d: LocalDb) => (d.product.startsWith("MariaDB") ? "MariaDB" : d.engine === "mysql" ? "MySQL" : "PostgreSQL");

/** "Find databases on this PC" (docs/07 §2.4): a quick probe of 127.0.0.1 plus local Docker. */
export function FindLocalDialog({ onClose }: { onClose: () => void }) {
  const conns = useSql((s) => s.conns);
  const [list, setList] = useState<LocalDb[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scan = async () => {
    setBusy(true);
    setError(null);
    try {
      setList(await api.sqlDetectLocal());
    } catch (e) {
      setError(asCoreError(e).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void scan();
  }, []);

  const saved = (d: LocalDb) => conns.find((c) => c.via === "direct" && isLocalAddress(c.address) && c.port === d.port && c.engine === d.engine);

  const add = (d: LocalDb) => {
    onClose();
    const container = d.container?.split(" (")[0];
    useConnDialog.getState().open({
      prefill: {
        name: container ?? `${engineName(d)} localhost${d.port === (d.engine === "mysql" ? 3306 : 5432) ? "" : `:${d.port}`}`,
        engine: d.engine,
        via: "direct",
        address: "127.0.0.1",
        port: d.port,
        username: d.user,
        database: d.database,
        ssl_mode: "disable",
      },
    });
  };

  return (
    <Modal
      title="Databases on this PC"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button className="mr-auto" onClick={() => void scan()} disabled={busy}>
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Look again
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <p className="m-0 text-xs text-muted">Looks at 127.0.0.1 on ports 3306, 3307, 5432 and 5433, and at the ports your Docker containers publish. Nothing is changed.</p>
      {busy && !list && (
        <div className="flex items-center gap-2 py-4 text-muted">
          <Loader2 size={14} className="animate-spin" /> Looking…
        </div>
      )}
      {error && <div className="rounded-lg border border-[#5A2D33] bg-[#33232A] px-3 py-2 text-[13px] text-prod-fg">{error}</div>}
      {list && list.length === 0 && <p className="m-0 py-3 text-[13px]">No databases found on this PC. Start XAMPP, Laragon, PostgreSQL or a Docker container, then look again.</p>}
      {list && list.length > 0 && (
        <div className="flex flex-col gap-2">
          {list.map((d) => {
            const have = saved(d);
            return (
              <div key={d.port} className="flex items-center gap-3 rounded-lg border border-line bg-panel2/40 px-3 py-2.5">
                <span aria-hidden className="text-lg leading-none">
                  {d.engine === "mysql" ? "🐬" : "🐘"}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13px]">
                    {have ? "" : "Add "}
                    <b>{d.product}</b> on <span className="font-mono">localhost:{d.port}</span>
                    {have ? "" : "?"}
                  </span>
                  <span className="truncate text-xs text-muted">
                    {d.container ? `Docker: ${d.container} · ` : ""}user {d.user}
                    {d.database ? ` · ${d.database}` : ""}
                  </span>
                  {d.hint && !have && <span className="text-xs text-muted">{d.hint}</span>}
                </div>
                {have ? (
                  <Button
                    className="h-8"
                    onClick={() => {
                      onClose();
                      openConn(have);
                    }}
                    title={`Saved as "${have.name}"`}
                  >
                    Open
                  </Button>
                ) : (
                  <Button variant="primary" className="h-8" onClick={() => add(d)}>
                    Add
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
