import { describe, expect, it } from "vitest";
import { envValueRanges, formatEnv, lintEnv } from "./env";
import { crumbs, langOf } from "./lang";
import { hasMarkers, resolve, threeWay } from "./merge";

describe("language by file name", () => {
  it.each([
    ["/srv/app/.env", "env"],
    ["/srv/app/.env.production", "env"],
    ["/srv/app/prod.env", "env"],
    ["/srv/app/docker-compose.yml", "yaml"],
    ["/srv/app/package.json", "json"],
    ["/srv/app/composer.lock", "json"],
    ["/etc/nginx/nginx.conf", "nginx"],
    ["/etc/nginx/conf.d/shop.conf", "nginx"],
    ["/etc/nginx/sites-available/shop", "nginx"],
    ["/etc/mysql/my.cnf", "ini"],
    ["/etc/systemd/system/app.service", "ini"],
    ["/srv/app/Dockerfile", "dockerfile"],
    ["/srv/app/Dockerfile.prod", "dockerfile"],
    ["/home/me/.bashrc", "shell"],
    ["/srv/app/deploy.sh", "shell"],
    ["/srv/app/index.php", "php"],
    ["/srv/app/src/main.tsx", "tsx"],
    ["/srv/app/README.md", "markdown"],
    ["/var/log/syslog", "text"],
  ])("%s → %s", (path, lang) => expect(langOf(path)).toBe(lang));
});

describe(".env checks", () => {
  it("finds duplicates, spaces, bad names, unquoted spaces and unclosed quotes", () => {
    const p = lintEnv(["# db", "DB_HOST=127.0.0.1", "DB_HOST=db", "APP NAME=x", "MAIL_FROM = me@x.io", "TITLE=My shop", 'KEY="open', "OK=1"].join("\n"));
    const msgs = p.map((x) => `${x.line + 1}:${x.severity}:${x.message.split(" ")[0]}`);
    expect(msgs).toContain("3:warning:DB_HOST");
    expect(msgs.some((m) => m.startsWith("4:error"))).toBe(true);
    expect(msgs).toContain("5:warning:Spaces");
    expect(msgs).toContain("6:warning:Value");
    expect(msgs).toContain("7:error:The");
    expect(msgs.some((m) => m.startsWith("8:"))).toBe(false);
  });

  it("accepts quoted values, comments, export and multi-line quoted values", () => {
    expect(lintEnv(['export A=1', 'B="has spaces"', "C='x y' ", "D=plain # a comment", 'KEY="-----BEGIN', "abc", '-----END"', ""].join("\n"))).toEqual([]);
  });

  it("formats without changing values or comments", () => {
    const src = ["# app", "  APP_ENV = production   ", "", "", "", "TITLE='My shop'", 'CERT="line1', "  line2  ", '"', "export  X=1", ""].join("\n");
    expect(formatEnv(src)).toBe(["# app", "APP_ENV=production", "", "TITLE='My shop'", 'CERT="line1', "  line2  ", '"', "export X=1", ""].join("\n"));
    expect(formatEnv(formatEnv(src))).toBe(formatEnv(src));
  });

  it("knows where values are (for Hide values)", () => {
    const text = "A=secret\n# c\nB=two # note\nC=";
    const r = envValueRanges(text).map((x) => text.slice(x.from, x.to));
    expect(r).toEqual(["secret", "two"]);
  });
});

describe("three-way merge", () => {
  const base = "a\nb\nc\nd\n";
  it("combines changes in different lines", () => {
    const m = threeWay(base, "A\nb\nc\nd\n", "a\nb\nc\nD\n");
    expect(m.conflicts).toBe(0);
    expect(resolve(m, []).text).toBe("A\nb\nc\nD\n");
  });
  it("same change on both sides is not a conflict", () => {
    const m = threeWay(base, "a\nB\nc\nd\n", "a\nB\nc\nd\n");
    expect(m.conflicts).toBe(0);
    expect(resolve(m, []).text).toBe("a\nB\nc\nd\n");
  });
  it("reports a conflict and resolves it by pick", () => {
    const m = threeWay(base, "a\nmine\nc\nd\n", "a\ntheirs\nc\nd\n");
    expect(m.conflicts).toBe(1);
    const open = resolve(m, []);
    expect(open.unresolved).toBe(1);
    expect(hasMarkers(open.text)).toBe(true);
    expect(resolve(m, ["mine"]).text).toBe("a\nmine\nc\nd\n");
    expect(resolve(m, ["theirs"]).text).toBe("a\ntheirs\nc\nd\n");
    expect(resolve(m, ["both"]).text).toBe("a\nmine\ntheirs\nc\nd\n");
  });
});

describe("folder path", () => {
  it("splits into clickable parts", () => {
    expect(crumbs("/")).toEqual([["/", "/"]]);
    expect(crumbs("/home/admin/.copilot")).toEqual([
      ["/", "/"],
      ["home", "/home"],
      ["admin", "/home/admin"],
      [".copilot", "/home/admin/.copilot"],
    ]);
  });
});
