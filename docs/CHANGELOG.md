# Changelog

The release workflow copies the section for the version (e.g. `## 0.7.0`), plus any versions since the last published release, into the GitHub Release notes, which the in-app updater shows under "What's new".

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
