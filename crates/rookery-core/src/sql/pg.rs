//! PostgreSQL engine (`tokio-postgres`, simple query protocol: every value is text,
//! rows stream, so the row cap can stop early).

use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::{mpsc, oneshot};
use tokio_postgres::error::{ErrorPosition, SqlState};
use tokio_postgres::{AsyncMessage, CancelToken, Client, SimpleQueryMessage};
use tokio_postgres_rustls::MakeRustlsConnect;

use super::schema::{self, TextRow, COL_SEP};
use super::{ConnParams, Done, ResultColumn, SchemaTree, Sink, StmtError};
use crate::model::SslMode;
use crate::{Error, Result};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct PgConn {
    client: Client,
    notices: mpsc::UnboundedReceiver<String>,
    pub cancel: PgCancel,
}

#[derive(Clone)]
pub struct PgCancel {
    token: CancelToken,
    tls: MakeRustlsConnect,
}

impl PgCancel {
    /// Ask the server to stop the running query (a separate short connection).
    pub async fn cancel(&self) -> Result<()> {
        self.token.cancel_query(self.tls.clone()).await.map_err(|e| Error::Other(format!("cancel: {e}")))
    }
}

/// Connect, apply the timeout and read-only settings. The receiver fires when the
/// connection ends (`Some(error)` if it broke).
pub async fn connect(p: &ConnParams) -> Result<(PgConn, String, oneshot::Receiver<Option<String>>)> {
    if p.user.trim().is_empty() {
        return Err(Error::Other("enter a user name".into()));
    }
    let mut cfg = tokio_postgres::Config::new();
    cfg.host(&p.host)
        .port(p.port)
        .user(&p.user)
        .application_name("Rookery")
        .connect_timeout(CONNECT_TIMEOUT)
        .keepalives(true)
        .keepalives_idle(Duration::from_secs(60))
        .ssl_mode(match p.ssl_mode {
            SslMode::Disable => tokio_postgres::config::SslMode::Disable,
            SslMode::Prefer => tokio_postgres::config::SslMode::Prefer,
            SslMode::Require | SslMode::VerifyFull => tokio_postgres::config::SslMode::Require,
        });
    if let Some(pw) = &p.password {
        cfg.password(pw.as_bytes());
    }
    if let Some(db) = p.database.as_deref().filter(|d| !d.is_empty()) {
        cfg.dbname(db);
    }
    let tls = MakeRustlsConnect::new(super::tls::client_config(p.ssl_mode == SslMode::VerifyFull, p.ca_path.as_deref())?);
    let (client, mut connection) = cfg.connect(tls.clone()).await.map_err(connect_err)?;

    // Drive the connection here (instead of `tokio::spawn(connection)`) to catch NOTICEs.
    let (ntx, notices) = mpsc::unbounded_channel();
    let (etx, ended) = oneshot::channel();
    tokio::spawn(async move {
        let end = loop {
            match std::future::poll_fn(|cx| connection.poll_message(cx)).await {
                Some(Ok(AsyncMessage::Notice(n))) => {
                    let _ = ntx.send(format!("{}: {}", n.severity(), n.message()));
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => break Some(e.to_string()),
                None => break None,
            }
        };
        let _ = etx.send(end);
    });

    let cancel = PgCancel { token: client.cancel_token(), tls };
    let conn = PgConn { client, notices, cancel };
    let version = conn.first_value("SHOW server_version").await?.unwrap_or_default();
    let version = format!("PostgreSQL {}", version.split_whitespace().next().unwrap_or(&version));
    let ms = u64::from(p.timeout_s.max(1)) * 1000;
    conn.batch(&format!("SET statement_timeout = {ms}")).await?;
    conn.set_read_only(p.read_only).await?;
    Ok((conn, version, ended))
}

fn connect_err(e: tokio_postgres::Error) -> Error {
    if let Some(db) = e.as_db_error() {
        if db.code() == &SqlState::INVALID_PASSWORD || db.code() == &SqlState::INVALID_AUTHORIZATION_SPECIFICATION {
            return Error::Other(format!("login failed: {}", db.message()));
        }
        return Error::Other(db.message().to_string());
    }
    Error::Other(format!("could not connect: {e}"))
}

pub fn stmt_err(e: tokio_postgres::Error) -> StmtError {
    let fatal = e.is_closed();
    match e.as_db_error() {
        Some(db) => {
            let mut message = format!("{}: {}", db.severity(), db.message());
            if let Some(d) = db.detail() {
                message.push_str(&format!("\nDETAIL: {d}"));
            }
            if let Some(h) = db.hint() {
                message.push_str(&format!("\nHINT: {h}"));
            }
            let position = match db.position() {
                Some(ErrorPosition::Original(p)) => Some(*p),
                _ => None,
            };
            StmtError { message, position, fatal }
        }
        None => StmtError {
            message: if fatal { "Connection lost".into() } else { e.to_string() },
            position: None,
            fatal,
        },
    }
}

fn is_canceled(e: &tokio_postgres::Error) -> bool {
    e.code() == Some(&SqlState::QUERY_CANCELED)
}

impl PgConn {
    async fn batch(&self, sql: &str) -> Result<()> {
        self.client.batch_execute(sql).await.map_err(|e| Error::Other(stmt_err(e).message))
    }

    async fn rows(&self, sql: &str) -> Result<Vec<TextRow>> {
        let msgs = self.client.simple_query(sql).await.map_err(|e| Error::Other(stmt_err(e).message))?;
        Ok(msgs
            .into_iter()
            .filter_map(|m| match m {
                SimpleQueryMessage::Row(r) => Some((0..r.len()).map(|i| r.get(i).map(String::from)).collect()),
                _ => None,
            })
            .collect())
    }

    async fn first_value(&self, sql: &str) -> Result<Option<String>> {
        Ok(self.rows(sql).await?.into_iter().next().and_then(|r| r.into_iter().next().flatten()))
    }

    pub fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    /// Server-side read-only for this session (applies to the next transactions).
    pub async fn set_read_only(&self, on: bool) -> Result<()> {
        self.batch(if on {
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"
        } else {
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE"
        })
        .await
    }

    pub async fn tx(&self, sql: &str) -> std::result::Result<(), StmtError> {
        self.client.batch_execute(sql).await.map_err(stmt_err)
    }

    pub fn take_notices(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(n) = self.notices.try_recv() {
            out.push(n);
        }
        out
    }

    pub async fn database(&self) -> Result<Option<String>> {
        self.first_value("SELECT current_database()").await
    }

    /// Run one statement, streaming its rows into `sink`. At the row cap a read is
    /// cancelled on the server; a write keeps running (its rows are just not shown).
    pub async fn exec(&mut self, sql: &str, cancel_at_cap: bool, sink: &mut Sink) -> std::result::Result<Done, StmtError> {
        let stream = self.client.simple_query_raw(sql).await.map_err(stmt_err)?;
        futures_util::pin_mut!(stream);
        let mut done = Done { affected: None, cut: false };
        let mut capped = false;
        while let Some(m) = stream.next().await {
            match m {
                Ok(SimpleQueryMessage::RowDescription(cols)) => sink.columns(
                    cols.iter().map(|c| ResultColumn { name: c.name().to_string(), type_name: String::new(), numeric: false }).collect(),
                ),
                Ok(SimpleQueryMessage::Row(r)) => {
                    if capped {
                        continue;
                    }
                    if !sink.row((0..r.len()).map(|i| r.get(i).map(String::from)).collect()) {
                        capped = true;
                        if cancel_at_cap {
                            done.cut = true;
                            let _ = self.cancel.cancel().await;
                        }
                    }
                }
                Ok(SimpleQueryMessage::CommandComplete(n)) => {
                    done.affected = Some(n);
                    sink.end_set(Some(n));
                }
                Ok(_) => {}
                Err(e) if done.cut && is_canceled(&e) => break,
                Err(e) => return Err(stmt_err(e)),
            }
        }
        sink.end_open();
        Ok(done)
    }

    pub async fn schema(&self, system: bool) -> Result<SchemaTree> {
        let ns = if system { "TRUE".to_string() } else { "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp)'".to_string() };
        let kinds = "c.relkind IN ('r','v','m','p','f')";
        let databases = self
            .rows("SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 1")
            .await?
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect();
        let schemas = self.rows(&format!("SELECT n.nspname FROM pg_namespace n WHERE {ns} ORDER BY 1")).await?;
        let tables = self
            .rows(&format!(
                "SELECT n.nspname, c.relname, c.relkind, c.reltuples::bigint
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE {kinds} AND {ns} ORDER BY 1, 2"
            ))
            .await?;
        let columns = self
            .rows(&format!(
                "SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                        pg_get_expr(d.adbin, d.adrelid)
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE a.attnum > 0 AND NOT a.attisdropped AND {kinds} AND {ns}
                 ORDER BY 1, 2, a.attnum"
            ))
            .await?;
        let indexes = self
            .rows(&format!(
                "SELECT n.nspname, t.relname, i.relname, ix.indisunique, ix.indisprimary,
                        array_to_string(ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
                                              FROM generate_subscripts(ix.indkey, 1) k ORDER BY k), chr({}))
                 FROM pg_index ix
                 JOIN pg_class t ON t.oid = ix.indrelid
                 JOIN pg_class i ON i.oid = ix.indexrelid
                 JOIN pg_namespace n ON n.oid = t.relnamespace
                 WHERE {ns} ORDER BY 1, 2, 3",
                COL_SEP as u32
            ))
            .await?;
        Ok(SchemaTree {
            database: self.database().await?,
            databases,
            schemas: schema::build(&schemas, &tables, &columns, &indexes),
        })
    }
}
