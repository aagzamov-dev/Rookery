# 07 — SQL connections (v0.7)

Status: **0.7.0 (the core) and 0.7.1 (shortcuts, history) built.** What was built, and where it differs from the text below, is in §10. Read [00-START-HERE.md](00-START-HERE.md) first: it has the project rules this feature must follow.

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
- Cells can be edited through the full-value viewer (§10). Inline grid typing and inserting/deleting rows remain out of scope.
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
| **Turning writes on** | Select Edit mode in the connection toolbar dropdown. PROD asks for confirmation naming the connection. Editing stays enabled until the connection closes or Read-only is selected. |
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
- Edit-mode duration: **until the connection closes or Read-only is selected**.
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
- **Auto-transaction** for SQL scripts only on protected sessions (PROD / "Open read-only") while changes are allowed; ordinary connections autocommit. Cell edits from the viewer always stay in a transaction until Commit/Rollback. Postgres wraps each script statement inside a transaction in a savepoint, so an error or a cut-off read doesn't lose the transaction.
- **Timeout**: MariaDB uses `max_statement_time` (seconds); MySQL `max_execution_time`; plus a client-side watchdog that cancels after `timeout_s + 2`.
- **Expiry with an open transaction**: further writes are refused at once; the server's read-only setting follows when the transaction ends.
- **SQL tab session events**: `SqlSession.state` = connected | lost | closed (idle / tab closed); a run reconnects transparently.
- **Editor text** is kept per tab under the local setting `ui.sql.drafts`; tab restore never stores a password.
- **Lock**: SQL sessions always close on lock and on webview reload. The lock button / Ctrl+L ask about open transactions first; idle auto-lock cannot ask (the server rolls back).

### 10.3 v0.7.1 scope (done, see §10.4)
- Docker **Open in SQL** (§2.4), Laravel **`.env` import** (§2.4, password always asked), **Find databases on this PC** (§2.4).
- **History** (`sql_history` table as migration **v7**, last 200 per connection, clearable) and **Save as snippet** (a separate SQL snippet kind, so terminals don't run it).

### 10.4 Built in 0.7.1, and differences from the text above
- **Code**: `crates/rookery-core/src/sql/detect.rs` (Docker inspect, `.env`, local detection), history in `db.rs` + `SqlManager::record`; UI `features/sql/SidePanel.tsx` (History / Snippets), `FindLocal.tsx`, `shortcuts.ts`, the import strip in `ConnectionDialog.tsx`, the prefill in `ServerDbView.tsx`, the button in `docker/DockerView.tsx`.
- **Migration v7**: `sql_history` exactly as §3.1, plus `snippets.kind` (`shell` | `sql`).
- **History**:
  - Rust records each run (the whole submitted text, `ok` = no statement failed, `rows` = rows returned or affected by the last statement, `elapsed_ms` = the whole run) **before** it sends `finished`, so the panel can reload on `finished`.
  - `conn_key`: the saved connection's id; `host:<host_id>:<engine>:<port>` for a server view; `url:<url without password>` for quick connect. `SqlOpened` returns it.
  - Not kept: text containing `password`, `passwd` or `identified` (`ALTER USER … PASSWORD`, `CREATE USER … IDENTIFIED BY`).
  - Commands `sql_history(conn_key, limit)` and `sql_history_clear(conn_key)`. Deleting a saved connection also deletes its history.
- **SQL snippets**: `Snippet.kind = "sql"`. Saving one clears alias, hotkey, variables and steps and stores scope "one server" with no server, so even an older app (0.7.0, which doesn't know `kind`) never offers it to a terminal. `appliesTo` / `appliesToContainer` return false for SQL snippets. They sync and back up like other snippets.
- **Docker**: `sql_docker_inspect(host_id, container)` → `SqlPrefill` (name, engine, address, port, user, database, `note`, `password_hint`). Engine by image name (`postgres`, `postgis`, `timescale` / `mysql`, `mariadb`, `percona`; `*exporter*` is skipped). User / database: `POSTGRES_USER`/`POSTGRES_DB` (+ bitnami `POSTGRESQL_*`), `MYSQL_USER`/`MARIADB_USER` else `root`, `MYSQL_DATABASE`/`MARIADB_DATABASE`. Address: published port on 127.0.0.1 first, then host network, then the container IP. The env is parsed in Rust; only the *name* of the password variable leaves it. The prefill goes to the server's **Database view** (not a dialog); if a database is already open there, it asks before closing it.
- **`.env`**: `sql_env_parse(text)` became `sql_env_import(source)` with `source = { kind: "local", path } | { kind: "remote", host_id, path }`, so the file is read by Rust and the password never passes through the webview. `DB_PASSWORD` (or the password in `DB_URL`) is kept in memory under `password_ref` (15 minutes, cleared on lock); `sql_test` and `sql_conn_save` take an optional `password_ref` instead of a password. Remote import makes the connection "through that server". Max file size 256 KB; `~/` paths are relative to the home folder.
- **Find databases on this PC**: `sql_detect_local()` → `LocalDb[]` (engine, port, product, container, user, database, hint). The probe reads the MySQL / MariaDB greeting, and sends a Postgres SSLRequest to a silent port (answer `S` / `N`); other services are not listed. Docker: `docker ps` + one `docker inspect` for the database containers, run with no console window on Windows and with the usual Docker paths on macOS; no Docker or a stopped daemon just means no Docker rows. Entry: sidebar → Databases → 🔍 (and the empty Databases list).
- **Tests**: unit tests for all parsers, the probe (fake Postgres / non-database listeners), history pruning and SQL snippet rules; `detect_local_for_real` (`#[ignore]`) and the existing `real_servers_end_to_end` (now also checks the history) were run against PostgreSQL 16 and MySQL 8.4 in Docker.

### 10.6 Table browser (HeidiSQL style) and the SSH | SQL sidebar — built in 0.7.0
- **Sidebar:** an **SSH | SQL** switch on top of the host list (`useUi.sidebar`, SSH on every start). SQL shows the saved connections (`DbConnections` in `features/sql/DbList.tsx`), the add / find buttons and the filter for them.
- **Tabs inside a SQL tab / Database view:** **Query** (the editor, always mounted) plus one tab per opened table.
  - Single click in the tree opens a *preview* tab (italic, replaced by the next click); a double-click, a foreign-key jump or switching Data / Structure keeps it.
  - Middle-click closes. The tree arrow still shows columns.
  - Files: `features/sql/TableView.tsx`, `tableLayout.ts`; tabs in `SqlTab.tsx`.
- **Data tab:**
  - **Paging:** the page size (100 / 200 / 500 / 1000) fetches one row more to know there's more ("Load N more" appends).
  - **Sort:** click a header (asc → desc → off); Shift+click adds keys. The default is the primary key.
  - **Quick search:** looks at up to 40 text columns (debounced 350 ms).
  - **Filters:** column + condition chips, all AND, editable.
  - **WHERE box:** a hand-written condition, shown as a chip.
  - **Right-click a cell:** = / ≠ / contains / is NULL, "Open <table> where <fk> = value" and "Rows in <table> pointing here".
  - **Columns:** drag to reorder, drag the edge to resize, hide / show.
  - **Also:** row detail panel, exact **Count**, CSV of the loaded rows, **Show SQL** with "Open in Query".
- **Structure tab:** columns (type, null, default, extra, comment, key marks), indexes, foreign keys and "referenced by" (clickable), size / engine / collation, and the CREATE code. MySQL uses `SHOW CREATE TABLE`; Postgres builds it from `pg_constraint` / `pg_get_indexdef` / `pg_get_viewdef`.
- **Rust** (`crates/rookery-core/src/sql/table.rs`):
  - **Commands:** `sql_table_detail(session, schema, table)`, `sql_table_rows(session, TableQuery)` → `{ query_id, sql }` (rows stream as normal `SqlResult` events, not kept in history), `sql_table_count(session, TableQuery)`.
  - **Safety:**
    - column names in filters / sort must exist in the catalog;
    - identifiers are always quoted;
    - values are literals: Postgres `'…'` / `E'…'`; MySQL `''` + `\\`;
    - LIKE patterns are escaped with `!`;
    - the final SQL must split into exactly one statement and classify as a read, so a WHERE with `;` or a write is refused;
    - the query then runs through `run_inner`: read-only guard, timeout, row cap and cancel as usual.
  - Columns per table are cached in the session and cleared on schema reload / `USE`.
- **Layouts:** `ui.sql.tables` (in `LOCAL_SETTING_KEYS`, not synced) keeps order / hidden / widths / page size per `<connKey>|<schema>.<table>`, the last 300 tables.
- **Cell actions:** click selects a cell; Ctrl+C / Cmd+C copies its complete value. A `⋯` button appears on hover or selection, with View full value, Copy value, and Edit value. Right-click offers the same actions alongside filters and foreign-key navigation.
- **Full-value viewer:** double-click or Enter opens a searchable, resizable CodeMirror viewer. In Edit mode it offers an Edit button, JSON validation/highlighting, and an explicit NULL checkbox. F2 opens the selected cell directly for editing; change or disable `sql.editCell` in Shortcuts.
- **Read-only / Edit mode:** the connection toolbar dropdown switches any session between Read-only and Edit mode. Editing stays enabled until the connection closes or the user selects Read-only; there is no countdown. PROD still opens read-only and requires confirmation to enable editing. Pending transactions keep Commit/Rollback available in Read-only mode. The UI uses `sql_set_edit_mode(session_id, enabled)`; switching to session-long editing invalidates any older write timer.
- **Cell writes:** `sql_table_update_cell(session_id, update)` validates current catalog metadata, requires a complete primary/unique key, binds values as parameters, and checks the original cell value. Only supported scalar columns on base tables (InnoDB on MySQL) are editable; generated/identity and binary columns and arbitrary query results are read-only. Updates affecting anything other than one row are rolled back. Failed edits use a savepoint when a transaction is already open.
- **PROD review:** the viewer shows an original/updated diff before applying the edit to the transaction. Applying is separate from Commit. Tables refresh after Apply, Commit, or Rollback.
- **Transaction review:** Review beside Commit/Rollback lists applied cell diffs and SQL write statements in execution order. Details are kept in memory until the transaction ends; changes made before the review feature loaded have no recorded details. SQL statements are shown as executed rather than as row-level diffs.
- **Viewer sizing:** the editor starts at 20vh, grows with its content up to 50vh, then scrolls. Cell diffs use the same limits. The NULL checkbox and edit/apply controls have larger click targets.
- **Integration test:** `ROOKERY_TEST_MYSQL_URL`, `ROOKERY_TEST_PG_URL`, or `ROOKERY_TEST_MARIADB_URL` can point to a disposable test database for `cargo test -p rookery-core real_cell_edits -- --ignored`.
- **Not yet:** inserting/deleting rows and structure changes.

### 10.5 Ideas for later
- Show column types for Postgres results (the simple protocol only gives names; numbers are right-aligned by looking at the values).
- A Commit / Rollback prompt when the window closes.
- History search across all connections; a keyboard shortcut for the History panel.

## Native database file operations

The Database toolbar has **Export**, **Import**, and **Backups** dialogs. Opening Export explicitly fetches table names and approximate data/index storage sizes. Every table starts selected; search, Select all, Clear, checkboxes, and per-table Structure + data / Structure only / Exclude controls define the export. Selected storage totals are estimates, not predicted dump sizes. Import and Backups do not query table sizes. Closing a dialog stops pending follow-up metadata requests. Losing focus or hiding a tab preserves the open draft and native picker result while blocking new metadata requests; no timer polls servers or job status.

SSH exports execute `pg_dump`, `mariadb-dump`, or `mysqldump` on the connection's SSH server using its original database endpoint. The matching client and GNU coreutils (`sha256sum`, `ln -T`) must already be on the server's standard PATH; missing tools report manual installation guidance. Credentials travel over SSH stdin into a private temporary authentication file, never command arguments. A local CA path is refused for SSH exports because it is not a server certificate path. Docker-only targets require a host-accessible database endpoint and native client; this feature does not discover or execute inside containers.

PROD confirmation requires the exact database name, with automatic capitalization/correction disabled and a case-sensitive mismatch hint. Awaiting confirmation and checking database access/table selection are separate from a running job. The operation log retains at most 100 lines / 32 KiB, showing timestamped native verbose activity, SSH dump/checksum/publication stages, and bounded redacted stderr. SQL/data diagnostic fragments and quoted import values are withheld; dump stdout stays in files. Native events drive progress; a local 150 ms log flush and elapsed clock make no server requests. Unknown dump sizes have no invented percentage.

Server destinations must be absolute paths. Exports use private staging under the destination parent, compute size and SHA-256 there, then publish without replacing any existing file, symlink or directory. Server backups can later be downloaded through Backups without creating another dump. Choosing This computer for an SSH export uses private server staging followed by a streamed SFTP download and checksum verification; no local dump client is needed. Server-only exports do not download the dump just to hash it.

Direct local exports and all imports/restores still run native clients on this computer (`pg_dump` / `pg_restore` / `psql`, or MariaDB/MySQL clients). Imports over SSH own a loopback forward. Compatible clients must be installed manually on this computer's PATH. Sources and downloads stream in 64 KiB chunks through private local staging without crossing IPC or entering the SQL editor, so the computer needs space for the entire input. Local publication may require another full copy. Destinations are never replaced. Cancellation terminates active dump/hash subprocesses and removes temporary credentials and staging; a completed destination may remain if cancellation races final publication. Out-of-space and native-tool failures are surfaced; disk capacity is not reserved in advance.

Only one database file job runs at a time, holding its SQL session's operation lock. Progress events report the current stage's bytes, known total where available, elapsed time, failure, and cancellation. A visible dialog updates elapsed time locally; closing it leaves the explicit job running. Closing its database session, reconnecting, or locking the vault cancels the job and kills/reaps its native child. Native import requires persistent Edit mode and no active query or transaction. PROD import/restore/delete and PROD SSH export (including temporary server staging for a local destination) require confirmation; the core also checks current saved environment labels. Errors and cancellation can leave applied import changes and must never trigger an automatic retry.

PostgreSQL exports are custom archives. A full table selection uses a whole-database dump to retain dependencies; subsets use quoted exact table patterns and can omit dependencies. Structure-only across the selection uses `--schema-only`; mixed selections exclude the chosen tables' row data. MySQL/MariaDB exports offer SQL (`.sql`) or compressed SQL (`.sql.gz`, the default in the dialog). Compression uses gzip, not a ZIP container, and creates only the compressed output. Direct local exports use a bounded streaming gzip encoder; SSH exports stream native output through a FIFO into `gzip -1`, checking both process exit statuses before publication. SSH compressed exports therefore also require `gzip` on the server. Existing API requests without a format retain plain SQL, and existing backup records remain readable. These are table SQL backups with triggers, excluding routines, events, users, and replication state. Mixed modes export schema without triggers, one transactional data pass, then triggers for every included table. Schema and data passes are not one shared snapshot; nontransactional tables and concurrent DDL can be inconsistent. These exports are not a complete server disaster-recovery backup.

Import supports MySQL/MariaDB plain or gzip SQL and PostgreSQL custom archives, plain SQL or gzip SQL. Gzip imports validate every member and trailer before starting the native client, then decode the private compressed snapshot directly into client stdin in bounded chunks, without an uncompressed staging file. Format/magic mismatches and ZIP archives are rejected. Backup bytes and checksums describe the final compressed file when gzip is selected. The dialog identifies the exact account/address/database and requires trust acknowledgement. Native clients stop at errors where supported, but arbitrary dumps can switch databases or execute database/local client commands under the user's privileges. Rookery does not promise database confinement, transactional rollback, or sandboxing. Exports never execute companion SQL or after-restore SQL against the source.

Backups lists only completed exports recorded by this device for the current connection/database. The local-only registry stores source/format, path, time, bytes, table modes, tool version, and SHA-256. Download, restore, and delete check the stored hash against a staged file snapshot; missing or changed files produce an error. A successful export records **restore not tested**. A successful native import reports process completion and asks the user to verify data; it does not mark a backup as restore-verified. Native files are not automatically opened in an editor. Both in-app and external-edit reads enforce the existing 20 MiB cap even if a file grows during reading, and oversized editor failures do not automatically fall back to an external editor.

Validation uses mocked IPC and local process/file fixtures, including streaming, pipe closure, cancellation/reaping, bounded diagnostics, authentication-file permissions, exact identifier handling, mixed-mode trigger ordering, checksum refusal, and no-overwrite behavior. No live database restore has been used to verify this implementation.

Database file operations continue when their Export, Import or Backups dialog is closed (including X and Escape). Rookery must remain open. Use **Cancel job** to stop an operation; connection close, reconnect and database switching stay blocked while it runs. Completed, failed and cancelled progress panels have a dismiss X.

The title-bar notification bell keeps the latest 100 notifications for the current app session, including database operation outcomes. **Enable desktop notifications** in the bell or Settings → Notifications explicitly requests native notification permission. Denied permission does not affect the application inbox. Native notifications hide details while the vault is locked.
