//! MySQL / MariaDB engine (`mysql_async`, text protocol: rows stream per result set).
//!
//! Cancel = `KILL QUERY <id>` from a second short connection. Timeout: MySQL
//! `max_execution_time` (SELECT only), MariaDB `max_statement_time`; the manager's
//! client-side watchdog covers the rest.

use std::time::Duration;

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Opts, OptsBuilder, Row, SslOpts, Value};

use super::schema::{self, TextRow, COL_SEP};
use super::{ConnParams, Done, ResultColumn, SchemaTree, Sink, StmtError};
use crate::model::SslMode;
use crate::{Error, Result};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// ER_QUERY_INTERRUPTED (KILL QUERY).
const QUERY_INTERRUPTED: u16 = 1317;

const SYSTEM_DBS: &str = "'mysql', 'sys', 'performance_schema', 'information_schema'";

pub struct MyConn {
    conn: Conn,
    pub cancel: MyCancel,
}

#[derive(Clone)]
pub struct MyCancel {
    opts: Opts,
    connection_id: u32,
}

impl MyCancel {
    pub async fn cancel(&self) -> Result<()> {
        let run = async {
            let mut c = Conn::new(self.opts.clone()).await?;
            c.query_drop(format!("KILL QUERY {}", self.connection_id)).await?;
            c.disconnect().await
        };
        tokio::time::timeout(CONNECT_TIMEOUT, run)
            .await
            .map_err(|_| Error::Other("cancel: timed out".into()))?
            .map_err(|e| Error::Other(format!("cancel: {e}")))
    }
}

fn opts(p: &ConnParams, tls: Option<SslOpts>) -> Opts {
    OptsBuilder::default()
        .ip_or_hostname(p.host.clone())
        .tcp_port(p.port)
        .user(Some(p.user.clone()))
        .pass(p.password.as_ref().map(|s| s.to_string()))
        .db_name(p.database.clone().filter(|d| !d.is_empty()))
        .prefer_socket(false)
        .stmt_cache_size(0)
        .tcp_keepalive(Some(Duration::from_secs(60)))
        .ssl_opts(tls)
        .into()
}

fn ssl_opts(p: &ConnParams) -> Option<SslOpts> {
    let verify = p.ssl_mode == SslMode::VerifyFull;
    let mut o = SslOpts::default().with_danger_accept_invalid_certs(!verify).with_danger_skip_domain_validation(!verify);
    if verify {
        if let Some(ca) = &p.ca_path {
            o = o.with_root_certs(vec![std::path::PathBuf::from(ca).into()]);
        }
    }
    (p.ssl_mode != SslMode::Disable).then_some(o)
}

async fn try_connect(o: Opts) -> std::result::Result<Conn, mysql_async::Error> {
    match tokio::time::timeout(CONNECT_TIMEOUT, Conn::new(o)).await {
        Ok(r) => r,
        Err(_) => Err(mysql_async::Error::Other("connection timed out".into())),
    }
}

/// Connect, apply the timeout and read-only settings.
pub async fn connect(p: &ConnParams) -> Result<(MyConn, String)> {
    if p.user.trim().is_empty() {
        return Err(Error::Other("enter a user name".into()));
    }
    let (conn, used) = match try_connect(opts(p, ssl_opts(p))).await {
        Ok(c) => (c, opts(p, ssl_opts(p))),
        // `prefer`: fall back to a plain connection when TLS does not work (not on a login error).
        Err(e) if p.ssl_mode == SslMode::Prefer && !matches!(e, mysql_async::Error::Server(_)) => {
            let plain = opts(p, None);
            (try_connect(plain.clone()).await.map_err(connect_err)?, plain)
        }
        Err(e) => return Err(connect_err(e)),
    };
    let cancel = MyCancel { opts: used, connection_id: conn.id() };
    let mut c = MyConn { conn, cancel };
    let raw: String = c.conn.query_first("SELECT VERSION()").await.map_err(other)?.unwrap_or_default();
    let mariadb = raw.to_ascii_lowercase().contains("mariadb");
    let number = raw.split('-').next().unwrap_or(&raw);
    let version = format!("{} {number}", if mariadb { "MariaDB" } else { "MySQL" });
    let timeout = if mariadb {
        format!("SET SESSION max_statement_time = {}", p.timeout_s.max(1))
    } else {
        format!("SET SESSION max_execution_time = {}", u64::from(p.timeout_s.max(1)) * 1000)
    };
    c.conn.query_drop(timeout).await.map_err(other)?;
    c.set_read_only(p.read_only).await?;
    Ok((c, version))
}

fn connect_err(e: mysql_async::Error) -> Error {
    match e {
        mysql_async::Error::Server(s) if s.code == 1045 => Error::Other(format!("login failed: {}", s.message)),
        mysql_async::Error::Server(s) => Error::Other(s.message),
        other => Error::Other(format!("could not connect: {other}")),
    }
}

fn other(e: mysql_async::Error) -> Error {
    Error::Other(stmt_err(e).message)
}

fn stmt_err(e: mysql_async::Error) -> StmtError {
    let fatal = e.is_fatal();
    let message = match &e {
        mysql_async::Error::Server(s) => format!("ERROR {} ({}): {}", s.code, s.state, s.message),
        _ if fatal => format!("Connection lost ({e})"),
        _ => e.to_string(),
    };
    StmtError { message, position: None, fatal }
}

fn is_interrupted(e: &mysql_async::Error) -> bool {
    matches!(e, mysql_async::Error::Server(s) if s.code == QUERY_INTERRUPTED)
}

/// Text protocol values are bytes; anything else is shown as its SQL literal.
fn text(v: Option<Value>) -> Option<String> {
    match v? {
        Value::NULL => None,
        Value::Bytes(b) => Some(match String::from_utf8(b) {
            Ok(s) => s,
            Err(e) => hex(e.as_bytes()),
        }),
        other => Some(other.as_sql(true).trim_matches('\'').to_string()),
    }
}

/// Binary data: `0x…` (first 64 bytes).
fn hex(b: &[u8]) -> String {
    let mut s: String = "0x".into();
    for x in b.iter().take(64) {
        s.push_str(&format!("{x:02X}"));
    }
    if b.len() > 64 {
        s.push('…');
    }
    s
}

/// A safely quoted string literal.
fn lit(s: &str) -> String {
    Value::from(s).as_sql(false)
}

impl MyConn {
    async fn rows(&mut self, sql: &str) -> Result<Vec<TextRow>> {
        let rows: Vec<Row> = self.conn.query(sql).await.map_err(other)?;
        Ok(rows.into_iter().map(|r| r.unwrap_raw().into_iter().map(text).collect()).collect())
    }

    pub async fn set_read_only(&mut self, on: bool) -> Result<()> {
        let sql = if on { "SET SESSION TRANSACTION READ ONLY" } else { "SET SESSION TRANSACTION READ WRITE" };
        self.conn.query_drop(sql).await.map_err(other)
    }

    pub async fn tx(&mut self, sql: &str) -> std::result::Result<(), StmtError> {
        self.conn.query_drop(sql).await.map_err(stmt_err)
    }

    pub async fn database(&mut self) -> Result<Option<String>> {
        Ok(self.rows("SELECT DATABASE()").await?.into_iter().next().and_then(|r| r.into_iter().next().flatten()))
    }

    /// Run one statement (a `CALL` may return several result sets).
    pub async fn exec(&mut self, sql: &str, cancel_at_cap: bool, sink: &mut Sink) -> std::result::Result<Done, StmtError> {
        let cancel = self.cancel.clone();
        let mut r = self.conn.query_iter(sql).await.map_err(stmt_err)?;
        let mut done = Done { affected: None, cut: false };
        loop {
            let cols = r.columns().filter(|c| !c.is_empty());
            if let Some(cols) = &cols {
                sink.columns(
                    cols.iter()
                        .map(|c| ResultColumn {
                            name: c.name_str().into_owned(),
                            type_name: format!("{:?}", c.column_type()).trim_start_matches("MYSQL_TYPE_").to_ascii_lowercase(),
                            numeric: c.column_type().is_numeric_type(),
                        })
                        .collect(),
                );
            }
            let mut capped = false;
            let mut count = 0u64;
            loop {
                match r.next().await {
                    Ok(Some(row)) => {
                        count += 1;
                        if capped {
                            continue;
                        }
                        if !sink.row(row.unwrap_raw().into_iter().map(text).collect()) {
                            capped = true;
                            if cancel_at_cap {
                                done.cut = true;
                                let _ = cancel.cancel().await;
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(e) if done.cut && is_interrupted(&e) => break,
                    Err(e) => return Err(stmt_err(e)),
                }
            }
            let affected = if cols.is_some() { count } else { r.affected_rows() };
            done.affected = Some(affected);
            sink.end_set(Some(affected));
            if done.cut || r.is_empty() {
                break;
            }
        }
        drop(r);
        Ok(done)
    }

    pub async fn schema(&mut self, system: bool) -> Result<SchemaTree> {
        let filter = if system { String::new() } else { format!("WHERE SCHEMA_NAME NOT IN ({SYSTEM_DBS})") };
        let databases = self
            .rows(&format!("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA {filter} ORDER BY 1"))
            .await?
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect();
        let Some(db) = self.database().await? else {
            return Ok(SchemaTree { database: None, databases, schemas: vec![] });
        };
        let d = lit(&db);
        let tables = self
            .rows(&format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = {d} ORDER BY TABLE_NAME"
            ))
            .await?;
        let columns = self
            .rows(&format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = {d} ORDER BY TABLE_NAME, ORDINAL_POSITION"
            ))
            .await?;
        let indexes = self
            .rows(&format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, MIN(NON_UNIQUE) = 0, INDEX_NAME = 'PRIMARY',
                        GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR '{COL_SEP}')
                 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = {d}
                 GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME ORDER BY TABLE_NAME, INDEX_NAME"
            ))
            .await?;
        let schemas = vec![vec![Some(db.clone())]];
        Ok(SchemaTree { database: Some(db), databases, schemas: schema::build(&schemas, &tables, &columns, &indexes) })
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_as_text() {
        assert_eq!(text(Some(Value::NULL)), None);
        assert_eq!(text(None), None);
        assert_eq!(text(Some(Value::Bytes(b"caf\xc3\xa9".to_vec()))).as_deref(), Some("café"));
        assert_eq!(text(Some(Value::Bytes(vec![0xff, 0x00]))).as_deref(), Some("0xFF00"));
        assert_eq!(text(Some(Value::Int(-5))).as_deref(), Some("-5"));
        assert_eq!(lit("it's"), "'it\\'s'");
    }
}
