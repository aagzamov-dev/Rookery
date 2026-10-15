# 05 — Mobile (Android first) & Tablet

The phone is for **checking and quick actions**, not long typing sessions. Same `rook-core`, same vault, same backup file, stricter power/data rules.

---

## 1. Technology
- **Tauri 2 mobile** (Android) with the same React app, responsive layouts (phone / tablet breakpoints), `rook-core` compiled for `aarch64-linux-android`.
- If Tauri mobile falls short (WebView performance for xterm, background limits): expose `rook-core` through **UniFFI** and build a Kotlin (Compose) UI. The core API must stay UI-agnostic from day one (no Tauri types in `rook-core`).
- Terminal: xterm.js in WebView is acceptable for short sessions; evaluate early (v0.1 spike) on a mid-range phone.
- iOS after Android (same path; Keychain + Face ID via `robius-authentication`).

---

## 2. Layout modes
| Width | Mode | Navigation |
|---|---|---|
| < 600 dp (phone) | Single column | Bottom nav: Servers · Terminal · Snippets · Settings; server screens stack with back |
| 600–900 dp (tablet portrait) | Single column, wider cards | Same as phone |
| ≥ 900 dp (tablet landscape) | **Split view**: server list left (330 dp), server content right with view tabs | Rail on the far left |

Tablet landscape mirrors desktop: Overview · Terminal · Docker · Files · Logs inside the selected server; split terminal + logs supported.

---

## 3. Lock
- PIN keypad (big round keys), auto-unlock on last digit, fingerprint button (Android BiometricPrompt, Keystore-backed key with user-auth requirement). Same attempt rules as desktop; Keystore enforces them in hardware.
- Lock on background after N seconds (default 30 s), on screen off, on start.

---

## 4. Home = Dashboard (renders from local DB, zero network on open)
- Group chips (All + groups, `↻` when auto-sync on). Scope box: title, summary, **Sync** button, **Auto-sync** switch (Mixed on All with confirm).
- Pull-to-refresh = Sync the selected scope.
- Cards: name, env tag, CPU/RAM/Disk bars, "Synced X ago" (faded when old), refresh pill, per-card ↻. Tap → Server screen.
- Mobile-specific rules (from refresh settings): `mobile` flag per host, **Wi-Fi only**, pause under 15 % battery, never sync while screen is off (foreground only in v1.0).

---

## 5. Server screen (stack)
- **Health**: CPU ring + sparkline, Memory/Disk/Net/Swap tiles. Subscribes to `metrics` **only while this screen is in the foreground**; back/home → unsubscribed, values kept.
- Action tiles: Containers, Terminal, Logs, Services; "Run workflow" button.
- **Containers**: segmented filter (All / Running / Problems); problem containers expanded first with Logs / Shell / Restart / Stop; compose group list. Loads on open (`docker ps`), `docker events` while on screen, `docker stats` streaming only on this screen.
- **Logs**: live follow only while on screen; gap fill with `--since` on return; filters, search, Pause / Restart / Save.
- **Terminal**: session dots (swipe between terminals), snippet chips row, extra-keys grid (Esc, Tab, Ctrl, Alt, arrows, `| / ~ -`), Files button. Ctrl is sticky. Landscape hides the header.
- Confirmations for Stop/Restart; PROD requires typing the container name for Remove.

---

## 6. First run & data
- Create or **Restore from Google Drive** (same OAuth PKCE flow via Custom Tabs) or import a `.rookbackup` from the file picker. Enter master password once → set PIN → enable fingerprint.
- Vault format identical to desktop; `VK` wrapped by PIN/biometric key in Android Keystore.

---

## 7. Later (post 1.0)
- **Background checks**: WorkManager every 15+ min for hosts with `mobile: true` and auto mode; local notification on threshold breach. Honest limits: not real-time.
- **Alerts**: optional integrations (Uptime Kuma, Netdata, Prometheus Alertmanager webhook → push via a tiny relay) or an opt-in agent.
- **Home-screen widget** (native Kotlin Glance) showing the last snapshots.
- **Mosh** for flaky mobile networks.

---

## 8. Mobile performance rules
- One SSH session per host, closed 10 s after leaving the server screen (shorter grace than desktop).
- Max 2 concurrent sync connections on mobile. Timeout 8 s.
- Metrics interval on mobile: 5 s (not 3 s). `docker stats` stream only on the Containers screen.
- All lists virtualised; logs ring buffer 2 000 lines on mobile.
