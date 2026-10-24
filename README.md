<p align="center">
  <picture><img src="app-icon.svg" width="88" alt="Rookery icon" /></picture>
</p>

<h1 align="center">Rookery</h1>

<p align="center">
  <b>Your servers. One workspace.</b><br />
  SSH terminals, files, Docker, databases and config editing — together in a desktop app for Windows and macOS.
</p>

<p align="center">
  <a href="https://aagzamov-dev.github.io/Rookery/#install"><b>Download Rookery</b></a>
  &nbsp;·&nbsp;
  <a href="#take-a-look">Take a look</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/aagzamov-dev/Rookery/releases/latest">Latest release</a>
  &nbsp;·&nbsp;
  <a href="docs/00-START-HERE.md">Developer docs</a>
</p>

<p align="center">Free and open source · No Rookery account · Rust + Tauri</p>

<p align="center">
  <picture><img src="docs/screenshots/dashboard.png" alt="Rookery dashboard with servers grouped by environment, resource usage and items needing attention" width="100%" /></picture>
</p>

<p align="center"><sub>Actual Rookery UI with demo data. All screenshots below use demo data.</sub></p>

## From “what broke?” to the right server

Checking a deployment often means opening a terminal, finding container logs, inspecting a database and editing a config file. Rookery keeps those tools in **one tab per server**, so you can follow the problem without rebuilding your workspace in several apps.

Group servers by environment, client or home lab. Switch between them with their tools close at hand. Connect with SSH; no Rookery agent to install on your servers.

## Try Rookery

**[Download for Windows or macOS](https://aagzamov-dev.github.io/Rookery/#install)** · [All release files](https://github.com/aagzamov-dev/Rookery/releases/latest)

| Platform | Choose this download |
|---|---|
| **Windows 10 / 11, x64** | The `.exe` installer. Installs for your user without administrator access. |
| **macOS, Apple Silicon or Intel** | The universal `.dmg`. Open it and drag Rookery into Applications. |

**First-install note:** the app is not yet Windows code-signed or Apple-notarized. Windows may show SmartScreen; macOS may block opening it. The [download page](https://aagzamov-dev.github.io/Rookery/#install) includes the platform-specific steps. Only bypass these warnings for a download you trust from this project's releases. In-app updates are separately verified with Rookery's update signature.

### Your first connection

1. **Create your vault.** Set a master password; optionally enable a device PIN for convenient unlocking.
2. **Add a server.** Enter its SSH address and credentials, or choose **Import my servers** for MobaXterm, PuTTY or a basic `~/.ssh/config`. Imported connections do not include passwords.
3. **Open its tab.** Start in Terminal, browse Files, or open Docker, Database or Editor as needed.

Server tools target Linux hosts: the Docker view needs Docker, and Services needs systemd. Databases can also connect directly, without an SSH host.

Want to inspect the interface before connecting anything? [Run the local demo](#explore-with-demo-data).

## Take a look

### Investigate without losing your place

Open terminals, follow logs and manage containers alongside the server's files. Snippets keep repeat commands within reach; the command palette and configurable shortcuts help you move quickly.

- **Terminal:** search, error highlighting, themes, snippets and broadcast typing. Local shells are supported too.
- **Docker:** containers grouped by Compose project, live logs, resource usage, start/stop/restart and a container shell.
- **Files and operations:** SFTP transfers, systemd services, processes and log-file following.

<picture><img src="docs/screenshots/terminal.png" alt="SSH terminal with reusable snippets and highlighted warning and error output" width="100%" /></picture>

[See the Docker view](docs/screenshots/docker.png) · [Explore desktop features](docs/03-DESKTOP-FEATURES.md)

### Inspect the database next to the deployment

Work with **PostgreSQL, MySQL and MariaDB** through SSH or a direct connection. Browse table data and structure, filter rows, follow foreign keys, run SQL with completion, and export results to CSV.

Open a Docker database in SQL or import connection settings from a Laravel `.env` file. Saved connections and query history keep repeat work close by.

**Production connections start read-only.** You can temporarily allow writes, with transaction controls and extra confirmation for destructive statements. Some statements, including MySQL DDL, commit immediately; these controls do not make every operation reversible.

<picture><img src="docs/screenshots/sql-table.png" alt="Database table browser with sortable rows, foreign-key navigation and a row detail panel" width="100%" /></picture>

[SQL connection guide](docs/07-SQL-CONNECTIONS.md)

### Edit the config, review the change

Open `.env`, nginx or Compose files in the built-in editor, with highlighting, validation, formatting and a **Hide values** option for secrets.

Before saving, Rookery checks whether the remote file changed. If it did, you can resolve a three-way merge. The previous server version is backed up locally, and production saves show a diff for review.

<picture><img src="docs/screenshots/editor.png" alt="Remote config editor with a folder tree, pinned files and inline validation" width="100%" /></picture>

[See conflict resolution](docs/screenshots/editor-merge.png) · [Editor guide](docs/08-EDITOR.md)

## Your workspace stays yours

- **Local storage:** connection settings and workspace data live in SQLite on your computer. Passwords and private keys are stored separately in an encrypted vault using Argon2id and XChaCha20-Poly1305. The local database and optional session logs are not covered by vault encryption.
- **No Rookery account or hosted sync service:** use an encrypted backup file, or sync through a folder you choose in Drive, OneDrive or Dropbox.
- **Connections when needed:** tools share an SSH session per server. Dashboard snapshots are cached; refresh them yourself or opt into auto-sync per group. View-specific collectors stop when their view is no longer active.
- **Updates from GitHub:** automatic update checks can be disabled in Settings.

Built with a Rust core and Tauri's native webview. [Read about data, sync and security](docs/04-DATA-SYNC-SECURITY.md).

## Run from source

You'll need Git, Node.js 20+, Rust 1.90+ and the [Tauri 2 prerequisites for your OS](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/aagzamov-dev/Rookery.git
cd Rookery
npm ci
npm run dev
```

### Explore with demo data

After cloning and running `npm ci`, start just the frontend:

```bash
npm --workspace apps/desktop run dev
```

Open [the local dashboard demo](http://localhost:1420/demo.html?scene=dashboard). It uses mocked data and does not connect to your servers. Change the scene to explore the terminal, Docker, SQL and editor interfaces. This is a UI preview, not a live server session.

### Contribute

Bug reports, usability feedback and focused fixes are welcome. [Open an issue](https://github.com/aagzamov-dev/Rookery/issues) with your OS, Rookery version, steps to reproduce and expected behavior. Remove credentials and private server details from logs or screenshots before sharing.

Before changing code, read the [working guide](docs/00-START-HERE.md) and [architecture](docs/01-ARCHITECTURE.md). Run `npm run typecheck` and `npm test` for code changes. Installer builds and update signing are covered in the [release guide](docs/06-AUTO-UPDATE.md).

[Roadmap](docs/02-ROADMAP.md) · [Changelog](docs/CHANGELOG.md) · [MIT license](LICENSE)

---

**If Rookery makes your server work easier, give it a star.** Tried it and got stuck? [Tell me where](https://github.com/aagzamov-dev/Rookery/issues) — that feedback helps make the next release better.
