# 04 — Data, Refresh Engine, Backup & Security

---

## 1. Local storage

### 1.1 App data folder (one folder = full backup)
```
%APPDATA%/Rookery/  (Win)   ~/Library/Application Support/Rookery/ (mac)
├─ rookery.db            # SQLite: hosts, groups, identities(meta), snippets, snapshots, settings
├─ vault.bin          # encrypted secrets blob (passwords, keys, passphrases, tokens)
├─ keys/              # private keys stored by reference (optional, may also live in vault)
├─ logs/              # session logs (optional)
└─ cache/             # temp downloads for "edit locally" (cleared on start)
```
Secrets are **never** in `rookery.db`; it holds only references (`secret_id`).

### 1.2 SQLite schema v1 (essential tables)
```sql
groups(id, parent_id, name, color, sort, identity_id, jump_host_id, theme, start_folder,
       refresh_mode, refresh_interval_s, refresh_collect, refresh_desktop, refresh_mobile, refresh_wifi_only,
       auto_sync_enabled)            -- group-level switch used by the Dashboard
hosts(id, group_id, name, address, port, env_label, tags_json, identity_id, jump_host_id, theme,
      start_view, start_folder, sudo_secret_id, auto_reconnect, keepalive_s, log_session,
      refresh_mode, refresh_interval_s, refresh_collect, refresh_desktop, refresh_mobile, refresh_wifi_only,
      sort, created_at, updated_at)
identities(id, name, username, auth_kind, key_path, secret_id_password, secret_id_key, secret_id_passphrase, secret_id_sudo)
known_hosts(host_id, key_type, fingerprint, first_seen, last_seen)
snippets(id, name, alias, command, vars_json, scope_kind, scope_value, run_mode, hotkey, ask_prod, dangerous, pack)
workflows(id, name, steps_json)
server_snapshots(host_id PRIMARY KEY, taken_at, ok, error, cpu, ram_used, ram_total, disk_pct, load1, uptime_s,
                 net_rx_bps, net_tx_bps, docker_json, services_json)   -- Dashboard reads ONLY this
snapshot_history(host_id, taken_at, cpu, ram_pct, disk_pct)              -- optional, 7 days, for small charts
settings(key, value_json)
tabs_state(json)                                                         -- session restore
```
Migrations with `rusqlite_migration`; schema version stored in `settings`.

---

## 2. Vault, PIN, keychain

### 2.1 Keys
- **Master password** (set once, strong) → `KEK = argon2id(master, salt, m=64MB, t=3, p=1)`.
- **Vault key** `VK` = random 32 bytes. Stored as `wrap(KEK, VK)` in `vault.bin` header.
- Secrets: `XChaCha20-Poly1305(VK, nonce, plaintext, aad=secret_id)`. Each secret has its own nonce.
- The same `VK` and format are used by **export files and mobile**, so one vault moves everywhere.

### 2.2 Fast unlock (PIN / biometrics)
- The PIN never encrypts the vault. On PIN setup: `PK = argon2id(pin, salt2)`; store `wrap(PK, VK)` **in the OS keychain** (Windows Credential Manager / macOS Keychain / Android Keystore), never on disk.
- Unlock with PIN: read keychain entry → unwrap `VK`. A copied `vault.bin` + `rookery.db` is useless without the master password because the PIN-wrapped key only exists in the keychain of that machine/user.
- Biometrics: keychain item protected by Windows Hello / Touch ID; unlock = OS prompt → `VK`.
- `VK` lives only in memory, zeroized on lock.

### 2.3 PIN rules
- 4–6 digits (user choice). Auto-submit on last digit; no Enter; autofocus on show.
- Attempts: 5 wrong → 30 s cooldown; 10 wrong → PIN entry disabled, master password required and PIN must be set again. Counter stored in keychain item metadata (not editable by deleting a file).
- Auto-lock: idle (default 10 min), OS lock/sleep, app start. Optional "close SSH sessions on lock".

### 2.4 Threat notes
- Memory: secrets wrapped in `zeroize`/`secrecy` types; terminal buffers are not secret.
- Clipboard: optional auto-clear 30 s after copying a secret.
- Logs never contain secrets; session logging warns that passwords typed echo-off are not logged but commands are.

### 2.5 Known hosts
- First connect: show fingerprint (SHA256), ask to trust. Changed fingerprint: block connect, big warning, "I replaced the server" path to accept.

---

## 3. Connection reuse & lease rules (summary of 01 §4.1)
- One SSH session per host; channels multiplex terminals, SFTP, exec. Leases from: terminal, files view/panel, metrics subscription, docker streams, tunnels, sync job. Last lease → 30 s grace → close.
- Jump host sessions are shared and leased by the sessions that go through them.

---

## 4. Refresh Engine (Dashboard / mobile background data)

### 4.1 Setting shape (same at global, group, host)
```
mode:      inherit | auto | manual | never      (global has no 'inherit')
interval:  30s | 1m | 5m | 15m                  (used when mode = auto)
collect:   basic | basic_docker | everything     (basic = metrics; +docker = docker ps + stats --no-stream; everything = + services)
desktop:   bool    mobile: bool    wifi_only: bool (mobile)
```
Effective = first non-inherit walking host → group (→ parent groups) → global.
Global defaults: mode `auto`, 5 min, basic + docker. `auto` only means "follow the group's Auto-sync switch", and every switch starts **off**, so nothing syncs on its own until the user turns a group on. Hosts without a group have their own switch ("Ungrouped" tab).

### 4.2 Dashboard switches vs settings
- Group tab **Auto-sync switch** = `groups.auto_sync_enabled` (a master switch for that group). When ON, hosts whose effective mode is `auto` are scheduled; `manual` hosts are not; `never` hosts are never touched. When OFF, nothing in the group is scheduled.
- "All" switch: ON = set every group ON; OFF = every group OFF; shows **Mixed** otherwise. Confirmation required because it touches every group.
- Global master pause (Settings/tray) overrides everything without changing stored values.

### 4.3 Sync now
- Scope = selected tab. Collect each host in scope except `never` (skipped and counted) and hosts requiring an interactive secret (marked **Locked**). Per-card ↻ = explicit one-host sync, allowed even for `never`.

### 4.4 Scheduler
- A single tokio task owns a priority queue keyed by `next_due(host)`. Concurrency semaphore (default 3, max 6). Timeout 10 s per host (connect + collect). Reuses an open session if the host tab is open (adds a lease), otherwise opens a temporary session and closes it right after.
- Backoff: 3 consecutive failures → interval ×2 (cap 30 min) → reset on success. Offline hosts are probed with a 3 s TCP connect first to fail fast.
- Pause conditions (no network at all): app locked, window hidden/minimised for > 60 s (desktop; configurable to keep running), OS sleep, master pause, mobile: screen off / not Wi-Fi (if set) / battery < 15 %.
- A collect never prompts: missing passphrase/password → `locked`.

### 4.5 Snapshots
- Result → upsert `server_snapshots`; emit `sync:progress`. Dashboard store mirrors the table and renders instantly on tab open. "Synced X ago" from `taken_at`; fade at > 15 min, grey at > 2 h.
- Needs-attention derived from snapshots only.

### 4.6 Collect script (basic)
Two `metrics` samples 1 s apart in **one** exec (CPU delta needs two reads):
```sh
S(){ head -1 /proc/stat; cat /proc/net/dev; }; S; echo ---; sleep 1; S; echo ---; head -3 /proc/meminfo; cat /proc/loadavg /proc/uptime; df -P / | tail -1
```
`basic_docker` appends: `echo ---; docker ps -a --format '{{json .}}' 2>&1; echo ---; docker stats --no-stream --format '{{json .}}' 2>&1`.

---

## 5. Backup: export / import

### 5.1 File `.rookerybackup`
```
magic "RKRYBK1" | json header { version, created_at, app_version, kdf:{salt,m,t,p}, nonce } | ciphertext
plaintext = JSON { db: { groups, hosts, identities, snippets, workflows, settings, known_hosts }, secrets: { id: base64 } , keys: {...} }
```
Encrypted with a key derived from a **backup password** (default: the master password; user may set a different one). Snapshots and logs are not included (optional flag).

### 5.2 Import
- Modes: Replace all / Merge (by id; conflicts → keep newer `updated_at`, show summary). Validates version, migrates older formats.

### 5.3 Where
- Settings › Backup: Export to file, Import from file, Google Drive (section 6). Title-bar chip shows last backup time and warns if > 7 days (configurable).

### 5.4 Scheduled local backup (P2)
- Daily to a chosen folder, keep last N.

---

## 6. Google Drive (manual, user's own account)
- OAuth 2.0 **PKCE**, loopback redirect (`tauri-plugin-oauth`), scope `https://www.googleapis.com/auth/drive.appdata` only (hidden app folder; no sensitive-scope review).
- Refresh token stored as a vault secret / keychain. Access token in memory.
- Backup = upload `.rookerybackup` to appDataFolder as `rookery-<timestamp>.rookerybackup`; keep last 10 (configurable). Restore = list files → pick → download → import (asks backup password).
- Never automatic unless the user enables "Backup after changes (debounced 10 min)". No background network otherwise.

---

## 7. Importers (P1, v0.5)
- `~/.ssh/config`: Host, HostName, User, Port, IdentityFile, ProxyJump → hosts + identities (key by path).
- MobaXterm `.mxtsessions` (INI): sessions/folders → hosts/groups; passwords are not importable (MobaXterm encrypts them) → mark "needs password".
- PuTTY: registry `HKCU\Software\SimonTatham\PuTTY\Sessions` → hosts.
- Termius: no official export; skip.

---

## 8. Privacy / telemetry
- No telemetry. No network except SSH to the user's servers, Google Drive when the user clicks, and the updater check (opt-out).
