//! SQL sessions: one per open database tab / view, keyed by `session_id`.
//!
//! - One connection per session for queries. It is opened by `open()` and reopened on the
//!   next run after an idle close or a lost connection (transparent to the UI).
//! - **Protected** sessions (PROD or "Open read-only") start read-only, enforced by the server.
//!   "Allow changes" turns writes on for a while; while they are on, the first statement that
//!   changes data opens a transaction, so nothing lands without Commit.
//! - Idle sessions drop their connection after 10 minutes, never with a transaction open.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;
use zeroize::Zeroizing;

use super::lex::{self, Kind};
use super::table::{self, ColMeta, ColumnDetail, TableDetail, TableQuery, TableRowsStarted};
use super::mysql::{self, MyCancel, MyConn};
use super::pg::{self, PgCancel, PgConn};
use super::{ConnParams, Done, SchemaTree, Sink, SqlOpened, SqlRunOpts, SqlTarget, SqlTestResult, StmtError, TxAction, IDLE_CLOSE};
use crate::db::Db;
use crate::forward::Forwarder;
use crate::ssh::ConnectionManager;
use crate::model::{db_secret_id, DbConnection, DbEngine, DbVia, EnvLabel, SqlHistoryEntry, SslMode};
use crate::vault::Vault;
use crate::{new_id, now_ms, CoreEvent, Error, Result};

const SWEEP_EVERY: Duration = Duration::from_secs(60);
/// How long a password read from a `.env` waits in memory for "use password from .env".
const STASH_FOR: Duration = Duration::from_secs(15 * 60);

enum Conn {
    Pg(PgConn),
    /// The sender only tells the watcher when the connection is dropped (MySQL has no driver task).
    My(MyConn, #[allow(dead_code)] oneshot::Sender<Option<String>>),
}

#[derive(Clone)]
enum Cancel {
    Pg(PgCancel),
    My(MyCancel),
}

impl Cancel {
    async fn cancel(&self) {
        let r = match self {
            Cancel::Pg(c) => c.cancel().await,
            Cancel::My(c) => c.cancel().await,
        };
        if let Err(e) = r {
            tracing::debug!("sql cancel: {e}");
        }
    }
}

impl Conn {
    async fn connect(p: &ConnParams) -> Result<(Conn, Cancel, String, oneshot::Receiver<Option<String>>)> {
        match p.engine {
            DbEngine::Postgres => {
                let (c, version, ended) = pg::connect(p).await?;
                let cancel = Cancel::Pg(c.cancel.clone());
                Ok((Conn::Pg(c), cancel, version, ended))
            }
            DbEngine::Mysql => {
                let (c, version) = mysql::connect(p).await?;
                let cancel = Cancel::My(c.cancel.clone());
                let (tx, ended) = oneshot::channel();
                Ok((Conn::My(c, tx), cancel, version, ended))
            }
        }
    }

    async fn exec(&mut self, sql: &str, cancel_at_cap: bool, sink: &mut Sink) -> std::result::Result<Done, StmtError> {
        match self {
            Conn::Pg(c) => c.exec(sql, cancel_at_cap, sink).await,
            Conn::My(c, _) => c.exec(sql, cancel_at_cap, sink).await,
        }
    }

    async fn tx(&mut self, sql: &str) -> std::result::Result<(), StmtError> {
        match self {
            Conn::Pg(c) => c.tx(sql).await,
            Conn::My(c, _) => c.tx(sql).await,
        }
    }

    async fn set_read_only(&mut self, on: bool) -> Result<()> {
        match self {
            Conn::Pg(c) => c.set_read_only(on).await,
            Conn::My(c, _) => c.set_read_only(on).await,
        }
    }

    async fn schema(&mut self, system: bool) -> Result<SchemaTree> {
        match self {
            Conn::Pg(c) => c.schema(system).await,
            Conn::My(c, _) => c.schema(system).await,
        }
    }

    async fn database(&mut self) -> Result<Option<String>> {
        match self {
            Conn::Pg(c) => c.database().await,
            Conn::My(c, _) => c.database().await,
        }
    }

    async fn columns(&mut self, schema: &str, table: &str) -> Result<Vec<ColumnDetail>> {
        match self {
            Conn::Pg(c) => c.columns(schema, table).await,
            Conn::My(c, _) => c.columns(schema, table).await,
        }
    }

    async fn table_detail(&mut self, schema: &str, table: &str) -> Result<TableDetail> {
        match self {
            Conn::Pg(c) => c.table_detail(schema, table).await,
            Conn::My(c, _) => c.table_detail(schema, table).await,
        }
    }

    async fn scalar(&mut self, sql: &str) -> Result<Option<String>> {
        match self {
            Conn::Pg(c) => c.scalar(sql).await,
            Conn::My(c, _) => c.scalar(sql).await,
        }
    }

    fn take_notices(&mut self) -> Vec<String> {
        match self {
            Conn::Pg(c) => c.take_notices(),
            Conn::My(..) => vec![],
        }
    }

    fn is_closed(&self) -> bool {
        match self {
            Conn::Pg(c) => c.is_closed(),
            Conn::My(..) => false,
        }
    }

    /// Savepoints around each statement inside a transaction (Postgres): an error or a
    /// cancelled read does not throw the whole transaction away.
    fn uses_savepoints(&self) -> bool {
        matches!(self, Conn::Pg(_))
    }
}

struct State {
    /// Opened read-only (PROD / "Open read-only"): writes need "Allow changes".
    protected: bool,
    /// Writes are refused right now.
    read_only: bool,
    /// What the server session currently enforces.
    server_read_only: bool,
    writes_until: Option<i64>,
    writes_gen: u64,
    tx_open: bool,
    tx_rows: u64,
    database: Option<String>,
    last_used: Instant,
    running: bool,
}

struct Session {
    id: String,
    /// Query history key (see [`conn_key`]).
    conn_key: String,
    params: Mutex<ConnParams>,
    conn: tokio::sync::Mutex<Option<Conn>>,
    /// Bumped on every (re)connect and deliberate close; a watcher of an older connection stays quiet.
    conn_gen: AtomicU64,
    cancel: Mutex<Option<Cancel>>,
    st: Mutex<State>,
    closed: AtomicBool,
    /// Through a server: the loopback forward (holds the SSH lease) for this session.
    forward: Mutex<Option<Forwarder>>,
    /// Table browser: columns per `schema.table` (cleared when the schema is reloaded).
    columns: Mutex<HashMap<String, Arc<Vec<ColumnDetail>>>>,
}

/// How the driver reaches the database.
enum Route {
    Direct,
    /// Through the saved server with this id.
    Ssh(String),
}

struct QueryCtl {
    session: Arc<Session>,
    cancelled: AtomicBool,
}

pub struct SqlManager {
    db: Arc<Db>,
    vault: Arc<Mutex<Vault>>,
    connections: Arc<ConnectionManager>,
    events: broadcast::Sender<CoreEvent>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    queries: Mutex<HashMap<String, Arc<QueryCtl>>>,
    sweeper: Mutex<Option<JoinHandle<()>>>,
    /// Passwords read from a `.env`, by reference; they never go to the webview.
    stash: Mutex<HashMap<String, (Zeroizing<String>, Instant)>>,
}

impl SqlManager {
    pub fn new(db: Arc<Db>, vault: Arc<Mutex<Vault>>, connections: Arc<ConnectionManager>, events: broadcast::Sender<CoreEvent>) -> Self {
        Self {
            db,
            vault,
            connections,
            events,
            sessions: Mutex::new(HashMap::new()),
            queries: Mutex::new(HashMap::new()),
            sweeper: Mutex::new(None),
            stash: Mutex::new(HashMap::new()),
        }
    }

    // ------------------------------------------------------- .env passwords

    /// Keep a password found in a file for a while; the UI only gets the reference.
    pub fn stash_password(&self, password: Zeroizing<String>) -> String {
        let mut s = self.stash.lock();
        s.retain(|_, (_, at)| at.elapsed() < STASH_FOR);
        let r = new_id();
        s.insert(r.clone(), (password, Instant::now()));
        r
    }

    /// The password behind a reference from `stash_password` (it stays until it expires or the app locks).
    pub fn stashed_password(&self, r: &str) -> Result<Zeroizing<String>> {
        let s = self.stash.lock();
        match s.get(r) {
            Some((pw, at)) if at.elapsed() < STASH_FOR => Ok(pw.clone()),
            _ => Err(Error::Other("the password from .env is no longer in memory; import the file again".into())),
        }
    }

    // ------------------------------------------------------------- targets

    fn saved_password(&self, conn_id: &str) -> Result<Option<Zeroizing<String>>> {
        let v = self.vault.lock();
        if !v.is_unlocked() {
            return Err(Error::VaultLocked);
        }
        v.get(&db_secret_id(conn_id))
    }

    /// Connection settings for a target, how to reach it, and whether it opens protected (read-only).
    fn resolve(&self, target: &SqlTarget) -> Result<(ConnParams, Route, bool)> {
        match target {
            SqlTarget::Saved { id } => {
                let c = self.db.get_db_connection(id)?;
                let password = self.saved_password(id)?;
                let route = self.route_of(&c)?;
                Ok((params_of(&c, password), route, c.opens_read_only()))
            }
            SqlTarget::Url { url, password } => {
                let parsed = parse_url(url)?;
                let mut p = parsed.params;
                if let Some(pw) = password.as_ref().filter(|p| !p.is_empty()) {
                    p.password = Some(Zeroizing::new(pw.clone()));
                }
                match parsed.via_server {
                    None => Ok((p, Route::Direct, false)),
                    Some(name) => {
                        let host = self
                            .db
                            .list_hosts()?
                            .into_iter()
                            .find(|h| h.name.eq_ignore_ascii_case(&name))
                            .ok_or_else(|| Error::NotFound(format!("no saved server named \"{name}\"")))?;
                        Ok((p, Route::Ssh(host.id.clone()), host.env_label == EnvLabel::Prod))
                    }
                }
            }
            SqlTarget::Server { host_id, engine, address, port, user, database, password } => {
                let host = self.db.get_host(host_id)?;
                let address = address.trim();
                let p = ConnParams {
                    engine: *engine,
                    host: if address.is_empty() { "127.0.0.1".into() } else { address.to_string() },
                    port: if *port == 0 { default_port(*engine) } else { *port },
                    user: user.trim().to_string(),
                    password: password.as_ref().filter(|p| !p.is_empty()).map(|p| Zeroizing::new(p.clone())),
                    database: database.as_ref().map(|d| d.trim().to_string()).filter(|d| !d.is_empty()),
                    ssl_mode: SslMode::Disable,
                    ca_path: None,
                    timeout_s: 30,
                    row_limit: 500,
                    read_only: false,
                };
                // The databases of a PROD server open read-only too.
                Ok((p, Route::Ssh(host.id), host.env_label == EnvLabel::Prod))
            }
        }
    }

    fn route_of(&self, c: &DbConnection) -> Result<Route> {
        match c.via {
            DbVia::Direct => Ok(Route::Direct),
            DbVia::Ssh => match &c.host_id {
                Some(h) => Ok(Route::Ssh(h.clone())),
                None => Err(Error::Other("the server for this connection is missing; edit it and pick one".into())),
            },
        }
    }

    /// Through a server: take a lease on its SSH session and forward a loopback port to
    /// the database; the driver then connects to `127.0.0.1:<port>`.
    async fn forward(&self, params: &mut ConnParams, route: &Route) -> Result<Option<Forwarder>> {
        let Route::Ssh(host_id) = route else { return Ok(None) };
        let lease = self.connections.acquire(host_id).await?;
        let fwd = Forwarder::ssh(lease, params.host.clone(), params.port).await?;
        params.host = "127.0.0.1".into();
        params.port = fwd.local_port;
        Ok(Some(fwd))
    }

    /// Connect once and close again ("Test connection"). `password` None = the saved one.
    pub async fn test(&self, conn: &DbConnection, password: Option<String>) -> Result<SqlTestResult> {
        let route = self.route_of(conn)?;
        let password = match password.filter(|p| !p.is_empty()) {
            Some(p) => Some(Zeroizing::new(p)),
            None if !conn.id.is_empty() => self.saved_password(&conn.id)?,
            None => None,
        };
        let mut params = params_of(conn, password);
        let started = Instant::now();
        let _fwd = self.forward(&mut params, &route).await?;
        let (_conn, _, version, _) = Conn::connect(&params).await?;
        Ok(SqlTestResult { server_version: version, latency_ms: started.elapsed().as_millis().min(u32::MAX as u128) as u32 })
    }

    // ------------------------------------------------------------ sessions

    pub async fn open(self: &Arc<Self>, target: SqlTarget) -> Result<SqlOpened> {
        let (mut params, route, protected) = self.resolve(&target)?;
        params.read_only = protected;
        let conn_key = conn_key(&target);
        let engine = params.engine;
        let database_hint = params.database.clone();
        let forward = self.forward(&mut params, &route).await?;
        let (mut conn, cancel, version, ended) = Conn::connect(&params).await?;
        let database = conn.database().await.ok().flatten().or(database_hint);
        let sess = Arc::new(Session {
            id: new_id(),
            conn_key: conn_key.clone(),
            params: Mutex::new(params),
            conn: tokio::sync::Mutex::new(Some(conn)),
            conn_gen: AtomicU64::new(1),
            cancel: Mutex::new(Some(cancel)),
            st: Mutex::new(State {
                protected,
                read_only: protected,
                server_read_only: protected,
                writes_until: None,
                writes_gen: 0,
                tx_open: false,
                tx_rows: 0,
                database: database.clone(),
                last_used: Instant::now(),
                running: false,
            }),
            closed: AtomicBool::new(false),
            forward: Mutex::new(forward),
            columns: Mutex::new(HashMap::new()),
        });
        self.watch(&sess, 1, ended);
        self.sessions.lock().insert(sess.id.clone(), sess.clone());
        self.ensure_sweeper();
        self.emit(&sess, "connected", None);
        Ok(SqlOpened { session_id: sess.id.clone(), engine, server_version: version, read_only: protected, database, conn_key })
    }

    fn session(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions.lock().get(id).cloned().ok_or_else(|| Error::NotFound("database session (reopen the tab)".into()))
    }

    fn emit(&self, s: &Session, state: &str, message: Option<String>) {
        let st = s.st.lock();
        let _ = self.events.send(CoreEvent::SqlSession {
            session_id: s.id.clone(),
            state: state.into(),
            tx_open: st.tx_open,
            tx_rows: st.tx_rows,
            read_only: st.read_only,
            protected: st.protected,
            writes_until: st.writes_until,
            database: st.database.clone(),
            message,
        });
    }

    /// Tell the UI when a connection breaks (the server rolls an open transaction back).
    fn watch(self: &Arc<Self>, sess: &Arc<Session>, gen: u64, ended: oneshot::Receiver<Option<String>>) {
        let me = Arc::downgrade(self);
        let sess = sess.clone();
        tokio::spawn(async move {
            let reason = ended.await.ok().flatten();
            let Some(me) = me.upgrade() else { return };
            if sess.closed.load(Ordering::SeqCst) || sess.conn_gen.load(Ordering::SeqCst) != gen {
                return;
            }
            let mut guard = sess.conn.lock().await;
            if sess.conn_gen.load(Ordering::SeqCst) != gen {
                return;
            }
            *guard = None;
            drop(guard);
            let had_tx = {
                let mut st = sess.st.lock();
                let had = st.tx_open;
                st.tx_open = false;
                st.tx_rows = 0;
                had
            };
            let msg = if had_tx {
                "Connection lost — uncommitted changes were rolled back".to_string()
            } else {
                format!("Connection lost{}; it reconnects on the next run", reason.map(|r| format!(" ({r})")).unwrap_or_default())
            };
            me.emit(&sess, "lost", Some(msg));
        });
    }

    /// Reconnect if the connection was closed (idle) or lost.
    async fn ensure_conn<'a>(self: &Arc<Self>, sess: &Arc<Session>, guard: &'a mut Option<Conn>) -> Result<&'a mut Conn> {
        if guard.as_ref().is_some_and(|c| c.is_closed()) {
            *guard = None;
        }
        if guard.is_none() {
            let mut params = sess.params.lock().clone();
            let read_only = sess.st.lock().read_only;
            params.read_only = read_only;
            let (conn, cancel, _, ended) = Conn::connect(&params).await?;
            let gen = sess.conn_gen.fetch_add(1, Ordering::SeqCst) + 1;
            *sess.cancel.lock() = Some(cancel);
            {
                let mut st = sess.st.lock();
                st.server_read_only = read_only;
                st.tx_open = false;
                st.tx_rows = 0;
            }
            self.watch(sess, gen, ended);
            *guard = Some(conn);
            self.emit(sess, "connected", None);
        }
        Ok(guard.as_mut().unwrap())
    }

    pub async fn close(&self, session_id: &str) {
        let Some(sess) = self.sessions.lock().remove(session_id) else { return };
        sess.closed.store(true, Ordering::SeqCst);
        sess.conn_gen.fetch_add(1, Ordering::SeqCst);
        // A running query keeps the lock; ask the server to stop it first.
        let cancel = sess.cancel.lock().clone();
        if sess.st.lock().running {
            if let Some(c) = cancel {
                c.cancel().await;
            }
        }
        sess.conn.lock().await.take();
        sess.forward.lock().take(); // releases the SSH lease
        self.emit(&sess, "closed", None);
    }

    /// App locked / webview reloaded: drop every session (open transactions roll back).
    pub async fn close_all(&self) {
        self.stash.lock().clear();
        let ids: Vec<String> = self.sessions.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id).await;
        }
    }

    fn ensure_sweeper(self: &Arc<Self>) {
        let mut slot = self.sweeper.lock();
        if slot.as_ref().is_some_and(|h| !h.is_finished()) {
            return;
        }
        let me = Arc::downgrade(self);
        *slot = Some(tokio::spawn(async move {
            loop {
                tokio::time::sleep(SWEEP_EVERY).await;
                let Some(me) = me.upgrade() else { return };
                let all: Vec<Arc<Session>> = me.sessions.lock().values().cloned().collect();
                if all.is_empty() {
                    return;
                }
                for s in all {
                    let idle = {
                        let st = s.st.lock();
                        !st.running && !st.tx_open && st.last_used.elapsed() > IDLE_CLOSE
                    };
                    if !idle {
                        continue;
                    }
                    if let Ok(mut guard) = s.conn.try_lock() {
                        if guard.is_some() {
                            s.conn_gen.fetch_add(1, Ordering::SeqCst);
                            *guard = None;
                            drop(guard);
                            me.emit(&s, "closed", Some("Closed after 10 minutes without queries; it reconnects on the next run".into()));
                        }
                    }
                }
            }
        }));
    }

    // ---------------------------------------------------------------- run

    /// Start running a script. Results arrive as `SqlResult` events for the returned query id.
    pub fn run(self: &Arc<Self>, session_id: &str, sql: String, opts: SqlRunOpts) -> Result<String> {
        self.start(session_id, sql, opts, true)
    }

    /// `history` = keep it in the query history (the table browser's own queries are not kept).
    fn start(self: &Arc<Self>, session_id: &str, sql: String, opts: SqlRunOpts, history: bool) -> Result<String> {
        let sess = self.session(session_id)?;
        {
            let mut st = sess.st.lock();
            if st.running {
                return Err(Error::Other("a query is already running in this tab".into()));
            }
            st.running = true;
            st.last_used = Instant::now();
        }
        let query_id = new_id();
        let ctl = Arc::new(QueryCtl { session: sess.clone(), cancelled: AtomicBool::new(false) });
        self.queries.lock().insert(query_id.clone(), ctl.clone());
        let me = self.clone();
        let qid = query_id.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let mut sink = me.run_inner(&ctl, &qid, &sql, opts).await;
            sink.end_open();
            // History first, so it is there when the UI sees `finished`.
            if history {
                me.record(&ctl.session.conn_key, &sql, started, sink.failed, sink.last_rows).await;
            }
            sink.finished();
            {
                let mut st = ctl.session.st.lock();
                st.running = false;
                st.last_used = Instant::now();
            }
            me.queries.lock().remove(&qid);
        });
        Ok(query_id)
    }

    /// Keep the run in the connection's history (text only, no results). Scripts that
    /// look like they hold a password (`ALTER USER … PASSWORD`, `IDENTIFIED BY`) are not kept.
    async fn record(&self, conn_key: &str, sql: &str, started: Instant, failed: bool, rows: Option<u64>) {
        let text = sql.trim();
        if text.is_empty() || !history_safe(text) {
            return;
        }
        let entry = SqlHistoryEntry {
            id: 0,
            conn_key: conn_key.to_string(),
            sql: text.to_string(),
            ran_at: now_ms(),
            ok: !failed,
            rows: rows.map(|r| r.min(i64::MAX as u64) as i64),
            elapsed_ms: Some(started.elapsed().as_millis().min(i64::MAX as u128) as i64),
        };
        let db = self.db.clone();
        match tokio::task::spawn_blocking(move || db.add_sql_history(&entry)).await {
            Ok(Err(e)) => tracing::warn!("sql history: {e}"),
            Err(e) => tracing::warn!("sql history: {e}"),
            Ok(Ok(())) => {}
        }
    }

    /// Runs the statements; the caller sends `finished` on the returned sink.
    async fn run_inner(self: &Arc<Self>, ctl: &QueryCtl, query_id: &str, sql: &str, opts: SqlRunOpts) -> Sink {
        let sess = &ctl.session;
        let (engine, timeout_s, row_limit) = {
            let p = sess.params.lock();
            (p.engine, p.timeout_s, p.row_limit_override(opts.row_limit))
        };
        let mut sink = Sink::new(self.events.clone(), query_id.to_string(), row_limit);
        let stmts = match lex::split(sql, engine) {
            Ok(s) => s,
            Err(m) => {
                sink.error(m, None);
                return sink;
            }
        };
        let mut guard = sess.conn.lock().await;
        if let Err(e) = self.ensure_conn(sess, &mut guard).await {
            sink.error(e.to_string(), None);
            return sink;
        }
        for (n, stmt) in stmts.iter().enumerate() {
            if ctl.cancelled.load(Ordering::SeqCst) {
                break;
            }
            sink.start_statement(n as u32);
            let info = lex::classify(stmt);
            let text = stmt.text(sql);
            let (read_only, protected, mut tx_open) = {
                let st = sess.st.lock();
                (st.read_only, st.protected, st.tx_open)
            };
            if read_only {
                if let Some(m) = lex::read_only_guard(stmt) {
                    sink.error(m.into(), None);
                    break;
                }
                if info.changes_data() {
                    sink.error("Read-only: this statement changes data. Use \u{1F512} → Allow changes to run it.".into(), None);
                    break;
                }
            }
            let Some(conn) = guard.as_mut() else {
                sink.error("Connection lost".into(), None);
                break;
            };

            // Writes on a protected session always go into a transaction.
            if protected && !read_only && info.changes_data() && !info.no_tx && !tx_open {
                if let Err(e) = conn.tx("BEGIN").await {
                    sink.error(e.message, None);
                    break;
                }
                tx_open = true;
                {
                    let mut st = sess.st.lock();
                    st.tx_open = true;
                    st.tx_rows = 0;
                }
                self.emit(sess, "connected", None);
            }
            let savepoint = tx_open && conn.uses_savepoints() && matches!(info.kind, Kind::Read | Kind::Write | Kind::Ddl);
            if savepoint {
                if let Err(e) = conn.tx("SAVEPOINT rookery_stmt").await {
                    sink.error(e.message, None);
                    break;
                }
            }

            // Client-side watchdog on top of the server's statement timeout.
            let watchdog = sess.cancel.lock().clone().map(|c| {
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(u64::from(timeout_s) + 2)).await;
                    c.cancel().await;
                })
            });
            let res = conn.exec(text, info.kind == Kind::Read, &mut sink).await;
            if let Some(w) = watchdog {
                w.abort();
            }
            for note in conn.take_notices() {
                sink.notice(note);
            }

            match res {
                Ok(done) => {
                    if savepoint {
                        let undo = if done.cut { "ROLLBACK TO SAVEPOINT rookery_stmt" } else { "RELEASE SAVEPOINT rookery_stmt" };
                        let _ = conn.tx(undo).await;
                    }
                    let mut changed = true;
                    let mut ended_tx = false;
                    {
                        let mut st = sess.st.lock();
                        match info.kind {
                            Kind::Begin => {
                                st.tx_open = true;
                                st.tx_rows = 0;
                            }
                            Kind::Commit | Kind::Rollback => {
                                st.tx_open = false;
                                st.tx_rows = 0;
                                ended_tx = true;
                            }
                            Kind::Write if st.tx_open => st.tx_rows += done.affected.unwrap_or(0),
                            // MySQL commits DDL at once.
                            Kind::Ddl if engine == DbEngine::Mysql && st.tx_open => {
                                st.tx_open = false;
                                st.tx_rows = 0;
                                ended_tx = true;
                            }
                            _ => changed = false,
                        }
                    }
                    if info.kind == Kind::Use {
                        let db = conn.database().await.ok().flatten();
                        sess.params.lock().database = db.clone();
                        sess.st.lock().database = db;
                        changed = true;
                    }
                    if ended_tx {
                        self.after_tx_end(sess, conn).await;
                    }
                    if changed {
                        self.emit(sess, "connected", None);
                    }
                }
                Err(e) => {
                    let pos = e.position.map(|p| lex::char_index(sql, stmt.start) as u32 + p.saturating_sub(1));
                    let message = if ctl.cancelled.load(Ordering::SeqCst) { format!("Cancelled. {}", e.message) } else { e.message };
                    sink.error(message, pos);
                    if e.fatal {
                        *guard = None;
                    } else if savepoint {
                        let _ = conn.tx("ROLLBACK TO SAVEPOINT rookery_stmt").await;
                    }
                    break;
                }
            }
        }
        drop(guard);
        sink
    }

    /// Stop a running query on the server; the rest of the script is skipped.
    pub async fn cancel(&self, query_id: &str) {
        let Some(ctl) = self.queries.lock().get(query_id).cloned() else { return };
        ctl.cancelled.store(true, Ordering::SeqCst);
        let cancel = ctl.session.cancel.lock().clone();
        if let Some(c) = cancel {
            c.cancel().await;
        }
    }

    // ------------------------------------------------------- transactions

    pub async fn tx(self: &Arc<Self>, session_id: &str, action: TxAction) -> Result<()> {
        let sess = self.session(session_id)?;
        let mut guard = sess.conn.lock().await;
        if action != TxAction::Begin && guard.is_none() {
            sess.st.lock().tx_open = false;
            return Err(Error::Other("no open transaction (the connection was reset)".into()));
        }
        let conn = self.ensure_conn(&sess, &mut guard).await?;
        let sql = match action {
            TxAction::Begin => "BEGIN",
            TxAction::Commit => "COMMIT",
            TxAction::Rollback => "ROLLBACK",
        };
        conn.tx(sql).await.map_err(|e| Error::Other(e.message))?;
        {
            let mut st = sess.st.lock();
            st.tx_open = action == TxAction::Begin;
            st.tx_rows = 0;
            st.last_used = Instant::now();
        }
        if action != TxAction::Begin {
            self.after_tx_end(&sess, conn).await;
        }
        drop(guard);
        self.emit(&sess, "connected", None);
        Ok(())
    }

    /// Writes ran out while a transaction was open: make the server read-only again now.
    async fn after_tx_end(&self, sess: &Session, conn: &mut Conn) {
        let (want, have) = {
            let st = sess.st.lock();
            (st.read_only, st.server_read_only)
        };
        if want && !have && conn.set_read_only(true).await.is_ok() {
            sess.st.lock().server_read_only = true;
        }
    }

    /// "Allow changes for N minutes" on a protected session (0 = read-only again now).
    pub async fn allow_writes(self: &Arc<Self>, session_id: &str, minutes: u32) -> Result<()> {
        self.allow_writes_for(session_id, Duration::from_secs(u64::from(minutes.min(24 * 60)) * 60)).await
    }

    /// Writes on for `dur` (zero = read-only again now). Calling it while writes are on extends them.
    pub(crate) async fn allow_writes_for(self: &Arc<Self>, session_id: &str, dur: Duration) -> Result<()> {
        let sess = self.session(session_id)?;
        if !sess.st.lock().protected {
            return Ok(()); // not a read-only connection: writes are always on
        }
        if dur.is_zero() {
            let gen = sess.st.lock().writes_gen;
            self.expire_writes(&sess, gen).await;
            return Ok(());
        }
        let (read_only, tx_open, server_ro) = {
            let st = sess.st.lock();
            (st.read_only, st.tx_open, st.server_read_only)
        };
        // Writes ran out inside a still-writable transaction: turning them back on needs no SET.
        let already = !read_only || (tx_open && !server_ro);
        if !already {
            if tx_open {
                return Err(Error::Other("finish the open transaction first (Commit or Rollback)".into()));
            }
            let mut guard = sess.conn.lock().await;
            let conn = self.ensure_conn(&sess, &mut guard).await?;
            conn.set_read_only(false).await?;
        }
        let until = now_ms() + dur.as_millis().min(i64::MAX as u128) as i64;
        let gen = {
            let mut st = sess.st.lock();
            st.read_only = false;
            st.server_read_only = false;
            st.writes_until = Some(until);
            st.writes_gen += 1;
            st.writes_gen
        };
        self.emit(&sess, "connected", None);
        let me = Arc::downgrade(self);
        let s = sess.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis((until - now_ms()).max(0) as u64)).await;
            if let Some(me) = me.upgrade() {
                me.expire_writes(&s, gen).await;
            }
        });
        Ok(())
    }

    /// Back to read-only. With a transaction open, the app refuses further writes at once and
    /// the server setting follows when the transaction ends.
    async fn expire_writes(&self, sess: &Arc<Session>, gen: u64) {
        let tx_open = {
            let mut st = sess.st.lock();
            if st.writes_gen != gen || st.read_only {
                return;
            }
            st.read_only = true;
            st.writes_until = None;
            st.tx_open
        };
        if !tx_open {
            let mut guard = sess.conn.lock().await;
            if let Some(conn) = guard.as_mut() {
                if conn.set_read_only(true).await.is_ok() {
                    sess.st.lock().server_read_only = true;
                }
            }
        }
        if !sess.closed.load(Ordering::SeqCst) {
            self.emit(sess, "connected", Some("Changes are off again (read-only)".into()));
        }
    }

    // ------------------------------------------------------------- schema

    pub async fn schema(self: &Arc<Self>, session_id: &str, system: bool) -> Result<SchemaTree> {
        let sess = self.session(session_id)?;
        sess.columns.lock().clear();
        let mut guard = sess.conn.lock().await;
        let conn = self.ensure_conn(&sess, &mut guard).await?;
        let tree = conn.schema(system).await?;
        sess.st.lock().last_used = Instant::now();
        Ok(tree)
    }

    /// Switch the session to another database (Postgres reconnects).
    pub async fn use_database(self: &Arc<Self>, session_id: &str, database: String) -> Result<()> {
        let sess = self.session(session_id)?;
        if sess.st.lock().tx_open {
            return Err(Error::Other("commit or roll back the open transaction first".into()));
        }
        let mut guard = sess.conn.lock().await;
        sess.params.lock().database = Some(database.clone());
        sess.columns.lock().clear();
        sess.conn_gen.fetch_add(1, Ordering::SeqCst);
        *guard = None; // the next connect uses the new database
        self.ensure_conn(&sess, &mut guard).await?;
        sess.st.lock().database = Some(database);
        drop(guard);
        self.emit(&sess, "connected", None);
        Ok(())
    }
}

// ------------------------------------------------------------ table browser

impl SqlManager {
    /// Structure tab: columns, indexes, foreign keys (both ways), CREATE code, size.
    pub async fn table_detail(self: &Arc<Self>, session_id: &str, schema: &str, table: &str) -> Result<TableDetail> {
        let sess = self.session(session_id)?;
        let mut guard = sess.conn.lock().await;
        let conn = self.ensure_conn(&sess, &mut guard).await?;
        let detail = conn.table_detail(schema, table).await?;
        sess.columns.lock().insert(format!("{schema}.{table}"), Arc::new(detail.columns.clone()));
        sess.st.lock().last_used = Instant::now();
        Ok(detail)
    }

    async fn table_columns(self: &Arc<Self>, sess: &Arc<Session>, schema: &str, table: &str) -> Result<Arc<Vec<ColumnDetail>>> {
        let key = format!("{schema}.{table}");
        if let Some(c) = sess.columns.lock().get(&key) {
            return Ok(c.clone());
        }
        let cols = {
            let mut guard = sess.conn.lock().await;
            let conn = self.ensure_conn(sess, &mut guard).await?;
            Arc::new(conn.columns(schema, table).await?)
        };
        if cols.is_empty() {
            return Err(Error::NotFound(format!("table {schema}.{table}")));
        }
        sess.columns.lock().insert(key, cols.clone());
        Ok(cols)
    }

    /// Data tab: one page of rows. The SQL is built here from the catalog's column names and
    /// quoted values, then runs like any other read (results arrive as `SqlResult` events).
    pub async fn table_rows(self: &Arc<Self>, session_id: &str, q: TableQuery) -> Result<TableRowsStarted> {
        let sess = self.session(session_id)?;
        let engine = sess.params.lock().engine;
        let cols = self.table_columns(&sess, &q.schema, &q.table).await?;
        let meta: Vec<ColMeta> = cols.iter().map(|c| ColMeta { name: &c.name, data_type: &c.data_type }).collect();
        let sql = table::select_sql(engine, &q, &meta)?;
        let limit = q.limit.clamp(1, table::MAX_PAGE);
        let query_id = self.start(session_id, sql.clone(), SqlRunOpts { row_limit: Some(limit) }, false)?;
        Ok(TableRowsStarted { query_id, sql })
    }

    /// Exact row count with the same filters (on demand: it can be slow on big tables).
    pub async fn table_count(self: &Arc<Self>, session_id: &str, q: TableQuery) -> Result<u64> {
        let sess = self.session(session_id)?;
        let engine = sess.params.lock().engine;
        let cols = self.table_columns(&sess, &q.schema, &q.table).await?;
        let meta: Vec<ColMeta> = cols.iter().map(|c| ColMeta { name: &c.name, data_type: &c.data_type }).collect();
        let sql = table::count_sql(engine, &q, &meta)?;
        if sess.st.lock().running {
            return Err(Error::Other("a query is running in this tab; wait or cancel it".into()));
        }
        let mut guard = sess.conn.lock().await;
        let conn = self.ensure_conn(&sess, &mut guard).await?;
        let n = conn.scalar(&sql).await?;
        sess.st.lock().last_used = Instant::now();
        Ok(n.and_then(|v| v.parse().ok()).unwrap_or(0))
    }
}

/// History key of a target: the saved connection's id, `host:<host_id>:<engine>:<port>` for a
/// server's Database view, `url:<url>` (password removed) for quick connect.
pub fn conn_key(target: &SqlTarget) -> String {
    match target {
        SqlTarget::Saved { id } => id.clone(),
        SqlTarget::Server { host_id, engine, port, .. } => {
            let port = if *port == 0 { default_port(*engine) } else { *port };
            format!("host:{host_id}:{}:{port}", engine.as_str())
        }
        SqlTarget::Url { url, .. } => {
            let clean = match url::Url::parse(url.trim()) {
                Ok(mut u) => {
                    let _ = u.set_password(None);
                    u.to_string()
                }
                Err(_) => url.trim().to_string(),
            };
            format!("url:{clean}")
        }
    }
}

/// False for text that may carry a password (it is then not kept in the history).
pub fn history_safe(sql: &str) -> bool {
    let l = sql.to_ascii_lowercase();
    !(l.contains("password") || l.contains("identified") || l.contains("passwd"))
}

impl ConnParams {
    fn row_limit_override(&self, o: Option<u32>) -> u32 {
        o.unwrap_or(self.row_limit).clamp(1, 100_000)
    }
}

// ------------------------------------------------------------------ helpers

fn params_of(c: &DbConnection, password: Option<Zeroizing<String>>) -> ConnParams {
    ConnParams {
        engine: c.engine,
        host: c.address.clone(),
        port: c.port,
        user: c.username.clone(),
        password,
        database: c.database.clone(),
        ssl_mode: c.ssl_mode,
        ca_path: c.ca_path.clone(),
        timeout_s: c.timeout_s,
        row_limit: c.row_limit,
        read_only: c.opens_read_only(),
    }
}

pub struct ParsedUrl {
    pub params: ConnParams,
    /// `ssh+mysql://<server>/db`: the saved server's name.
    pub via_server: Option<String>,
}

pub fn default_port(engine: DbEngine) -> u16 {
    match engine {
        DbEngine::Postgres => 5432,
        DbEngine::Mysql => 3306,
    }
}

fn is_local(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// `postgres://user:pw@host:5432/db?sslmode=require`, `mysql://root@localhost/shop`,
/// `mariadb://…`, `ssh+mysql://prod-api-01/shop` (through the saved server "prod-api-01").
pub fn parse_url(url: &str) -> Result<ParsedUrl> {
    let u = url::Url::parse(url.trim()).map_err(|_| Error::Other("not a database URL (postgres://user@host/db)".into()))?;
    let (via_ssh, scheme) = match u.scheme().strip_prefix("ssh+") {
        Some(rest) => (true, rest),
        None => (false, u.scheme()),
    };
    let engine = match scheme {
        "postgres" | "postgresql" => DbEngine::Postgres,
        "mysql" | "mariadb" => DbEngine::Mysql,
        other => return Err(Error::Other(format!("unknown database type '{other}' (use postgres://, mysql:// or mariadb://)"))),
    };
    let decode = |s: &str| percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned();
    let host = u.host_str().map(|h| h.trim_matches(['[', ']']).to_string()).filter(|h| !h.is_empty());
    let host = host.ok_or_else(|| Error::Other("the URL has no host".into()))?;
    let database = u.path().trim_start_matches('/').split('/').next().map(decode).filter(|d| !d.is_empty());
    let user = match decode(u.username()) {
        u if u.is_empty() && engine == DbEngine::Mysql => "root".to_string(),
        u if u.is_empty() => "postgres".to_string(),
        u => u,
    };
    let password = u.password().map(|p| Zeroizing::new(decode(p)));
    let mut ssl_mode = if via_ssh || is_local(&host) { SslMode::Disable } else { SslMode::Prefer };
    for (k, v) in u.query_pairs() {
        if k == "sslmode" || k == "ssl-mode" || k == "ssl_mode" {
            ssl_mode = match v.to_ascii_lowercase().replace('_', "-").as_str() {
                "disable" | "disabled" => SslMode::Disable,
                "prefer" | "preferred" | "allow" => SslMode::Prefer,
                "require" | "required" | "verify-ca" => SslMode::Require,
                "verify-full" | "verify-identity" => SslMode::VerifyFull,
                other => return Err(Error::Other(format!("unknown sslmode '{other}'"))),
            };
        }
    }
    let (via_server, host) = if via_ssh { (Some(host), "127.0.0.1".to_string()) } else { (None, host) };
    Ok(ParsedUrl {
        params: ConnParams {
            engine,
            host,
            port: u.port().unwrap_or(default_port(engine)),
            user,
            password,
            database,
            ssl_mode,
            ca_path: None,
            timeout_s: 30,
            row_limit: 500,
            read_only: false,
        },
        via_server,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_database_urls() {
        let p = parse_url("postgres://app:s%40cret@db.example.com:6543/shop?sslmode=verify-full").unwrap();
        assert_eq!(p.params.engine, DbEngine::Postgres);
        assert_eq!((p.params.host.as_str(), p.params.port), ("db.example.com", 6543));
        assert_eq!(p.params.user, "app");
        assert_eq!(p.params.password.as_deref().map(|s| s.as_str()), Some("s@cret"));
        assert_eq!(p.params.database.as_deref(), Some("shop"));
        assert_eq!(p.params.ssl_mode, SslMode::VerifyFull);
        assert!(p.via_server.is_none());

        let m = parse_url("mysql://localhost/shop").unwrap();
        assert_eq!((m.params.engine, m.params.port, m.params.user.as_str()), (DbEngine::Mysql, 3306, "root"));
        assert_eq!(m.params.ssl_mode, SslMode::Disable, "localhost: no TLS by default");
        assert_eq!(parse_url("mariadb://u@10.0.0.5").unwrap().params.ssl_mode, SslMode::Prefer);

        let s = parse_url("ssh+mysql://prod-api-01/shop").unwrap();
        assert_eq!(s.via_server.as_deref(), Some("prod-api-01"));
        assert_eq!(s.params.host, "127.0.0.1");
        assert_eq!(s.params.ssl_mode, SslMode::Disable);

        assert!(parse_url("redis://localhost").is_err());
        assert!(parse_url("prod-api-01").is_err());
    }

    #[tokio::test]
    async fn env_passwords_stay_in_memory_until_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path()).unwrap();
        let r = core.sql.stash_password(Zeroizing::new("pw".into()));
        assert_eq!(core.sql.stashed_password(&r).unwrap().as_str(), "pw");
        assert_eq!(core.sql.stashed_password(&r).unwrap().as_str(), "pw", "Test, then Save");
        assert!(core.sql.stashed_password("nope").is_err());
        core.sql.close_all().await;
        assert!(core.sql.stashed_password(&r).is_err(), "locking forgets it");
    }

    #[test]
    fn history_keys_and_password_filter() {
        assert_eq!(conn_key(&SqlTarget::Saved { id: "abc".into() }), "abc");
        let server = SqlTarget::Server {
            host_id: "h1".into(),
            engine: DbEngine::Mysql,
            address: "172.17.0.2".into(),
            port: 0,
            user: "root".into(),
            database: None,
            password: Some("pw".into()),
        };
        assert_eq!(conn_key(&server), "host:h1:mysql:3306");
        let url = conn_key(&SqlTarget::Url { url: "postgres://app:secret@db:5432/shop".into(), password: None });
        assert_eq!(url, "url:postgres://app@db:5432/shop");
        assert!(history_safe("select * from users where id = 1"));
        assert!(!history_safe("ALTER USER app WITH PASSWORD 'x'"));
        assert!(!history_safe("create user 'a'@'%' identified by 'x'"));
    }

    #[tokio::test]
    async fn refused_connection_fails_cleanly() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path()).unwrap();
        // port 1 on localhost: nothing listens there
        let err = core.sql.open(SqlTarget::Url { url: "postgres://u@127.0.0.1:1/db".into(), password: None }).await.unwrap_err();
        assert!(err.to_string().contains("connect"), "{err}");
        assert!(core.sql.sessions.lock().is_empty());
    }

    /// Events of one run, until `finished`.
    async fn run_and_collect(core: &crate::Core, rx: &mut broadcast::Receiver<CoreEvent>, sid: &str, sql: &str, limit: Option<u32>) -> Vec<CoreEvent> {
        let qid = core.sql.run(sid, sql.into(), SqlRunOpts { row_limit: limit }).unwrap();
        let mut out = Vec::new();
        loop {
            let ev = tokio::time::timeout(Duration::from_secs(20), rx.recv()).await.expect("no result in time").unwrap();
            if let CoreEvent::SqlResult { query_id, finished, .. } = &ev {
                if *query_id == qid {
                    let end = *finished;
                    out.push(ev);
                    if end {
                        return out;
                    }
                }
            }
        }
    }

    /// Run on the session's connection directly, without the app's read-only check.
    async fn raw_exec(core: &crate::Core, sid: &str, sql: &str) -> std::result::Result<(), String> {
        let s = core.sql.session(sid).unwrap();
        let mut g = s.conn.lock().await;
        let (tx, _rx) = broadcast::channel(16);
        let mut sink = Sink::new(tx, "raw".into(), 10);
        g.as_mut().unwrap().exec(sql, false, &mut sink).await.map(|_| ()).map_err(|e| e.message)
    }

    fn rows(ev: &[CoreEvent]) -> usize {
        ev.iter().map(|e| if let CoreEvent::SqlResult { rows, .. } = e { rows.len() } else { 0 }).sum()
    }

    fn first_error(ev: &[CoreEvent]) -> Option<String> {
        ev.iter().find_map(|e| if let CoreEvent::SqlResult { error, .. } = e { error.clone() } else { None })
    }

    /// Against real servers (any of the three):
    /// `ROOKERY_TEST_PG_URL=postgres://postgres:pw@localhost/postgres`
    /// `ROOKERY_TEST_MYSQL_URL=mysql://root:pw@localhost/shop`, `ROOKERY_TEST_MARIADB_URL=mariadb://root:pw@localhost/shop`
    /// then `cargo test -p rookery-core -- --ignored`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn real_servers_end_to_end() {
        let mut ran = 0;
        for var in ["ROOKERY_TEST_PG_URL", "ROOKERY_TEST_MYSQL_URL", "ROOKERY_TEST_MARIADB_URL"] {
            if let Ok(url) = std::env::var(var) {
                eprintln!("{var}…");
                end_to_end(&url).await;
                ran += 1;
            }
        }
        if ran == 0 {
            eprintln!("no ROOKERY_TEST_*_URL set; skipped");
        }
    }

    async fn end_to_end(url: &str) {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path()).unwrap();
        core.vault.lock().create("master password").unwrap();
        let mut rx = core.subscribe_events();
        let p = parse_url(url).unwrap().params;
        let pg = p.engine == DbEngine::Postgres;
        let conn = core
            .db
            .save_db_connection(DbConnection {
                id: String::new(),
                name: "prod".into(),
                engine: p.engine,
                via: DbVia::Direct,
                host_id: None,
                address: p.host.clone(),
                port: p.port,
                username: p.user.clone(),
                database: p.database.clone(),
                ssl_mode: p.ssl_mode,
                ca_path: None,
                env_label: crate::model::EnvLabel::Prod,
                group_id: None,
                read_only: false,
                row_limit: 500,
                timeout_s: 30,
                sort: 0,
                created_at: 0,
                updated_at: 0,
                has_password: false,
            })
            .unwrap();
        if let Some(pw) = &p.password {
            core.vault.lock().set(&conn.secret_id(), pw).unwrap();
        }
        let opened = core.sql.open(SqlTarget::Saved { id: conn.id.clone() }).await.unwrap();
        eprintln!("  {}", opened.server_version);
        assert!(opened.read_only, "PROD opens read-only");
        let sid = opened.session_id.clone();
        let ro_query = if pg { "show transaction_read_only" } else { "select @@transaction_read_only" };
        let ro_on = if pg { "on" } else { "1" };
        let first_cell = |ev: &[CoreEvent]| {
            ev.iter().find_map(|e| match e {
                CoreEvent::SqlResult { rows, .. } => rows.first().and_then(|r| r[0].clone()),
                _ => None,
            })
        };

        // rows stream, stop at the cap (the rest is cancelled on the server), the session still works
        let many = if pg { "select g from generate_series(1, 1000000) g" } else { "select 1 from information_schema.COLUMNS a, information_schema.COLUMNS b" };
        let started = Instant::now();
        let ev = run_and_collect(&core, &mut rx, &sid, many, Some(1000)).await;
        assert_eq!(rows(&ev), 1000);
        assert!(ev.iter().any(|e| matches!(e, CoreEvent::SqlResult { truncated: true, .. })));
        assert!(started.elapsed() < Duration::from_secs(10));

        // the server itself is read-only, and the app refuses writes / switching it off
        let ev = run_and_collect(&core, &mut rx, &sid, ro_query, None).await;
        assert_eq!(first_cell(&ev).as_deref(), Some(ro_on));
        // past the app's own check, the server refuses the write by itself
        let err = raw_exec(&core, &sid, "create table rookery_server_check (a int)").await.unwrap_err().to_lowercase();
        assert!(err.contains("read-only") || err.contains("read only"), "{err}");
        let ev = run_and_collect(&core, &mut rx, &sid, "create temporary table t (a int)", None).await;
        assert!(first_error(&ev).unwrap().contains("Read-only"));
        let off = if pg { "set default_transaction_read_only = off" } else { "SET SESSION TRANSACTION READ WRITE" };
        let ev = run_and_collect(&core, &mut rx, &sid, off, None).await;
        assert!(first_error(&ev).unwrap().contains("read-only"));

        // allow changes: writes go into a transaction; rollback undoes them
        core.sql.allow_writes(&sid, 15).await.unwrap();
        let values: Vec<String> = (1..=37).map(|i| format!("({i})")).collect();
        let script = format!("create temporary table t (a int); insert into t values {}", values.join(","));
        let ev = run_and_collect(&core, &mut rx, &sid, &script, None).await;
        assert_eq!(first_error(&ev), None);
        {
            let s = core.sql.session(&sid).unwrap();
            let st = s.st.lock();
            assert!(st.tx_open);
            assert_eq!(st.tx_rows, 37);
        }
        // an error inside the transaction does not lose it
        let ev = run_and_collect(&core, &mut rx, &sid, "select * from no_such_table", None).await;
        assert!(first_error(&ev).is_some());
        if pg {
            assert!(matches!(ev.iter().find_map(|e| if let CoreEvent::SqlResult { error_pos, .. } = e { *error_pos } else { None }), Some(14)));
        }
        let ev = run_and_collect(&core, &mut rx, &sid, "select count(*) from t", None).await;
        assert_eq!(first_cell(&ev).as_deref(), Some("37"));
        core.sql.tx(&sid, TxAction::Rollback).await.unwrap();
        let ev = run_and_collect(&core, &mut rx, &sid, "select count(*) from t", None).await;
        if pg {
            assert!(first_error(&ev).is_some(), "the table was created in the rolled-back transaction");
        }
        // writes off again
        core.sql.allow_writes(&sid, 0).await.unwrap();
        let ev = run_and_collect(&core, &mut rx, &sid, ro_query, None).await;
        assert_eq!(first_cell(&ev).as_deref(), Some(ro_on));

        // "Allow changes" runs out by itself, also in the middle of a transaction:
        // further writes are refused at once, the server follows when the transaction ends
        core.sql.allow_writes_for(&sid, Duration::from_millis(1500)).await.unwrap();
        let ev = run_and_collect(&core, &mut rx, &sid, "create temporary table t2 (a int); insert into t2 values (1)", None).await;
        assert_eq!(first_error(&ev), None);
        assert!(core.sql.session(&sid).unwrap().st.lock().tx_open);
        tokio::time::sleep(Duration::from_millis(2000)).await;
        assert!(core.sql.session(&sid).unwrap().st.lock().read_only, "expired");
        let ev = run_and_collect(&core, &mut rx, &sid, "insert into t2 values (2)", None).await;
        assert!(first_error(&ev).unwrap().contains("Read-only"));
        core.sql.tx(&sid, TxAction::Rollback).await.unwrap();
        let ev = run_and_collect(&core, &mut rx, &sid, ro_query, None).await;
        assert_eq!(first_cell(&ev).as_deref(), Some(ro_on), "server read-only again after the transaction");

        // cancel really stops the query on the server
        let sleep = if pg { "select pg_sleep(60)" } else { "select sleep(60)" };
        let qid = core.sql.run(&sid, sleep.into(), SqlRunOpts::default()).unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let started = Instant::now();
        core.sql.cancel(&qid).await;
        loop {
            if let CoreEvent::SqlResult { query_id, finished: true, .. } = rx.recv().await.unwrap() {
                if query_id == qid {
                    break;
                }
            }
        }
        assert!(started.elapsed() < Duration::from_secs(5), "cancel took {:?}", started.elapsed());

        // the timeout stops a long statement (server setting, client watchdog as backup)
        let mut quick = core.db.get_db_connection(&conn.id).unwrap();
        quick.id = String::new();
        quick.timeout_s = 1;
        quick.env_label = crate::model::EnvLabel::Dev;
        let quick = core.db.save_db_connection(quick).unwrap();
        if let Some(pw) = &p.password {
            core.vault.lock().set(&quick.secret_id(), pw).unwrap();
        }
        let q = core.sql.open(SqlTarget::Saved { id: quick.id.clone() }).await.unwrap();
        assert!(!q.read_only);
        let started = Instant::now();
        let slow = if pg { "select pg_sleep(8)" } else { "select sleep(8)" };
        run_and_collect(&core, &mut rx, &q.session_id, slow, None).await;
        assert!(started.elapsed() < Duration::from_secs(5), "timeout took {:?}", started.elapsed());

        // schema tree
        let tree = core.sql.schema(&sid, false).await.unwrap();
        assert!(tree.database.is_some());
        assert!(tree.databases.contains(tree.database.as_ref().unwrap()));
        if !pg {
            assert!(!tree.databases.iter().any(|d| d == "mysql"), "system databases hidden");
        }

        // every run went into this connection's history (text only), newest first
        let hist = core.db.list_sql_history(&opened.conn_key, 200).unwrap();
        assert_eq!(opened.conn_key, conn.id);
        assert!(hist.len() >= 10, "{}", hist.len());
        assert!(hist.iter().any(|h| h.sql == "select * from no_such_table" && !h.ok));
        assert!(hist.iter().any(|h| h.sql == "select count(*) from t" && h.ok && h.rows == Some(1)));

        core.lock(false).await;
        assert!(core.sql.sessions.lock().is_empty(), "locking closes SQL sessions");
    }

    /// Through an SSH server: \`ROOKERY_TEST_SSH=user:pw@127.0.0.1:2222\` and
    /// \`ROOKERY_TEST_SSH_DB=postgres://postgres:pw@<db host as seen from the server>:5432/postgres\`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn through_a_server_end_to_end() {
        let (Ok(ssh), Ok(db_url)) = (std::env::var("ROOKERY_TEST_SSH"), std::env::var("ROOKERY_TEST_SSH_DB")) else {
            eprintln!("ROOKERY_TEST_SSH / ROOKERY_TEST_SSH_DB not set; skipped");
            return;
        };
        let (cred, addr) = ssh.rsplit_once('@').unwrap();
        let (user, pw) = cred.split_once(':').unwrap();
        let (h, port) = addr.rsplit_once(':').unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path()).unwrap();
        core.vault.lock().create("master password").unwrap();
        let ident = core
            .db
            .save_identity(crate::model::Identity {
                id: String::new(),
                name: user.into(),
                username: user.into(),
                auth: crate::model::AuthKind::Password,
                key_path: None,
                has_password: false,
                has_key: false,
                has_passphrase: false,
                has_sudo: false,
                updated_at: 0,
            })
            .unwrap();
        core.vault.lock().set(&ident.secret_id("password"), pw).unwrap();
        let host = core
            .db
            .save_host(crate::model::Host {
                id: String::new(),
                group_id: None,
                name: "test-server".into(),
                address: h.into(),
                port: port.parse().unwrap(),
                env_label: EnvLabel::Prod,
                tags: vec![],
                identity_id: Some(ident.id.clone()),
                jump_host_id: None,
                theme: None,
                start_view: Default::default(),
                start_folder: None,
                auto_reconnect: true,
                keepalive_s: 30,
                log_session: false,
                refresh: Default::default(),
                sort: 0,
                created_at: 0,
                updated_at: 0,
            })
            .unwrap();
        // first contact: trust the host key like the UI does
        match core.connections.acquire(&host.id).await {
            Err(Error::UnknownHostKey { fingerprint, .. }) => core.connections.trust_pending_key(&host.id, &fingerprint).unwrap(),
            Err(e) => panic!("{e}"),
            Ok(_) => {}
        }

        let p = parse_url(&db_url).unwrap().params;
        let mut rx = core.subscribe_events();
        let opened = core
            .sql
            .open(SqlTarget::Server {
                host_id: host.id.clone(),
                engine: p.engine,
                address: p.host.clone(),
                port: p.port,
                user: p.user.clone(),
                database: p.database.clone(),
                password: p.password.as_ref().map(|s| s.to_string()),
            })
            .await
            .unwrap();
        assert!(opened.read_only, "a PROD server opens its databases read-only");
        assert!(core.connections.info(&host.id).leases >= 1, "the session holds a lease");
        let ev = run_and_collect(&core, &mut rx, &opened.session_id, "select 40 + 2", None).await;
        assert_eq!(first_error(&ev), None);
        assert_eq!(rows(&ev), 1);
        // cancel goes through the same forward
        let qid = core.sql.run(&opened.session_id, "select pg_sleep(60)".into(), SqlRunOpts::default()).unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let started = Instant::now();
        core.sql.cancel(&qid).await;
        loop {
            if let CoreEvent::SqlResult { query_id, finished: true, .. } = rx.recv().await.unwrap() {
                if query_id == qid {
                    break;
                }
            }
        }
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!core.sql.schema(&opened.session_id, false).await.unwrap().databases.is_empty());

        // a saved connection through the server (Test connection, then open)
        let saved = core
            .db
            .save_db_connection(DbConnection {
                id: String::new(),
                name: "via ssh".into(),
                engine: p.engine,
                via: DbVia::Ssh,
                host_id: Some(host.id.clone()),
                address: p.host.clone(),
                port: p.port,
                username: p.user.clone(),
                database: p.database.clone(),
                ssl_mode: SslMode::Disable,
                ca_path: None,
                env_label: EnvLabel::Dev,
                group_id: None,
                read_only: false,
                row_limit: 500,
                timeout_s: 30,
                sort: 0,
                created_at: 0,
                updated_at: 0,
                has_password: false,
            })
            .unwrap();
        if let Some(pw) = &p.password {
            core.vault.lock().set(&saved.secret_id(), pw).unwrap();
        }
        assert!(core.sql.test(&saved, None).await.unwrap().server_version.starts_with("PostgreSQL"));
        let o2 = core.sql.open(SqlTarget::Saved { id: saved.id.clone() }).await.unwrap();
        assert!(!o2.read_only);

        // closing every session releases the leases
        core.sql.close(&opened.session_id).await;
        core.sql.close(&o2.session_id).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(core.connections.info(&host.id).leases, 0);
    }
}
