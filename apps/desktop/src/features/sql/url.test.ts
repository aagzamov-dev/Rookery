import { describe, expect, it } from "vitest";
import { isDbUrl, stripUrlPassword, tabForSave } from "./url";

describe("database URLs", () => {
  it("recognises database URLs", () => {
    expect(isDbUrl("postgres://u@h/db")).toBe(true);
    expect(isDbUrl(" mysql://root@localhost/shop")).toBe(true);
    expect(isDbUrl("ssh+mysql://prod-api-01/shop")).toBe(true);
    expect(isDbUrl("root@10.0.0.5:22")).toBe(false);
  });

  it("keeps the password out of the tab URL", () => {
    const r = stripUrlPassword("postgres://app:s%40cret@db.example.com:6543/shop?sslmode=require");
    expect(r.password).toBe("s@cret");
    expect(r.url).toBe("postgres://app@db.example.com:6543/shop?sslmode=require");
    expect(r.url).not.toContain("cret");
    expect(r.title).toBe("db.example.com · shop");
    expect(stripUrlPassword("mysql://root@localhost/shop").password).toBeNull();
  });

  it("never saves a password in the session", () => {
    const t = { id: "db:1", kind: "db" as const, title: "x", target: { kind: "url" as const, url: "mysql://root:hunter2@h/shop" } };
    expect(JSON.stringify(tabForSave(t))).not.toContain("hunter2");
    const saved = { id: "db:2", kind: "db" as const, title: "x", target: { kind: "saved" as const, id: "c1" } };
    expect(tabForSave(saved)).toBe(saved);
  });
});
