# 03 — Desktop Features (Windows & macOS)

Every section says **when it loads**, **what it keeps**, and **what it costs the server**. If a section does not say "loads on open", it loads only when the user opens it.

---

## 1. App shell

### 1.1 Title bar
- Logo + name, quick-connect/search field (center), backup status chip ("Backed up to Drive · 2h ago" / "Not backed up"), native window controls.
- Backup chip click → Settings › Backup.

### 1.2 Quick connect / search (Ctrl+K also opens the palette)
- `user@host[:port]` + Enter → creates a temporary host (not saved unless the user clicks "Save") and opens a server tab.
- Plain text → searches hosts, snippets, open tabs.

### 1.3 Icon rail (always visible)
Hosts · Dashboard · Snippets · Tunnels · Hosts & identities · (spacer) · Lock · Settings.
- Hosts toggles the host list panel. Others open/focus their **page tab**.

### 1.4 Host list panel (collapsible, remembers width)
- Groups (nested, collapsible) with color square and count; hosts with status dot.
- Status dot = **last known** state from the DB (`server_snapshots`) or live session state if a tab is open. **No pinging** in the list.
- Click host → open/focus its server tab. Double-click → same but forces Terminal view.
- Right-click host: Open, Open in new terminal, Sync now, Edit, Duplicate, Move to…, Refresh setting (Inherit/Auto/Manual/Never), Delete.
- Right-click group: Sync group, Auto-sync on/off, Interval, Edit, Add host, Collapse all.
- Drag & drop to reorder / move between groups.
- Filter box filters by name, address, tag.
- Labels: PROD = red tag + red tab top border; STAGING amber; others by group color.

### 1.5 Tab bar
- Mixed **server tabs** (dot + name + env tag) and **page tabs** (icon + name). Close ×, middle-click close, drag to reorder, Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+W.
- One tab per server. Opening an already-open server focuses its tab.
- **Session restore**: on start, tabs and their active view are restored **without connecting**. A server tab shows "Disconnected · click to connect" until focused (or until "auto-connect restored tabs" is enabled in Settings).
- Closing a server tab: drops all leases → session closes after 30 s grace; all view state freed.

---

## 2. Server tab

### 2.1 View bar
`Overview · Terminal (n) · Files · Docker (•) · Services · Logs · Settings` + right side: terminal switcher (shell 1 / shop-app-1 / +), Split, Files panel toggle.
- Views are **lazy-mounted on first click and kept mounted hidden** afterwards.
- Start view per server/group setting (default Terminal).
- Docker dot: amber/red if last known state had problems (from snapshot or live events).

### 2.2 Stats bar (bottom, server tabs only)
- CPU % + sparkline, RAM used/total, Disk % (root), Net ↓↑, uptime, SSH latency, tunnel summary.
- Source: `metrics` subscription every 3 s **only while this tab is active and the window is visible**. Switching tab pauses it; the last values stay displayed (greyed after 30 s without updates).
- Click → Overview view.

### 2.3 Overview view
- Larger cards + uPlot charts for CPU/RAM/Disk/Net/Load from the **in-memory history** (15 min) collected by the same `metrics` subscription. No extra server cost.
- Quick facts (OS, kernel, Docker version, IPs) collected **once** on first open (`uname -a; cat /etc/os-release; docker --version; hostname -I`) and cached for the tab lifetime.

---

## 3. Terminal view

### 3.1 Core
- xterm.js + WebGL renderer, unicode11, search (Ctrl+F), web-links, image addon (Sixel/iTerm).
- Multiple terminals per server (switcher in the view bar); split horizontally/vertically with react-resizable-panels; each split is its own PTY channel on the same SSH session.
- Scrollback 10 000 lines (configurable). Output flow control to keep the UI responsive under `cat bigfile`.
- Terminal instances are created once and kept alive while the tab exists; on view/tab re-show `fit()` + resize is sent to the PTY.

### 3.2 Snippet bar + alias expansion
- Bar above the terminal shows snippets whose scope matches this server (all / tag / group / server), grouped by pack. Click → run (or paste only, per snippet setting). Hover shows the full command.
- Alias expansion: typing an alias followed by **Tab** (configurable: Tab or `;` prefix) replaces it with the command locally **before** sending to the server. Implementation: a local input buffer mirrors the current line (from keystrokes since last Enter); on Tab, if the buffer equals an alias, send backspaces + command. Never intercept anything else.

### 3.3 Appearance
- Theme per server/group/global; iTerm2 color scheme importer (`.itermcolors` → xterm theme). Font family/size, ligatures, cursor style, padding, optional background transparency/vibrancy.
- PROD tint: subtle red top border + red tab marker (never changes terminal colors so logs stay readable).

### 3.4 Safety
- Multi-line paste warning with preview (bypass with Shift+Ctrl+V).
- "Confirm before running on PROD" for snippets flagged dangerous.

### 3.5 Local shell
- Local tab kind: PowerShell / cmd / WSL / zsh via portable-pty. Appears in tab bar with a terminal icon, no stats bar.

### 3.6 Broadcast
- Toggle: input goes to all terminals in the current split group (or to selected server tabs in a picker). Clear visual banner while active.

### 3.7 Command finished notification
- With shell integration (OSC 133), a command that ran > N s (default 20) and finishes while the app/tab is not focused sends a desktop notification with exit status.

### 3.8 Sudo helper
- When the PTY output ends with `[sudo] password for <user>:` and the identity has a sudo password, show a small inline "Fill from vault" button (never auto-send).

### 3.9 Session logging
- Per server/global option: write raw output to `logs/<server>/<date>.log` with rotation.

### 3.10 Triggers
- Regex → style (ERROR red, WARN amber, custom). Optional desktop notification. Evaluated on the frontend on new lines only.

### 3.11 Extras (P2)
- Quake-style drop-down window via global shortcut; window vibrancy (Mica/Acrylic/macOS).

---

## 4. Files view & Files panel (SFTP)

### 4.1 Loads on open
- First open of Files view or Files panel opens **one SFTP channel** on the existing session. Lists the start folder (server setting) or the terminal cwd if "Follow terminal" is on.
- Directory listings cached per path for the tab lifetime; re-show within 60 s does not re-list; manual refresh button; auto-refresh after own uploads/deletes.

### 4.2 UI
- Panel (right of terminal, resizable) and full view share one component. Columns: name, size, modified, perms (view only). Virtualised. Breadcrumb path, hidden files toggle, sort.
- Actions: upload (drag-drop, picker), download, new folder, rename, delete (confirm), chmod, copy path, open in terminal (cd), edit.
- Transfers queue with progress, pause/cancel; resumable where SFTP allows.

### 4.3 Follow terminal
- Uses OSC 7 (cwd) when the shell integration snippet is installed (we offer "Install shell integration" which appends a few lines to `.bashrc`/`.zshrc`). Fallback: parse `PWD` from the prompt only if the user enabled "prompt parsing". **Never** runs `pwd` by itself.

### 4.4 Edit locally
- Double-click text file → download to a temp dir → open in built-in CodeMirror tab or external editor (setting). A watcher re-uploads on save with a toast; conflict check via mtime.

---

## 5. Docker, Services, Logs, Processes (all inside the server tab)

### 5.1 Docker view — loads on first open
- First open: `docker ps -a --format json` + compose grouping (`com.docker.compose.project` label; `docker inspect` batch once, cached).
- Then: subscribe to `docker.events` (push; keeps list state correct at zero polling cost) — stays on while the server tab exists.
- Table grouped by compose project: status dot + name + state text, image, CPU, Memory, ports, actions (Logs, Shell, Restart, Stop/Start, …more: remove, inspect, copy id).
- Filter box, "Problems" filter (restarting, exited non-zero, unhealthy).
- Actions ask for confirmation on PROD (type container name for Remove).
- If `docker` is missing or permission denied → friendly empty state with the exact fix (`usermod -aG docker <user>`).

### 5.2 Live CPU/RAM per container
- Subscribe to **one** streaming `docker stats --format json` only while the Docker view is visible. Hidden → process killed; last values stay.

### 5.3 Logs panel (right of the container table)
- Opens for the selected container. Starts `docker logs --tail 200 -f` **only while visible**. On hide: stop follow, keep ring buffer (5 000 lines), remember last timestamp. On re-show: `--since <last_ts>` to fill the gap, then `-f` again.
- Level detection (ERROR/WARN/INFO via regex, configurable), filter chips, search, pause, download to file, wrap toggle.

### 5.4 Shell into container
- Creates a new terminal **inside the same server tab** named after the container: `docker exec -it <id> sh -c 'command -v bash >/dev/null && exec bash || exec sh'`.

### 5.5 Quick commands per container
- Snippets with scope "container" (match by name pattern or compose service). Run via `docker exec` in a new terminal or inline (output shown in a drawer).

### 5.6 Services view — loads on open
- `systemctl list-units --type=service` once; manual refresh; optional 10 s refresh while visible. Actions: start/stop/restart/enable/disable (sudo via vault helper), "journal" → opens `journalctl -u <svc> -f` in the Logs view.

### 5.7 Logs view (server log files)
- Favorites per server (e.g. `storage/logs/laravel.log`, `/var/log/nginx/error.log`) + browse via SFTP. `tail -n 200 -f` only while visible, same gap-fill logic as 5.3 (by byte offset). Same highlighting/search UI.

### 5.8 Processes view — loads on open
- `ps` top-40 by CPU; optional 5 s refresh while visible; kill with confirmation.

---

## 6. Snippets page tab & command palette

### 6.1 Library
- Left: list grouped by pack/tag with search; right: editor. Import/Export packs (JSON).

### 6.2 Snippet fields
- Name, alias (unique), command (multi-line ok), variables auto-detected `${name}` with default + "ask each run", scope (All / Tag / Group / Server / Container), run mode (Run / Paste only / New terminal), hotkey, "Ask before PROD", "Dangerous" flag, pack.

### 6.3 Command palette (Ctrl/⌘K, works on every tab)
- Sections: Snippets (scoped to the current server first), Workflows, Hosts (open tab), Actions (sync group, lock, new terminal, split, toggle files panel…), Open tabs.
- Enter = run/open; Ctrl+Enter = paste only; Tab = edit variables inline; ↑↓ navigate. cmdk-based.

### 6.4 Hotkeys
- "Record" button captures a chord; conflicts shown immediately. App-level via tinykeys; optional global via tauri-plugin-global-shortcut (palette, lock, quake window).

### 6.5 PROD guard
- Snippets with "Ask before PROD" show a confirm dialog with the final command and the server name.

### 6.6 Workflows
- Ordered steps (snippets or raw commands), per step: continue/stop on non-zero exit (needs shell integration to read exit codes; otherwise "fire and forget" mode). Run in a new terminal with a step header line. Variables asked once.

### 6.7 Packs
- Built-in: Laravel, Docker, Git, systemd, Nginx. Users can export a pack and share the JSON.

---

## 7. Hosts & identities page tab

### 7.1 Tree (left)
- Groups and hosts with checkboxes for bulk actions; each row shows its effective refresh setting (`↻ 1m`, `Manual`, `Never`).

### 7.2 Host editor (center)
- General: name, address, port, group, tags, environment label.
- Login: identity (inherit from group or override), sudo password (vault), jump host.
- **Background refresh**: inheritance trail (Global → Group → Server), mode, interval, what to collect, desktop/mobile, Wi-Fi only. See 04 §4.
- When the tab opens: start view, start folder, terminal theme, auto-reconnect, keep-alive, log to file.
- Buttons: Test connection (opens and closes a session; shows latency, fingerprint, auth method), Open tab, Duplicate, Delete.

### 7.3 Bulk edit / move
- Select N hosts → change group, identity, tags, refresh setting, environment label in one dialog.

### 7.4 Identities (right)
- Name, auth (password / key file / key stored in vault / agent), passphrase, sudo password, "used by N servers". Generate ed25519 key + "Copy public key to server" (runs `ssh-copy-id` equivalent over the existing session).

---

## 8. Dashboard page tab

### 8.1 Rendering
- Always from `server_snapshots` in SQLite. Opening the tab costs **zero network**. Cards: name, env tag, address/OS, CPU/RAM/Disk bars, "Synced X ago" (fades when old), refresh-setting pill, per-card ↻.

### 8.2 Group tabs + Sync
- Tabs: All · each group (shows `↻` + interval when auto-sync is on). Selected tab = **scope**.
- "Sync now" syncs the scope (skips Never, marks Locked, never prompts). Button label reflects scope ("Sync Home lab"). Progress per card: queued → syncing → ok/failed/locked.
- Per-card ↻ syncs one server even if it is Never (explicit user action).

### 8.3 Auto-sync switch
- Reflects the scope: On/Off for a group; on All: On / Off / **Mixed (n of m)**. Changing on All asks for confirmation and applies to every group, keeping per-group intervals and per-server overrides.
- Interval selector appears for a group scope (30 s / 1 / 5 / 15 min). Global master pause lives in Settings and in the tray menu.

### 8.4 Needs attention
- Derived from the latest snapshots with thresholds (CPU > 85 % for 2 snapshots, Disk > 80 %, container restarting/unhealthy, offline > 1 h). Clicking opens the server tab on the right view.

### 8.5 Context menus
- Right-click group tab: Sync, Auto-sync on/off, Interval, Edit group. Remembered last selected tab.

---

## 9. Lock screen
- One PIN field, autofocus on show, numeric only, unlocks on the last digit, no Enter. Wrong → shake, clear, refocus, "n tries left". 5 wrong → 30 s wait; 10 → PIN disabled, master password required.
- Buttons: Windows Hello / Touch ID; "Use master password".
- Triggers: manual (Ctrl+L / rail), idle timeout, OS lock/sleep, app start. While locked all subscriptions are stopped and sessions stay open (configurable: close sessions on lock).

---

## 10. Tunnels page tab (v0.5)
- List of local/remote/dynamic forwards per server with on/off switch, status, bytes. A tunnel takes a lease on its server session. "Open in browser" for local HTTP forwards. Tunnel summary also in the stats bar.

---

## 11. Settings page tab
- General: theme, fonts, start page, restore tabs, auto-connect restored tabs.
- Security: PIN length, biometrics, auto-lock idle, lock on sleep, close sessions on lock, clipboard clear.
- Refresh (global defaults): mode, interval, what to collect, concurrency, timeout, master pause.
- Terminal: scrollback, paste warning, shell integration install, triggers.
- Backup: export/import, Google Drive connect/backup/restore, scheduled local backup.
- Shortcuts: all app hotkeys editable.

## 12. Onboarding (P2)
- First run: create master password → set PIN → optional import (ssh config / MobaXterm / PuTTY) → optional Drive connect.
