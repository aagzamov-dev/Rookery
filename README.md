# Rookery

Local-first server manager: terminal, SFTP, Docker and monitoring for Windows and macOS (Android later).

Specs: [01-ARCHITECTURE](01-ARCHITECTURE.md) · [02-ROADMAP](02-ROADMAP.md) · [03-DESKTOP-FEATURES](03-DESKTOP-FEATURES.md) · [04-DATA-SYNC-SECURITY](04-DATA-SYNC-SECURITY.md) · [05-MOBILE-TABLET](05-MOBILE-TABLET.md) · [06-AUTO-UPDATE](06-AUTO-UPDATE.md)
Design: https://claude.ai/artifact/B6ZbSxMVvfykQtpF5ojndo

## Layout

```
crates/rookery-core     all logic: vault, SQLite, SSH sessions + leases, terminals, collectors, subscriptions (no Tauri)
crates/rookery-tauri    Tauri 2 shell: commands + event forwarding (thin)
apps/desktop         React + TypeScript + Vite + Tailwind
apps/desktop/src/ipc/bindings   TS types generated from rookery-core (ts-rs) — committed
```

## Prerequisites

- Rust (stable, via rustup)
- Windows: Visual Studio 2022 Build Tools with "Desktop development with C++"; WebView2 (preinstalled on Windows 11)
- macOS: Xcode command line tools
- Node 20+

## Commands

```bash
npm install            # once
npm run icons          # once: generate app icons from app-icon.svg
npm run bindings       # regenerate TS types after changing rookery-core/src/model.rs or events.rs
npm run dev            # run the desktop app (Vite + Tauri)
npm test               # Rust tests + frontend tests
npm run build          # release bundle
```

## What works today (v0.1 – v0.4)

- Vault: master password (Argon2id + XChaCha20-Poly1305), 4–6 digit PIN stored wrapped in the OS keychain, auto-submit, attempt limits (5 → 30 s wait, 10 → disabled), auto-lock after 10 min idle.
- Hosts, nested groups, reusable identities (password, key file, key in vault), identity inherited from group.
- Shell: icon rail, host list, mixed server/page tabs. **Nothing connects until a server tab is opened.**
- Server tab: one SSH session per host (leases, 30 s grace close, auto-reconnect with backoff), host-key trust on first connect and a warning when it changes, multiple terminals per server kept alive across tab/view switches, stats bar + Overview from one batched command every 3 s — only while that tab is active and the window is focused.

- Snippets: alias, `${variables}` with defaults, scope (all / tag / group / server), run mode, hotkey, PROD confirmation, starter packs (Laravel, Docker, Git, System). Run them from the snippet bar, the command palette, a hotkey, or by typing the alias and pressing Tab in a terminal.
- Command palette: Ctrl+K (⌘K), or Ctrl+Shift+P inside a terminal. Enter runs, Ctrl+Enter types without running.
- Terminal copy/paste: Ctrl+Shift+C / Ctrl+Shift+V, Shift+Insert, Ctrl+C copies a selection, Ctrl+V pastes, right-click copy/paste, warning before multi-line pastes. All options are in Settings.
- Keyboard shortcuts page (keyboard icon in the rail): ~50 functions (select all, copy, paste, find, clear, zoom, tabs, views, files…), many unassigned so you choose the keys; presets for MobaXterm/PuTTY, Windows Terminal and iTerm2; custom keys that type text; import/export. Ctrl+letter shortcuts you set yourself also work inside terminals.
- Terminal extras: themes (10 built in + iTerm `.itermcolors` import), fonts, find bar (F3), broadcast typing, long-command notifications, sudo password fill from the vault, local shells (PowerShell, cmd, WSL, Git Bash / zsh, bash).
- Workflows (multi-step snippets), snippet import/export, quick commands per container, Processes view, folder upload, known-hosts list, session restore.
- Files (SFTP): full view and a side panel next to the terminal; upload (picker or drag & drop), download, new folder, rename, delete, cd here; edit locally — saves upload back, with conflict protection; panel can follow `cd` after a one-click shell-integration install.
- Docker: containers grouped by compose project, live CPU/memory, start/stop/restart/remove, logs panel (live, errors/warnings, search), shell into a container. List updates come from `docker events` — no polling.
- Services (systemd) with start/stop/restart in a terminal (you type sudo), journal; Logs view follows any log file with `tail -F`.
- Everything above runs only while its view is on screen and stops when you leave it.

- Dashboard (v0.4): group tabs (All · each group · Ungrouped), cards from saved snapshots (opening it never connects), Sync for the selected tab or one card, Auto-sync switch per group with interval (On / Off / Mixed on All, with confirmation), needs-attention list (high CPU twice in a row, RAM, disk, restarting/unhealthy containers, failed services, offline > 1 h), right-click menus. Each sync is one command over one short connection (or the already-open session), max 3 servers at once, offline servers fail fast, 3 failures in a row double the interval (up to 30 min), and auto-sync pauses when the app is locked or minimised for a minute.

- Backup & sync (v0.5): one sync password (same on every device); a sync folder inside Google Drive / OneDrive / Dropbox keeps PC and laptop merged (newest edit wins, deletions sync, passwords included, encrypted); backup file with Save / Show in folder / Copy file (paste into Telegram) and Import with Merge or Replace.

Not yet (v0.5): importers (~/.ssh/config, MobaXterm, PuTTY), tunnels, jump hosts, SSH agent login, key generator.

## Where data lives

`%APPDATA%\Rookery` (Windows) · `~/Library/Application Support/Rookery` (macOS): `rookery.db` (no secrets), `vault.bin` (encrypted). The PIN entry is in the OS keychain.
# server-managment
