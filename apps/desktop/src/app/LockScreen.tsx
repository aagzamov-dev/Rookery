import { forwardRef, useEffect, useRef, useState, type FormEvent } from "react";
import clsx from "clsx";
import { api, asCoreError } from "../ipc/api";
import { useVault } from "../stores/vault";
import { Button, TextInput } from "../ui/primitives";

type Mode = "create" | "pin" | "master" | "set-pin";

/** First run: create vault → set PIN. Later: PIN (auto-submit on last digit) or master password. */
export function LockScreen() {
  const status = useVault((s) => s.status)!;
  const setStatus = useVault((s) => s.setStatus);
  const skipPin = useVault((s) => s.skipPin);
  const initial: Mode = !status.initialised
    ? "create"
    : status.unlocked && !status.pin_set
      ? "set-pin"
      : status.pin_set && !status.pin_disabled
        ? "pin"
        : "master";
  const [mode, setMode] = useState<Mode>(initial);

  useEffect(() => setMode(initial), [initial]);

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-bg p-4">
      <div className="flex w-full max-w-[360px] flex-col items-center gap-5 rounded-2xl border border-line bg-panel px-8 pt-9 pb-7">
        <span aria-hidden className="grid h-12 w-12 place-items-center rounded-xl bg-accent font-mono text-lg font-bold text-bg">
          &gt;_
        </span>
        {mode === "create" && <CreateVault onDone={(s) => { setStatus(s); setMode("set-pin"); }} />}
        {mode === "set-pin" && <SetPin onDone={setStatus} onSkip={skipPin} />}
        {mode === "pin" && <PinUnlock pinLength={status.pin_length ?? 4} onDone={setStatus} onUseMaster={() => setMode("master")} />}
        {mode === "master" && (
          <MasterUnlock
            disabledPin={status.pin_disabled}
            onDone={(s) => {
              setStatus(s);
              if (!s.pin_set || s.pin_disabled) setMode("set-pin");
            }}
            onUsePin={status.pin_set && !status.pin_disabled ? () => setMode("pin") : undefined}
          />
        )}
      </div>
    </div>
  );
}

function Title({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <h1 className="m-0 text-xl font-semibold">{title}</h1>
      <span className="text-muted">{sub}</span>
    </div>
  );
}

function CreateVault({ onDone }: { onDone: (s: Awaited<ReturnType<typeof api.vaultCreate>>) => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (a.length < 8) return setErr("At least 8 characters");
    if (a !== b) return setErr("Passwords do not match");
    setBusy(true);
    try {
      onDone(await api.vaultCreate(a));
    } catch (x) {
      setErr(asCoreError(x).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-3">
      <Title title="Create your vault" sub="The master password encrypts all logins. You rarely need to type it." />
      <TextInput type="password" autoFocus placeholder="Master password" value={a} onChange={(e) => setA(e.target.value)} />
      <TextInput type="password" placeholder="Repeat master password" value={b} onChange={(e) => setB(e.target.value)} />
      {err && <span className="text-center text-prod-fg">{err}</span>}
      <Button variant="primary" className="h-10" disabled={busy}>
        Create vault
      </Button>
      <span className="text-center text-[11px] text-muted">If you forget it, encrypted logins cannot be recovered.</span>
    </form>
  );
}

function SetPin({ onDone, onSkip }: { onDone: (s: Awaited<ReturnType<typeof api.vaultSetPin>>) => void; onSkip: () => void }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onDone(await api.vaultSetPin(pin));
    } catch (x) {
      setErr(asCoreError(x).message);
    }
  };
  return (
    <form onSubmit={save} className="flex w-full flex-col gap-3">
      <Title title="Set a quick PIN" sub="4–6 digits to unlock this device. It never leaves this computer." />
      <PinField value={pin} onChange={setPin} maxLength={6} />
      {err && <span className="text-center text-prod-fg">{err}</span>}
      <Button variant="primary" className="h-10" disabled={pin.length < 4}>
        Save PIN
      </Button>
      <Button type="button" variant="ghost" onClick={onSkip}>
        Skip for now
      </Button>
    </form>
  );
}

function PinUnlock({
  pinLength,
  onDone,
  onUseMaster,
}: {
  pinLength: number;
  onDone: (s: Awaited<ReturnType<typeof api.vaultUnlockPin>>) => void;
  onUseMaster: () => void;
}) {
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refocus whenever the window regains focus while locked.
  useEffect(() => {
    const f = () => inputRef.current?.focus();
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, []);

  const change = async (v: string) => {
    setPin(v);
    if (v.length < pinLength || busy) return;
    setBusy(true);
    try {
      onDone(await api.vaultUnlockPin(v));
    } catch (x) {
      const e = asCoreError(x);
      setPin("");
      setShake(true);
      setTimeout(() => setShake(false), 400);
      if (e.kind === "wrong_pin") setMsg({ text: `Wrong PIN · ${e.attempts_left} tries left`, bad: true });
      else if (e.kind === "pin_cooldown") setMsg({ text: `Too many tries — wait ${e.cooldown_s}s`, bad: true });
      else if (e.kind === "pin_disabled") {
        setMsg({ text: "PIN disabled — use the master password", bad: true });
        setTimeout(onUseMaster, 800);
      } else setMsg({ text: e.message, bad: true });
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <Title title="Rook is locked" sub="Type your PIN — opens on the last digit" />
      <div className={clsx("w-full", shake && "shake")}>
        <PinField ref={inputRef} value={pin} onChange={change} maxLength={pinLength} bad={!!msg?.bad && pin === ""} disabled={busy} />
      </div>
      <div aria-live="polite" className={clsx("min-h-5 text-center", msg?.bad ? "text-prod-fg" : "text-muted")}>
        {msg?.text}
      </div>
      <Button variant="ghost" onClick={onUseMaster} className="text-accent">
        Use master password
      </Button>
    </div>
  );
}

function MasterUnlock({
  disabledPin,
  onDone,
  onUsePin,
}: {
  disabledPin: boolean;
  onDone: (s: Awaited<ReturnType<typeof api.vaultUnlockMaster>>) => void;
  onUsePin?: () => void;
}) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onDone(await api.vaultUnlockMaster(pw));
    } catch (x) {
      setErr(asCoreError(x).message);
      setPw("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-3">
      <Title title="Unlock with master password" sub={disabledPin ? "Your PIN was disabled after too many tries." : "Enter your master password"} />
      <TextInput type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Master password" />
      {err && <span className="text-center text-prod-fg">{err}</span>}
      <Button variant="primary" className="h-10" disabled={busy || !pw}>
        Unlock
      </Button>
      {onUsePin && (
        <Button type="button" variant="ghost" onClick={onUsePin}>
          Use PIN instead
        </Button>
      )}
    </form>
  );
}

const PinField = forwardRef<
  HTMLInputElement,
  { value: string; onChange: (v: string) => void; maxLength: number; bad?: boolean; disabled?: boolean }
>(function PinField({ value, onChange, maxLength, bad, disabled }, ref) {
  return (
    <input
      ref={ref}
      type="password"
      inputMode="numeric"
      autoComplete="off"
      autoFocus
      aria-label="PIN"
      maxLength={maxLength}
      disabled={disabled}
      value={value}
      placeholder={"•".repeat(maxLength)}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, maxLength))}
      className={clsx(
        "h-14 w-full rounded-xl border bg-bg text-center font-mono text-2xl tracking-[0.6em] outline-none placeholder:text-[#4A5570]",
        bad ? "border-bad shadow-[0_0_0_3px_rgba(255,107,107,0.18)]" : "border-accent-line shadow-[0_0_0_3px_rgba(138,180,255,0.18)]",
      )}
    />
  );
});
