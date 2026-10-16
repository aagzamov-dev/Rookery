// Demo files for the Editor scenes (no real server).
const ENV = `# shop · production
APP_ENV=production
APP_URL=https://shop.example.com
APP_KEY=base64:7Hq2hY0r4mVt9xWc1L3nKp8sFz6uQe5a

DB_HOST=db
DB_PORT=5432
DB_DATABASE=shop
DB_USERNAME=shop
DB_PASSWORD=Xr9!vLq2#sT7pW
DB_HOST=127.0.0.1

MAIL_FROM = orders@shop.example.com
MAIL_NAME=Shop orders
REDIS_URL=redis://redis:6379/0
`;

const COMPOSE = `services:
  app:
    image: ghcr.io/example/shop:2.14.1
    restart: unless-stopped
    env_file: .env
    depends_on: [db, redis]
    ports:
      - "127.0.0.1:8080:8080"
  db:
    image: postgres:16
    volumes:
      - db:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine

volumes:
  db: {}
`;

const NGINX = `server {
    listen 443 ssl http2;
    server_name shop.example.com;

    ssl_certificate     /etc/letsencrypt/live/shop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
`;

const CONFIG = `{"name":"shop","workers":4,"queues":["orders","mail"],"features":{"newCheckout":true,"giftCards":false}}
`;

const FILES: Record<string, string> = {
  "/srv/shop/.env": ENV,
  "/srv/shop/docker-compose.yml": COMPOSE,
  "/srv/shop/nginx/shop.conf": NGINX,
  "/srv/shop/config/app.json": CONFIG,
  "/srv/shop/deploy.sh": "#!/usr/bin/env bash\nset -euo pipefail\ncd /srv/shop\ndocker compose pull app\ndocker compose up -d app\n",
};
const DIRS: Record<string, string[]> = {
  "/srv/shop": ["config", "nginx", ".env", "deploy.sh", "docker-compose.yml"],
  "/srv/shop/config": ["app.json"],
  "/srv/shop/nginx": ["shop.conf"],
};

const now = Math.floor(Date.now() / 1000);
const ver = (path: string) => ({ size: FILES[path]?.length ?? 0, mtime: now - 3600, sha256: `demo-${path}` });

export function editorMock(cmd: string, a: Record<string, unknown>, scene: string): unknown {
  const path = a.path as string;
  switch (cmd) {
    case "sftp_home":
      return "/srv/shop";
    case "sftp_list":
      return (DIRS[path] ?? []).map((name) => {
        const p = `${path}/${name}`;
        const dir = p in DIRS;
        return { path: p, name, kind: dir ? "dir" : "file", size: FILES[p]?.length ?? 0, mtime: now - 86400, mode: dir ? 0o755 : 0o640 };
      });
    case "editor_open":
      return {
        path,
        real_path: path,
        content: FILES[path] ?? "",
        version: ver(path),
        eol: "lf",
        mixed_eol: false,
        bom: false,
        read_only: false,
        read_only_reason: null,
        owned: !path.endsWith(".env"),
        mode: path.endsWith(".env") ? "640" : "644",
      };
    case "editor_stat":
      return { size: FILES[path]?.length ?? 0, mtime: now - 3600, exists: true };
    case "editor_save":
      if (scene === "editor-merge") {
        const theirs = (FILES[path] ?? "").replace("MAIL_NAME=Shop orders", "MAIL_NAME=Shop · Orders").replace("REDIS_URL=redis://redis:6379/0", "REDIS_URL=redis://redis:6379/1");
        return { kind: "conflict", theirs, theirs_version: { size: theirs.length, mtime: now - 120, sha256: "demo-theirs" }, deleted: false };
      }
      return { kind: "saved", version: { size: (a.content as string).length, mtime: now, sha256: "demo-saved" }, method: "atomic" };
    case "editor_backups":
      return [
        { id: "1", at: Date.now() - 3600_000, size: 410, sha256: "a" },
        { id: "2", at: Date.now() - 86400_000, size: 398, sha256: "b" },
      ];
    case "editor_backup_read":
      return FILES[path]?.replace("DB_PORT=5432", "DB_PORT=5433") ?? "";
    default:
      return undefined;
  }
}
