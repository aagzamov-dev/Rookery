import { useEffect, useRef, useState } from "react";
import { Database, Loader2 } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { DbEngine } from "../../ipc/bindings/DbEngine";
import { useHosts } from "../../stores/hosts";
import { useSql } from "../../stores/sql";
import { Button, Field, Select, TextInput } from "../../ui/primitives";
import { useConnDialog } from "./connDialog";
import { sqlKeyForHost } from "./registry";
import { SqlTab } from "./SqlTab";

const DEFAULTS: Record<DbEngine, { port: string; user: string }> = {
  postgres: { port: "5432", user: "postgres" },
  mysql: { port: "3306", user: "root" },
};

/**
 * Server tab → Database: a database on (or reachable from) this server, through its SSH
 * session. Nothing connects until you press Connect. The password stays in memory only.
 */
export function ServerDbView({ hostId }: { hostId: string }) {
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const [engine, setEngine] = useState<DbEngine>("postgres");
  const [address, setAddress] = useState("127.0.0.1");
  const [port, setPort] = useState(DEFAULTS.postgres.port);
  const [user, setUser] = useState(DEFAULTS.postgres.user);
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const meta = useSql((s) => (sessionId ? s.sessions[sessionId] : undefined));

  // Closing the server tab closes the database session (and releases its SSH lease).
  const open = useRef<string | null>(null);
  useEffect(() => {
    open.current = sessionId;
  }, [sessionId]);
  useEffect(
    () => () => {
      if (open.current) {
        void api.sqlClose(open.current);
        useSql.getState().forgetSession(open.current);
      }
    },
    [],
  );

  const pickEngine = (e: DbEngine) => {
    // Follow the engine's defaults unless they were changed by hand.
    if (port === DEFAULTS[engine].port) setPort(DEFAULTS[e].port);
    if (user === DEFAULTS[engine].user) setUser(DEFAULTS[e].user);
    setEngine(e);
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const o = await api.sqlOpen({
        kind: "server",
        host_id: hostId,
        engine,
        address: address.trim() || "127.0.0.1",
        port: Number(port) || 0,
        user: user.trim(),
        database: database.trim() || null,
        password: password || null,
      });
      useSql.getState().opened(o, sqlKeyForHost(hostId));
      setSessionId(o.session_id);
    } catch (e) {
      setError(asCoreError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!sessionId) return;
    await api.sqlClose(sessionId).catch(() => {});
    useSql.getState().forgetSession(sessionId);
    setSessionId(null);
  };

  if (sessionId && meta) {
    return (
      <SqlTab
        tabKey={sqlKeyForHost(hostId)}
        sessionId={sessionId}
        label={host?.name ?? "server"}
        env={host?.env_label}
        extra={
          <>
            <Button
              className="h-7"
              title="Save as a database connection (sidebar → Databases); the password goes to the vault"
              onClick={() =>
                useConnDialog.getState().open({
                  prefill: {
                    name: `${host?.name ?? "server"} ${database.trim() || meta.database || (engine === "mysql" ? "mysql" : "postgres")}`,
                    engine,
                    via: "ssh",
                    host_id: hostId,
                    address: address.trim() || "127.0.0.1",
                    port: Number(port) || 0,
                    username: user.trim(),
                    database: database.trim() || meta.database,
                    ssl_mode: "disable",
                    env_label: host?.env_label ?? "none",
                  },
                  password,
                })
              }
            >
              Save
            </Button>
            <Button className="h-7" onClick={disconnect}>
              Disconnect
            </Button>
          </>
        }
      />
    );
  }

  return (
    <div className="absolute inset-0 overflow-auto bg-bg p-6">
      <form
        className="mx-auto flex max-w-[520px] flex-col gap-4 rounded-xl border border-line bg-panel p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <div className="flex items-center gap-2">
          <Database size={16} className="text-accent" />
          <h2 className="m-0 text-[15px] font-semibold">Database on {host?.name ?? "this server"}</h2>
        </div>
        <p className="m-0 text-xs text-muted">
          Connects through this server's SSH session. The address is as seen from the server, so 127.0.0.1 means a database running on it.
          {host?.env_label === "prod" && " This is a PROD server: the database opens read-only."}
        </p>
        <div className="grid grid-cols-[1fr_2fr_1fr] gap-3">
          <Field label="Engine">
            <Select value={engine} onChange={(e) => pickEngine(e.target.value as DbEngine)}>
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL / MariaDB</option>
            </Select>
          </Field>
          <Field label="Address (from the server)">
            <TextInput mono value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <Field label="Port">
            <TextInput mono inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="User">
            <TextInput mono value={user} onChange={(e) => setUser(e.target.value)} />
          </Field>
          <Field label="Password" hint="Kept in memory for this tab only.">
            <TextInput type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </div>
        <Field label="Database (optional)">
          <TextInput mono value={database} onChange={(e) => setDatabase(e.target.value)} placeholder={engine === "postgres" ? "same as the user" : "none"} />
        </Field>
        {error && <div className="rounded-lg border border-[#5A2D33] bg-[#33232A] px-3 py-2 text-[13px] text-prod-fg">{error}</div>}
        <div className="flex justify-end">
          <Button variant="primary" type="submit" disabled={busy || !user.trim()}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            Connect
          </Button>
        </div>
      </form>
    </div>
  );
}
