# Changelog

The release workflow copies the section for the version (e.g. `## 0.7.0`), plus any versions since the last published release, into the GitHub Release notes, which the in-app updater shows under "What's new".

## 1.1.0

- **Docker with sudo:** when Docker access is denied, **Use sudo…** turns on `sudo docker` for that server (device-local setting). The password comes from the login's saved sudo password, its login password or one typed for this session; it is only ever sent on stdin. The dashboard, Docker view, logs, stats and container shells use it, and terminal `[sudo]` prompts after a sudo command are filled automatically. One refused password pauses all automatic sudo for the server until a new one is entered, so it cannot lock the account. Container output that imitates a sudo prompt is never answered.

- **Docker logs as ZIP:** pick containers and a period (last hour … custom range); one ZIP with a log file per container and a manifest. Streams to disk, can be cancelled, stops at 2 GiB, and the file appears complete or not at all.

- **Search tab:** search file contents (grep) or names (find) in a folder on the server or this computer. Every filter is visible: case, whole word, regex, files to include/skip, folders to skip, hidden files, symbolic links, depth and result limit. Typing searches after a pause; a new search cancels the previous one on the server; searches run at low priority with a 60 s limit. Results open in the editor at the matching line. Needs `find`, `xargs` and `grep` on the server.

- **Open with sudo:** files your login cannot read offer **Open with sudo** (never automatic); reloading and saving such a tab use sudo too. Up to 5 MB.

- **Files and editor tree:** ⋮ / right-click menus with New file, New folder, Rename, Duplicate, Copy path, ZIP, tar.gz, Extract, Permissions, Make executable, Follow in Logs and Delete. Names without an extension (`Dockerfile`) and dot files work. Nothing is ever overwritten; production deletes need the name typed. Archives run in the background with Cancel, appear complete or not at all, and refuse unsafe paths and links (Python 3 on the server). Multi-select in Files (Ctrl/⌘/Shift-click) deletes after one confirmation. Open tabs and pins follow renames; unsaved tabs block rename/delete.

- **Editor:** quick open (⌘P / Ctrl+P) with recent files; recent folders in Files; a tab menu (close others/saved/all, rename, copy path, show in Files).

- **Git:** discard all changes in a folder (the confirmation lists every file; staged changes stay), file history following renames, and blame.

- **Host editor:** new hosts start with a new login. **Copy connection** copies `ssh user@host`; **Copy credentials** copies address, port, user and password after asking the master password every time, and empties the clipboard 30 s later.

- **Layout:** the server view bar stays on one line; views that do not fit move into a ⋯ menu and the active view always stays visible.

- **Fixes:** fewer Docker refreshes (health checks no longer trigger them; spaced out under sudo); a failed reconnect stops Docker collectors instead of leaving some in the old mode; the log download period is computed when you click Download; commands Rookery sends to a new terminal no longer trigger "command finished" notifications.

Verified with unit and interaction tests, real local grep/find/Git/archive runs and the mocked UI. Sudo, search, archives and Git history on live Linux servers have had limited testing.

## 1.0.0

- **Global notifications:** a shared notification center keeps operation results available across workspaces, with unread counts, clear-all controls and desktop notification permission/testing.

- **macOS notifications:** test and operation notifications share an awaited UserNotifications route with foreground banners, real authorization checks and visible submission errors. Windows retains its existing notification route. macOS Focus and notification settings still control presentation; packaged-app banner delivery has not been runtime verified.

- **Gzip SQL backups:** MySQL/MariaDB exports now offer SQL or gzip SQL (`.sql.gz`), streaming only the chosen output locally or on SSH servers (`gzip -1` required remotely). Import/restore validates gzip before streaming into native clients without an uncompressed staging file; compressed bytes retain SHA-256 checks and existing PROD/cancellation guards. PostgreSQL custom exports and old backup records remain compatible. ZIP archives are unsupported. Verified with local native fixtures and mocked UI; live restores remain unverified.

- **Database backup feedback:** exact PROD confirmation disables browser capitalization/correction. Confirmation, access checks and running jobs have separate status text; bounded timestamped logs stream native verbose activity, real SSH stages and redacted errors without polling or invented percentages.

- **This computer:** enabled by default at the top of the SSH sidebar, with a Settings toggle. The local workspace reuses Overview, Terminal, Files, Editor, Git, Docker and Database; no Services or Logs tabs and no localhost SSH setup. Native CPU/RAM/home-volume/network/uptime collection runs only in visible Overview and follows the live interval/Off setting. Local Git/Docker use argv, local files retain bounded version-aware saves/backups, and local databases reuse SQL plus native export/import. Docker is pinned to the local default/Desktop socket; remote/custom contexts are not used. Disabling preserves drafts and running terminals/jobs while pausing workspace requests. Restored computer tabs wait for a click. Verified with mocked UI and temporary native fixtures; Windows execution and live system/Docker/database behavior remain unverified.

- **Database files:** Export / Import / Backups dialogs use installed native PostgreSQL and MySQL/MariaDB tools. Export defaults to all tables with search, selection, per-table structure/data modes and approximate storage totals. Local files and SSH-server files stream through private local staging, with progress/cancel, no-overwrite destinations, and core PROD/edit-mode checks. Backups records only Rookery exports with SHA-256 and download/restore/delete; export completion is explicitly not restore verification. Large dumps never enter the SQL editor or automatically fall back to an external editor. Mocked UI and local native-process fixtures pass; live database restores remain unverified. See [scope and limits](07-SQL-CONNECTIONS.md#native-database-file-operations).

## 0.9.0

- **Production changes:** Files operations, Docker actions, process signals and shell integration enforce confirmation against the saved host in Rust. External-editor saves remain local until **Review upload**; pending drafts survive locking, and locked uploads are rejected. Production snippet and container quick commands always ask before running.
- **Visible work only:** live metrics have a persisted interval / Off control. Hidden Files follow/transfer refreshes and editor read chains pause. Opt-in automatic snapshots only run in the active connected Overview while focused with metrics on; explicit Sync now remains available for other hosts. Docker failures stop collection until **Reload Docker**, with at most three stream attempts.
- **Bounded logs:** Yesterday and custom local time ranges load explicit partial history, with **Latest / follow** to return. Docker history returns up to 2,000 lines; file history inspects at most the final 2 MiB / 20,000 lines, filters supported timestamps, and shows the newest 2,000 matches. No rotated files or full-file scans. Live Docker resumes always include a 500-line cap; local streams retain at most 5,000 lines / 4 MiB. Shared SSH exec output stops at 8 MiB combined stdout/stderr and closes channels on failure, timeout or cancellation.

- **Git refresh:** editor saves, completed remote terminal commands and reconnects mark cached repositories stale. Git refreshes the visible clean repository on demand or after returning to a stale cache, without polling or hidden requests; dirty drafts and failed requests stay protected. React/CodeMirror interaction tests cover folder actions, production confirmation, visibility, refresh races and draft preservation.

- **Git layout:** persisted drag resizing for the changes panel and both diff panes; compact collapsible folder tree with Staged first and a remembered flat-list toggle; larger repository-add button. Diff resizing retains drafts, selection and editor state. The servers sidebar now remembers its width down to 104 px with compact labels and production markers.

- **Git workspace:** repository dropdown/+ dialog, compact commit message above one changes list, larger stage controls and collapsed stashes at the bottom. Edit working-tree diffs inline, save safely or save then stage; staged diffs remain read-only and drafts survive switching views. First open discovers repositories only within two levels of the configured start folder, with strict limits and a persisted once-only marker.

- **PIN recovery:** Settings → Security now changes the device PIN after verifying the current PIN or master password. The lock screen has Forgot PIN recovery with the master password; verification, cooldowns and replacement are enforced in Rust.

- **Git:** lazy per-server Git view with saved repository folders, remote browsing/manual paths, cached status, CodeMirror diffs, staging, commits, local branches, fetch/fast-forward pull/push/publish, stashes and editor-based conflict resolution with merge/rebase abort and rebase continuation. Every production mutation requires confirmation, enforced in Rust; production editor saves enforce the existing review as well.
- **Lazy views:** restored hidden views and terminal slots wait for their first actual display; hidden database/schema/table work and Docker logs pause with the window/view visibility.

- **Reliability:** interruptible SQL reconnect/disconnect after network stalls, bounded cancellation, MySQL health detection, PostgreSQL transaction/metadata recovery, accurate connection state, and no automatic SQL replay.
- **SSH/files:** reject unsupported routes; close owned forwarded streams; reopen stale SFTP channels; stage private uploads safely with conflict checks, unique partial downloads, cancellation status and bounded concurrency.
- **Performance/UI:** virtualized file/log lists, incremental log parsing, lazy editors, bounded buffers, stale-navigation protection, accessible modal focus, keyboard file actions, resizable SQL panels, density setting and narrow Docker layout.
- **Recovery/diagnostics:** event-gap reporting with status refresh, runtime rollback for failed backup restores, reviewed diagnostic JSON export, expanded CI and database/SSH regression fixtures. See [Priority 1 validation and limits](09-PRIORITY-1-STABILIZE-AND-OPTIMIZE.md#implementation-record--2026-10-25).

- **Logs:** browse server folders and click a log file to save and follow it; manual paths and common logs remain available.
- **Files:** select a file for toolbar download, ZIP a file or folder, or unzip a selected ZIP into a new sibling folder. Archive operations require Python 3 on the server, refuse existing destinations, and reject symbolic links and unsafe archive paths.

## 0.8.1

- **SQL cell viewer and editing:** click to select a cell, copy its full value with Ctrl+C / Cmd+C, and double-click or press Enter to view it. The cell menu includes View, Copy, and Edit; F2 opens editing and can be reassigned in Shortcuts.
- **Connection mode:** a Read-only / Edit mode dropdown replaces the countdown. Editing stays enabled until the connection closes or Read-only is selected. PROD still opens read-only and asks before enabling editing.
- **Safe cell updates:** supported table columns with a primary or unique key can be edited in a searchable editor, with JSON validation and an explicit NULL option. Stale values are rejected, and edits remain uncommitted until Commit or Rollback.
- **Production review:** inspect the original/updated diff before applying a PROD edit. A new Review button beside Commit and Rollback shows recorded cell diffs and SQL statements in execution order.
- **Viewer usability:** dialogs stay centered even when the table is scrolled. Editors start compact, grow with their content, and scroll at their maximum height. NULL checkboxes and edit/apply buttons are larger.
- **Search fixes:** editor Find/Replace panels stay inside their view and disappear when the app locks. SQL editors support Find, and Escape closes Find before closing a value viewer.

## 0.8.0

- **Editor** (server tab → **Editor**, Ctrl+9): open any text file on the server, edit it comfortably, and save it without losing anyone's changes.
  - **Folders** on the left (double-click a folder to go into it, click the path on top to go back up, Back / Up / Home, right-click menu; remembered per server), files in **tabs** (● = unsaved), **pinned files** per server (`.env`, `docker-compose.yml`, `nginx.conf`…), **Open path…** (Ctrl+O). In Files, double-click a file (or **Edit in Rookery**) to open it here.
  - **Languages**: `.env`, JSON, YAML, JS / TS, PHP, Python, HTML, CSS / SCSS, Markdown, XML, SQL, shell, nginx, Dockerfile, INI / TOML.
  - **Editing**: find / replace with regex (Ctrl+F), go to line (Ctrl+G), multi-cursor (Alt+click), column selection (Alt+drag), folding, word wrap, show spaces.
  - **Format** (Shift+Alt+F) with Prettier, and a careful tidy-up for `.env` that never changes a value.
  - **Problems while typing**: JSON and YAML errors, and for `.env` duplicate keys, spaces around `=`, values with spaces but no quotes, unclosed quotes.
  - **Hide values** in `.env` files: values show as dots, except on the line you are editing.
- **Safe saving**:
  - **Nobody's changes are lost.** Before writing, Rookery checks the file is still the version you opened (SHA-256). If someone changed it, nothing is written: a **three-way merge** combines both sides, and you choose for lines changed on both (keep mine / theirs / both).
  - **While you edit**, coming back to the window checks the file (no polling). A banner offers **Compare** or **Reload**. A tab without unsaved changes reloads by itself.
  - **On PROD**, a side-by-side review of the changes comes before every save.
  - **Your own files** are replaced in one step (temp file + rename, same group and permissions), so a dropped connection never leaves half a file. Other people's files are written in place, so owner and permissions stay.
  - **Save with sudo** when permission is denied. The vault's sudo password is the only thing sent to sudo; the content comes from a private temp file.
  - **Checks**: what was written is read back and compared. Line endings (LF / CRLF), a UTF-8 BOM and the final newline are kept. Binary and non-UTF-8 files are refused; files over 5 MB open read-only.
  - **History**: the server's version before each save is kept on this PC (last 20 per file, 30 days, never synced). Compare one and **Restore into editor**.
- **Database view**: **Remember password**. After a successful login it is kept encrypted in the vault, like SSH logins, and the view connects by itself next time. Saved logins are listed per server, and their passwords can be forgotten.

## 0.7.0

- **Databases (PostgreSQL, MySQL, MariaDB)**: see what's in a database and fix a problem quickly, right next to the terminal.
  - **SSH | SQL** switch at the top of the sidebar: your servers, or your database connections (SSH is shown first).
  - **In a server tab**: the new **Database** view (Ctrl+8) connects through that server's SSH session. Nothing opens on the network.
  - **Database tabs**: saved connections, direct or through a server, with SSL. Paste a URL into quick connect (`postgres://user@host/db`, `mysql://root@localhost/shop`).
- **Tables like HeidiSQL**: click a table to open it as a tab (double-click keeps it open), next to the **Query** tab.
  - **Data**:
    - rows page by page (100 / 200 / 500 / 1000, "Load more");
    - click a header to sort (Shift+click for more columns);
    - quick search over the text columns;
    - filters (=, ≠, contains, starts with, <, >, is NULL, is empty…), or your own WHERE.
  - **Right-click a cell** to filter by its value, or jump through a foreign key to the related row (and back: "rows pointing here").
  - **Columns**: drag to reorder, drag the edge to resize, hide / show. Remembered per table on this computer.
  - **Also**: a row detail panel with every value of the selected row, **Count** for the exact number of rows, CSV export, and **Show SQL** with "Open in Query".
  - **Structure**: columns (type, null, default, extra, comment), indexes, foreign keys both ways, size and engine, and the full CREATE code.
  - **Safe filters**: Rookery turns filters and sorting into SQL itself and quotes every name and value, so typing `'; DROP …` into a filter is just text.
- **SQL editor**:
  - highlighting and completion of your table and column names;
  - Ctrl+Enter runs the statement at the cursor, Ctrl+. cancels it on the server;
  - a fast results grid: copy values, rows or columns, or export CSV.
- **Safe on production**: PROD connections are read-only, enforced by the database server. **Allow changes** turns writes on for 15 minutes with a countdown.
  - Every change goes into a transaction, and nothing is saved until you press **Commit**.
  - Risky statements (DELETE without WHERE, DROP, TRUNCATE…) ask first. On PROD you type the database name.
  - Closing a tab, locking or switching database with uncommitted changes asks Commit / Roll back.
- **Shortcuts in**:
  - **Open in SQL** on database containers in the Docker view;
  - **Import from a Laravel .env** (its password is used only if you tick it);
  - **Find databases on this PC** (XAMPP, Laragon, PostgreSQL, Docker).
- **Query history** per connection (the last 200, on this computer only) and **SQL snippets** (terminals never run them).
- **Backup & sync**: saved database connections and their passwords travel to your other devices, encrypted, like your servers do.

## 0.6.0

- **Auto-update**: Rookery checks GitHub once a day when it starts (can be turned off in Settings › About). When there is an update it shows the release notes and an Update button, verifies the signature, installs and restarts. Your data is kept.
- **Backup & sync**:
  - one sync password, the same on each device;
  - a sync folder inside Google Drive / OneDrive / Dropbox keeps PC and laptop merged: newest edit wins, deletions sync, logins come along encrypted;
  - backup file with Save, Show in folder, Copy file (paste it into Telegram), and Import with Merge or Replace.
- **Import servers** from MobaXterm sessions, PuTTY and `~/.ssh/config`. A first-run welcome screen offers this, a new server, or joining your other computer.
- **Hosts page**: select many servers to move them to a group, change the login or environment, add a tag or delete them. Duplicate a server from the table or from the host list's right-click menu.
- **Terminal triggers**: lines with ERROR / WARN (or your own patterns) get a faint coloured band and a scrollbar mark, with an optional notification.
- **Session logs**: save SSH sessions to plain-text files with a time on each line, for all servers or per server; old logs are deleted automatically.
- **System-wide hotkey**: bring Rookery to the front from any app, press again to minimise.
- **Security**: choose the auto-lock time (or never).
- **Dashboard** (from 0.4): group tabs, Sync and auto-sync per group, needs-attention list.

## 0.1.0 – 0.4.0

The first builds: vault with PIN, hosts and groups, iTerm-style terminal, snippets and the command palette, shortcuts page, SFTP files, Docker, services, logs, processes, and the dashboard.
