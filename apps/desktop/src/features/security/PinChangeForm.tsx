import { useState, type FormEvent } from "react";
import { api, asCoreError } from "../../ipc/api";
import type { PinCredential } from "../../ipc/bindings/PinCredential";
import type { VaultStatus } from "../../ipc/bindings/VaultStatus";
import { useVault } from "../../stores/vault";
import { Button, Field, Select, TextInput } from "../../ui/primitives";

export function PinChangeForm({ recovery = false, onDone, onCancel }: { recovery?: boolean; onDone: (status: VaultStatus) => void; onCancel: () => void }) {
  const status = useVault((s) => s.status);
  const canUsePin = !recovery && !!status?.pin_set && !status.pin_disabled;
  const [method, setMethod] = useState<PinCredential["kind"]>(canUsePin ? "pin" : "master");
  const [credential, setCredential] = useState("");
  const [pin, setPin] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usePin = canUsePin && method === "pin";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{4,6}$/.test(pin)) { setError("Choose a PIN with 4–6 digits."); return; }
    if (pin !== repeat) { setError("The new PINs do not match."); return; }
    if (!credential) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.vaultChangePin(pin, { kind: usePin ? "pin" : "master", value: credential });
      setCredential("");
      setPin("");
      setRepeat("");
      onDone(result);
    } catch (cause) {
      const failure = asCoreError(cause);
      setCredential("");
      setError(failure.kind === "wrong_pin" ? `Wrong current PIN · ${failure.attempts_left} tries left.` : failure.kind === "pin_cooldown" ? `Too many tries. Wait ${failure.cooldown_s}s or use your master password.` : failure.kind === "pin_disabled" ? "Your PIN is disabled. Verify with your master password." : failure.message);
      if (failure.kind === "pin_disabled") setMethod("master");
      await useVault.getState().load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-3">
      <p className="m-0 text-xs text-muted">{recovery ? "Verify your master password and choose a new PIN to unlock this device. Your saved logins stay unchanged." : "Verify with your current PIN or master password. The new PIN applies only to this device."}</p>
      {canUsePin && <Field label="Verify with"><Select aria-label="Verify with" value={method} disabled={busy} onChange={(event) => { setMethod(event.target.value === "pin" ? "pin" : "master"); setCredential(""); setError(null); }}><option value="pin">Current PIN</option><option value="master">Master password</option></Select></Field>}
      <Field label={usePin ? "Current PIN" : "Master password"}>
        <TextInput autoFocus type="password" autoComplete="off" aria-label={usePin ? "Current PIN" : "Master password"} inputMode={usePin ? "numeric" : undefined} maxLength={usePin ? 6 : undefined} value={credential} disabled={busy} onChange={(event) => setCredential(usePin ? event.target.value.replace(/\D/g, "").slice(0, 6) : event.target.value)} />
      </Field>
      <Field label="New PIN (4–6 digits)"><TextInput type="password" inputMode="numeric" autoComplete="new-password" aria-label="New PIN" maxLength={6} value={pin} disabled={busy} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))} /></Field>
      <Field label="Repeat new PIN"><TextInput type="password" inputMode="numeric" autoComplete="new-password" aria-label="Repeat new PIN" maxLength={6} value={repeat} disabled={busy} onChange={(event) => setRepeat(event.target.value.replace(/\D/g, "").slice(0, 6))} /></Field>
      {error && <div role="alert" className="text-xs text-prod-fg">{error}</div>}
      <div className="mt-1 flex justify-end gap-2"><Button type="button" disabled={busy} onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" disabled={busy || !credential || pin.length < 4 || repeat.length < 4}>{busy ? "Updating PIN…" : recovery ? "Reset PIN and unlock" : "Save new PIN"}</Button></div>
    </form>
  );
}
