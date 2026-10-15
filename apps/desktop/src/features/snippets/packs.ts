import type { Snippet } from "../../ipc/bindings/Snippet";
import { emptySnippet } from "../../stores/snippets";
import { syncVars } from "./vars";

type Seed = {
  name: string;
  alias: string;
  command: string;
  defaults?: Record<string, string>;
  mode?: Snippet["run_mode"];
  tag?: string;
  /** Workflow steps (then `command` is ignored). */
  steps?: string[];
  scope?: Snippet["scope"];
  scopeValue?: string;
};

function make(pack: string, seeds: Seed[]): Snippet[] {
  return seeds.map((s, i) => {
    const sn = emptySnippet();
    sn.name = s.name;
    sn.alias = s.alias;
    sn.command = s.steps ? "" : s.command;
    sn.steps = s.steps ?? [];
    sn.pack = pack;
    sn.sort = i;
    sn.run_mode = s.mode ?? "run";
    if (s.tag) {
      sn.scope = "tag";
      sn.scope_value = s.tag;
    }
    if (s.scope) {
      sn.scope = s.scope;
      sn.scope_value = s.scopeValue ?? null;
    }
    sn.vars = syncVars(s.steps ? s.steps.join("\n") : s.command, []).map((v) => ({ ...v, default: s.defaults?.[v.name] ?? null }));
    return sn;
  });
}

export const PACKS: { id: string; name: string; description: string; snippets: () => Snippet[] }[] = [
  {
    id: "laravel",
    name: "Laravel",
    description: "artisan serve, migrate, queue, cache, logs — shown on hosts tagged “laravel”",
    snippets: () =>
      make("Laravel", [
        { name: "Serve app", alias: "paserve", command: "php artisan serve --host=0.0.0.0 --port=${port}", defaults: { port: "8000" }, tag: "laravel" },
        { name: "Migrate", alias: "pam", command: "php artisan migrate --force", tag: "laravel" },
        { name: "Tinker", alias: "pat", command: "php artisan tinker", tag: "laravel" },
        { name: "Queue restart", alias: "qr", command: "php artisan queue:restart", tag: "laravel" },
        { name: "Clear caches", alias: "pacc", command: "php artisan optimize:clear", tag: "laravel" },
        { name: "Tail Laravel log", alias: "llog", command: "tail -f storage/logs/laravel.log", tag: "laravel" },
        {
          name: "Deploy",
          alias: "deploy",
          command: "",
          tag: "laravel",
          mode: "new_terminal",
          steps: ["git pull --ff-only", "composer install --no-dev --optimize-autoloader", "php artisan migrate --force", "php artisan optimize", "php artisan queue:restart"],
        },
        { name: "Artisan in container", alias: "dart", command: "php artisan ${command}", defaults: { command: "about" }, scope: "container", scopeValue: "*app*" },
      ]),
  },
  {
    id: "docker",
    name: "Docker",
    description: "compose status, logs, restart, prune",
    snippets: () =>
      make("Docker", [
        { name: "Compose status", alias: "dcps", command: "docker compose ps" },
        { name: "Compose logs", alias: "dclogs", command: "docker compose logs -f --tail=200 ${service}", defaults: { service: "" } },
        { name: "Compose restart", alias: "dcr", command: "docker compose restart ${service}", defaults: { service: "" } },
        { name: "Compose pull + up", alias: "dcup", command: "docker compose pull && docker compose up -d" },
        { name: "Disk usage", alias: "ddf", command: "docker system df" },
        { name: "Prune unused", alias: "dprune", command: "docker system prune -f", mode: "paste" },
      ]),
  },
  {
    id: "git",
    name: "Git",
    description: "status, pull, log",
    snippets: () =>
      make("Git", [
        { name: "Status", alias: "gs", command: "git status -sb" },
        { name: "Pull", alias: "gp", command: "git pull --ff-only" },
        { name: "Log", alias: "gl", command: "git log --oneline -n 20" },
      ]),
  },
  {
    id: "system",
    name: "System",
    description: "disk, memory, services, journal",
    snippets: () =>
      make("System", [
        { name: "Disk usage", alias: "dfh", command: "df -h" },
        { name: "Memory", alias: "mem", command: "free -h" },
        { name: "Biggest folders here", alias: "dus", command: "du -sh * 2>/dev/null | sort -rh | head -20" },
        { name: "Service status", alias: "svc", command: "systemctl status ${service} --no-pager", defaults: { service: "nginx" } },
        { name: "Follow journal", alias: "jf", command: "journalctl -u ${service} -f", defaults: { service: "nginx" } },
      ]),
  },
];
