// Made-up servers for the demo / README screenshots (documentation IP ranges only).
import type { Container } from "../ipc/bindings/Container";
import type { ContainerStats } from "../ipc/bindings/ContainerStats";
import type { Group } from "../ipc/bindings/Group";
import type { Host } from "../ipc/bindings/Host";
import type { Identity } from "../ipc/bindings/Identity";
import type { MetricsSample } from "../ipc/bindings/MetricsSample";
import type { Snapshot } from "../ipc/bindings/Snapshot";
import type { Snippet } from "../ipc/bindings/Snippet";
import { emptyGroup, emptyHost, emptyIdentity } from "../stores/hosts";
import { emptySnippet } from "../stores/snippets";

const now = Date.now();
const GB = 1024 ** 3;

const group = (id: string, name: string, color: string, auto = false): Group => ({ ...emptyGroup(), id, name, color, auto_sync_enabled: auto });
const groups: Group[] = [
  group("g-prod", "Production", "#FF7A7A"),
  group("g-stg", "Staging", "#F2BA45"),
  group("g-lab", "Home lab", "#57C994", true),
  group("g-acme", "Client · Acme", "#8AB4FF", true),
];

const identities: Identity[] = [
  { ...emptyIdentity(), id: "i-deploy", name: "deploy", username: "deploy", auth: "key_file", key_path: "~/.ssh/id_ed25519", has_key: true },
  { ...emptyIdentity(), id: "i-root", name: "root", username: "root", auth: "password", has_password: true },
];

const host = (id: string, g: string, name: string, address: string, env: Host["env_label"], extra: Partial<Host> = {}): Host => ({
  ...emptyHost(g),
  id,
  name,
  address,
  env_label: env,
  identity_id: "i-deploy",
  ...extra,
});
const hosts: Host[] = [
  host("h-api01", "g-prod", "prod-api-01", "203.0.113.10", "prod", { tags: ["docker", "laravel"], start_folder: "/var/www/shop" }),
  host("h-api02", "g-prod", "prod-api-02", "203.0.113.11", "prod", { tags: ["docker", "laravel"] }),
  host("h-db01", "g-prod", "prod-db-01", "203.0.113.20", "prod", { tags: ["postgres"], refresh: { ...emptyHost().refresh, mode: "never" } }),
  host("h-stg-web", "g-stg", "staging-web", "198.51.100.5", "staging", { tags: ["docker"] }),
  host("h-stg-wrk", "g-stg", "staging-worker", "198.51.100.6", "staging"),
  host("h-pi", "g-lab", "pi-nas", "10.0.0.12", "lab", { identity_id: "i-root" }),
  host("h-ha", "g-lab", "homeassistant", "10.0.0.30", "lab", { identity_id: "i-root" }),
  host("h-acme", "g-acme", "acme-vps", "192.0.2.44", "client"),
];

const metrics = (cpu: number, ramPct = 40, disk = 50): MetricsSample => ({
  ts_ms: now,
  cpu_pct: cpu,
  ram_used_bytes: Math.round((ramPct / 100) * 8 * GB),
  ram_total_bytes: 8 * GB,
  disk_pct: disk,
  disk_used_bytes: Math.round((disk / 100) * 80 * GB),
  disk_total_bytes: 80 * GB,
  load1: cpu / 40,
  load5: cpu / 50,
  load15: cpu / 60,
  uptime_s: 41 * 86400 + 3600 * 5,
  net_rx_bps: 2_400_000,
  net_tx_bps: 640_000,
});

const docker = (running: number, total: number, extra: Partial<NonNullable<Snapshot["docker"]>> = {}) => ({
  total,
  running,
  exited: total - running,
  unhealthy: [],
  restarting: [],
  top: [],
  error: null,
  ...extra,
});

const snap = (host_id: string, minutesAgo: number, m: MetricsSample | null, extra: Partial<Snapshot> = {}): Snapshot => ({
  host_id,
  taken_at: now - minutesAgo * 60_000,
  state: "ok",
  error: null,
  last_ok_at: now - minutesAgo * 60_000,
  metrics: m,
  prev_cpu_pct: null,
  os: "Ubuntu 24.04.1 LTS",
  docker: null,
  failed_services: null,
  duration_ms: 1400,
  ...extra,
});

const snapshots: Snapshot[] = [
  snap("h-api01", 2, metrics(23, 39, 81), { docker: docker(5, 6) }),
  snap("h-api02", 2, metrics(18, 35, 54), { docker: docker(5, 5) }),
  snap("h-db01", 3 * 24 * 60, metrics(41, 72, 63), { os: "Debian 12" }),
  snap("h-stg-web", 25, metrics(6, 22, 38), { docker: docker(3, 4, { unhealthy: ["staging-app-1"] }) }),
  snap("h-stg-wrk", 25, metrics(92, 64, 47), { prev_cpu_pct: 90, os: "Ubuntu 22.04.4 LTS" }),
  snap("h-pi", 0.5, metrics(9, 31, 88), { os: "Raspberry Pi OS 12" }),
  snap("h-ha", 1, metrics(0), {
    state: "failed",
    error: "offline (no answer on the SSH port)",
    last_ok_at: now - 2 * 3600_000,
    os: "Home Assistant OS 13",
  }),
  snap("h-acme", 5, null, { state: "locked", error: "Needs password for root — add it to the identity", last_ok_at: null, os: null }),
];

const snippet = (id: string, name: string, alias: string, command: string, extra: Partial<Snippet> = {}): Snippet => ({ ...emptySnippet(), id, name, alias, command, ...extra });
const snippets: Snippet[] = [
  snippet("s1", "Serve app", "paserve", "php artisan serve --port=${port:8000}", { vars: [{ name: "port", default: "8000", ask: false }], hotkey: "Ctrl+Alt+S" }),
  snippet("s2", "Follow app logs", "dlogs", "docker compose logs -f --tail=100 ${service:app}"),
  snippet("s3", "Deploy", "deploy", "", { steps: ["git pull --ff-only", "composer install --no-dev", "php artisan migrate --force", "docker compose up -d --build"], ask_prod: true }),
  snippet("s4", "Disk usage", "df", "df -h / && du -sh /var/log/* | sort -h | tail"),
  { ...snippet("s5", "Failed orders today", "", "SELECT id, email, total FROM orders WHERE status = 'failed' AND created_at > CURRENT_DATE ORDER BY id DESC;"), alias: null, kind: "sql", scope: "host" },
];

const containers: Container[] = [
  ["shop-app-1", "shop/app:2.14.0", "running", "Up 3 hours (healthy)", "9000/tcp", "healthy", "shop", "app"],
  ["shop-nginx-1", "nginx:1.27", "running", "Up 3 hours", "0.0.0.0:443->443/tcp", null, "shop", "nginx"],
  ["shop-redis-1", "redis:7", "running", "Up 3 hours", "6379/tcp", null, "shop", "redis"],
  ["shop-db-1", "postgres:16-alpine", "running", "Up 3 hours (healthy)", "5432/tcp", "healthy", "shop", "db"],
  ["shop-worker-1", "shop/app:2.14.0", "running", "Up 12 minutes", "", null, "shop", "worker"],
  ["shop-scheduler-1", "shop/app:2.14.0", "running", "Up 3 hours", "", null, "shop", "scheduler"],
  ["uptime-kuma", "louislam/uptime-kuma:1", "exited", "Exited (1) 2 days ago", "", null, null, null],
].map(([name, image, state, status, ports, health, project, service], i) => ({
  id: `c${i}${"0".repeat(10)}`,
  name: name as string,
  image: image as string,
  state: state as string,
  status: status as string,
  ports: ports as string,
  health: health as string | null,
  project: project as string | null,
  service: service as string | null,
  created: "2026-10-16 06:00:00 +0000 UTC",
}));

const stats: ContainerStats[] = [
  { id: "c0", name: "shop-app-1", cpu_pct: 12.4, mem_pct: 6.1, mem_usage: "492MiB / 7.6GiB" },
  { id: "c1", name: "shop-nginx-1", cpu_pct: 0.8, mem_pct: 0.4, mem_usage: "31MiB / 7.6GiB" },
  { id: "c2", name: "shop-redis-1", cpu_pct: 1.1, mem_pct: 1.2, mem_usage: "94MiB / 7.6GiB" },
  { id: "c3", name: "shop-worker-1", cpu_pct: 7.9, mem_pct: 4.3, mem_usage: "338MiB / 7.6GiB" },
  { id: "c4", name: "shop-scheduler-1", cpu_pct: 0.2, mem_pct: 2.0, mem_usage: "158MiB / 7.6GiB" },
];

const iso = (sec: number) => new Date(now - sec * 1000).toISOString().replace("Z", "000000Z");
const logLines = [
  [96, "INFO  Order 18231 paid (stripe)"],
  [80, "INFO  GET /api/products 200 41ms"],
  [61, "WARNING Slow query 1.8s on orders (user 4412)"],
  [44, "INFO  GET /api/cart 200 28ms"],
  [30, "ERROR Payment webhook timeout after 30s (stripe)"],
  [22, "INFO  Retrying webhook 1/3"],
  [9, "INFO  Webhook delivered, order 18233 paid"],
  [3, "INFO  GET /health 200 3ms"],
].map(([s, t]) => `${iso(s as number)} ${t}`);

const P = "\x1b[1;32mdeploy@prod-api-01\x1b[0m:\x1b[1;34m/var/www/shop\x1b[0m$ ";
const terminal = [
  `\x1b[90mLast login: Thu Oct 16 09:12:44 2026 from 192.0.2.1\x1b[0m`,
  `${P}docker compose ps --format "table {{.Name}}\\t{{.Status}}"`,
  `NAME               STATUS`,
  `shop-app-1         Up 3 hours (healthy)`,
  `shop-nginx-1       Up 3 hours`,
  `shop-redis-1       Up 3 hours`,
  `shop-worker-1      Up 12 minutes`,
  `${P}tail -n 5 storage/logs/laravel.log`,
  `[2026-10-16 09:41:02] production.INFO: Order 18231 paid`,
  `[2026-10-16 09:41:07] production.WARNING: Slow query 1.8s on orders`,
  `[2026-10-16 09:41:09] production.ERROR: Payment webhook timeout (stripe)`,
  `[2026-10-16 09:41:12] production.INFO: Retrying webhook 1/3`,
  `[2026-10-16 09:41:15] production.INFO: Webhook delivered`,
  `${P}git log --oneline -3`,
  `\x1b[33m4f2c9a1\x1b[0m \x1b[1;36m(HEAD -> main, origin/main)\x1b[0m Checkout: retry Stripe webhooks`,
  `\x1b[33m9b81e0d\x1b[0m Orders: index on created_at`,
  `\x1b[33m27aa3f4\x1b[0m Release 2.14.0`,
  `${P}`,
].join("\r\n");

export const DEMO = {
  groups,
  hosts,
  identities,
  snippets,
  snapshots,
  containers,
  stats,
  logLines,
  terminal,
  metrics: (_i: number) => metrics(23, 39, 81),
  settings: {
    "ui.onboarded": true,
    "ui.update": { auto: true, skipped: null, lastCheck: now, lastVersion: "0.6.0" },
    "ui.dashboard.tab": "all",
  } as Record<string, unknown>,
  syncStatus: {
    settings: { paused: false, concurrency: 3, run_when_hidden: false, ungrouped_auto: false },
    global: { mode: "auto", interval_s: 300, collect: "basic_docker", desktop: true, mobile: true, wifi_only: true },
    running: [],
  },
  backupStatus: {
    config: { device_id: "d-pc", device_name: "WORK-PC", folder: "G:\\My Drive\\Rookery", auto: true },
    has_password: true,
    syncing: false,
    last_sync_at: now - 2 * 60_000,
    last_error: null,
    last_summary: { added: 3, updated: 1, deleted: 0, notes: [] },
    peers: [{ device_id: "d-mac", device_name: "MacBook Air", written_at: now - 14 * 60_000, error: null }],
  },
};
