// Quick-connect database URLs. Passwords never go into tab state or the saved session.
import type { Tab } from "../../stores/tabs";

export function isDbUrl(s: string) {
  return /^(ssh\+)?(postgres|postgresql|mysql|mariadb):\/\//i.test(s.trim());
}

/** Split a URL into the tab URL (no password), the password and a tab title. */
export function stripUrlPassword(raw: string): { url: string; password: string | null; title: string } {
  try {
    const u = new URL(raw.trim());
    const password = u.password ? decodeURIComponent(u.password) : null;
    u.password = "";
    const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
    return { url: u.toString(), password, title: `${u.hostname}${db ? ` · ${db}` : ""}` };
  } catch {
    // Not parseable: keep only what is before an "@" credential part, never a password.
    const t = raw.trim().replace(/\/\/[^@/]*@/, "//");
    return { url: t, password: null, title: t };
  }
}

/** A tab as it may be written to `ui.session`: database URLs without any password. */
export function tabForSave(t: Tab): Tab {
  if (t.kind !== "db" || t.target.kind !== "url") return t;
  return { ...t, target: { kind: "url", url: stripUrlPassword(t.target.url).url } };
}
