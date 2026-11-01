import { allowDatabaseSessionClose, databaseSessionsForTabs } from "../sql/jobGuard";
import { useEffect, useState } from "react";
import { Database, Plus, X } from "lucide-react";
import type { DbConnection } from "../../ipc/bindings/DbConnection";
import { useTabs } from "../../stores/tabs";
import { useSql } from "../../stores/sql";
import { Button, EnvTag } from "../../ui/primitives";
import { DbTab, tabPasswords } from "../sql/DbTab";
import { useConnDialog } from "../sql/connDialog";
import { sqlKeyForHost } from "../sql/registry";
import { openTransactions, settleTransactions } from "../sql/txGuard";
import { COMPUTER_ID } from "./target";

export const isLocalConnection = (connection: DbConnection) =>
  connection.via === "direct" &&
  ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    connection.address.toLowerCase(),
  );
const tabId = sqlKeyForHost(COMPUTER_ID);

export function ComputerDatabases({
  visible,
  requestsActive,
}: {
  visible: boolean;
  requestsActive: boolean;
}) {
  const connections = useSql((s) => s.conns);
  const prefill = useSql((s) => s.serverPrefill[COMPUTER_ID]);
  const [selected, setSelected] = useState<DbConnection | null>(null);
  const pick = async (connection: DbConnection | null) => {
    if (!(await allowDatabaseSessionClose(databaseSessionsForTabs([tabId])))) return;
    if (
      !(await settleTransactions(
        openTransactions([tabId]),
        "switching local databases",
      ))
    )
      return;
    tabPasswords.delete(tabId);
    if (connection && !isLocalConnection(connection)) {
      useTabs
        .getState()
        .openDb({ kind: "saved", id: connection.id }, connection.name);
      return;
    }
    setSelected(connection);
  };
  useEffect(() => {
    if (!requestsActive || !prefill) return;
    useSql.getState().setServerPrefill(COMPUTER_ID, null);
    useConnDialog
      .getState()
      .open(
        {
          prefill: {
            name: prefill.name,
            via: "direct",
            host_id: null,
            address: prefill.address,
            port: prefill.port,
            engine: prefill.engine,
            username: prefill.user,
            database: prefill.database,
            ssl_mode: "disable",
          },
        },
        (connection) => void pick(connection),
      );
  }, [requestsActive, prefill]);
  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2">
        <Database size={15} className="text-muted" />
        <span className="font-semibold">Local databases</span>
        {selected && (
          <>
            <span className="text-muted">{selected.name}</span>
            <Button className="ml-auto h-7" onClick={() => void pick(null)}>
              <X size={12} /> Connections
            </Button>
          </>
        )}
        {!selected && (
          <Button
            className="ml-auto"
            disabled={!requestsActive}
            onClick={() =>
              useConnDialog
                .getState()
                .open(
                  {
                    prefill: {
                      via: "direct",
                      host_id: null,
                      address: "127.0.0.1",
                      ssl_mode: "disable",
                    },
                  },
                  (connection) => void pick(connection),
                )
            }
          >
            <Plus size={13} /> Add connection
          </Button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {selected ? (
          <DbTab
            key={selected.id}
            tab={{
              id: tabId,
              kind: "db",
              target: { kind: "saved", id: selected.id },
              title: selected.name,
            }}
            active={visible}
            requestsActive={requestsActive}
          />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3 p-5">
            <p className="m-0 text-muted">
              Saved direct connections to this computer. Open a connection for
              SQL, tables and database export/import. Nothing is scanned or
              connected automatically.
            </p>
            {connections.filter(isLocalConnection).map((connection) => (
              <button
                key={connection.id}
                disabled={!requestsActive}
                onClick={() => void pick(connection)}
                className="flex items-center gap-3 rounded-xl border border-line bg-panel p-4 text-left hover:bg-panel2"
              >
                <Database size={17} className="text-accent" />
                <span className="flex-1">
                  <b>{connection.name}</b>
                  <span className="ml-3 text-xs text-muted">
                    {connection.engine} · {connection.address}:{connection.port}
                  </span>
                </span>
                <EnvTag env={connection.env_label} />
              </button>
            ))}
            {!connections.some(isLocalConnection) && (
              <p className="text-muted">
                No saved local connections. Add PostgreSQL, MySQL or MariaDB
                with Add connection.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
