import { useState } from "react";
import clsx from "clsx";
import { Keyboard, Trash2, Upload } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, asCoreError } from "../../ipc/api";
import { isMac } from "../../keys/chord";
import { FONT_MAX, FONT_MIN, useKeys, type AppPrefs, type TerminalPrefs } from "../../stores/keys";
import { useTabs } from "../../stores/tabs";
import { INTERVALS, useSync, type AttentionThresholds } from "../../stores/sync";
import type { Collect } from "../../ipc/bindings/Collect";
import type { RefreshMode } from "../../ipc/bindings/RefreshMode";
import { COLLECT_LABEL, MODE_LABEL } from "../hosts/RefreshFields";
import { Button, Select, TextInput } from "../../ui/primitives";
import { BUILTIN_THEMES, FONT_CHOICES, fontLabel, parseItermColors, resolveTheme } from "../server-tab/terminal/themes";

export function SettingsPage() {
  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-8 p-6">
      <div className="flex items-center gap-3">
        <h1 className="m-0 text-xl font-semibold">Settings</h1>
        <Button className="ml-auto" onClick={() => useTabs.getState().openPage("shortcuts")}>
          <Keyboard size={14} /> Keyboard shortcuts
        </Button>
      </div>
      <Appearance />
      <TerminalClipboard />
      <Notifications />
      <Startup />
      <DashboardSync />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 text-xs font-semibold tracking-wider text-muted uppercase">{title}</h2>
      <div className="flex flex-col rounded-xl border border-line bg-panel p-1.5">{children}</div>
    </section>
  );
}

function Toggle<K extends keyof TerminalPrefs>({ k, label, hint }: { k: K; label: string; hint?: string }) {
  const value = useKeys((s) => s.terminal[k]) as boolean;
  const set = useKeys((s) => s.setTerminal);
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-panel2">
      <input type="checkbox" checked={value} onChange={(e) => void set({ [k]: e.target.checked } as Partial<TerminalPrefs>)} className="mt-0.5 accent-accent" />
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

function AppToggle<K extends keyof AppPrefs>({ k, label, hint }: { k: K; label: string; hint?: string }) {
  const value = useKeys((s) => s.app[k]);
  const set = useKeys((s) => s.setApp);
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-panel2">
      <input type="checkbox" checked={value} onChange={(e) => void set({ [k]: e.target.checked } as Partial<AppPrefs>)} className="mt-0.5 accent-accent" />
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </span>
    </label>
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

function Appearance() {
  const t = useKeys((s) => s.terminal);
  const custom = useKeys((s) => s.customThemes);
  const set = useKeys((s) => s.setTerminal);
  const saveTheme = useKeys((s) => s.saveTheme);
  const deleteTheme = useKeys((s) => s.deleteTheme);
  const [msg, setMsg] = useState<string | null>(null);
  const [customFont, setCustomFont] = useState(FONT_CHOICES.includes(t.fontFamily) ? "" : t.fontFamily);

  const names = [...Object.keys(BUILTIN_THEMES), ...Object.keys(custom)];

  const importIterm = async () => {
    setMsg(null);
    const picked = await openDialog({ multiple: false, title: "Import iTerm2 color scheme", filters: [{ name: "iTerm2 colors", extensions: ["itermcolors"] }] });
    if (!picked || Array.isArray(picked)) return;
    try {
      const theme = parseItermColors(await api.fileReadText(picked));
      const name = picked.split(/[\\/]/).pop()!.replace(/\.itermcolors$/i, "");
      await saveTheme(name, theme);
      await set({ theme: name });
      setMsg(`Imported “${name}”.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : asCoreError(e).message);
    }
  };

  return (
    <Section title="Terminal appearance">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 p-2">
        {names.map((n) => {
          const th = resolveTheme(n, custom);
          const sel = t.theme === n;
          return (
            <div key={n} className="group/t relative">
              <button
                onClick={() => void set({ theme: n })}
                className={clsx("flex w-full flex-col gap-1.5 rounded-lg border p-2 text-left", sel ? "border-accent" : "border-line hover:border-accent-line")}
              >
                <span className="flex h-12 flex-col justify-center gap-1 rounded-md px-2 font-mono text-[10px]" style={{ background: th.background, color: th.foreground }}>
                  <span>
                    <span style={{ color: th.green }}>user@host</span>:<span style={{ color: th.blue }}>~</span>$ ls
                  </span>
                  <span className="flex gap-1">
                    {[th.red, th.green, th.yellow, th.blue, th.magenta, th.cyan].map((c, i) => (
                      <span key={i} className="h-2 w-3 rounded-sm" style={{ background: c }} />
                    ))}
                  </span>
                </span>
                <span className="truncate text-xs">{n}</span>
              </button>
              {custom[n] && (
                <button aria-label={`Delete theme ${n}`} title="Delete imported theme" onClick={() => void deleteTheme(n)} className="absolute top-1 right-1 hidden h-6 w-6 place-items-center rounded bg-panel text-muted group-hover/t:grid hover:text-[#FFA8A8]">
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 px-3 pb-2">
        <Button onClick={() => void importIterm()}>
          <Upload size={13} /> Import .itermcolors
        </Button>
        <span className="text-xs text-muted">{msg ?? "Each server can also have its own theme (host editor), e.g. a red one for PROD."}</span>
      </div>
      <Row label="Font">
        <Select value={FONT_CHOICES.includes(t.fontFamily) ? t.fontFamily : "custom"} onChange={(e) => e.target.value !== "custom" && void set({ fontFamily: e.target.value })}>
          {FONT_CHOICES.map((f) => (
            <option key={f} value={f}>
              {fontLabel(f)}
            </option>
          ))}
          <option value="custom">Other…</option>
        </Select>
        <TextInput
          className="w-48"
          placeholder="Other font name"
          value={customFont}
          onChange={(e) => setCustomFont(e.target.value)}
          onBlur={() => customFont.trim() && void set({ fontFamily: `"${customFont.trim()}", monospace` })}
        />
      </Row>
      <Row label="Font size">
        <Button className="w-8 px-0" onClick={() => void set({ fontSize: t.fontSize - 1 })} disabled={t.fontSize <= FONT_MIN} aria-label="Smaller font">
          −
        </Button>
        <span className="w-8 text-center font-mono">{t.fontSize}</span>
        <Button className="w-8 px-0" onClick={() => void set({ fontSize: t.fontSize + 1 })} disabled={t.fontSize >= FONT_MAX} aria-label="Bigger font">
          +
        </Button>
      </Row>
      <Row label="Cursor">
        <Select value={t.cursorStyle} onChange={(e) => void set({ cursorStyle: e.target.value as TerminalPrefs["cursorStyle"] })}>
          <option value="block">Block</option>
          <option value="bar">Bar</option>
          <option value="underline">Underline</option>
        </Select>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={t.cursorBlink} onChange={(e) => void set({ cursorBlink: e.target.checked })} className="accent-accent" /> Blink
        </label>
      </Row>
    </Section>
  );
}

function TerminalClipboard() {
  return (
    <Section title="Terminal — copy and paste">
      {!isMac && (
        <>
          <Toggle k="ctrlCCopies" label="Ctrl+C copies selected text" hint="With nothing selected, Ctrl+C still stops the running command." />
          <Toggle k="ctrlVPastes" label="Ctrl+V pastes" hint="Turn off if you need to send a literal Ctrl+V to a program." />
        </>
      )}
      <Toggle k="rightClickPastes" label="Right-click: copy selection, or paste" hint="Like PuTTY and MobaXterm." />
      <Toggle k="copyOnSelect" label="Copy automatically when selecting text" />
      <Toggle k="warnMultilinePaste" label="Ask before pasting more than one line" hint="Each line can run as a command — the dialog shows exactly what will be pasted." />
    </Section>
  );
}

function Notifications() {
  const after = useKeys((s) => s.terminal.notifyAfterSec);
  const set = useKeys((s) => s.setTerminal);
  return (
    <Section title="Notifications">
      <Toggle
        k="notifyLongCommands"
        label="Notify when a long command finishes while you're elsewhere"
        hint="Works best with shell integration on (Files panel › Turn on) — then the notification also says if it failed."
      />
      <Row label="Long means more than">
        <TextInput mono className="w-20" value={after} onChange={(e) => void set({ notifyAfterSec: Number(e.target.value.replace(/\D/g, "")) || 20 })} />
        <span className="text-xs text-muted">seconds</span>
      </Row>
    </Section>
  );
}

function Startup() {
  return (
    <Section title="Tabs and startup">
      <AppToggle k="restoreTabs" label="Reopen my tabs when Rookery starts" hint="Server tabs come back without connecting." />
      <AppToggle k="autoConnectRestored" label="Connect reopened server tabs right away" hint="Off: each restored server waits until you click Connect." />
    </Section>
  );
}

function DashboardSync() {
  const settings = useSync((s) => s.settings);
  const global = useSync((s) => s.global);
  const thresholds = useSync((s) => s.thresholds);
  const { setSettings, setGlobal, setThresholds } = useSync.getState();
  const check = (label: string, hint: string, value: boolean, onChange: (v: boolean) => void) => (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-panel2">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-accent" />
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        <span className="text-xs text-muted">{hint}</span>
      </span>
    </label>
  );
  const num = (k: keyof AttentionThresholds, suffix: string) => (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      <TextInput
        mono
        className="h-7 w-14"
        value={thresholds[k]}
        onChange={(e) => void setThresholds({ ...thresholds, [k]: Number(e.target.value.replace(/\D/g, "")) || 0 })}
      />
      {suffix}
    </label>
  );
  return (
    <Section title="Dashboard sync">
      {check("Pause auto-sync everywhere", "Group switches keep their state. Sync now still works.", settings.paused, (v) => void setSettings({ paused: v }))}
      {check(
        "Keep auto-syncing while the window is minimised",
        "Off: auto-sync stops a minute after you minimise Rookery and resumes when you come back.",
        settings.run_when_hidden,
        (v) => void setSettings({ run_when_hidden: v }),
      )}
      <Row label="Default interval" hint="Used by groups and servers set to Inherit.">
        <Select className="w-36" value={global.interval_s ?? 300} onChange={(e) => void setGlobal({ interval_s: Number(e.target.value) })}>
          {INTERVALS.map((i) => (
            <option key={i.s} value={i.s}>
              Every {i.label}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Default mode" hint="Auto follows each group's Auto-sync switch (all off until you turn one on).">
        <Select className="w-52" value={global.mode} onChange={(e) => void setGlobal({ mode: e.target.value as RefreshMode })}>
          {(Object.keys(MODE_LABEL) as (keyof typeof MODE_LABEL)[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="What to collect" hint="One command per server. Docker adds `docker ps` and one `docker stats --no-stream`.">
        <Select className="w-52" value={global.collect ?? "basic_docker"} onChange={(e) => void setGlobal({ collect: e.target.value as Collect })}>
          {(Object.keys(COLLECT_LABEL) as Collect[]).map((c) => (
            <option key={c} value={c}>
              {COLLECT_LABEL[c]}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Servers at the same time" hint="More is faster; fewer is gentler on your network.">
        <Select className="w-20" value={settings.concurrency} onChange={(e) => void setSettings({ concurrency: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Needs attention when" hint="Checked against the last sync. CPU must stay high for two syncs in a row.">
        <span className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted">CPU &gt;</span>
          {num("cpu", "%")}
          <span className="text-xs text-muted">RAM &gt;</span>
          {num("ram", "%")}
          <span className="text-xs text-muted">Disk &gt;</span>
          {num("disk", "%")}
          <span className="text-xs text-muted">offline &gt;</span>
          {num("offlineMin", "min")}
        </span>
      </Row>
    </Section>
  );
}
