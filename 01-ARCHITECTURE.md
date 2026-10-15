# 01 — Architecture & Lazy-Load Model

Working name: **Rook** (placeholder). Local-first server manager: terminal + SFTP + Docker + monitoring, for Windows, macOS, later Android.

Design reference: https://claude.ai/artifact/B6ZbSxMVvfykQtpF5ojndo

---

## 1. Principles (non-negotiable)

1. **Nothing loads until the user opens it.** A server in a list is just a row in the local database. No connection, no metrics, no Docker. Opening a server tab connects; opening a view (Docker, Files, Logs…) fetches that view's data for the first time.
2. **Switching tabs or views never destroys state and never re-fetches.** Every open server tab and every opened view stays in memory with its scroll position, filters, terminal buffer and data. Hidden things only *pause* live updates.
3. **Live data only while visible.** Polling/streaming runs only for the view the user is looking at, in a focused, non-minimised window. Hidden = paused, not discarded.
4. **Minimal server load.** One SSH connection per server (multiplexed channels). One batched command per poll tick. Streams (`docker events`, `docker logs -f`) instead of polling where possible. Hard limits on concurrency.
5. **No agent on the server.** Everything goes over SSH with standard Linux tools. Nothing to install.
6. **Secrets never leave the encrypted vault.** Never prompt for secrets in the background.
7. **Explicit sync.** Multi-server data (Dashboard) is fetched only when the user presses Sync or has opted in to auto-sync per group/server.

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| App shell | **Tauri 2** | Windows, macOS; Android later from the same code |
| UI | **React 18 + TypeScript + Vite** | |
| Styling / components | **Tailwind CSS + shadcn/ui**, **Lucide** icons | Dark theme first (see design) |
| State | **Zustand** (slices per domain) + **TanStack Query** only for one-shot fetches | Subscriptions are custom (section 5) |
| Terminal | **xterm.js** + addons: fit, webgl, search, web-links, unicode11, image | Keep instances alive across tab switches |
| Panels / tabs | **react-resizable-panels**, **dnd-kit** (drag tabs/hosts) | |
| Command palette | **cmdk** · in-app hotkeys **tinykeys** · global **tauri-plugin-global-shortcut** | |
| Charts | **uPlot** | Tiny, fast; fine for mobile |
| Tables / lists | **TanStack Table + TanStack Virtual** | Virtualised file lists, logs |
| Editor (remote file edit) | **CodeMirror 6** | |
| SSH / SFTP | **russh** + **russh-sftp** (Rust) | Pure Rust, no OpenSSL |
| Local shell | **portable-pty** | PowerShell / zsh / WSL tabs |
| Docker | Over SSH: `docker … --format '{{json .}}'` (default) · optional socket forward + **bollard** later | No Docker port needed |
| Storage | **SQLite** via `rusqlite` (bundled) | One file: `rook.db` |
| Crypto | **argon2**, **chacha20poly1305** (XChaCha20-Poly1305), **zeroize** | Vault + export |
| OS keychain | **keyring** crate | Stores vault key wrapped by PIN/biometrics |
| Biometrics | **robius-authentication** | Windows Hello / Touch ID / Android fingerprint |
| Google Drive | **oauth2** (PKCE, loopback redirect) + **reqwest** → Drive API v3, scope `drive.appdata` | Manual backup/restore |
| Config parsing (imports) | **ssh2-config**, **rust-ini** (MobaXterm), **winreg** (PuTTY) | |
| Updates / signing | **tauri-plugin-updater**; Windows code-signing cert; Apple notarization | v0.6 |

---

## 3. Repository layout

```
rook/
├─ crates/
│  ├─ rook-core/            # Pure Rust library. NO Tauri dependency. Reused by mobile.
│  │  ├─ vault/             # master password, PIN wrap, encrypt/decrypt, keychain
│  │  ├─ db/                # SQLite schema, migrations, repositories
│  │  ├─ ssh/               # ConnectionManager, Session, channels, keep-alive, reconnect
│  │  ├─ sftp/              # SFTP ops, transfers, local-edit watcher
│  │  ├─ terminal/          # PTY channel wrapper, scrollback limits, flow control
│  │  ├─ collectors/        # metrics (one batched script), docker, services, processes, logs
│  │  ├─ refresh/           # RefreshEngine: inheritance, scheduler, concurrency, backoff, cache
│  │  ├─ snippets/          # snippets, variables, workflows, scope resolution
│  │  ├─ backup/            # export/import (.rookbackup), Drive client, importers
│  │  └─ model/             # shared types (serde) used by IPC
│  └─ rook-tauri/           # Tauri app: commands + events, thin glue over rook-core
├─ apps/
│  └─ desktop/              # React app (Vite)
│     ├─ src/app/           # shell: title bar, rail, host list, tab bar, lock
│     ├─ src/features/      # server-tab/{overview,terminal,files,docker,services,logs,settings}
│     │                     # pages/{dashboard,snippets,hosts,tunnels,settings}
│     ├─ src/stores/        # zustand slices: tabs, sessions, views, hosts, snippets, sync, ui
│     ├─ src/subscriptions/ # visibility → subscribe/unsubscribe engine (section 5)
│     └─ src/ipc/           # typed wrappers for Tauri commands/events
└─ docs/                    # these md files
```

Rule: **all logic lives in `rook-core`**. The React app only renders and sends intents. This is what makes Android cheap later.

---

## 4. Runtime architecture

```
┌──────────────────── React (apps/desktop) ────────────────────┐
│ tabsStore ─ viewsStore ─ sessionsStore ─ syncStore ─ hostsStore│
│          ▲ events                            │ commands        │
└──────────┼───────────────────────────────────┼─────────────────┘
           │ Tauri IPC (typed)                 ▼
┌──────────┴──────────── rook-tauri (commands/events) ──────────┐
│                 rook-core                                      │
│  Vault ─ Db ─ ConnectionManager ─ Collectors ─ RefreshEngine   │
│                       │ one SSH connection per server          │
│                       ├─ channel: PTY (terminal 1)             │
│                       ├─ channel: PTY (terminal 2 / exec)      │
│                       ├─ channel: SFTP                         │
│                       ├─ channel: exec (metrics tick)          │
│                       └─ channel: exec stream (docker events)  │
└────────────────────────────────────────────────────────────────┘
```

### 4.1 ConnectionManager (Rust)

- `open(server_id) -> SessionId`: connects (via jump host if set), authenticates with the identity from the vault, starts keep-alive. Idempotent: a second `open` for the same server returns the existing session.
- Reference-counted **leases**: each consumer (terminal, files view, metrics subscription, sync job) holds a lease. When the last lease is dropped the session enters **grace** (default 30 s) and then closes. Reopening inside grace is instant.
- **Reconnect**: on drop, exponential backoff (1 s → 30 s), re-attaches channels that can be re-attached (metrics, docker events). PTYs are re-created and the UI shows a "reconnected" line.
- **Hard caps**: max 32 open sessions; background sync uses a separate pool of max 3–4 (section 4.4).

### 4.2 Collectors (Rust) — "one exec per tick"

Every poll is **one** `exec` with a small shell script, parsed in Rust. Never N commands per tick.

`metrics` (default every 3 s while visible):
```sh
cat /proc/stat | head -1; echo ---; head -3 /proc/meminfo; echo ---; cat /proc/loadavg; echo ---; cat /proc/uptime; echo ---; df -P / | tail -1; echo ---; cat /proc/net/dev
```
CPU % = delta between this and the previous sample (kept in Rust). Net rate = delta / interval.

`docker.list` (on demand): `docker ps -a --format '{{json .}}'` (+ compose grouping from labels via `docker inspect` only on first load, cached).
`docker.stats` (streaming, only while Docker view visible): `docker stats --format '{{json .}}'` — **one long-running process**, not repeated `--no-stream` calls.
`docker.events` (streaming, while a server tab is open and Docker view was opened at least once): `docker events --format '{{json .}}' --filter type=container` — push, near-zero cost, keeps the list state correct without polling.
`docker.logs` (streaming, only while Logs panel visible): `docker logs --tail 200 --since <last_ts> -f <id>`.
`services` (on demand): `systemctl list-units --type=service --no-pager --plain --no-legend`.
`processes` (on demand, optional 5 s while visible): `ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu | head -40`.

All scripts must be POSIX `sh` compatible and fail soft (missing `docker` → "Docker not available on this server").

### 4.3 Subscriptions (the core contract between UI and Rust)

A **subscription** = "the UI is currently showing data source X for session S". Rust starts the collector/stream when the first subscription for (S, X) appears and stops it when the last one disappears. The last result is kept in memory in Rust and in the UI store, so re-subscribing shows cached data immediately and only then refreshes.

```
subscribe(session, source, params)   -> SubId
unsubscribe(SubId)
event  "<source>:update" { session, data, ts }
```

Sources: `metrics`, `docker.list`, `docker.stats`, `docker.events`, `docker.logs(container)`, `services`, `processes`, `sftp.dir(path)` (not a stream, cached), `tunnel.status`.

### 4.4 RefreshEngine (Dashboard / mobile background refresh)

Separate from subscriptions. Runs **only** on explicit Sync or when auto-refresh is enabled for a group/server (see 04-DATA-SYNC-SECURITY.md §4).
- Per server: resolve effective setting (server → group → global).
- Collect = one connection (reuse the open session if the server tab is open, else a temporary one), one batched script (metrics twice, 1 s apart, for CPU%) + optional `docker ps` / `docker stats --no-stream` depending on "what to collect". Then close the temporary connection.
- Concurrency 3 (configurable 1–6). Timeout 10 s. Servers that need an interactive secret are **skipped and marked Locked**.
- Backoff: after 3 consecutive failures, double the interval up to 30 min; reset on success.
- Results are written to `server_snapshots` (SQLite) with a timestamp. The Dashboard **always renders from the DB**; it never waits on the network.
- Pauses: window hidden/minimised, OS sleep, app locked, (mobile) not on Wi-Fi if configured, low battery.

---

## 5. Frontend state & visibility model

### 5.1 Stores

```ts
tabsStore:      { tabs: Tab[]; activeTabId }            // Tab = { kind:'server', serverId } | { kind:'page', page:'dashboard'|'snippets'|'hosts'|'tunnels'|'settings' }
sessionsStore:  { byServerId: { state:'idle'|'connecting'|'connected'|'reconnecting'|'error', latencyMs, sessionId } }
viewsStore:     { byServerId: { activeView, opened: Set<View>, terminal: {...}, docker: {...}, files: {...}, logs: {...}, services: {...} } }
syncStore:      { selectedGroup:'all'|groupId, autoByGroup, intervals, snapshots (mirror of DB), running: Set<serverId> }
hostsStore, snippetsStore, uiStore (lock state, window focus, theme)
```

### 5.2 Mount policy

- A **server tab** is created when the user opens a server. Its views are **mounted lazily on first open** and then **kept mounted but hidden** (`display:none` / `visibility:hidden`, not unmounted). This preserves scroll, selection, filters, xterm buffers and half-typed input for free.
- xterm instances live in a registry outside React; on view re-show call `fit()` once.
- Closing a server tab unmounts everything for that server, drops all leases, and frees buffers.

### 5.3 Visibility → subscriptions

`isVisible(server, view) = tab is active && view is active in that tab && window focused/visible && !minimised && !locked`

```ts
// subscriptions/engine.ts (pseudo)
effect(() => {
  for each server tab:
    for each opened view:
      const want = isVisible(server, view) ? sourcesFor(view) : []        // e.g. docker view -> ['docker.list','docker.stats']
      const keep = alwaysOnFor(server)                                      // ['metrics'] while tab is active; ['docker.events'] once docker was opened
      diff(current[server], union(want, keep)) -> subscribe / unsubscribe
})
```

Rules:
1. Hidden → `unsubscribe`, data stays in the store. Re-shown → render cached immediately, `subscribe` again (stale-while-revalidate).
2. Stats bar `metrics` is active only for the **active** server tab. Switching to another server tab pauses the first server's metrics.
3. Never fetch a view's data until the user opened that view at least once.
4. Window blur/minimise/lock → everything unsubscribed within 2 s. Focus → resubscribe only what's visible.
5. Streams that are cheap and keep state correct (`docker.events`) may stay on while the server tab exists; everything else is visibility-gated.
6. Memory caps: terminal scrollback 10 000 lines; log ring buffer 5 000 lines per container; metrics history 15 min at 3 s.

### 5.4 Re-show without refetch

When a view is re-shown and its data is younger than `freshFor` (default: docker list 15 s, services 30 s, sftp dir 60 s, processes 5 s), **do not** refetch; just resubscribe to live streams. Older → render cached + refresh in background with a subtle "updating…" indicator.

---

## 6. IPC contract (rook-tauri)

Commands (request/response):
```
vault.create(master) · vault.unlock(master|pin|biometric) · vault.lock() · vault.set_pin(pin)
hosts.list() · hosts.save(host) · hosts.delete(id) · groups.save · identities.save/list
session.open(server_id) -> {session_id} · session.close(session_id) · session.state(session_id)
term.open(session_id, {cols,rows,cwd?,container?}) -> term_id · term.write(term_id, bytes) · term.resize · term.close
sftp.list(session_id, path) · sftp.get(session_id, remote, local) · sftp.put · sftp.edit_local(session_id, remote) -> watches & re-uploads
docker.action(session_id, container_id, 'start'|'stop'|'restart'|'remove')
subscribe(session_id, source, params) -> sub_id · unsubscribe(sub_id)
sync.run(scope: 'all'|{group}|{server}) -> job_id · sync.cancel(job_id) · sync.snapshots(scope)
refresh.set(level:'global'|{group}|{server}, setting) · refresh.effective(server_id)
snippets.list/save/delete · snippets.run(term_id, snippet_id, vars)
backup.export(path, password) · backup.import(path, password) · drive.connect() · drive.backup() · drive.list() · drive.restore(id)
```
Events (push):
```
session:state {session_id, state, error?}
term:data {term_id, bytes} · term:exit {term_id}
metrics:update · docker.list:update · docker.stats:update · docker.events:update · docker.logs:update · services:update · processes:update
sync:progress {job_id, server_id, state:'queued'|'running'|'ok'|'failed'|'skipped'|'locked', snapshot?}
transfer:progress {id, bytes, total}
```
All payloads are `serde` types from `rook-core/model`, exported to TS with `ts-rs` or `specta`.

---

## 7. Performance budgets

| Item | Budget |
|---|---|
| Idle app with 20 servers in list, no tabs open | 0 connections, 0 network, < 150 MB RAM |
| One server tab, Terminal view active | 1 connection, 1 exec every 3 s (metrics) |
| Same tab, Docker view active | + 1 streaming `docker stats` + `docker events`; `docker ps` once, then only on events |
| Switch to Dashboard tab | server metrics paused; Dashboard renders from DB with 0 network |
| Dashboard "Sync all" (20 servers) | ≤ 3 parallel connections, ≤ 10 s per server, done in ~70 s worst case |
| Cold start to lock screen | < 1 s; unlock → UI < 300 ms; no network |

---

## 8. Testing strategy (minimum)

- `rook-core`: unit tests for parsers (metrics script output, `docker ps` JSON, systemctl), refresh inheritance resolution, scheduler/backoff, vault round-trip, backup export/import.
- Integration: a Docker image running `sshd` + `docker` (dind) used in CI to test connect, exec, SFTP, collectors.
- Frontend: tests for the visibility→subscription diff (pure function) — this is the most important behaviour in the app.
