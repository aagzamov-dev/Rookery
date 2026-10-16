import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { DbConnection } from "../../ipc/bindings/DbConnection";
import type { DbEngine } from "../../ipc/bindings/DbEngine";
import type { EnvLabel } from "../../ipc/bindings/EnvLabel";
import type { SslMode } from "../../ipc/bindings/SslMode";
import { useHosts } from "../../stores/hosts";
import { useSql } from "../../stores/sql";
import { Button, Field, Modal, Select, TextInput } from "../../ui/primitives";

export interface ConnDraft {
  /** Edit this saved connection. */
  conn?: DbConnection;
  /** Prefill a new one (quick connect URL, server view). */
  prefill?: Partial<DbConnection>;
  /** A password typed earlier (kept in memory); saved only when you press Save. */
  password?: string;
}

const PORTS: Record<DbEngine, number> = { postgres: 5432, mysql: 3306 };
const ENVS: EnvLabel[] = ["none", "prod", "staging", "dev", "lab", "client"];
const isLocal = (a: string) => ["localhost", "127.0.0.1", "::1"].includes(a.trim().toLowerCase());

export function blankConn(p: Partial<DbConnection> = {}): DbConnection {
  const engine = p.engine ?? "postgres";
  return {
    id: "",
    name: "",
    engine,
    via: "direct",
    host_id: null,
    address: "127.0.0.1",
    port: PORTS[engine],
    username: engine === "mysql" ? "root" : "postgres",
    database: null,
    ssl_mode: "disable",
    ca_path: null,
    env_label: "none",
    group_id: null,
    read_only: false,
    row_limit: 500,
    timeout_s: 30,
    sort: 0,
    created_at: 0,
    updated_at: 0,
    has_password: false,
    ...p,
  };
}

/** SSL default for where the database is: none for this PC and through a server, prefer otherwise. */
function defaultSsl(c: DbConnection): SslMode {
  return c.via === "ssh" || isLocal(c.address) ? "disable" : "prefer";
}

/** New / edit database connection (docs/07 §2.3). The password goes to the vault and never comes back. */
export function ConnectionDialog({ draft, onClose, onSaved }: { draft: ConnDraft; onClose: () => void; onSaved?: (c: DbConnection) => void }) {
  const hosts = useHosts((s) => s.hosts);
  const groups = useHosts((s) => s.groups);
  const [c, setC] = useState<DbConnection>(() => draft.conn ?? blankConn(draft.prefill));
  const [password, setPassword] = useState(draft.password ?? "");
  const [forget, setForget] = useState(false);
  const [sslTouched, setSslTouched] = useState(!!draft.conn || !!draft.prefill?.ssl_mode);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const patch = (p: Partial<DbConnection>) =>
    setC((prev) => {
      const next = { ...prev, ...p };
      // Port / user follow the engine unless changed by hand.
      if (p.engine && p.engine !== prev.engine) {
        if (prev.port === PORTS[prev.engine]) next.port = PORTS[p.engine];
        if (prev.username === (prev.engine === "mysql" ? "root" : "postgres")) next.username = p.engine === "mysql" ? "root" : "postgres";
      }
      if (!sslTouched && (p.address !== undefined || p.via !== undefined)) next.ssl_mode = defaultSsl(next);
      return next;
    });

  const prod = c.env_label === "prod";
  const unencrypted = c.via === "direct" && !isLocal(c.address) && c.ssl_mode === "disable";
  // undefined = keep the saved one, "" = forget it, value = set.
  const pwArg = forget ? "" : password ? password : undefined;

  const runTest = async () => {
    setBusy("test");
    setTest(null);
    try {
      const r = await api.sqlTest({ ...c, name: c.name || "test" }, password || undefined);
      setTest({ ok: true, text: `Connected · ${r.server_version} · ${r.latency_ms} ms` });
    } catch (e) {
      setTest({ ok: false, text: asCoreError(e).message });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const name = c.name.trim() || `${c.database ?? c.address}`;
      const saved = await useSql.getState().saveConn({ ...c, name, read_only: c.read_only || prod }, pwArg);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(asCoreError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const pickCa = async () => {
    const p = await openDialog({ multiple: false, filters: [{ name: "Certificates", extensions: ["pem", "crt", "cer"] }] });
    if (typeof p === "string") patch({ ca_path: p });
  };

  return (
    <Modal
      title={draft.conn ? `Edit ${draft.conn.name}` : "New database connection"}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button className="mr-auto" onClick={runTest} disabled={busy !== null || !c.address.trim()}>
            {busy === "test" && <Loader2 size={14} className="animate-spin" />}
            Test connection
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy !== null || !c.address.trim() || (c.via === "ssh" && !c.host_id)}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
        <Field label="Name">
          <TextInput value={c.name} placeholder="shop prod" onChange={(e) => patch({ name: e.target.value })} autoFocus />
        </Field>
        <Field label="Engine">
          <Select value={c.engine} onChange={(e) => patch({ engine: e.target.value as DbEngine })}>
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL / MariaDB</option>
          </Select>
        </Field>
        <Field label="Environment">
          <Select value={c.env_label} onChange={(e) => patch({ env_label: e.target.value as EnvLabel })}>
            {ENVS.map((e) => (
              <option key={e} value={e}>
                {e === "none" ? "—" : e.toUpperCase()}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Connect via">
          <Select value={c.via} onChange={(e) => patch({ via: e.target.value as DbConnection["via"], host_id: e.target.value === "ssh" ? (c.host_id ?? hosts[0]?.id ?? null) : null })}>
            <option value="direct">Direct (from this PC)</option>
            <option value="ssh">Through a server (SSH)</option>
          </Select>
        </Field>
        {c.via === "ssh" ? (
          <Field label="Server">
            <Select value={c.host_id ?? ""} onChange={(e) => patch({ host_id: e.target.value || null })}>
              {!c.host_id && <option value="">Pick a server…</option>}
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Group (optional)">
            <Select value={c.group_id ?? ""} onChange={(e) => patch({ group_id: e.target.value || null })}>
              <option value="">No group</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      <div className="grid grid-cols-[3fr_1fr] gap-3">
        <Field label={c.via === "ssh" ? "Database host (as seen from the server)" : "Host"} hint={isLocal(c.address) && c.via === "direct" ? "This computer's database. On another device it means that device's database." : undefined}>
          <TextInput mono value={c.address} onChange={(e) => patch({ address: e.target.value })} />
        </Field>
        <Field label="Port">
          <TextInput mono inputMode="numeric" value={String(c.port || "")} onChange={(e) => patch({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Field label="User">
          <TextInput mono value={c.username} onChange={(e) => patch({ username: e.target.value })} />
        </Field>
        <Field label="Password" hint={c.has_password && !forget ? "Saved. Type to change." : "Kept in the vault, never shown again."}>
          <TextInput type="password" autoComplete="off" value={password} placeholder={c.has_password && !forget ? "unchanged" : ""} disabled={forget} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Database (optional)">
          <TextInput mono value={c.database ?? ""} onChange={(e) => patch({ database: e.target.value || null })} />
        </Field>
      </div>
      {c.has_password && (
        <label className="-mt-2 flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={forget} onChange={(e) => setForget(e.target.checked)} /> Forget the saved password
        </label>
      )}

      <div className="grid grid-cols-[1fr_2fr] gap-3">
        <Field label="SSL" hint="Cloud databases (RDS, DigitalOcean, Supabase): require.">
          <Select
            value={c.ssl_mode}
            onChange={(e) => {
              setSslTouched(true);
              patch({ ssl_mode: e.target.value as SslMode });
            }}
          >
            <option value="disable">disable</option>
            <option value="prefer">prefer</option>
            <option value="require">require</option>
            <option value="verify-full">verify-full</option>
          </Select>
        </Field>
        {c.ssl_mode === "verify-full" && (
          <Field label="CA file (optional)">
            <div className="flex gap-2">
              <TextInput mono className="min-w-0 flex-1" value={c.ca_path ?? ""} placeholder="system certificates" onChange={(e) => patch({ ca_path: e.target.value || null })} />
              <Button onClick={pickCa}>Browse…</Button>
            </div>
          </Field>
        )}
      </div>
      {unencrypted && (
        <div className="flex items-center gap-2 rounded-lg border border-[#6A5828] bg-[#2F2A1E] px-3 py-2 text-[13px] text-[#F7CB6A]">
          <AlertTriangle size={14} /> Password and data travel unencrypted. Use SSL or connect through a server.
        </div>
      )}

      <div className="grid grid-cols-[2fr_1fr_1fr] items-end gap-3">
        <label className="flex h-9 items-center gap-2 text-[13px]">
          <input type="checkbox" checked={c.read_only || prod} disabled={prod} onChange={(e) => patch({ read_only: e.target.checked })} />
          Open read-only
          {prod && <span className="text-xs text-muted">(always on PROD)</span>}
        </label>
        <Field label="Row limit">
          <TextInput mono inputMode="numeric" value={String(c.row_limit)} onChange={(e) => patch({ row_limit: Number(e.target.value.replace(/\D/g, "")) || 1 })} />
        </Field>
        <Field label="Timeout (s)">
          <TextInput mono inputMode="numeric" value={String(c.timeout_s)} onChange={(e) => patch({ timeout_s: Number(e.target.value.replace(/\D/g, "")) || 1 })} />
        </Field>
      </div>

      {test && (
        <div className={test.ok ? "flex items-center gap-2 text-[13px] text-ok" : "rounded-lg border border-[#5A2D33] bg-[#33232A] px-3 py-2 text-[13px] text-prod-fg"}>
          {test.ok && <CheckCircle2 size={14} />}
          {test.text}
        </div>
      )}
      {error && <div className="rounded-lg border border-[#5A2D33] bg-[#33232A] px-3 py-2 text-[13px] text-prod-fg">{error}</div>}
    </Modal>
  );
}
