import type { AuthKind } from "../../ipc/bindings/AuthKind";

/** What "Copy credentials" puts on the clipboard: address, port, user and (if saved) the password. */
export function credentialsText(c: { address: string; port: number; username: string; auth: AuthKind; password: string | null; keyPath: string | null }): string {
  const lines = [`Host: ${c.address}`, `Port: ${c.port}`, `User: ${c.username}`];
  if (c.auth === "password") lines.push(c.password ? `Password: ${c.password}` : "Password: (not saved)");
  else if (c.auth === "key_file") lines.push(`Key file: ${c.keyPath ?? "(not set)"}`);
  else lines.push("Key: private key stored in the Rookery vault");
  return lines.join("\n");
}

/** Clipboard holding a password is emptied after this long (if it still holds it). */
export const CLEAR_AFTER_MS = 30_000;

/** Quote for a POSIX shell only when needed (`deploy` stays as is). */
const sh = (v: string) => (/^[\w.@%+=:,/-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

/** "Copy connection": the ssh command for this host (no password). */
export function connectionCommand(c: { address: string; port: number; username: string }): string {
  const target = c.username ? `${c.username}@${c.address}` : c.address;
  return `ssh ${c.port && c.port !== 22 ? `-p ${c.port} ` : ""}${sh(target)}`;
}
