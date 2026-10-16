# Changelog

The release workflow copies the section for a tag (e.g. `## 0.6.0`) into the GitHub Release notes, which the in-app updater shows under "What's new".

## 0.7.0

- **Databases (PostgreSQL, MySQL, MariaDB)**: see what's in a database and fix a problem quickly, right next to the terminal.
  - **In a server tab**: the new **Database** view (Ctrl+8) connects through that server's SSH session. Nothing opens on the network.
  - **Database tabs**: saved connections in the sidebar under your hosts, direct or through a server, with SSL. Paste a URL into quick connect (`postgres://user@host/db`, `mysql://root@localhost/shop`).
  - **Schema tree** with tables, columns, keys and indexes. Double-click a table to see its first rows.
  - **SQL editor** with highlighting and completion of your table and column names. Ctrl+Enter runs the statement at the cursor, Ctrl+. cancels it on the server.
  - **Results grid** that stays fast with many rows. Copy values, rows or columns, or export CSV.
- **Safe on production**: PROD connections are read-only, enforced by the database server. **Allow changes** turns writes on for 15 minutes with a countdown.
  - Every change goes into a transaction, and nothing is saved until you press **Commit**.
  - Risky statements (DELETE without WHERE, DROP, TRUNCATE…) ask first. On PROD you type the database name.
  - Closing a tab, locking or switching database with uncommitted changes asks Commit / Roll back.
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
