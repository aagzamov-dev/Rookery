import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Database, Loader2 } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { DbConnection } from "../../ipc/bindings/DbConnection";
import type { SqlTarget } from "../../ipc/bindings/SqlTarget";
import { useHosts } from "../../stores/hosts";
import { useSql } from "../../stores/sql";
import { useTabs, type DbTarget, type Tab } from "../../stores/tabs";
import { Button, TextInput } from "../../ui/primitives";
import { useConnDialog } from "./connDialog";
const SqlTab = lazy(() => import("./SqlTab").then((module) => ({ default: module.SqlTab })));
import { stripUrlPassword } from "./url";

export { isDbUrl } from "./url";

/**
 * Passwords typed for unsaved (URL) tabs: memory only, never in the tab state or `ui.session`.
 * Keyed by tab id; gone when the app restarts.
 */
export const tabPasswords = new Map<string, string>();

/** Open a quick-connect URL as an unsaved database tab. */
export function openDbUrl(raw: string) {
  const { url, password, title } = stripUrlPassword(raw);
  const id = useTabs.getState().openDb({ kind: "url", url }, title, true);
  if (password) tabPasswords.set(id, password);
}

/** URL → a prefilled saved connection ("Save" on an unsaved tab). */
function prefillFromUrl(url: string): Partial<DbConnection> {
  try {
    const u = new URL(url);
    const scheme = u.protocol.replace(":", "").toLowerCase();
    const viaSsh = scheme.startsWith("ssh+");
    const engine = scheme.replace("ssh+", "").startsWith("postgres") ? "postgres" : "mysql";
    const db = decodeURIComponent(u.pathname.replace(/^\//, "")) || null;
    const p: Partial<DbConnection> = {
      engine,
      name: `${u.hostname}${db ? ` ${db}` : ""}`,
      username: decodeURIComponent(u.username) || (engine === "mysql" ? "root" : "postgres"),
      database: db,
      port: u.port ? Number(u.port) : engine === "mysql" ? 3306 : 5432,
    };
    if (viaSsh) {
      const host = useHosts.getState().hosts.find((h) => h.name.toLowerCase() === u.hostname.toLowerCase());
      return { ...p, via: "ssh", host_id: host?.id ?? null, address: "127.0.0.1", ssl_mode: "disable" };
    }
    return { ...p, address: u.hostname, ssl_mode: ["localhost", "127.0.0.1"].includes(u.hostname) ? "disable" : "prefer" };
  } catch {
    return {};
  }
}

function sqlTarget(t: DbTarget, password: string | undefined): SqlTarget {
  return t.kind === "saved" ? { kind: "saved", id: t.id } : { kind: "url", url: t.url, password: password ?? null };
}

/** A database tab: connects the first time it is shown (restored tabs wait for a click). */
export function DbTab({ tab, active, requestsActive = active }: { tab: Extract<Tab, { kind: "db" }>; active: boolean; requestsActive?: boolean }) {
  const deferred = useTabs((s) => !!s.deferred[tab.id]);
  const conn = useSql((s) => (tab.target.kind === "saved" ? s.conns.find((c) => c.id === (tab.target as { id: string }).id) : undefined));
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askPassword, setAskPassword] = useState(false);
  const [pw, setPw] = useState("");
  const meta = useSql((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const tried = useRef(false);
  const generation = useRef(0);
  const sid = useRef<string | null>(null);

  const connect = async (password?: string) => {
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const o = await api.sqlOpen(sqlTarget(tab.target, password ?? tabPasswords.get(tab.id)));
      if (request !== generation.current) { void api.sqlClose(o.session_id); return; }
      if (password) tabPasswords.set(tab.id, password);
      useSql.getState().opened(o, tab.id);
      sid.current = o.session_id;
      setSessionId(o.session_id);
      setAskPassword(false);
    } catch (e) {
      if (request !== generation.current) return;
      const msg = asCoreError(e).message;
      setError(msg);
      // A login failure without a saved password: ask for one.
      if (/password|login failed|authentication/i.test(msg) && !(conn?.has_password && !password)) setAskPassword(true);
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (requestsActive && !deferred && !sessionId && !tried.current) {
      tried.current = true;
      void connect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestsActive, deferred, sessionId]);

  // Closing the tab closes the session (an open transaction rolls back).
  sid.current = sessionId;
  useEffect(
    () => () => {
      generation.current++;
      tried.current = false;
      if (sid.current) {
        void api.sqlClose(sid.current);
        useSql.getState().forgetSession(sid.current);
      }
      // The in-memory password is dropped in closeTab (not here: dev mode remounts once).
    },
    [tab.id],
  );

  const save = () =>
    useConnDialog.getState().open({ prefill: tab.target.kind === "url" ? prefillFromUrl(tab.target.url) : {}, password: tabPasswords.get(tab.id) }, (c) => {
      // The tab becomes the saved connection's tab.
      useTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...tab, target: { kind: "saved", id: c.id }, title: c.name } : t)) }));
    });

  if (sessionId && meta) {
    return (
      <div className="absolute inset-0" style={{ display: active ? "block" : "none" }}>
        <Suspense fallback={<div role="status" className="p-4 text-muted">Loading database editor…</div>}>
      <SqlTab
        visible={active}
        requestsActive={requestsActive}
          tabKey={tab.id}
          sessionId={sessionId}
          label={conn?.name ?? tab.title}
          env={conn?.env_label}
          extra={tab.target.kind === "url"
            ? [{ label: "Save connection", onClick: save }]
            : conn ? [{ label: "Edit connection", onClick: () => useConnDialog.getState().open({ conn }) }] : []}
        />
      </Suspense>
      </div>
    );
  }

  const name = conn?.name ?? tab.title;
  return (
    <div className="absolute inset-0 grid place-items-center bg-bg" style={{ display: active ? "grid" : "none" }}>
      <div className="flex max-w-md flex-col items-center gap-3 text-center text-muted">
        <Database size={22} className="text-accent" />
        <b className="text-text">{name}</b>
        {busy ? (
          <span className="flex items-center gap-2">
            <Loader2 size={15} className="animate-spin text-accent" /> Connecting…
          </span>
        ) : askPassword ? (
          <form
            className="flex w-80 flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void connect(pw);
            }}
          >
            {error && <span className="text-[13px] text-prod-fg">{error}</span>}
            <TextInput type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
            <span className="text-[11px]">Kept in memory for this tab. Save the connection to keep it in the vault.</span>
            <Button variant="primary" type="submit">
              Connect
            </Button>
          </form>
        ) : (
          <>
            <span className={error ? "text-[13px] text-prod-fg" : ""}>{error ?? "Not connected yet."}</span>
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  useTabs.getState().setDeferred(tab.id, false);
                  void connect();
                }}
              >
                Connect
              </Button>
              {conn && error && <Button onClick={() => useConnDialog.getState().open({ conn })}>Edit connection</Button>}
              {!conn && tab.target.kind === "saved" && <span className="text-xs">This connection was deleted.</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
