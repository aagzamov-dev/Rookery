// Demo mode for README screenshots: the real UI with a mocked core (no Tauri, no servers,
// no vault). Open http://localhost:1420/demo.html?scene=dashboard (dev server only — this
// page is not part of the app build). Scenes: dashboard, terminal, docker, backup, hosts,
// shortcuts, snippets, sql (database tab), sql-server (server Database view), sql-dialog,
// editor, editor-merge, editor-review.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { DEMO } from "./data";
import { editorMock } from "./editor";
import { ORDER_COLUMNS, ORDER_DETAIL, orderRows, SQL_COLUMNS, SQL_CONNS, SQL_DRAFT, SQL_TREE, sqlRows } from "./sql";

const scene = new URLSearchParams(location.search).get("scene") ?? "dashboard";
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const core = (payload: unknown) => void emit("core", payload);

let n = 0;
mockWindows("main");
mockIPC(
  (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const ed = editorMock(cmd, a, scene);
    if (ed !== undefined) return ed;
    switch (cmd) {
      case "vault_status":
        return { initialised: true, unlocked: true, pin_set: true, pin_disabled: false, pin_length: 4, pin_attempts_left: null };
      case "groups_list":
        return DEMO.groups;
      case "hosts_list":
        return DEMO.hosts;
      case "identities_list":
        return DEMO.identities;
      case "snippets_list":
        return DEMO.snippets;
      case "snapshots_list":
        return DEMO.snapshots;
      case "known_hosts_list":
        return [];
      case "local_shells":
        return [{ id: "pwsh", label: "PowerShell", program: "pwsh.exe", args: [] }];
      case "sessions_all":
        return [];
      case "setting_get":
        if (a.key === "ui.sql.drafts") return { "host:h-api01": SQL_DRAFT, "db:demo": SQL_DRAFT };
        return DEMO.settings[a.key as string] ?? null;
      case "sql_conns_list":
        return SQL_CONNS;
      case "sql_test":
        return { server_version: "PostgreSQL 16.2", latency_ms: 38 };
      case "sql_open":
        return { session_id: "sql1", engine: "mysql", server_version: "MySQL 8.0.36", read_only: true, database: "shop", conn_key: "c-shop" };
      case "sql_detect_local":
        return [
          { engine: "mysql", port: 3306, product: "MariaDB 10.4.32", container: null, user: "root", database: null, hint: "XAMPP / Laragon: user root, no password" },
          { engine: "postgres", port: 5433, product: "PostgreSQL", container: "shop-db-1 (postgres:16-alpine)", user: "shop", database: "shop", hint: "Password: POSTGRES_PASSWORD in the container's settings" },
        ];
      case "sql_env_import":
        return { name: "Shop API", engine: "mysql", address: "127.0.0.1", port: 3306, user: "shop", database: "shop", note: null, password_hint: null, password_ref: "env-1" };
      case "sql_docker_inspect":
        return { name: a.container, engine: "postgres", address: "172.18.0.4", port: 5432, user: "shop", database: "shop", note: "container IP on shop_default", password_hint: "POSTGRES_PASSWORD in the container's settings" };
      case "sql_history": {
        const now = Date.now();
        return [
          { id: 3, conn_key: a.connKey, sql: "SELECT id, email, status FROM orders WHERE status = 'failed' ORDER BY id DESC LIMIT 100", ran_at: now - 60_000, ok: true, rows: 37, elapsed_ms: 41 },
          { id: 2, conn_key: a.connKey, sql: "SELECT count(*) FROM orders", ran_at: now - 600_000, ok: true, rows: 1, elapsed_ms: 12 },
          { id: 1, conn_key: a.connKey, sql: "SELECT * FROM order", ran_at: now - 3_600_000, ok: false, rows: null, elapsed_ms: 3 },
        ];
      }
      case "sql_allow_writes": {
        const m = a.minutes as number;
        setTimeout(() => core({ type: "sql_session", session_id: a.sessionId, state: "connected", tx_open: false, tx_rows: 0, read_only: m === 0, protected: true, writes_until: m ? Date.now() + m * 60_000 : null, database: "shop", message: null }), 30);
        return null;
      }
      case "sql_schema":
        return SQL_TREE;
      case "sql_table_detail":
        return { ...ORDER_DETAIL, name: a.table as string };
      case "sql_table_count":
        return 92311;
      case "sql_table_rows": {
        const q = `q${++n}`;
        const base = { query_id: q, stmt: 0, affected: null, error: null, error_pos: null, notice: null, finished: false };
        setTimeout(() => {
          const rows = orderRows().slice(0, 200);
          core({ type: "sql_result", ...base, index: 0, columns: ORDER_COLUMNS, rows, done: true, affected: rows.length, elapsed_ms: 18, truncated: true });
          core({ type: "sql_result", ...base, index: 1, columns: null, rows: [], done: true, finished: true, elapsed_ms: null, truncated: false });
        }, 80);
        return { query_id: q, sql: "SELECT * FROM `shop`.`orders` ORDER BY `id` ASC LIMIT 201" };
      }
      case "sql_run": {
        const q = `q${++n}`;
        const base = { query_id: q, stmt: 0, affected: null, error: null, error_pos: null, notice: null, finished: false, truncated: false };
        setTimeout(() => {
          const rows = sqlRows();
          core({ type: "sql_result", ...base, index: 0, columns: SQL_COLUMNS, rows, done: true, affected: rows.length, elapsed_ms: 41 });
          core({ type: "sql_result", ...base, index: 1, columns: null, rows: [], done: true, finished: true, elapsed_ms: null });
        }, 120);
        return q;
      }
      case "sync_status":
        return DEMO.syncStatus;
      case "backup_status":
        return DEMO.backupStatus;
      case "session_attach":
        setTimeout(() => core({ type: "session", info: { host_id: a.hostId, state: "connected", latency_ms: 38, error: null, leases: 1 } }), 50);
        return `att${++n}`;
      case "session_info":
        return { host_id: a.hostId, state: "connected", latency_ms: 38, error: null, leases: 1 };
      case "subscribe": {
        const host = a.hostId as string;
        const source = a.source as string;
        const id = `sub${++n}`;
        if (source === "metrics") return { sub_id: id, cached: DEMO.metrics(0) };
        if (source === "docker") return { sub_id: id, cached: DEMO.containers };
        if (source === "docker.stats") setTimeout(() => core({ type: "docker_stats", host_id: host, stats: DEMO.stats }), 120);
        if (source === "docker.logs") {
          const c = (a.params as { container?: string } | undefined)?.container ?? "shop-app-1";
          setTimeout(() => core({ type: "log_lines", host_id: host, stream: `docker:${c}`, lines: DEMO.logLines }), 150);
        }
        return { sub_id: id, cached: null };
      }
      case "term_open": {
        const id = `term${++n}`;
        setTimeout(() => core({ type: "term_data", term_id: id, data: b64(DEMO.terminal) }), 400);
        return id;
      }
      case "plugin:app|version":
        return "0.6.0";
      case "plugin:updater|check":
        return null;
      case "plugin:notification|is_permission_granted":
        return false;
      default:
        if (cmd.endsWith("_list")) return [];
        return null;
    }
  },
  { shouldMockEvents: true },
);

// Boot the real app, then open the scene's tab.
await import("../main");
const { useTabs } = await import("../stores/tabs");
const { useHosts } = await import("../stores/hosts");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50 && !useHosts.getState().loaded; i++) await wait(50);
const tabs = useTabs.getState();
const api01 = "h-api01";
switch (scene) {
  case "terminal":
    tabs.openServer("h-stg-web", "terminal");
    tabs.openServer("h-pi", "overview");
    tabs.openServer(api01, "terminal");
    break;
  case "docker": {
    tabs.openServer("h-stg-web", "terminal");
    tabs.openServer(api01, "docker");
    const { useDocker } = await import("../stores/docker");
    for (let i = 0; i < 40 && !useDocker.getState().byHost[api01]?.containers.length; i++) await wait(50);
    useDocker.getState().select(api01, DEMO.containers[0].id); // open the logs panel
    break;
  }
  case "sql-server": {
    tabs.openServer("h-stg-web", "terminal");
    tabs.openServer(api01, "database");
    let btn: HTMLButtonElement | null = null;
    for (let i = 0; i < 60 && !(btn = document.querySelector<HTMLButtonElement>("form button[type=submit]")); i++) await wait(50);
    btn?.click();
    const { sqlRegistry } = await import("../features/sql/registry");
    for (let i = 0; i < 60 && !sqlRegistry.get("host:h-api01"); i++) await wait(50);
    await wait(300);
    sqlRegistry.get("host:h-api01")?.run("all");
    break;
  }
  case "sql": {
    tabs.openServer("h-stg-web", "terminal");
    useTabs.setState((s) => ({ tabs: [...s.tabs, { id: "db:demo", kind: "db", target: { kind: "saved", id: "c-shop" }, title: "shop prod" }], activeTabId: "db:demo" }));
    const { sqlRegistry } = await import("../features/sql/registry");
    for (let i = 0; i < 60 && !sqlRegistry.get("db:demo"); i++) await wait(50);
    await wait(300);
    sqlRegistry.get("db:demo")?.run("all");
    break;
  }
  case "sql-table":
  case "sql-structure": {
    tabs.openServer("h-stg-web", "terminal");
    useTabs.setState((s) => ({ tabs: [...s.tabs, { id: "db:demo", kind: "db", target: { kind: "saved", id: "c-shop" }, title: "shop prod" }], activeTabId: "db:demo" }));
    let row: HTMLElement | null = null;
    for (let i = 0; i < 80 && !(row = [...document.querySelectorAll<HTMLElement>("[data-sql-key=\"db:demo\"] [role=button]")].find((e) => e.textContent?.startsWith("orders")) ?? null); i++) await wait(50);
    row?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await wait(400);
    if (scene === "sql-structure") {
      [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Structure")?.click();
    } else {
      for (let i = 0; i < 40 && !document.querySelector("[aria-label=\"Search rows\"]"); i++) await wait(50);
      [...document.querySelectorAll<HTMLButtonElement>("[aria-label=\"Show row details\"]")][0]?.click();
      const cell = [...document.querySelectorAll<HTMLElement>("[data-sql-key=\"db:demo\"] .truncate")].find((e) => e.textContent === "92309");
      cell?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }
    break;
  }
  case "sql-dialog": {
    tabs.openServer("h-stg-web", "terminal");
    const { useConnDialog } = await import("../features/sql/connDialog");
    const { useSql } = await import("../stores/sql");
    for (let i = 0; i < 60 && !useSql.getState().connsLoaded; i++) await wait(50);
    useConnDialog.getState().open({ conn: useSql.getState().conns.find((c) => c.id === "c-analytics") });
    break;
  }
  case "editor":
  case "editor-merge":
  case "editor-review": {
    const host = scene === "editor-review" ? api01 : "h-stg-web";
    if (scene !== "editor-review") tabs.openServer(api01, "terminal");
    tabs.openServer(host, "editor");
    const ed = await import("../features/editor/actions");
    for (let i = 0; i < 80 && !ed.mounted.get(host); i++) await wait(50);
    await wait(200);
    if (scene === "editor-review") {
      const d = await ed.openFile(host, "/srv/shop/nginx/shop.conf");
      await wait(300);
      ed.replaceText(d.key, ed.textOf(d.key).replace("proxy_pass http://127.0.0.1:8080;", "proxy_pass http://127.0.0.1:8081;\n        proxy_read_timeout 120s;"));
      await wait(400);
      ed.hooks.get(host)?.save(d.key);
      break;
    }
    await ed.openFile(host, "/srv/shop/docker-compose.yml");
    const d = await ed.openFile(host, "/srv/shop/.env");
    await wait(300);
    const t = ed.textOf(d.key);
    ed.replaceText(d.key, scene === "editor-merge" ? t.replace("MAIL_NAME=Shop orders", "MAIL_NAME=Shop mail").replace("DB_PORT=5432", "DB_PORT=6432") : t.replace("DB_PORT=5432", "DB_PORT=6432"));
    const { useEditor } = await import("../stores/editor");
    useEditor.getState().togglePin(host, "/srv/shop/docker-compose.yml");
    await wait(600);
    if (scene === "editor-merge") ed.hooks.get(host)?.save(d.key);
    break;
  }
  case "backup":
  case "hosts":
  case "shortcuts":
  case "snippets":
  case "dashboard":
    tabs.openPage("dashboard");
    if (scene !== "dashboard") tabs.openPage(scene);
    break;
}
