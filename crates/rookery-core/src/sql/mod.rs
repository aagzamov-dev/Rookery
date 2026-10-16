//! SQL connections (docs/07-SQL-CONNECTIONS.md): look at a database and fix a problem quickly.
//!
//! Named `sql`, not `db`: `db.rs` is Rookery's own SQLite store.
//!
//! - [`SqlManager`] keeps one session per open database tab / view. A session owns one
//!   connection for queries; nothing connects until a tab is opened, nothing polls.
//! - Results stream to the UI as [`crate::CoreEvent::SqlResult`] chunks of ≤ 500 rows.
//!   Values are text (`None` = NULL): display only, no typed decoding.
//! - Read-only is enforced by the server (session setting) and by [`lex::read_only_guard`].

pub mod detect;
pub mod lex;
mod manager;
mod mysql;
mod pg;
mod schema;
pub mod table;
mod tls;

use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::model::DbEngine;
use crate::CoreEvent;

pub use manager::{conn_key, default_port, SqlManager};

/// Everything a driver needs to connect. The password only lives in memory.
#[derive(Clone)]
pub struct ConnParams {
    pub engine: DbEngine,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<zeroize::Zeroizing<String>>,
    pub database: Option<String>,
    pub ssl_mode: crate::model::SslMode,
    pub ca_path: Option<String>,
    pub timeout_s: u32,
    pub row_limit: u32,
    pub read_only: bool,
}

/// Rows per `SqlResult` event.
pub const CHUNK_ROWS: usize = 500;
/// Idle sessions close after this long (never while a transaction is open).
pub const IDLE_CLOSE: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// What to open (`sql_open`). Passwords given here are kept in memory for the session only.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SqlTarget {
    /// A saved connection; the password comes from the vault.
    Saved { id: String },
    /// "This server's" Database view: through the server's SSH session.
    Server {
        host_id: String,
        engine: DbEngine,
        /// Database host as seen from the server (default 127.0.0.1).
        address: String,
        port: u16,
        user: String,
        database: Option<String>,
        password: Option<String>,
    },
    /// Quick connect: `postgres://user@host:5432/db`, `mysql://…`, `ssh+mysql://<server>/db`.
    Url { url: String, password: Option<String> },
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SqlOpened {
    pub session_id: String,
    pub engine: DbEngine,
    /// "PostgreSQL 16.2", "MySQL 8.0.36", "MariaDB 11.4.2".
    pub server_version: String,
    pub read_only: bool,
    pub database: Option<String>,
    /// Key of this connection's query history (`sql_history`).
    pub conn_key: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SqlTestResult {
    pub server_version: String,
    pub latency_ms: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SqlRunOpts {
    /// Overrides the connection's row limit ("Load 500 more").
    pub row_limit: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum TxAction {
    Begin,
    Commit,
    Rollback,
}

// ------------------------------------------------------------------ schema

#[derive(Debug, Clone, Default, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SchemaTree {
    /// The database this session is in.
    pub database: Option<String>,
    /// All databases on the server (system ones only when asked).
    pub databases: Vec<String>,
    /// Postgres schemas of the current database; MySQL: one entry named after the database.
    pub schemas: Vec<SchemaInfo>,
}

#[derive(Debug, Clone, Default, Serialize, TS, PartialEq)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SchemaInfo {
    pub name: String,
    pub tables: Vec<TableInfo>,
}

#[derive(Debug, Clone, Default, Serialize, TS, PartialEq)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct TableInfo {
    pub name: String,
    /// table | view | matview | partitioned | foreign
    pub kind: String,
    /// Estimate from the statistics (may be stale or missing).
    #[ts(type = "number | null")]
    pub rows_est: Option<i64>,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
}

#[derive(Debug, Clone, Default, Serialize, TS, PartialEq)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    /// PRI (primary key) | UNI (single-column unique) | MUL (first column of an index).
    pub key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, TS, PartialEq)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

// ------------------------------------------------------------------ results

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ResultColumn {
    pub name: String,
    /// Type name when the driver knows it ("" otherwise); used for alignment only.
    pub type_name: String,
    /// Numeric column: the grid right-aligns it.
    pub numeric: bool,
}

/// An error from one statement. `position` = 1-based char in the statement (Postgres).
#[derive(Debug, Clone)]
pub struct StmtError {
    pub message: String,
    pub position: Option<u32>,
    /// The connection itself is gone (not just this statement).
    pub fatal: bool,
}

/// Exec outcome: rows affected by the last command; `cut` = stopped (and cancelled) at the row cap.
pub struct Done {
    pub affected: Option<u64>,
    pub cut: bool,
}

/// Collects rows of the running statement and sends them to the UI in chunks.
pub struct Sink {
    events: broadcast::Sender<CoreEvent>,
    query_id: String,
    /// Result-set number inside this run (one per statement, more for MySQL CALL).
    next_index: u32,
    stmt: u32,
    stmt_started: Instant,
    cur: Option<OpenSet>,
    row_cap: u32,
    /// For the history: any statement failed; rows of the last finished statement.
    pub(crate) failed: bool,
    pub(crate) last_rows: Option<u64>,
}

struct OpenSet {
    index: u32,
    columns: Option<Vec<ResultColumn>>,
    rows: Vec<Vec<Option<String>>>,
    count: u32,
    truncated: bool,
    last_flush: Instant,
}

impl Sink {
    pub fn new(events: broadcast::Sender<CoreEvent>, query_id: String, row_cap: u32) -> Self {
        Self { events, query_id, next_index: 0, stmt: 0, stmt_started: Instant::now(), cur: None, row_cap: row_cap.max(1), failed: false, last_rows: None }
    }

    pub fn start_statement(&mut self, stmt: u32) {
        self.stmt = stmt;
        self.stmt_started = Instant::now();
    }

    fn open(&mut self) -> &mut OpenSet {
        if self.cur.is_none() {
            let index = self.next_index;
            self.next_index += 1;
            self.cur = Some(OpenSet { index, columns: None, rows: Vec::new(), count: 0, truncated: false, last_flush: Instant::now() });
        }
        self.cur.as_mut().unwrap()
    }

    /// A new result set starts (column names known).
    pub fn columns(&mut self, cols: Vec<ResultColumn>) {
        if self.cur.as_ref().is_some_and(|c| c.columns.is_some() || c.count > 0) {
            self.end_set(None);
        }
        self.open().columns = Some(cols);
    }

    /// Add a row. Returns false once the row cap is reached (the row is dropped).
    pub fn row(&mut self, values: Vec<Option<String>>) -> bool {
        let cap = self.row_cap;
        let set = self.open();
        if set.count >= cap {
            set.truncated = true;
            return false;
        }
        set.rows.push(values);
        set.count += 1;
        if set.rows.len() >= CHUNK_ROWS || set.last_flush.elapsed().as_millis() > 250 {
            self.flush(false, None);
        }
        true
    }

    pub fn is_truncated(&self) -> bool {
        self.cur.as_ref().is_some_and(|c| c.truncated)
    }

    fn flush(&mut self, done: bool, affected: Option<u64>) {
        let elapsed_ms = done.then(|| self.stmt_started.elapsed().as_millis().min(u32::MAX as u128) as u32);
        let stmt = self.stmt;
        let Some(set) = self.cur.as_mut() else { return };
        if done {
            self.last_rows = Some(if set.columns.is_some() || set.count > 0 { u64::from(set.count) } else { affected.unwrap_or(0) });
        }
        let ev = CoreEvent::SqlResult {
            query_id: self.query_id.clone(),
            index: set.index,
            stmt,
            columns: set.columns.take(),
            rows: std::mem::take(&mut set.rows),
            done,
            affected,
            elapsed_ms,
            truncated: set.truncated,
            error: None,
            error_pos: None,
            notice: None,
            finished: false,
        };
        set.last_flush = Instant::now();
        let _ = self.events.send(ev);
    }

    /// The current result set (or statement without rows) is complete.
    pub fn end_set(&mut self, affected: Option<u64>) {
        self.open();
        self.flush(true, affected);
        self.cur = None;
    }

    /// Close a set left open (e.g. the stream ended without a completion message).
    pub fn end_open(&mut self) {
        if self.cur.is_some() {
            self.end_set(None);
        }
    }

    pub fn error(&mut self, message: String, error_pos: Option<u32>) {
        self.failed = true;
        let index = self.cur.take().map(|c| c.index).unwrap_or_else(|| {
            self.next_index += 1;
            self.next_index - 1
        });
        let _ = self.events.send(CoreEvent::SqlResult {
            query_id: self.query_id.clone(),
            index,
            stmt: self.stmt,
            columns: None,
            rows: vec![],
            done: true,
            affected: None,
            elapsed_ms: Some(self.stmt_started.elapsed().as_millis().min(u32::MAX as u128) as u32),
            truncated: false,
            error: Some(message),
            error_pos,
            notice: None,
            finished: false,
        });
    }

    pub fn notice(&self, text: String) {
        let _ = self.events.send(CoreEvent::SqlResult {
            query_id: self.query_id.clone(),
            index: self.next_index,
            stmt: self.stmt,
            columns: None,
            rows: vec![],
            done: false,
            affected: None,
            elapsed_ms: None,
            truncated: false,
            error: None,
            error_pos: None,
            notice: Some(text),
            finished: false,
        });
    }

    pub fn finished(&mut self) {
        self.end_open();
        let _ = self.events.send(CoreEvent::SqlResult {
            query_id: self.query_id.clone(),
            index: self.next_index,
            stmt: self.stmt,
            columns: None,
            rows: vec![],
            done: true,
            affected: None,
            elapsed_ms: None,
            truncated: false,
            error: None,
            error_pos: None,
            notice: None,
            finished: true,
        });
    }
}

/// Postgres / MySQL type names that hold numbers.
pub fn is_numeric_type(t: &str) -> bool {
    let t = t.to_ascii_lowercase();
    ["int", "numeric", "decimal", "float", "double", "real", "money", "serial", "bit"]
        .iter()
        .any(|k| t.contains(k))
        && !t.contains("interval")
        && !t.contains("point")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(rx: &mut broadcast::Receiver<CoreEvent>) -> Vec<CoreEvent> {
        let mut v = Vec::new();
        while let Ok(e) = rx.try_recv() {
            v.push(e);
        }
        v
    }

    #[test]
    fn rows_are_sent_in_chunks_with_columns_first() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut sink = Sink::new(tx, "q1".into(), 10_000);
        sink.start_statement(0);
        sink.columns(vec![ResultColumn { name: "id".into(), type_name: "int4".into(), numeric: true }]);
        for i in 0..1200 {
            assert!(sink.row(vec![Some(i.to_string())]));
        }
        sink.end_set(Some(1200));
        sink.finished();
        let ev = collect(&mut rx);
        let chunks: Vec<(usize, bool, bool)> = ev
            .iter()
            .filter_map(|e| match e {
                CoreEvent::SqlResult { rows, columns, done, finished: false, .. } => Some((rows.len(), columns.is_some(), *done)),
                _ => None,
            })
            .collect();
        assert_eq!(chunks, vec![(500, true, false), (500, false, false), (200, false, true)]);
        assert!(matches!(ev.last(), Some(CoreEvent::SqlResult { finished: true, .. })));
    }

    #[test]
    fn row_cap_marks_truncated() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut sink = Sink::new(tx, "q1".into(), 3);
        sink.columns(vec![]);
        assert!(sink.row(vec![None]));
        assert!(sink.row(vec![None]));
        assert!(sink.row(vec![None]));
        assert!(!sink.row(vec![None]), "4th row is over the cap");
        assert!(sink.is_truncated());
        sink.end_set(Some(4));
        let ev = collect(&mut rx);
        match &ev[0] {
            CoreEvent::SqlResult { rows, truncated, done, affected, .. } => {
                assert_eq!(rows.len(), 3);
                assert!(*truncated && *done);
                assert_eq!(*affected, Some(4));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn statements_without_rows_and_errors_get_their_own_index() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut sink = Sink::new(tx, "q".into(), 500);
        sink.start_statement(0);
        sink.end_set(Some(37)); // UPDATE · 37 rows
        sink.start_statement(1);
        sink.error("syntax error".into(), Some(12));
        let ev = collect(&mut rx);
        let idx: Vec<(u32, u32)> = ev
            .iter()
            .map(|e| match e {
                CoreEvent::SqlResult { index, stmt, .. } => (*index, *stmt),
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(idx, vec![(0, 0), (1, 1)]);
    }

    #[test]
    fn numeric_types() {
        assert!(is_numeric_type("integer"));
        assert!(is_numeric_type("numeric(10,2)"));
        assert!(is_numeric_type("bigint unsigned"));
        assert!(!is_numeric_type("interval"));
        assert!(!is_numeric_type("character varying(255)"));
    }
}
