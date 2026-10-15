# 02 — Roadmap & Priorities

Priorities:
- **P0** — must exist for the milestone to ship.
- **P1** — strongly expected; ship in the milestone if time allows, else next.
- **P2** — nice to have.
- **P3** — later / maybe.

Each feature points to the file where it is specified: `[A]` 01-ARCHITECTURE, `[D]` 03-DESKTOP-FEATURES, `[S]` 04-DATA-SYNC-SECURITY, `[M]` 05-MOBILE-TABLET.

---

## v0.1 — Foundation (lazy model + vault + terminal)

Goal: open the app, unlock with PIN, click a server, get a fast terminal in a tab. The **lazy-load / state model is built here, not later** — retrofitting it is the most expensive mistake possible.

| P | Feature | Spec |
|---|---|---|
| P0 | Tauri 2 + React project, `rook-core` crate, typed IPC, CI build for Win/mac | [A] §3, §6 |
| P0 | SQLite storage, schema v1, migrations | [S] §1 |
| P0 | Vault: master password, XChaCha20-Poly1305, Argon2id, keychain-wrapped key | [S] §2 |
| P0 | Lock screen: 4–6 digit PIN, auto-submit, autofocus, attempt limits, auto-lock | [S] §2.3, [D] §9 |
| P0 | Hosts, groups (nested), identities — CRUD, inheritance (identity, jump host, theme, start folder) | [D] §7, [S] §1 |
| P0 | App shell: title bar, icon rail, host list (collapsible), tab bar (server + page tabs) | [D] §1 |
| P0 | ConnectionManager: one session per server, leases, grace close, keep-alive, reconnect | [A] §4.1 |
| P0 | Server tab with view bar; **Terminal view** (xterm.js, multiple terminals per server, split) | [D] §2, §3 |
| P0 | Subscriptions engine (visibility → subscribe/unsubscribe), mount-and-keep policy | [A] §5 |
| P0 | Stats bar (`metrics` subscription, 3 s, active tab only) | [D] §2.2 |
| P0 | PROD/STAGING/… environment labels, red tint for PROD | [D] §1.4 |
| P1 | Quick connect bar (`user@host`) | [D] §1.2 |
| P1 | Terminal themes (import iTerm2 schemes), fonts, ligatures | [D] §3.3 |
| P1 | Known-hosts manager + fingerprint change warning | [S] §2.5 |
| P1 | Multi-line paste warning | [D] §3.4 |
| P2 | Local shell tabs (PowerShell / zsh / WSL) | [D] §3.5 |

Done when: 20 hosts in the list cause **zero** connections; opening/closing/switching tabs behaves exactly as [A] §5 describes; killing Wi-Fi and reconnecting restores the session.

---

## v0.2 — Productivity (snippets, palette, hotkeys)

| P | Feature | Spec |
|---|---|---|
| P0 | Snippets: alias, command, variables `${var}` with defaults/ask, scope (all / tag / group / server) | [D] §6 |
| P0 | Command palette (Ctrl/⌘K): snippets, hosts, actions; Enter run / Ctrl+Enter paste | [D] §6.3 |
| P0 | Snippet bar in Terminal view, filtered by server tags | [D] §3.2 |
| P0 | Hotkeys per snippet with "Record" UI; global hotkey for palette | [D] §6.4 |
| P0 | "Ask before running on PROD" | [D] §6.5 |
| P1 | Alias expansion in terminal (`paserve` + Tab) | [D] §3.2 |
| P1 | Workflows (ordered steps, stop on failure) | [D] §6.6 |
| P1 | Session restore on app start (which tabs/views were open; reconnect lazily on tab focus) | [D] §1.5 |
| P1 | Broadcast input to several terminals | [D] §3.6 |
| P2 | Snippet packs (Laravel, Docker, Git, systemd, Nginx), import/export | [D] §6.7 |
| P2 | Command-finished desktop notification | [D] §3.7 |

---

## v0.3 — Files & Docker (the differentiators)

| P | Feature | Spec |
|---|---|---|
| P0 | Files view + Files side panel (SFTP): browse, upload/download with progress, drag-drop | [D] §4 |
| P0 | "Follow terminal" (cwd via shell integration OSC 7 / OSC 133; no polling) | [D] §4.3 |
| P0 | Edit remote file locally (CodeMirror or external editor), auto-upload on save | [D] §4.4 |
| P0 | Docker view: container list grouped by compose project, `docker events` stream, actions start/stop/restart | [D] §5 |
| P0 | Container logs panel (follow while visible, `--since` gap fill on re-show, ring buffer, level filters, search) | [D] §5.3 |
| P0 | Shell into container → new terminal inside the same server tab | [D] §5.4 |
| P1 | Live container CPU/RAM via one streaming `docker stats` | [D] §5.2 |
| P1 | Quick commands per container (snippets scoped to a container) | [D] §5.5 |
| P1 | Services view (systemd): status, start/stop/restart, journal tail | [D] §5.6 |
| P1 | Logs view (server log files: tail -f with highlight) | [D] §5.7 |
| P2 | Processes view (top-N, kill) | [D] §5.8 |
| P2 | Sudo password fill from vault when `[sudo] password:` appears | [D] §3.8 |

---

## v0.4 — Dashboard & Refresh Engine

| P | Feature | Spec |
|---|---|---|
| P0 | `server_snapshots` cache; Dashboard renders from DB only | [S] §4.5 |
| P0 | Dashboard tab: group tabs (All + groups), cards, "Synced X ago", stale fading | [D] §8 |
| P0 | Sync now — scoped to the selected tab; per-card sync | [D] §8.2 |
| P0 | Auto-sync switch scoped to tab; Mixed state on All with confirmation | [D] §8.3 |
| P0 | Refresh settings inheritance global → group → server (Inherit / Auto / Manual / Never), interval, what to collect | [S] §4 |
| P0 | RefreshEngine: concurrency, timeouts, backoff, pause conditions, Locked handling | [A] §4.4, [S] §4.4 |
| P1 | Needs-attention list from last snapshots (thresholds configurable) | [D] §8.4 |
| P1 | Overview view inside server tab (charts from live metrics history) | [D] §2.3 |
| P2 | Right-click group → sync / auto-sync / interval | [D] §8.5 |

---

## v0.5 — Backup, Sync & Imports

| P | Feature | Spec |
|---|---|---|
| P0 | Encrypted export/import `.rookbackup` (Argon2id + XChaCha20) with version/migration | [S] §5 |
| P0 | Google Drive manual backup/restore (OAuth PKCE, `drive.appdata`), refresh token in keychain | [S] §6 |
| P0 | "Backed up to Drive · 2h ago" status in title bar; restore chooser | [D] §1.1 |
| P1 | Import from `~/.ssh/config`, MobaXterm `.mxtsessions`, PuTTY registry | [S] §7 |
| P1 | Port-forwarding manager (Tunnels page) with on/off switches | [D] §10 |
| P1 | Jump host / bastion | [S] §1, [D] §7 |
| P1 | SSH key generator + "copy key to server" | [D] §7.4 |
| P2 | Scheduled local backups to a folder | [S] §5.4 |

---

## v0.6 — Polish & release

| P | Feature | Spec |
|---|---|---|
| P0 | Code signing (Windows cert, Apple notarization), auto-update | [A] §2 |
| P0 | Settings page (global refresh defaults, theme, fonts, shortcuts, auto-lock) | [D] §11 |
| P1 | Session logging to file | [D] §3.9 |
| P1 | Triggers (highlight ERROR/WARN; optional notify) | [D] §3.10 |
| P1 | Bulk edit / move hosts; duplicate host | [D] §7.3 |
| P2 | Hotkey (Quake-style) terminal window; window vibrancy | [D] §3.11 |
| P2 | Onboarding: first-run import wizard | [D] §12 |

---

## v1.0 — Android (then iOS)

| P | Feature | Spec |
|---|---|---|
| P0 | Tauri mobile build of the same React app + `rook-core`; UniFFI fallback plan | [M] §1 |
| P0 | Lock (PIN, fingerprint, Android Keystore) | [M] §3 |
| P0 | Dashboard home with group chips, Sync, Auto-sync, Wi-Fi-only, low-battery pause | [M] §4 |
| P0 | Server screen: health, Containers, Logs, Terminal with key bar | [M] §5 |
| P1 | Restore from Drive on first run | [M] §6 |
| P2 | Background check every 15+ min (WorkManager) + local notifications | [M] §7 |
| P3 | Home-screen widget (native Kotlin), push alerts via optional agent/integrations | [M] §7 |

---

## Explicitly out of scope (v1)

X11 server, RDP, VNC, Telnet/serial, Mosh, team sharing, AI assistant, plugins/macros.

---

## Order of implementation inside v0.1 (first 3–4 weeks)

1. `rook-core`: db + vault + model types → tests.
2. `rook-core`: ssh ConnectionManager + PTY channel + metrics collector → integration test against a Docker sshd.
3. `rook-tauri`: commands/events for the above; `ts-rs` export.
4. Frontend shell: lock → hosts list → tab bar → server tab → Terminal view.
5. Subscriptions engine + stats bar. Verify every rule in [A] §5 by hand and with tests **before** adding any other view.
