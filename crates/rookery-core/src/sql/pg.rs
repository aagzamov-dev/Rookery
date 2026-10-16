//! PostgreSQL engine (`tokio-postgres`, simple query protocol: every value is text,
//! rows stream, so the row cap can stop early).

use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::{mpsc, oneshot};
use tokio_postgres::error::{ErrorPosition, SqlState};
use tokio_postgres::{AsyncMessage, CancelToken, Client, SimpleQueryMessage};
use tokio_postgres_rustls::MakeRustlsConnect;

use super::schema::{self, TextRow, COL_SEP};
use super::table::{ident, literal, ColumnDetail, ForeignKey, TableDetail};
use super::{ConnParams, Done, IndexInfo, ResultColumn, SchemaTree, Sink, StmtError};
use crate::model::{DbEngine, SslMode};
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

/// `pg_constraint` action codes.
fn pg_action(c: Option<&str>) -> Option<String> {
    Some(
        match c? {
            "a" => "NO ACTION",
            "r" => "RESTRICT",
            "c" => "CASCADE",
            "n" => "SET NULL",
            "d" => "SET DEFAULT",
            _ => return None,
        }
        .into(),
    )
}

fn pg_fk(r: &TextRow) -> ForeignKey {
    let s = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
    let list = |i: usize| s(i).split(COL_SEP).filter(|c| !c.is_empty()).map(String::from).collect();
    ForeignKey {
        name: s(0),
        from_schema: s(1),
        from_table: s(2),
        from_columns: list(3),
        to_schema: s(4),
        to_table: s(5),
        to_columns: list(6),
        on_update: pg_action(r.get(7).and_then(|v| v.as_deref())),
        on_delete: pg_action(r.get(8).and_then(|v| v.as_deref())),
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

    /// First value of the first row (counts).
    pub async fn scalar(&self, sql: &str) -> Result<Option<String>> {
        self.first_value(sql).await
    }

    /// Columns of one table, in order (name, type, null, default, extra, comment).
    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnDetail>> {
        let (s, t) = (literal(DbEngine::Postgres, schema), literal(DbEngine::Postgres, table));
        let base = |extra: &str| {
            format!(
                "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
                        {extra}, col_description(c.oid, a.attnum)
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE n.nspname = {s} AND c.relname = {t} AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum"
            )
        };
        // identity (PG 10+) / generated (PG 12+) columns; older servers get the plain list.
        let rows = match self
            .rows(&base("CASE WHEN a.attidentity <> '' THEN 'identity' WHEN a.attgenerated <> '' THEN 'generated' END"))
            .await
        {
            Ok(r) => r,
            Err(_) => self.rows(&base("NULL")).await?,
        };
        Ok(rows
            .into_iter()
            .map(|r| ColumnDetail {
                name: r[0].clone().unwrap_or_default(),
                data_type: r[1].clone().unwrap_or_default(),
                nullable: r[2].as_deref() == Some("t"),
                default: r[3].clone(),
                key: None,
                extra: r[4].clone(),
                comment: r[5].clone(),
            })
            .collect())
    }

    /// Everything the Structure tab shows. Several small catalog queries, all for one table.
    pub async fn table_detail(&self, schema: &str, table: &str) -> Result<TableDetail> {
        let (s, t) = (literal(DbEngine::Postgres, schema), literal(DbEngine::Postgres, table));
        let rel = format!("(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = {s} AND c.relname = {t})");
        let info = self
            .rows(&format!(
                "SELECT c.relkind, c.reltuples::bigint, pg_total_relation_size(c.oid), obj_description(c.oid, 'pg_class')
                 FROM pg_class c WHERE c.oid = {rel}"
            ))
            .await?;
        let Some(info) = info.into_iter().next() else {
            return Err(Error::NotFound(format!("table {schema}.{table}")));
        };
        let kind = match info[0].as_deref() {
            Some("v") => "view",
            Some("m") => "matview",
            Some("p") => "partitioned",
            Some("f") => "foreign",
            _ => "table",
        };
        let mut columns = self.columns(schema, table).await?;
        let index_rows = self
            .rows(&format!(
                "SELECT i.relname, ix.indisunique, ix.indisprimary,
                        array_to_string(ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
                                              FROM generate_subscripts(ix.indkey, 1) k ORDER BY k), chr({}))
                 FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
                 WHERE ix.indrelid = {rel} ORDER BY ix.indisprimary DESC, i.relname",
                COL_SEP as u32
            ))
            .await?;
        let indexes: Vec<IndexInfo> = index_rows
            .iter()
            .map(|r| IndexInfo {
                name: r[0].clone().unwrap_or_default(),
                unique: r[1].as_deref() == Some("t") || r[2].as_deref() == Some("t"),
                primary: r[2].as_deref() == Some("t"),
                columns: r[3].clone().unwrap_or_default().split(COL_SEP).filter(|c| !c.is_empty()).map(String::from).collect(),
            })
            .collect();
        schema::mark_column_keys(&mut columns, &indexes);

        let fk_sql = |side: &str| {
            format!(
                "SELECT con.conname, n1.nspname, c1.relname,
                        array_to_string(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
                                              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o), chr({sep})),
                        n2.nspname, c2.relname,
                        array_to_string(ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
                                              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o), chr({sep})),
                        con.confupdtype, con.confdeltype
                 FROM pg_constraint con
                 JOIN pg_class c1 ON c1.oid = con.conrelid JOIN pg_namespace n1 ON n1.oid = c1.relnamespace
                 JOIN pg_class c2 ON c2.oid = con.confrelid JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                 WHERE con.contype = 'f' AND con.{side} = {rel} ORDER BY con.conname",
                sep = COL_SEP as u32
            )
        };
        let foreign_keys = self.rows(&fk_sql("conrelid")).await?.iter().map(pg_fk).collect();
        let referenced_by = self.rows(&fk_sql("confrelid")).await?.iter().map(pg_fk).collect();

        // CREATE script from the catalog (Postgres has no SHOW CREATE TABLE).
        let name = super::table::table_ref(DbEngine::Postgres, schema, table);
        let create_sql = if kind == "view" || kind == "matview" {
            let def = self.first_value(&format!("SELECT pg_get_viewdef({rel}, true)")).await?.unwrap_or_default();
            Some(format!("CREATE {}VIEW {name} AS\n{}", if kind == "matview" { "MATERIALIZED " } else { "" }, def.trim_end()))
        } else {
            let cons = self
                .rows(&format!("SELECT conname, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid = {rel} ORDER BY contype DESC, conname"))
                .await?;
            let extra_idx = self
                .rows(&format!(
                    "SELECT pg_get_indexdef(ix.indexrelid) FROM pg_index ix
                     WHERE ix.indrelid = {rel} AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)"
                ))
                .await?;
            let mut lines: Vec<String> = columns
                .iter()
                .map(|c| {
                    format!(
                        "  {} {}{}{}",
                        ident(DbEngine::Postgres, &c.name),
                        c.data_type,
                        c.default.as_ref().map(|d| format!(" DEFAULT {d}")).unwrap_or_default(),
                        if c.nullable { "" } else { " NOT NULL" }
                    )
                })
                .collect();
            for r in &cons {
                lines.push(format!("  CONSTRAINT {} {}", ident(DbEngine::Postgres, r[0].as_deref().unwrap_or("")), r[1].as_deref().unwrap_or("")));
            }
            let mut out = format!("CREATE TABLE {name} (\n{}\n);", lines.join(",\n"));
            for r in &extra_idx {
                if let Some(d) = &r[0] {
                    out.push_str(&format!("\n{d};"));
                }
            }
            if let Some(c) = &info[3] {
                out.push_str(&format!("\nCOMMENT ON TABLE {name} IS {};", literal(DbEngine::Postgres, c)));
            }
            Some(out)
        };

        Ok(TableDetail {
            schema: schema.into(),
            name: table.into(),
            kind: kind.into(),
            columns,
            indexes,
            foreign_keys,
            referenced_by,
            create_sql,
            rows_est: info[1].as_deref().and_then(|v| v.parse::<i64>().ok()).filter(|v| *v >= 0),
            size_bytes: info[2].as_deref().and_then(|v| v.parse().ok()),
            engine: None,
            collation: None,
            comment: info[3].clone(),
        })
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
