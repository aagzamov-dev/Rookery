# Rook

Local-first server manager: terminal, SFTP, Docker and monitoring for Windows and macOS (Android later).

Specs: [01-ARCHITECTURE](01-ARCHITECTURE.md) · [02-ROADMAP](02-ROADMAP.md) · [03-DESKTOP-FEATURES](03-DESKTOP-FEATURES.md) · [04-DATA-SYNC-SECURITY](04-DATA-SYNC-SECURITY.md) · [05-MOBILE-TABLET](05-MOBILE-TABLET.md)
Design: https://claude.ai/artifact/B6ZbSxMVvfykQtpF5ojndo

## Layout

```
crates/rook-core     all logic: vault, SQLite, SSH sessions + leases, terminals, collectors, subscriptions (no Tauri)
crates/rook-tauri    Tauri 2 shell: commands + event forwarding (thin)
apps/desktop         React + TypeScript + Vite + Tailwind
apps/desktop/src/ipc/bindings   TS types generated from rook-core (ts-rs) — committed
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
npm run bindings       # regenerate TS types after changing rook-core/src/model.rs or events.rs
npm run dev            # run the desktop app (Vite + Tauri)
npm test               # Rust tests + frontend tests
npm run build          # release bundle
```

## What v0.1 does today

- Vault: master password (Argon2id + XChaCha20-Poly1305), 4–6 digit PIN stored wrapped in the OS keychain, auto-submit, attempt limits (5 → 30 s wait, 10 → disabled), auto-lock after 10 min idle, Ctrl+L.
- Hosts, nested groups, reusable identities (password, key file, key in vault), identity inherited from group.
- Shell: icon rail, host list, mixed server/page tabs. **Nothing connects until a server tab is opened.**
- Server tab: one SSH session per host (leases, 30 s grace close, auto-reconnect with backoff), host-key trust on first connect and a warning when it changes, multiple terminals per server kept alive across tab/view switches, stats bar + Overview from one batched command every 3 s — only while that tab is active and the window is focused.

Not yet: snippets/palette (v0.2), Files/Docker/Services/Logs (v0.3), Dashboard sync (v0.4), backup/Drive/jump hosts/agent auth (v0.5).

## Where data lives

`%APPDATA%\Rook` (Windows) · `~/Library/Application Support/Rook` (macOS): `rook.db` (no secrets), `vault.bin` (encrypted). The PIN entry is in the OS keychain.
# server-managment
