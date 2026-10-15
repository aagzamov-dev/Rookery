import type { Collect } from "../../ipc/bindings/Collect";
import type { RefreshMode } from "../../ipc/bindings/RefreshMode";
import type { RefreshSetting } from "../../ipc/bindings/RefreshSetting";
import { useHosts } from "../../stores/hosts";
import { effectiveRefresh, INTERVALS, intervalShort, useSync } from "../../stores/sync";
import { Field, Select } from "../../ui/primitives";

const MODE_LABEL: Record<Exclude<RefreshMode, "inherit">, string> = {
  auto: "Auto (when the group's Auto-sync is on)",
  manual: "Manual (only when I press Sync)",
  never: "Never (skip in group syncs)",
};
const COLLECT_LABEL: Record<Collect, string> = {
  basic: "CPU, memory, disk",
  basic_docker: "+ Docker containers",
  everything: "+ Docker + failed services",
};

/**
 * Dashboard sync setting for a host or group. "Inherit" shows what it would inherit
 * from the parent group / Settings.
 */
export function RefreshFields({ value, onChange, parentGroupId }: { value: RefreshSetting; onChange: (v: RefreshSetting) => void; parentGroupId: string | null }) {
  const groups = useHosts((s) => s.groups);
  const global = useSync((s) => s.global);
  // What "inherit" resolves to: a host with an all-inherit setting under the parent group.
  const inherited = effectiveRefresh(
    { group_id: parentGroupId, refresh: { mode: "inherit", interval_s: null, collect: null, desktop: null, mobile: null, wifi_only: null } } as never,
    groups,
    global,
  );
  const set = (patch: Partial<RefreshSetting>) => onChange({ ...value, ...patch });

  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-xs font-semibold text-muted">Dashboard sync</h3>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Mode">
          <Select value={value.mode} onChange={(e) => set({ mode: e.target.value as RefreshMode })}>
            <option value="inherit">Inherit — {inherited.mode}</option>
            {(Object.keys(MODE_LABEL) as (keyof typeof MODE_LABEL)[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Interval">
          <Select value={value.interval_s ?? ""} onChange={(e) => set({ interval_s: e.target.value === "" ? null : Number(e.target.value) })}>
            <option value="">Inherit — {intervalShort(inherited.interval_s)}</option>
            {INTERVALS.map((i) => (
              <option key={i.s} value={i.s}>
                Every {i.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Collect">
          <Select value={value.collect ?? ""} onChange={(e) => set({ collect: (e.target.value || null) as Collect | null })}>
            <option value="">Inherit — {COLLECT_LABEL[inherited.collect].replace("+ ", "")}</option>
            {(Object.keys(COLLECT_LABEL) as Collect[]).map((c) => (
              <option key={c} value={c}>
                {COLLECT_LABEL[c]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </section>
  );
}

export { MODE_LABEL, COLLECT_LABEL };
