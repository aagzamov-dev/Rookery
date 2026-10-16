import { useEffect, useState, type ReactNode } from "react";
import { KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../../ipc/api";
import type { KnownHost } from "../../ipc/bindings/KnownHost";
import { askConfirm } from "../../stores/dialogs";
import type { Host } from "../../ipc/bindings/Host";
import { useHosts } from "../../stores/hosts";
import type { PageKind } from "../../stores/tabs";
import { SnippetsPage } from "../snippets/SnippetsPage";
import { SettingsPage } from "../settings/SettingsPage";
import { ShortcutsPage } from "../shortcuts/ShortcutsPage";
import { DashboardPage } from "../dashboard/DashboardPage";
import { BackupPage } from "../backup/BackupPage";
import { HostsTable } from "../hosts/HostsTable";

/** Page tabs. None of them touch the network on open. */
export function PageTab({ page, active, onEditHost }: { page: PageKind; active: boolean; onEditHost: (h: Host) => void }) {
  return (
    <div className={page === "snippets" ? "absolute inset-0 bg-bg" : "absolute inset-0 overflow-auto bg-bg"} style={{ display: active ? "block" : "none" }}>
      {page === "dashboard" && <DashboardPage />}
      {page === "hosts" && <HostsPage onEditHost={onEditHost} />}
      {page === "snippets" && <SnippetsPage />}
      {page === "tunnels" && <Soon title="Tunnels" version="v0.5" text="Port forwarding with on/off switches. Each tunnel keeps its server session alive." />}
      {page === "settings" && <SettingsPage />}
      {page === "shortcuts" && <ShortcutsPage />}
      {page === "backup" && <BackupPage />}
    </div>
  );
}

function Soon({ title, version, text }: { title: string; version: string; text: string }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-md text-center">
        <h2 className="m-0 mb-2 text-base font-semibold">
          {title} <span className="ml-1 rounded-full bg-panel2 px-2 py-0.5 text-[11px] font-medium text-muted">{version}</span>
        </h2>
        <p className="m-0 leading-relaxed text-muted">{text}</p>
      </div>
    </div>
  );
}

function HostsPage({ onEditHost }: { onEditHost: (h: Host) => void }) {
  const hosts = useHosts((s) => s.hosts);
  const identities = useHosts((s) => s.identities);
  return (
    <div className="flex flex-wrap gap-6 p-6">
      <HostsTable onEditHost={onEditHost} />
      <Section title="Identities" icon={<KeyRound size={16} />}>
        {identities.map((i) => (
          <div key={i.id} className="flex flex-col gap-1 rounded-lg border border-line bg-panel2 p-3">
            <span className="flex items-center gap-2">
              <span className="font-semibold">{i.name}</span>
              <span className="ml-auto text-[11px] text-muted">{hosts.filter((h) => h.identity_id === i.id).length} hosts</span>
            </span>
            <span className="font-mono text-[11px] text-muted">
              {i.username} · {i.auth.replace(/_/g, " ")}
              {i.has_password && " · password saved"}
              {i.has_passphrase && " · passphrase saved"}
            </span>
          </div>
        ))}
        {identities.length === 0 && <p className="text-muted">Identities are created from the host editor.</p>}
      </Section>
      <KnownHosts />
    </div>
  );
}

/** Trusted server keys. Forget one and the next connection asks again (e.g. after a reinstall). */
function KnownHosts() {
  const hosts = useHosts((s) => s.hosts);
  const [list, setList] = useState<KnownHost[] | null>(null);
  const load = () => void api.knownHostsList().then(setList).catch(() => setList([]));
  useEffect(load, []);
  return (
    <section className="flex w-full flex-col gap-2">
      <h2 className="m-0 mb-1 flex items-center gap-2 text-lg font-semibold">
        <ShieldCheck size={16} className="text-accent" /> Trusted host keys
      </h2>
      {list?.length === 0 && <p className="m-0 text-muted">No trusted keys yet — you approve each server's key the first time you connect.</p>}
      {list?.map((k) => {
        const h = hosts.find((x) => x.id === k.host_id);
        return (
          <div key={k.host_id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2.5">
            <span className="min-w-[140px] font-medium">{h?.name ?? "deleted host"}</span>
            <span className="text-xs text-muted">{k.key_type}</span>
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{k.fingerprint}</code>
            <span className="text-xs text-muted">last seen {new Date(k.last_seen).toLocaleDateString()}</span>
            <button
              onClick={async () => {
                const ok = await askConfirm({
                  title: `Forget the key of ${h?.name ?? "this host"}?`,
                  body: "The next connection will show the server's fingerprint and ask you to trust it again. Do this after reinstalling a server.",
                  preview: k.fingerprint,
                  confirmLabel: "Forget key",
                  danger: true,
                });
                if (!ok) return;
                await api.knownHostForget(k.host_id);
                load();
              }}
              className="flex items-center gap-1.5 text-xs text-[#FFA8A8] hover:underline"
            >
              <Trash2 size={12} /> Forget
            </button>
          </div>
        );
      })}
    </section>
  );
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-[280px] flex-1 flex-col gap-2">
      <h2 className="m-0 mb-2 flex items-center gap-2 text-lg font-semibold">
        <span className="text-accent">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}
