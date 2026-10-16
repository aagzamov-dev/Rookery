import { useEffect, useMemo, useRef, useState } from "react";
import { Database, KeyRound, Loader2, X } from "lucide-react";
import type { DbConnection } from "../../ipc/bindings/DbConnection";
import { api, asCoreError } from "../../ipc/api";
import type { DbEngine } from "../../ipc/bindings/DbEngine";
import { askConfirm } from "../../stores/dialogs";
import { useHosts } from "../../stores/hosts";
import { useSql } from "../../stores/sql";
import { Button, Field, Select, TextInput } from "../../ui/primitives";
import { blankConn } from "./ConnectionDialog";
import { useConnDialog } from "./connDialog";
import { sqlKeyForHost } from "./registry";
import { SqlTab } from "./SqlTab";

const DEFAULTS: Record<DbEngine, { port: string; user: string }> = {
  postgres: { port: "5432", user: "postgres" },
  mysql: { port: "3306", user: "root" },
};
const DEFAULTS_PORT: Record<DbEngine, number> = { postgres: 5432, mysql: 3306 };

/**
 * Server tab → Database: a database on (or reachable from) this server, through its SSH
 * session. Nothing connects until the view is opened.
 *
 * "Remember password" (on by default): after a successful connect, the login is kept as a saved
 * connection through this server, its password in the vault (`dbconn:<id>:password`), like SSH
 * logins. The next time the view opens, it connects with it by itself. A login that failed is
 * never saved. Unticking it forgets the password.
 */
export function ServerDbView({ hostId }: { hostId: string }) {
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const [engine, setEngine] = useState<DbEngine>("postgres");
  const [address, setAddress] = useState("127.0.0.1");
  const [port, setPort] = useState(DEFAULTS.postgres.port);
  const [user, setUser] = useState(DEFAULTS.postgres.user);
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const meta = useSql((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const prefill = useSql((s) => s.serverPrefill[hostId]);
  /** Docker "Open in SQL": where the values came from, and where the password is. */
  const [source, setSource] = useState<{ name: string; note: string | null; passwordHint: string | null } | null>(null);

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

  // Docker → Open in SQL: fill the form, then ask for the password (never read from the container).
  useEffect(() => {
    if (!prefill) return;
    useSql.getState().setServerPrefill(hostId, null);
    void (async () => {
      if (open.current) {
        const ok = await askConfirm({
          title: `Open ${prefill.name} instead?`,
          body: "This closes the current database connection in this view.",
          confirmLabel: "Close and open",
        });
        if (!ok) return;
        await api.sqlClose(open.current).catch(() => {});
        useSql.getState().forgetSession(open.current);
        setSessionId(null);
      }
      setEngine(prefill.engine);
      setAddress(prefill.address);
      setPort(String(prefill.port));
      setUser(prefill.user);
      setDatabase(prefill.database ?? "");
      setPassword("");
      setError(null);
      setSource({ name: prefill.name, note: prefill.note, passwordHint: prefill.password_hint });
      setTimeout(() => document.getElementById(`sql-pw-${hostId}`)?.focus(), 50);
    })();
  }, [prefill, hostId]);

  // Logins remembered for this server (newest first).
  const conns = useSql((s) => s.conns);
  const connsLoaded = useSql((s) => s.connsLoaded);
  const saved = useMemo(() => conns.filter((c) => c.via === "ssh" && c.host_id === hostId).sort((a, b) => b.updated_at - a.updated_at), [conns, hostId]);
  const sameLogin = (c: DbConnection) =>
    c.engine === engine && c.address === (address.trim() || "127.0.0.1") && c.port === (Number(port) || DEFAULTS_PORT[engine]) && c.username === user.trim();
  const current = saved.find(sameLogin);
  useEffect(() => {
    if (!connsLoaded) void useSql.getState().loadConns().catch(() => {});
  }, [connsLoaded]);

  const fill = (c: DbConnection) => {
    setEngine(c.engine);
    setAddress(c.address);
    setPort(String(c.port));
    setUser(c.username);
    setDatabase(c.database ?? "");
    setPassword("");
    setRemember(true);
  };

  /** Connect with a remembered login (the password stays in the vault). */
  const connectSaved = async (c: DbConnection) => {
    fill(c);
    setBusy(true);
    setError(null);
    try {
      const o = await api.sqlOpen({ kind: "saved", id: c.id });
      useSql.getState().opened(o, sqlKeyForHost(hostId));
      setSessionId(o.session_id);
    } catch (e) {
      setError(`${asCoreError(e).message} — type the password again to update the saved one.`);
      setTimeout(() => document.getElementById(`sql-pw-${hostId}`)?.focus(), 50);
    } finally {
      setBusy(false);
    }
  };

  // Opening the view with a remembered login connects at once (like a server's SSH session).
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || !connsLoaded || sessionId || prefill) return;
    autoTried.current = true;
    const c = saved.find((x) => x.has_password);
    if (c) void connectSaved(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connsLoaded, saved, sessionId, prefill]);

  /** Remember (or forget) the login after a successful connect. Never saves a failed login. */
  const rememberLogin = async (openedDb: string | null) => {
    const m = current;
    if (!remember) {
      if (m?.has_password) await useSql.getState().saveConn(m, "").catch(() => {});
      return;
    }
    if (!password) return; // connected with the saved password: nothing new to keep
    const conn: DbConnection = m
      ? { ...m, database: database.trim() || m.database }
      : blankConn({
          name: `${host?.name ?? "server"} · ${database.trim() || openedDb || (engine === "mysql" ? "mysql" : "postgres")}`,
          engine,
          via: "ssh",
          host_id: hostId,
          address: address.trim() || "127.0.0.1",
          port: Number(port) || DEFAULTS_PORT[engine],
          username: user.trim(),
          database: database.trim() || null,
          env_label: host?.env_label ?? "none",
        });
    await useSql.getState().saveConn(conn, password).catch((e) => setError(`Connected, but the password could not be saved: ${asCoreError(e).message}`));
  };

  const forget = async (c: DbConnection) => {
    const ok = await askConfirm({
      title: `Forget the password for ${c.username}@${c.address}:${c.port}?`,
      body: "It is removed from the vault (on your other devices too, after sync). The connection stays in the SQL list without a password.",
      confirmLabel: "Forget password",
    });
    if (ok) await useSql.getState().saveConn(c, "").catch((e) => setError(asCoreError(e).message));
  };

  const pickEngine = (e: DbEngine) => {
    // Follow the engine's defaults unless they were changed by hand.
    if (port === DEFAULTS[engine].port) setPort(DEFAULTS[e].port);
    if (user === DEFAULTS[engine].user) setUser(DEFAULTS[e].user);
    setEngine(e);
  };

  const connect = async () => {
    // Nothing typed and this login's password is remembered: use the vault.
    if (!password && current?.has_password) return connectSaved(current);
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
      await rememberLogin(o.database);
      setPassword("");
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
                  password: password || undefined,
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
        {source && (
          <div className="rounded-lg border border-accent-line bg-accent-bg px-3 py-2 text-xs">
            Filled in from the container <b>{source.name}</b>
            {source.note ? ` (${source.note})` : ""}. Type the password
            {source.passwordHint ? <> — it is the value of {source.passwordHint}</> : ""}; Rookery does not read it from the container.
          </div>
        )}
        {saved.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">Saved logins on this server</span>
            {saved.map((c) => (
              <div key={c.id} className="flex items-center gap-2 rounded-lg border border-line bg-bg px-2.5 py-1.5">
                <button type="button" onClick={() => (c.has_password ? void connectSaved(c) : fill(c))} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] hover:text-accent" title={c.has_password ? "Connect with the saved password" : "Fill in (no password saved)"}>
                  <span aria-hidden>{c.engine === "mysql" ? "🐬" : "🐘"}</span>
                  <span className="truncate font-mono text-xs">
                    {c.username}@{c.address}:{c.port}
                    {c.database ? `/${c.database}` : ""}
                  </span>
                  {c.has_password && <KeyRound size={12} className="flex-none text-ok" aria-label="password saved" />}
                </button>
                {c.has_password && (
                  <button type="button" aria-label="Forget password" title="Forget the saved password" onClick={() => void forget(c)} className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-panel2 hover:text-text">
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
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
          <Field label="Password">
            <TextInput
              id={`sql-pw-${hostId}`}
              type="password"
              autoComplete="off"
              value={password}
              placeholder={current?.has_password ? "saved — leave empty to use it" : ""}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Database (optional)">
          <TextInput mono value={database} onChange={(e) => setDatabase(e.target.value)} placeholder={engine === "postgres" ? "same as the user" : "none"} />
        </Field>
        <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
          <input type="checkbox" className="mt-0.5 accent-accent" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span className="flex flex-col gap-0.5">
            <span>Remember password</span>
            <span className="text-xs text-muted">
              {remember
                ? "Kept encrypted in the vault, like SSH logins, and used next time you open this view. Saved only after a successful login."
                : current?.has_password
                  ? "The saved password for this login is forgotten when you connect."
                  : "Kept in memory for this tab only."}
            </span>
          </span>
        </label>
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
