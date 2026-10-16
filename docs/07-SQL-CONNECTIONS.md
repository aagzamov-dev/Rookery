# 07 — SQL connections (v0.7)

Status: **0.7.0 built (the core); v0.7.1 shortcuts next.** What was built, and where it differs from the text below, is in §10. Read [00-START-HERE.md](00-START-HERE.md) first: it has the project rules this feature must follow.

Goal: **see what's in a database and fix a problem quickly**, safely, including on production. Show databases, tables and columns, run SQL, read the results. It is a quick look-and-fix tool next to the terminal, **not** a full database IDE.

---

## 1. Scope

### In (v0.7)
- Engines: **PostgreSQL** and **MySQL / MariaDB**.
- Two entry points, one engine and one UI:
  1. **Database view** inside a server tab: connects through that server's SSH session.
  2. **Database tabs**: saved connections in the sidebar, each opening its own tab (local PC, direct remote, through a server, cloud with SSL). Quick connect by URL.
- **Schema tree:** databases → (Postgres: schemas) → tables / views → columns (type, null, default, key), plus indexes.
- **SQL editor:** CodeMirror 6, SQL highlighting per dialect, completion from the loaded schema, run all / run selection / run statement at cursor.
- **Results:** virtualised grid, several result tabs (one per statement), copy cell / row / column, export CSV, rows affected, time.
- **Production safety:** read-only by default on PROD, explicit transactions with Commit / Rollback, risky-statement warnings, row cap, timeout, real cancel (§6).
- **History** per connection (local only), and "Save as snippet".
- **Shortcuts:**
  - Docker view: **Open in SQL** for `postgres` / `mysql` / `mariadb` containers.
  - Import a connection from a Laravel `.env`.
  - **Find databases on this PC.**

### Out (not v0.7)
- ER diagrams, schema designer, migrations, data import, user / permission management, query builder, charts.
- Editing cells directly in the grid: later (v0.8). v0.7 is SQL-only for writes.
- Other engines: SQLite, SQL Server, Redis, MongoDB. Keep the engine trait open for them (§4.2).

---

## 2. User experience

### 2.1 Sidebar and tabs
- **Sidebar:** under the Hosts list, a collapsible **Databases** section lists saved connections. Each row shows an engine icon (🐘 / 🐬), the name, an env tag, and a 🔒 badge when read-only.
- **Opening:** click a connection to open it as a tab of kind `db`. Several database tabs can be open at once, and the same connection can be opened twice (two editors).
- **Tab label:** `name · database` plus the env tag. The tab colour follows the env (PROD red) like server tabs.
- **Quick connect:** the title-bar field accepts URLs:
  - `postgres://user@host:5432/db`
  - `mysql://root@localhost/shop`
  - `mariadb://…`
  - `ssh+mysql://prod-api-01/shop`: "through the saved server named prod-api-01".

  It opens an unsaved tab with a **Save** button.
- **Server tabs:** a new view **Database** (after Docker), with its own key in `VIEWS`. It opens the same UI with the connection's mode set to "this server".

### 2.2 Layout of a database tab / view
```
┌ toolbar: [▶ Run Ctrl+Enter] [Run selection] [■ Cancel] | DB: shop ▾ | 🔒 Read-only ▾ | Tx: none | 38 ms ┐
├───────────────┬────────────────────────────────────────────────────────────────────────────────────┤
│ schema tree   │ SQL editor (CodeMirror)                                                            │
│ 260 px,       │                                                                                    │
│ filter box,   ├──────────── drag handle ───────────────────────────────────────────────────────────┤
│ ↻ refresh     │ [Result 1] [Result 2] [Messages]                     rows 500 (limit) · 41 ms · CSV │
│               │ results grid (virtualised)                                                         │
└───────────────┴────────────────────────────────────────────────────────────────────────────────────┘
```
- **Tree actions:** double-click a table → `SELECT * FROM t LIMIT 100` into the editor and run it. Right-click → Select top 100 / Count rows / Copy name / Show CREATE / Insert column list.
- **Editor:**
  - Ctrl+Enter runs the statement at the cursor (or the selection); Ctrl+Shift+Enter runs everything.
  - Statements are split on `;`, ignoring `;` inside strings, comments and dollar-quotes.
  - Completion: keywords plus table and column names from the cached schema.
- **Results:**
  - Grid: numbers right-aligned, `NULL` greyed, long text truncated with "…" (full value on hover / copy).
  - Non-SELECT statements show "UPDATE · 37 rows affected".
  - Errors show inline with the position highlighted in the editor when the server reports one.
- **Empty state:** "Connected to shop (MySQL 8.0.36). Double-click a table or write SQL."

### 2.3 New / edit connection dialog
- **Basics:** Name; Engine (PostgreSQL, MySQL / MariaDB); env label; group (optional, reuses host groups).
- **Connect via:**
  - **Direct:** host, port.
  - **Through a server:** pick a saved host. The database host defaults to `127.0.0.1` "as seen from the server".
  - **This server's view:** no dialog; filled from the server tab.
- **Login:** user and password. The password goes to the vault and never back to the UI; there's a "saved" flag like identities.
- **Database:** optional default database / schema.
- **SSL:** `disable | prefer | require | verify-full` (+ optional CA file). Defaults:
  - `disable` for localhost and for through-a-server;
  - `prefer` for direct remote;
  - cloud presets (RDS, DigitalOcean, Supabase) set `require`.
- **Safety:** "Open read-only" (default ON when env = prod, otherwise OFF), row limit (500), timeout (30 s).
- **Test connection** button: "Connected · PostgreSQL 16.2 · 38 ms".
- **Warning:** direct remote + SSL `disable` → "Password and data travel unencrypted. Use SSL or connect through a server."

### 2.4 Shortcuts into the feature
- **Docker → Open in SQL:**
  - On a container whose image matches `postgres|mysql|mariadb`, run `docker inspect` (one exec) and read env `POSTGRES_USER / POSTGRES_DB / MYSQL_USER / MYSQL_DATABASE` and the published or internal port.
  - Open a *server-view* connection to `container-IP:port` (or `127.0.0.1:published`), prefilled.
  - The password is never read from env automatically. Ask for it, with an option to save.
- **Laravel `.env`:**
  - "Import from .env" in the dialog: a local file (file picker) or a remote path (read via SFTP on the selected server).
  - It parses `DB_CONNECTION, DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME`. `DB_PASSWORD` is offered, but only used when the user ticks "use password from .env".
- **Find databases on this PC:**
  - A TCP probe of `127.0.0.1` on 3306, 3307, 5432, 5433 (timeout 300 ms each).
  - Plus Docker Desktop: `docker ps` locally if `docker` exists, looking at published ports of database images.
  - Results show as "Add MySQL on localhost:3306?". Defaults: MySQL `root` with no password (XAMPP / Laragon), Postgres `postgres`.

---

## 3. Data model

### 3.1 `db_connections` (SQLite migration **v6**, append to `MIGRATIONS` in `crates/rookery-core/src/db.rs`)
```sql
CREATE TABLE db_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  engine TEXT NOT NULL,            -- 'postgres' | 'mysql'
  via TEXT NOT NULL DEFAULT 'direct', -- 'direct' | 'ssh'
  host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL, -- for via = 'ssh'
  address TEXT NOT NULL,           -- DB host (as seen from the PC, or from the server when via = 'ssh')
  port INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  database TEXT,                   -- default database / schema
  ssl_mode TEXT NOT NULL DEFAULT 'prefer',
  ca_path TEXT,
  env_label TEXT NOT NULL DEFAULT 'none',
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  read_only INTEGER NOT NULL DEFAULT 0,  -- open read-only
  row_limit INTEGER NOT NULL DEFAULT 500,
  timeout_s INTEGER NOT NULL DEFAULT 30,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE sql_history (               -- local only, never synced, no result data
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conn_key TEXT NOT NULL,                -- db_connections.id, or 'host:<host_id>:<engine>:<port>' for server views
  sql TEXT NOT NULL,
  ran_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  rows INTEGER,
  elapsed_ms INTEGER
);
CREATE INDEX sql_history_conn ON sql_history(conn_key, ran_at DESC);
```
- **Password:** vault secret `dbconn:<id>:password` (never in SQLite, never sent to the webview).
- **Rust model:** `DbConnection` in `model.rs` with `#[derive(TS)] #[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]`, plus `has_password: bool` (computed, like `Identity`). `i64` fields use `#[ts(type = "number")]`.
- **History:** keep the last 200 entries per `conn_key`, pruned on insert.

### 3.2 Sync & backup (must follow docs/04 §5)
- `db_connections` **syncs**. Use `updated_at` versions, a tombstone kind `"db_connection"` via `delete_tracked`, and add the table to:
  - `backup::Payload` (+ secrets with prefix `dbconn:`, carried like identity secrets);
  - `merge()` (after hosts, because `host_id` must exist; a missing host means `via='direct'` disabled with a note);
  - `data_revision()`;
  - `wipe_synced()`;
  - `Db::apply_delete`;
  - the two-device sync test.
- `sql_history` is **local only**: never in the backup or the sync file.
- **Localhost connections** do sync, and mean "this computer's database" on each device (documented in the UI as a hint).

---

## 4. Rust architecture (`crates/rookery-core/src/sql/`)

Name the module **`sql`**, not `db`: `db.rs` is Rookery's own SQLite store.

### 4.1 Transport
- **Direct:** the driver connects to `address:port` itself.
- **Through a server:** a **loopback forwarder**, which is also the base for v0.5 Tunnels:
  1. `acquire()` a `Lease` on the host (the session stays open while the DB session lives).
  2. Bind a listener on `127.0.0.1:0` (loopback only, random port).
  3. For each accepted TCP connection, open `handle.channel_open_direct_tcpip(address, port, "127.0.0.1", local_port)` and pump bytes both ways (`channel.into_stream()` + `tokio::io::copy_bidirectional`).
  4. The driver connects to `127.0.0.1:<local_port>`.
  5. Closing the DB session drops the listener and the lease.
- Put the forwarder in `crates/rookery-core/src/forward.rs` so Tunnels can reuse it.

### 4.2 Engines
- Trait (async), in `sql/mod.rs`:
  ```rust
  trait Engine: Send + Sync {
      async fn server_version(&self) -> Result<String>;
      async fn schema(&self, database: Option<&str>) -> Result<SchemaTree>;
      async fn run(&self, sql: &str, opts: RunOpts, sink: ResultSink) -> Result<()>; // streams chunks
      async fn cancel(&self) -> Result<()>;
      async fn set_read_only(&self, on: bool) -> Result<()>;
      async fn begin(&self) / commit(&self) / rollback(&self) -> Result<()>;
  }
  ```
- **PostgreSQL:** `tokio-postgres` (+ `tokio-postgres-rustls` for TLS).
  - The editor uses the **simple query protocol** (`simple_query_raw`): every value arrives as text, multi-statement works, rows stream so we can stop at the row cap.
  - Cancel with `client.cancel_token().cancel_query(...)`.
- **MySQL / MariaDB:** `mysql_async` (rustls feature).
  - The editor uses `query_iter` (text protocol), streaming rows per result set.
  - Cancel: open a second short connection and run `KILL QUERY <connection_id>`.
- **Display:** values go to the UI as `Option<String>` (`None` = NULL), with column names and a type name for alignment. No typed decoding is needed for display.
- **Check versions before adding the crates:** run `cargo info <crate>` for `rust-version` and features, and check that nothing they pull in is yanked. In v0.6, all `zip` 2.x / 4.x releases were yanked; see docs/06. Watch the installer size: the budget is +4 MB.

### 4.3 Sessions
- `SqlManager` lives in `Core` (add `pub sql: Arc<sql::SqlManager>`) and holds sessions keyed by `session_id` (one per open tab / view).
- Each session has **one** connection for queries, plus a lazily-opened one for cancel / `KILL` (MySQL).
- **Idle:** close after 10 min without a query; the UI reconnects transparently on the next run.
- **Lock:** `Core::lock()` must close every SQL session (`sql.close_all()`) and drop forwarders.
- **Disconnect** while a transaction is open → the server rolls it back. Tell the UI ("Connection lost — uncommitted changes were rolled back").

### 4.4 Schema queries
- **PostgreSQL:**
  - Databases: `SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1`.
  - Schemas, tables / views and est. rows: `pg_namespace`, `pg_class` (`relkind IN ('r','v','m','p','f')`, `reltuples`).
  - Columns: `information_schema.columns` (ordinal, type, nullable, default).
  - Keys / indexes: `pg_index` + `pg_attribute`.
  - Hide `pg_catalog`, `information_schema` and `pg_toast*` behind "Show system schemas".
  - Switching database means a new connection (Postgres can't `USE`).
- **MySQL:**
  - Databases: `information_schema.SCHEMATA`, hiding `mysql`, `sys`, `performance_schema`, `information_schema` behind the same toggle.
  - Tables: `information_schema.TABLES` (TABLE_TYPE, TABLE_ROWS estimate).
  - Columns: `information_schema.COLUMNS` (COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY).
  - Indexes: `information_schema.STATISTICS`.
  - Switch database with `USE`.
- **Loading:** tables of one database are loaded when expanded, then cached per session. ↻ reloads.

### 4.5 Tauri commands (`crates/rookery-tauri/src/commands.rs`) and events
- **Commands:**
  - `sql_conns_list`, `sql_conn_save(conn, password: Option<String>)`, `sql_conn_delete(id)`
  - `sql_test(conn, password)` → version + latency
  - `sql_open(target)` → `{ session_id, server_version, read_only }`
    - `target` = `{ kind: "saved", id }` | `{ kind: "server", host_id, engine, port, user, database }` | `{ kind: "url", url, password }`
  - `sql_close(session_id)`
  - `sql_schema(session_id, database: Option<String>)` → `SchemaTree`
  - `sql_run(session_id, sql, opts)` → `query_id`
  - `sql_cancel(query_id)`
  - `sql_tx(session_id, action: "begin"|"commit"|"rollback")`
  - `sql_set_read_only(session_id, on)`
  - `sql_history(conn_key, limit)`
  - `sql_detect_local()` → candidates
  - `sql_docker_inspect(host_id, container)` → prefill (no password)
  - `sql_env_parse(text)` → prefill
- **Events:** on the single `core` channel, as new `CoreEvent` variants:
  - `SqlResult { query_id, index, columns?, rows: Vec<Vec<Option<String>>>, done, affected?, elapsed_ms?, truncated, error?, notice? }`. Send rows in chunks of ≤ 500 rows, and send `columns` with the first chunk of each result set.
  - `SqlSession { session_id, state: "connected"|"lost", tx_open, read_only, message? }`
- **Secrets stay in Rust:** passwords go webview → Rust → vault only. No command ever returns a password.

---

## 5. Frontend (`apps/desktop/src/features/sql/`)
- **Files:**
  - `SqlTab.tsx`: the shared tab / view;
  - `SchemaTree.tsx`, `SqlEditor.tsx` (CodeMirror 6: `@codemirror/view`, `@codemirror/state`, `@codemirror/lang-sql` with `MySQL` / `PostgreSQL` dialect and `schema` completion);
  - `ResultsGrid.tsx` (virtualised; `@tanstack/react-virtual` or a small custom window);
  - `ConnectionDialog.tsx`, `DbList.tsx` (sidebar section);
  - `split.ts`: the statement splitter, with unit tests;
  - `classify.ts`: risk classifier, with unit tests.
- **Store** `stores/sql.ts`: connections, open sessions, per-tab editor text (persist the text locally like `ui.session`; the key must be **local** → add it to `LOCAL_SETTING_KEYS`), results, running query, tx state.
- **Tabs** (`stores/tabs.ts`):
  - New `Tab` kind `{ kind: "db", id, connId | target, title }`.
  - New server `View` `"database"`, added to `VIEWS` in `ServerTab.tsx` and to the view shortcuts in `keys/actions.ts` (Ctrl+8).
  - Session restore: db tabs come back **disconnected** (they connect on first focus, like server tabs).
- **Events:** route `sql_result` / `sql_session` in `ipc/events.ts`.
- **Keyboard actions** (`keys/actions.ts`, group "SQL"): `sql.run` (Mod+Enter, terminalOnly false, editor-scoped), `sql.runAll` (Mod+Shift+Enter), `sql.cancel` (Mod+.), `sql.newTab`, `sql.toggleTree`.
- **Look:** use existing tokens and primitives (`Button`, `Select`, `TextInput`, `Modal`, `ContextMenu`, `askConfirm`). Slate Blue palette only (see 00-START-HERE §6). Monospace in the editor and grid uses the terminal font preference.

---

## 6. Safety rules (non-negotiable on PROD)

| Rule | How |
|---|---|
| **Read-only by default** when `env_label = prod` (or the connection's "Open read-only") | Postgres: `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` + `SET default_transaction_read_only = on`. MySQL: `SET SESSION TRANSACTION READ ONLY`. The **server** enforces it, not just the UI. |
| **Turning writes on** | The toolbar 🔒 menu → "Allow changes for 15 minutes" → confirm dialog naming the connection and env. Turns off by itself; the toolbar shows a countdown. |
| **Writes always in a transaction** (when writes are on) | The first non-SELECT auto-`BEGIN`s. The banner shows "Uncommitted changes · 37 rows" with **Commit** / **Rollback**. Closing the tab, locking the app or switching database with an open tx asks (Commit / Rollback / Cancel). DDL in MySQL auto-commits: warn before running it ("ALTER/CREATE/DROP commit immediately on MySQL"). |
| **Risky statements** | `classify.ts` before sending: `UPDATE`/`DELETE` without `WHERE`, `DROP`, `TRUNCATE`, `ALTER`, `GRANT`/`REVOKE`, multi-statement with any write → confirm dialog showing the statement. On PROD the confirm needs typing the database name. |
| **Row cap** | Stream rows and stop at `row_limit` (default 500), then cancel the rest server-side. Show "500 rows (limit) · Load 500 more" (re-runs with a higher cap). No SQL rewriting. |
| **Timeout** | Postgres `SET statement_timeout = <timeout_s*1000>`. MySQL `SET SESSION max_execution_time = <ms>` (SELECT only) + client-side timer → cancel. |
| **Cancel** | The toolbar ■ / Mod+. → `sql_cancel` → Postgres cancel request / MySQL `KILL QUERY`. Must really stop the query on the server. |
| **Load** | One query connection per session; schema loaded lazily; nothing connects until the tab / view is opened; idle sessions close after 10 min. Never poll the database. |
| **Secrets** | Passwords only in the vault (`dbconn:<id>:password`), never logged, never in history, never sent to the webview. |
| **History** | Stores SQL text only (no results), local only, last 200 per connection, clearable. |

---

## 7. Build order and "done" checks

1. **Core + PostgreSQL direct:**
   - migration v6, `DbConnection` model + CRUD + vault secret;
   - the `sql` module with the Postgres engine (simple query, streaming, cancel, read-only, tx, timeout);
   - commands + events;
   - Rust tests: statement result chunking, read-only enforcement, schema query parsing against fixtures. An integration test against a real Postgres is behind `#[ignore]` + an env var URL.
2. **MySQL / MariaDB engine:** same tests, plus `KILL QUERY` cancel.
3. **Loopback forwarder + "through a server"**, plus the server-tab **Database** view (connect via the host's lease).
4. **UI:**
   - database tab, schema tree, editor (CodeMirror + completion), results grid, Messages tab, CSV export, history;
   - vitest for `split.ts` (strings, comments, `$$` dollar quotes, MySQL `DELIMITER` not supported → message) and `classify.ts`.
5. **Saved connections:** sidebar section, dialog with Test connection, quick-connect URLs, session restore (disconnected).
6. **Safety layer end to end** (§6). Manual check on a PROD-labelled connection: a write is refused by the server; "Allow changes" works and expires; Commit / Rollback; `DELETE` without `WHERE` asks; cancel stops `SELECT pg_sleep(60)` / `SELECT SLEEP(60)`.
7. **Shortcuts:** Docker "Open in SQL", Laravel `.env` import, "Find databases on this PC".
8. **Sync & backup:** add connections to payload / merge / revision / tombstones; extend `pc_and_laptop_sync_through_a_folder` with a connection + its password.
9. **Docs:**
   - mark 02-ROADMAP v0.7 rows;
   - add §13 "Databases" to 03-DESKTOP-FEATURES;
   - add the v0.7.0 section to CHANGELOG;
   - add a README tour item + a `sql` demo scene + a screenshot (`docs/screenshots/sql.png`, via `apps/desktop/demo.html?scene=sql`).

Every step: `cargo test -p rookery-core`, `cargo build -p rookery-tauri`, `npx tsc --noEmit -p apps/desktop`, `npx vitest run` (in apps/desktop) must pass.

---

## 8. Decisions already made (from the product owner)
- **Both entry points:** the server-tab Database view **and** standalone database tabs.
- **Local PC databases** must be easy: detection + XAMPP / Laragon / Postgres defaults.
- **Keep it minimal:** see / run / fix. PROD safety comes first.
- **Engines:** PostgreSQL + MySQL / MariaDB first.

## 9. Open questions — answered (2026-10-16)
- Database tabs in the Dashboard? **No.**
- Allow-changes duration: **15 min.**
- Password from a Laravel `.env`: **always ask** (v0.7.1).
- Scope: **"simple core first"**: the §2.4 shortcuts and history move to v0.7.1.
- Server view password: **Save makes a saved connection** (vault); unsaved views keep it in memory.
- Idle close with a transaction open: **never** (only idle sessions without a transaction close).
- Risky statement on PROD: **type the database name.**
- Grid: `@tanstack/react-virtual`.

---

## 10. Built in 0.7.0

### 10.1 Done (steps 1–8 of §7)
- **Core** (`crates/rookery-core/src/sql/`): `manager.rs` (sessions, read-only, writes timer, transactions, idle close, cancel), `pg.rs` (tokio-postgres, simple query, notices), `mysql.rs` (mysql_async, text protocol, `KILL QUERY`), `lex.rs` (split / classify / read-only guard), `schema.rs` (catalog rows → tree), `tls.rs` (rustls + ring).
- **Forwarder** `crates/rookery-core/src/forward.rs`, migration **v6** (`db_connections` only), backup / sync of connections + passwords.
- **UI** `apps/desktop/src/features/sql/`: `SqlTab`, `SqlEditor`, `SchemaTree`, `ResultsGrid`, `ConnectionDialog`, `DbList`, `DbTab`, `ServerDbView`, `split.ts`, `classify.ts`, `txGuard.ts`, `url.ts`; store `stores/sql.ts`; demo scenes `sql`, `sql-server`, `sql-dialog`.
- **Tests**: unit tests in Rust and vitest; `#[ignore]` integration tests against real servers (`ROOKERY_TEST_PG_URL`, `ROOKERY_TEST_MYSQL_URL`, `ROOKERY_TEST_MARIADB_URL`, and `ROOKERY_TEST_SSH` + `ROOKERY_TEST_SSH_DB` for "through a server"). Run on PostgreSQL 16, MySQL 8.4, MariaDB 11.4 and an OpenSSH server in Docker.

### 10.2 Differences from the text above
- **Commands**: `sql_open` server target also takes `address` and an optional `password`. `sql_set_read_only` is `sql_allow_writes(session_id, minutes)` (0 = read-only again; while writes are on it extends). Added `sql_use(session_id, database)` (both engines reconnect to switch database). `sql_schema(session_id, system)` loads the current database's schemas with columns and indexes in one call. `sql_history`, `sql_detect_local`, `sql_docker_inspect`, `sql_env_parse` are v0.7.1.
- **Statements are split in Rust** (`lex.rs`) and run one by one; `SqlResult` has `stmt`, `error_pos` (char offset in the submitted text) and `finished` (last event of a run). `split.ts` is the same splitter for "statement at cursor" and risk checks.
- **Read-only**: besides the server setting, Rust refuses statements that change data while read-only and anything that would switch read-only off (`SET … READ WRITE`, `default_transaction_read_only`, `transaction_read_only` / `tx_read_only`, `BEGIN / START TRANSACTION READ WRITE`, `RESET ALL`, `DISCARD`, `set_config(…)`).
- **Auto-transaction** only on protected sessions (PROD / "Open read-only") while changes are allowed; ordinary connections autocommit. Postgres wraps each statement inside a transaction in a savepoint, so an error or a cut-off read doesn't lose the transaction.
- **Timeout**: MariaDB uses `max_statement_time` (seconds); MySQL `max_execution_time`; plus a client-side watchdog that cancels after `timeout_s + 2`.
- **Expiry with an open transaction**: further writes are refused at once; the server's read-only setting follows when the transaction ends.
- **SQL tab session events**: `SqlSession.state` = connected | lost | closed (idle / tab closed); a run reconnects transparently.
- **Editor text** is kept per tab under the local setting `ui.sql.drafts`; tab restore never stores a password.
- **Lock**: SQL sessions always close on lock and on webview reload. The lock button / Ctrl+L ask about open transactions first; idle auto-lock cannot ask (the server rolls back).

### 10.3 Left for v0.7.1
- Docker **Open in SQL** (§2.4), Laravel **`.env` import** (§2.4, password always asked), **Find databases on this PC** (§2.4).
- **History** (`sql_history` table as migration **v7**, last 200 per connection, clearable) and **Save as snippet** (a separate SQL snippet kind, so terminals don't run it).
- Ideas seen while building: show column types for Postgres results (the simple protocol only gives names; numbers are right-aligned by looking at the values); a Commit / Rollback prompt when the window closes.
