# Changelog

The release workflow copies the section for the version (e.g. `## 0.7.0`), plus any versions since the last published release, into the GitHub Release notes, which the in-app updater shows under "What's new".

## 0.9.0

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
