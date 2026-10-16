// Settings sections added in v0.6: security, session logs, triggers, system-wide hotkey, about.
import { useState } from "react";
import clsx from "clsx";
import { ArrowUpCircle, FolderOpen, Plus, Trash2 } from "lucide-react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { api, asCoreError } from "../../ipc/api";
import { isMac, normalizeChord } from "../../keys/chord";
import { DEFAULT_TRIGGERS, useKeys, type Trigger, type TriggerColor } from "../../stores/keys";
import { RELEASES_URL, useUpdate } from "../../stores/update";
import { Button, Select, TextInput } from "../../ui/primitives";
import { ShortcutRecorder } from "../../ui/ShortcutRecorder";
import { blend, TRIGGER_COLORS, triggerError } from "../server-tab/terminal/triggers";

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 text-xs font-semibold tracking-wider text-muted uppercase">{title}</h2>
      <div className="flex flex-col rounded-xl border border-line bg-panel p-1.5">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <span className="flex min-w-[180px] flex-1 flex-col gap-0.5">
        <span>{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-panel2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-accent" />
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function Security() {
  const app = useKeys((s) => s.app);
  const setApp = useKeys((s) => s.setApp);
  return (
    <Section title="Security">
      <Row label="Lock after" hint="No mouse or keyboard input for this long locks Rookery. Unlock with your PIN.">
        <Select className="w-36" value={app.autoLockMin} onChange={(e) => void setApp({ autoLockMin: Number(e.target.value) })}>
          {[1, 5, 10, 15, 30, 60, 120].map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} min` : `${m / 60} h`}
            </option>
          ))}
          <option value={0}>Never</option>
        </Select>
      </Row>
    </Section>
  );
}

export function SessionLogs() {
  const app = useKeys((s) => s.app);
  const setApp = useKeys((s) => s.setApp);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Section title="Session logs">
      <Check
        checked={app.logSessions}
        onChange={(v) => void setApp({ logSessions: v })}
        label="Save every SSH session to a log file"
        hint="Plain text with a time on each line, colours removed. Only output is saved, never what you type. A server can also turn it on just for itself (server editor)."
      />
      <Row label="Keep logs for" hint="Older logs are deleted when Rookery starts.">
        <Select className="w-36" value={app.logRetentionDays} onChange={(e) => void setApp({ logRetentionDays: Number(e.target.value) })}>
          {[7, 14, 30, 90, 365].map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
          <option value={0}>Forever</option>
        </Select>
        <Button
          onClick={async () => {
            try {
              await openPath(await api.logsDir());
              setErr(null);
            } catch (e) {
              setErr(/not found|cannot find|No such/i.test(String(e)) ? "No logs yet." : asCoreError(e).message);
            }
          }}
        >
          <FolderOpen size={13} /> Open logs folder
        </Button>
      </Row>
      {err && <p className="m-0 px-3 pb-2 text-xs text-muted">{err}</p>}
    </Section>
  );
}

const COLORS: TriggerColor[] = ["red", "yellow", "green", "blue", "purple"];

export function Triggers() {
  const t = useKeys((s) => s.terminal);
  const setTerminal = useKeys((s) => s.setTerminal);
  const list = t.triggers;
  const save = (triggers: Trigger[]) => void setTerminal({ triggers });
  const update = (id: string, patch: Partial<Trigger>) => save(list.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  return (
    <Section title="Terminal triggers">
      <Check
        checked={t.highlightTriggers}
        onChange={(v) => void setTerminal({ highlightTriggers: v })}
        label="Highlight matching lines"
        hint="A faint coloured band behind the line and a mark in the scrollbar. The output itself is never changed; full-screen apps (vim, htop) are not scanned."
      />
      <div className={clsx("flex flex-col gap-1 px-3 pb-2", !t.highlightTriggers && "opacity-50")}>
        {list.map((x) => {
          const error = triggerError(x.pattern);
          return (
            <div key={x.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-bg px-2 py-1.5">
              <input type="checkbox" aria-label="Enabled" className="accent-accent" checked={x.enabled} onChange={(e) => update(x.id, { enabled: e.target.checked })} />
              <TextInput
                mono
                aria-label="Pattern (regular expression)"
                className={clsx("h-8 min-w-[220px] flex-1", error && "border-bad")}
                value={x.pattern}
                title={error ?? "Regular expression, e.g. \\bERROR\\b or timeout|refused"}
                onChange={(e) => update(x.id, { pattern: e.target.value })}
              />
              <span className="flex gap-1">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    aria-label={c}
                    title={c}
                    onClick={() => update(x.id, { color: c })}
                    className={clsx("h-5 w-5 rounded-full border-2", x.color === c ? "border-text" : "border-transparent")}
                    style={{ background: blend("#171D29", TRIGGER_COLORS[c], 0.75) }}
                  />
                ))}
              </span>
              <label className="flex items-center gap-1.5 text-xs text-muted" title="Match upper/lower case exactly">
                <input type="checkbox" className="accent-accent" checked={x.caseSensitive} onChange={(e) => update(x.id, { caseSensitive: e.target.checked })} />
                Aa
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted" title="Desktop notification when it matches while you are in another tab or app (max once per 30 s)">
                <input type="checkbox" className="accent-accent" checked={x.notify} onChange={(e) => update(x.id, { notify: e.target.checked })} />
                Notify
              </label>
              <button aria-label="Delete trigger" onClick={() => save(list.filter((y) => y.id !== x.id))} className="grid h-7 w-7 place-items-center text-muted hover:text-prod-fg">
                <Trash2 size={13} />
              </button>
              {error && <span className="w-full text-xs text-prod-fg">{error}</span>}
            </div>
          );
        })}
        <div className="flex gap-2 pt-1">
          <Button
            className="h-7 text-xs"
            onClick={() => save([...list, { id: `t${Date.now().toString(36)}`, pattern: "", color: "blue", notify: false, enabled: true, caseSensitive: false }])}
          >
            <Plus size={12} /> Add trigger
          </Button>
          <Button variant="ghost" className="h-7 text-xs" onClick={() => save(DEFAULT_TRIGGERS)}>
            Reset to defaults
          </Button>
        </div>
      </div>
    </Section>
  );
}

export function GlobalHotkey() {
  const chord = useKeys((s) => s.app.globalHotkey);
  const setApp = useKeys((s) => s.setApp);
  const [err, setErr] = useState<string | null>(null);
  const apply = async (next: string | null) => {
    try {
      await api.globalHotkeySet(next);
      await setApp({ globalHotkey: next });
      setErr(null);
    } catch (e) {
      setErr(asCoreError(e).message);
      void api.globalHotkeySet(chord).catch(() => {});
    }
  };
  return (
    <Section title="System-wide hotkey">
      <Row
        label="Show / hide Rookery from anywhere"
        hint={`Quake-style: press it in any app to bring Rookery to the front (with a terminal focused), press again to minimise. Try ${isMac ? "⌥Space" : "Ctrl+`"}.`}
      >
        <ShortcutRecorder value={chord} warnShell={false} placeholder="Not set" onChange={(c) => void apply(c ? normalizeChord(c) : null)} />
        {chord && (
          <Button variant="ghost" onClick={() => void apply(null)}>
            Turn off
          </Button>
        )}
      </Row>
      {err && <p className="m-0 px-3 pb-2 text-xs text-prod-fg">{err}</p>}
    </Section>
  );
}

export function About() {
  const u = useUpdate();
  const status =
    u.phase === "checking"
      ? "Checking…"
      : u.phase === "none"
        ? "You have the latest version."
        : u.phase === "available"
          ? `Version ${u.available?.version} is available.`
          : u.phase === "downloading" || u.phase === "installing"
            ? "Updating…"
            : u.phase === "error"
              ? `Could not check: ${u.error}`
              : u.prefs.lastCheck
                ? `Last checked ${new Date(u.prefs.lastCheck).toLocaleString()}.`
                : "";
  return (
    <Section title="About">
      <Row label={`Rookery ${u.current}`} hint={status}>
        <Button
          variant="primary"
          disabled={u.phase === "checking" || u.phase === "downloading"}
          onClick={() => {
            useUpdate.setState({ dismissed: false });
            void u.checkNow(true);
          }}
        >
          <ArrowUpCircle size={13} /> Check for updates
        </Button>
        <Button variant="ghost" onClick={() => void openUrl(RELEASES_URL)}>
          Release notes
        </Button>
      </Row>
      <Check
        checked={u.prefs.auto}
        onChange={(v) => void u.setAuto(v)}
        label="Check for updates when Rookery starts (once a day)"
        hint="Downloads only a small version file from GitHub — no data about you or your servers. Updates are verified with Rookery's signature before installing."
      />
    </Section>
  );
}
