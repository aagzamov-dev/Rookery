import { useMemo, useState } from "react";
import { asCoreError } from "../../ipc/api";
import type { AuthKind } from "../../ipc/bindings/AuthKind";
import type { EnvLabel } from "../../ipc/bindings/EnvLabel";
import type { Host } from "../../ipc/bindings/Host";
import { emptyHost, emptyIdentity, useHosts } from "../../stores/hosts";
import { useTabs } from "../../stores/tabs";
import { closeTab } from "../../app/tabActions";
import { Button, Field, Modal, Select, TextInput } from "../../ui/primitives";
import { useKeys } from "../../stores/keys";
import { RefreshFields } from "./RefreshFields";
import { BUILTIN_THEMES } from "../server-tab/terminal/themes";

export interface HostDraft {
  host?: Host;
  groupId?: string | null;
  quick?: { user: string; address: string; port: number };
}

const INHERIT = "";
const NEW = "__new__";

export function HostEditor({ draft, onClose }: { draft: HostDraft; onClose: () => void }) {
  const groups = useHosts((s) => s.groups);
  const identities = useHosts((s) => s.identities);
  const saveHost = useHosts((s) => s.saveHost);
  const deleteHost = useHosts((s) => s.deleteHost);
  const saveIdentity = useHosts((s) => s.saveIdentity);
  const openServer = useTabs((s) => s.openServer);

  const initial = useMemo<Host>(() => {
    if (draft.host) return draft.host;
    const h = emptyHost(draft.groupId ?? null);
    if (draft.quick) {
      h.name = draft.quick.address;
      h.address = draft.quick.address;
      h.port = draft.quick.port;
    }
    return h;
  }, [draft]);

  const [h, setH] = useState<Host>(initial);
  const [tags, setTags] = useState(initial.tags.join(", "));
  const groupIdentity = useMemo(() => {
    let gid = h.group_id;
    for (let i = 0; gid && i < 32; i++) {
      const g = groups.find((x) => x.id === gid);
      if (!g) break;
      if (g.identity_id) return identities.find((x) => x.id === g.identity_id) ?? null;
      gid = g.parent_id;
    }
    return null;
  }, [h.group_id, groups, identities]);

  const [identSel, setIdentSel] = useState<string>(
    initial.identity_id ?? (draft.quick?.user || (!groupIdentity && identities.length === 0) ? NEW : INHERIT),
  );
  const [newUser, setNewUser] = useState(draft.quick?.user ?? "");
  const [auth, setAuth] = useState<AuthKind>("password");
  const [secret, setSecret] = useState("");
  const [keyPath, setKeyPath] = useState("~/.ssh/id_ed25519");
  const [passphrase, setPassphrase] = useState("");
  const [sudo, setSudo] = useState("");
  const customThemes = useKeys((s) => s.customThemes);
  const themeNames = [...Object.keys(BUILTIN_THEMES), ...Object.keys(customThemes)];
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = identities.find((i) => i.id === identSel);
  const set = <K extends keyof Host>(k: K, v: Host[K]) => setH((x) => ({ ...x, [k]: v }));

  const save = async (connect: boolean) => {
    setErr(null);
    if (!h.name.trim() || !h.address.trim()) return setErr("Name and address are required.");
    setBusy(true);
    try {
      let identityId: string | null = identSel === INHERIT ? null : identSel;
      if (identSel === NEW) {
        if (!newUser.trim()) throw new Error("Username is required.");
        const ident = emptyIdentity();
        ident.name = `${newUser.trim()}@${h.name.trim()}`;
        ident.username = newUser.trim();
        ident.auth = auth;
        ident.key_path = auth === "key_file" ? keyPath.trim() : null;
        const saved = await saveIdentity(ident, {
          password: auth === "password" && secret ? secret : undefined,
          key: auth === "key_in_vault" && secret ? secret : undefined,
          passphrase: auth !== "password" && passphrase ? passphrase : undefined,
          sudo: sudo || undefined,
        });
        identityId = saved.id;
      } else if (selected && (secret || sudo)) {
        await saveIdentity(selected, {
          ...(secret ? (selected.auth === "password" ? { password: secret } : { passphrase: secret }) : {}),
          ...(sudo ? { sudo } : {}),
        });
      }
      const saved = await saveHost({
        ...h,
        name: h.name.trim(),
        address: h.address.trim(),
        identity_id: identityId,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      onClose();
      if (connect) openServer(saved.id, saved.start_view, saved.start_folder);
    } catch (e) {
      setErr(e instanceof Error ? e.message : asCoreError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft.host) return;
    if (!confirm(`Delete ${draft.host.name}? Its saved login stays in Identities.`)) return;
    const tab = useTabs.getState().tabs.find((t) => t.id === `server:${draft.host!.id}`);
    if (tab) closeTab(tab);
    await deleteHost(draft.host.id);
    onClose();
  };

  return (
    <Modal
      title={draft.host ? `Edit ${draft.host.name}` : "New host"}
      onClose={onClose}
      width={620}
      footer={
        <>
          {draft.host && (
            <Button variant="danger" className="mr-auto" onClick={remove}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save(false)} disabled={busy}>
            Save
          </Button>
          <Button variant="primary" onClick={() => save(true)} disabled={busy}>
            Save & open
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[2fr_3fr_80px] gap-3">
        <Field label="Name">
          <TextInput autoFocus value={h.name} onChange={(e) => set("name", e.target.value)} placeholder="prod-api-01" />
        </Field>
        <Field label="Address">
          <TextInput mono value={h.address} onChange={(e) => set("address", e.target.value)} placeholder="203.0.113.10" />
        </Field>
        <Field label="Port">
          <TextInput mono value={h.port} onChange={(e) => set("port", Number(e.target.value.replace(/\D/g, "")) || 22)} />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Group">
          <Select value={h.group_id ?? ""} onChange={(e) => set("group_id", e.target.value || null)}>
            <option value="">No group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Environment">
          <Select value={h.env_label} onChange={(e) => set("env_label", e.target.value as EnvLabel)}>
            {(["none", "prod", "staging", "dev", "lab", "client"] as EnvLabel[]).map((x) => (
              <option key={x} value={x}>
                {x === "none" ? "None" : x.toUpperCase()}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tags" hint="comma separated">
          <TextInput value={tags} onChange={(e) => setTags(e.target.value)} placeholder="laravel, docker" />
        </Field>
      </div>

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-bg p-4">
        <h3 className="m-0 text-xs font-semibold tracking-wider text-muted uppercase">Login</h3>
        <Field label="Identity">
          <Select value={identSel} onChange={(e) => setIdentSel(e.target.value)}>
            <option value={INHERIT}>{groupIdentity ? `Inherit from group (${groupIdentity.name})` : "Inherit from group (none set)"}</option>
            {identities.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} — {i.username}
              </option>
            ))}
            <option value={NEW}>+ New identity…</option>
          </Select>
        </Field>

        {identSel === NEW && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Username">
                <TextInput mono value={newUser} onChange={(e) => setNewUser(e.target.value)} placeholder="deploy" />
              </Field>
              <Field label="Authentication">
                <Select value={auth} onChange={(e) => setAuth(e.target.value as AuthKind)}>
                  <option value="password">Password</option>
                  <option value="key_file">Key file on this computer</option>
                  <option value="key_in_vault">Paste private key (stored in vault)</option>
                </Select>
              </Field>
            </div>
            {auth === "password" && (
              <Field label="Password" hint="Encrypted in your vault.">
                <TextInput type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
              </Field>
            )}
            {auth === "key_file" && (
              <Field label="Private key path">
                <TextInput mono value={keyPath} onChange={(e) => setKeyPath(e.target.value)} />
              </Field>
            )}
            {auth === "key_in_vault" && (
              <Field label="Private key (OpenSSH / PEM)">
                <textarea
                  rows={4}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  className="rounded-lg border border-line bg-panel p-3 font-mono text-xs outline-none focus:border-accent-line"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </Field>
            )}
            {auth !== "password" && (
              <Field label="Key passphrase" hint="Leave empty if the key has none.">
                <TextInput type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
              </Field>
            )}
          </>
        )}

        {selected && (
          <Field
            label={selected.auth === "password" ? "Change password (optional)" : "Change key passphrase (optional)"}
            hint={`Shared by every host using “${selected.name}”.`}
          >
            <TextInput type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="unchanged" />
          </Field>
        )}
        {identSel !== INHERIT && (
          <Field
            label={selected?.has_sudo ? "sudo password (saved — type to change)" : "sudo password (optional)"}
            hint="Lets the terminal offer “Fill sudo password” at a [sudo] prompt. Typed into the server directly — never shown."
          >
            <TextInput type="password" value={sudo} onChange={(e) => setSudo(e.target.value)} placeholder={selected?.has_sudo ? "unchanged" : ""} />
          </Field>
        )}
      </section>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Terminal theme" hint="e.g. a red theme for PROD">
          <Select value={h.theme ?? ""} onChange={(e) => set("theme", e.target.value || null)}>
            <option value="">Default (Settings)</option>
            {themeNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Start folder">
          <TextInput mono value={h.start_folder ?? ""} onChange={(e) => set("start_folder", e.target.value || null)} placeholder="/var/www/shop" />
        </Field>
        <Field label="Start view">
          <Select value={h.start_view} onChange={(e) => set("start_view", e.target.value as Host["start_view"])}>
            <option value="terminal">Terminal</option>
            <option value="overview">Overview</option>
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-5">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={h.auto_reconnect} onChange={(e) => set("auto_reconnect", e.target.checked)} className="accent-accent" />
          Auto-reconnect
        </label>
        <label className="flex items-center gap-2">
          Keep-alive
          <TextInput mono className="h-7 w-16" value={h.keepalive_s} onChange={(e) => set("keepalive_s", Number(e.target.value.replace(/\D/g, "")) || 30)} />s
        </label>
      </div>
      <RefreshFields value={h.refresh} onChange={(v) => set("refresh", v)} parentGroupId={h.group_id} />
      {err && <div className="rounded-lg border border-[#5A2D33] bg-[#33232A] px-3 py-2 text-prod-fg">{err}</div>}
    </Modal>
  );
}
