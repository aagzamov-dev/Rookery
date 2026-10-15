import type { ReactNode } from "react";
import { KeyRound, LayoutGrid } from "lucide-react";
import type { Host } from "../../ipc/bindings/Host";
import { useHosts } from "../../stores/hosts";
import type { PageKind } from "../../stores/tabs";

/** Page tabs. None of them touch the network on open. */
export function PageTab({ page, active, onEditHost }: { page: PageKind; active: boolean; onEditHost: (h: Host) => void }) {
  return (
    <div className="absolute inset-0 overflow-auto bg-bg" style={{ display: active ? "block" : "none" }}>
      {page === "dashboard" && <DashboardPage />}
      {page === "hosts" && <HostsPage onEditHost={onEditHost} />}
      {page === "snippets" && <Soon title="Snippets" version="v0.2" text="Aliases like paserve, variables, hotkeys and the Ctrl+K command palette." />}
      {page === "tunnels" && <Soon title="Tunnels" version="v0.5" text="Port forwarding with on/off switches. Each tunnel keeps its server session alive." />}
      {page === "settings" && <Soon title="Settings" version="v0.6" text="Theme, fonts, shortcuts, auto-lock and refresh defaults." />}
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

function DashboardPage() {
  const hosts = useHosts((s) => s.hosts);
  const groups = useHosts((s) => s.groups);
  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <LayoutGrid size={18} className="text-accent" />
        <h1 className="m-0 text-xl font-semibold">Dashboard</h1>
        <span className="rounded-full bg-panel2 px-2 py-0.5 text-[11px] text-muted">group sync arrives in v0.4</span>
      </div>
      <p className="m-0 max-w-2xl leading-relaxed text-muted">
        The dashboard always renders from saved snapshots on this computer — opening it never connects to a server. Sync and
        auto-sync will be per group, as in the design.
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
        {hosts.map((h) => {
          const g = groups.find((x) => x.id === h.group_id);
          return (
            <div key={h.id} className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4">
              <div className="flex items-center gap-2">
                <span aria-hidden className="h-2 w-2 rounded-full bg-[#6B7690]" />
                <span className="font-semibold">{h.name}</span>
                {g && <span className="ml-auto text-xs text-muted">{g.name}</span>}
              </div>
              <span className="font-mono text-xs text-muted">{h.address}</span>
              <span className="text-xs text-muted">Never synced</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HostsPage({ onEditHost }: { onEditHost: (h: Host) => void }) {
  const hosts = useHosts((s) => s.hosts);
  const identities = useHosts((s) => s.identities);
  return (
    <div className="flex flex-wrap gap-6 p-6">
      <section className="flex min-w-[320px] flex-[2] flex-col gap-2">
        <h1 className="m-0 mb-2 text-lg font-semibold">Hosts</h1>
        {hosts.map((h) => (
          <button key={h.id} onClick={() => onEditHost(h)} className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2.5 text-left hover:bg-panel2">
            <span className="font-medium">{h.name}</span>
            <span className="font-mono text-xs text-muted">
              {h.address}:{h.port}
            </span>
            <span className="ml-auto text-xs text-muted">{identities.find((i) => i.id === h.identity_id)?.name ?? "inherits login"}</span>
          </button>
        ))}
        {hosts.length === 0 && <p className="text-muted">No hosts yet.</p>}
      </section>
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
    </div>
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
