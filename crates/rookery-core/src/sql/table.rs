//! Table browser (docs/07 §10): structure, paged data queries, and parameterized cell edits.
//! SQL is built here from catalog metadata so the UI never assembles SQL from user values.
//!
//! Safety: every identifier comes from the catalog and is quoted; every value is a quoted
//! literal for reads or a bound parameter for edits; a hand-written `WHERE` must leave exactly one read-only statement. The query then
//! runs through the normal session path (read-only guard, timeout, row cap, cancel).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::lex::{self, Kind};
use crate::model::DbEngine;
use crate::{Error, Result};

/// Rows per page cap (the UI offers 100 / 200 / 500 / 1000).
pub const MAX_PAGE: u32 = 5000;
/// Search looks at this many text columns at most (keeps the OR list short).
const SEARCH_COLUMNS: usize = 40;

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct TableCellUpdate {
    pub schema: String,
    pub table: String,
    pub column: String,
    pub keys: Vec<(String, String)>,
    pub original: Option<String>,
    pub value: Option<String>,
}

pub struct CellUpdatePlan {
    pub sql: String,
    pub values: Vec<Option<String>>,
}

pub fn editable_type(data_type: &str) -> Option<&'static str> {
    let mut depth = 0;
    let name: String = data_type.to_lowercase().chars().filter(|c| {
        if *c == '(' { depth += 1; return false; }
        if *c == ')' { depth -= 1; return false; }
        depth == 0
    }).collect();
    match name.trim().trim_end_matches(" unsigned") {
        "text" | "tinytext" | "mediumtext" | "longtext" => Some("text"),
        "character varying" | "varchar" => Some("varchar"),
        "character" | "char" => Some("char"),
        "smallint" | "tinyint" => Some("smallint"),
        "integer" | "int" | "mediumint" => Some("integer"),
        "bigint" => Some("bigint"),
        "numeric" | "decimal" => Some("numeric"),
        "real" | "float" => Some("real"),
        "double precision" | "double" => Some("double precision"),
        "boolean" | "bool" => Some("boolean"),
        "uuid" => Some("uuid"),
        "json" => Some("json"),
        "jsonb" => Some("jsonb"),
        "date" => Some("date"),
        "timestamp" | "timestamp without time zone" | "datetime" => Some("timestamp"),
        "timestamp with time zone" => Some("timestamptz"),
        "time" | "time without time zone" => Some("time"),
        "time with time zone" => Some("timetz"),
        _ => None,
    }
}

pub fn cell_update_plan(engine: DbEngine, detail: &TableDetail, update: &TableCellUpdate) -> Result<CellUpdatePlan> {
    let fail = |message: &str| Error::Other(message.into());
    if !matches!(detail.kind.as_str(), "table" | "partitioned") {
        return Err(fail("Only base tables can be edited"));
    }
    if engine == DbEngine::Mysql && !detail.engine.as_deref().is_some_and(|e| e.eq_ignore_ascii_case("InnoDB")) {
        return Err(fail("Cell editing requires an InnoDB table so changes can be rolled back"));
    }
    let column = detail.columns.iter().find(|c| c.name == update.column).ok_or_else(|| fail("Column no longer exists"))?;
    if column.extra.as_deref().is_some_and(|e| {
        let extra = e.to_lowercase();
        matches!(extra.as_str(), "generated" | "identity") || extra.contains("stored generated") || extra.contains("virtual generated")
    }) {
        return Err(fail("Generated and identity columns cannot be edited"));
    }
    let cast = editable_type(&column.data_type).ok_or_else(|| fail("This column type cannot be edited as text"))?;
    if update.value.is_none() && !column.nullable {
        return Err(fail("This column does not allow NULL"));
    }
    if update.original == update.value {
        return Err(fail("No changes to apply"));
    }
    let key_valid = detail.indexes.iter().any(|i| (i.primary || i.unique) && !i.columns.is_empty()
        && i.columns.len() == update.keys.len()
        && i.columns.iter().all(|name| update.keys.iter().filter(|(n, _)| n == name).count() == 1)
        && i.columns.iter().all(|name| detail.columns.iter().any(|c| &c.name == name && editable_type(&c.data_type).is_some())));
    if !key_valid {
        return Err(fail("A complete primary or unique key is required to edit this row"));
    }
    let mut values = vec![update.value.clone()];
    let mut conditions = Vec::new();
    for (name, value) in &update.keys {
        values.push(Some(value.clone()));
        let col = ident(engine, name);
        conditions.push(match engine {
            DbEngine::Postgres => format!("CAST({col} AS text) IS NOT DISTINCT FROM ${}::text", values.len()),
            DbEngine::Mysql => format!("CAST({col} AS BINARY) <=> CAST(? AS BINARY)"),
        });
    }
    values.push(update.original.clone());
    let col = ident(engine, &column.name);
    conditions.push(match engine {
        DbEngine::Postgres => format!("CAST({col} AS text) IS NOT DISTINCT FROM ${}::text", values.len()),
        DbEngine::Mysql => format!("CAST({col} AS BINARY) <=> CAST(? AS BINARY)"),
    });
    let value = match engine {
        DbEngine::Postgres => format!("CAST($1::text AS {cast})"),
        DbEngine::Mysql => "?".into(),
    };
    Ok(CellUpdatePlan {
        sql: format!("UPDATE {} SET {col} = {value} WHERE {}", table_ref(engine, &detail.schema, &detail.name), conditions.join(" AND ")),
        values,
    })
}

// ------------------------------------------------------------------ types

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    IsNull,
    NotNull,
    Empty,
    NotEmpty,
}

impl FilterOp {
    fn needs_value(self) -> bool {
        !matches!(self, FilterOp::IsNull | FilterOp::NotNull | FilterOp::Empty | FilterOp::NotEmpty)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ColumnFilter {
    pub column: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SortKey {
    pub column: String,
    pub desc: bool,
}

/// One page of a table's rows.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct TableQuery {
    pub schema: String,
    pub table: String,
    /// All must match (AND).
    #[serde(default)]
    pub filters: Vec<ColumnFilter>,
    /// Quick search: any text column contains it.
    #[serde(default)]
    pub search: Option<String>,
    /// Hand-written condition (what goes after WHERE).
    #[serde(default)]
    pub where_sql: Option<String>,
    #[serde(default)]
    pub sort: Vec<SortKey>,
    pub limit: u32,
    #[serde(default)]
    #[ts(type = "number")]
    pub offset: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct TableRowsStarted {
    pub query_id: String,
    /// The exact SQL that runs ("Show SQL", "Open in Query").
    pub sql: String,
}

#[derive(Debug, Clone, Default, Serialize, TS, PartialEq)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ColumnDetail {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    /// PRI | UNI | MUL (as in the schema tree).
    pub key: Option<String>,
    /// auto_increment, identity, generated, on update …
    pub extra: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, TS, PartialEq)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ForeignKey {
    pub name: String,
    pub from_schema: String,
    pub from_table: String,
    pub from_columns: Vec<String>,
    pub to_schema: String,
    pub to_table: String,
    pub to_columns: Vec<String>,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct TableDetail {
    pub schema: String,
    pub name: String,
    /// table | view | matview | partitioned | foreign
    pub kind: String,
    pub columns: Vec<ColumnDetail>,
    pub indexes: Vec<super::IndexInfo>,
    /// Keys in this table that point to other tables.
    pub foreign_keys: Vec<ForeignKey>,
    /// Keys in other tables that point to this one.
    pub referenced_by: Vec<ForeignKey>,
    /// `SHOW CREATE TABLE` (MySQL) or built from the catalog (Postgres).
    pub create_sql: Option<String>,
    #[ts(type = "number | null")]
    pub rows_est: Option<i64>,
    #[ts(type = "number | null")]
    pub size_bytes: Option<i64>,
    pub engine: Option<String>,
    pub collation: Option<String>,
    pub comment: Option<String>,
}

// ---------------------------------------------------------------- quoting

/// A quoted identifier (always quoted: names come from the catalog, quoting keeps any of them valid).
pub fn ident(engine: DbEngine, name: &str) -> String {
    match engine {
        DbEngine::Postgres => format!("\"{}\"", name.replace('"', "\"\"")),
        DbEngine::Mysql => format!("`{}`", name.replace('`', "``")),
    }
}

/// A quoted string literal that is safe whatever the server's escape settings are:
/// - Postgres: `'…'` with `''`, or `E'…'` (backslashes doubled) when the value has a backslash.
/// - MySQL: `''` for quotes (valid with and without NO_BACKSLASH_ESCAPES) and `\\` for backslashes.
pub fn literal(engine: DbEngine, value: &str) -> String {
    let v = value.replace('\0', "");
    match engine {
        DbEngine::Postgres if v.contains('\\') => format!("E'{}'", v.replace('\\', "\\\\").replace('\'', "''")),
        DbEngine::Postgres => format!("'{}'", v.replace('\'', "''")),
        DbEngine::Mysql => format!("'{}'", v.replace('\\', "\\\\").replace('\'', "''")),
    }
}

/// `schema.table` (MySQL: database.table).
pub fn table_ref(engine: DbEngine, schema: &str, table: &str) -> String {
    format!("{}.{}", ident(engine, schema), ident(engine, table))
}

/// A LIKE pattern matching `value` literally, with `!` as the escape character.
fn like(engine: DbEngine, prefix: &str, value: &str, suffix: &str) -> String {
    let esc = value.replace('!', "!!").replace('%', "!%").replace('_', "!_");
    format!("{} ESCAPE '!'", literal(engine, &format!("{prefix}{esc}{suffix}")))
}

/// Column types that hold text (search looks at these; LIKE needs no cast on MySQL).
pub fn is_text_type(t: &str) -> bool {
    let t = t.to_ascii_lowercase();
    ["char", "text", "uuid", "json", "xml", "citext", "enum", "set(", "name", "inet"].iter().any(|k| t.contains(k)) || t == "set"
}

/// A column as text, for LIKE / empty checks.
fn as_text(engine: DbEngine, col: &str, data_type: &str) -> String {
    match engine {
        DbEngine::Postgres => format!("CAST({col} AS text)"),
        DbEngine::Mysql if is_text_type(data_type) => col.to_string(),
        DbEngine::Mysql => format!("CAST({col} AS CHAR)"),
    }
}

// ----------------------------------------------------------------- builder

/// Names and types of the table's columns (from the catalog).
pub struct ColMeta<'a> {
    pub name: &'a str,
    pub data_type: &'a str,
}

fn find<'a>(cols: &'a [ColMeta<'a>], name: &str) -> Result<&'a ColMeta<'a>> {
    cols.iter().find(|c| c.name == name).ok_or_else(|| Error::Other(format!("unknown column {name}")))
}

fn condition(engine: DbEngine, f: &ColumnFilter, cols: &[ColMeta]) -> Result<String> {
    let meta = find(cols, &f.column)?;
    let col = ident(engine, meta.name);
    let value = f.value.as_deref().unwrap_or("");
    if f.op.needs_value() && f.value.is_none() {
        return Err(Error::Other(format!("enter a value for {}", meta.name)));
    }
    let text = as_text(engine, &col, meta.data_type);
    let ci = if engine == DbEngine::Postgres { "ILIKE" } else { "LIKE" };
    Ok(match f.op {
        FilterOp::Eq => format!("{col} = {}", literal(engine, value)),
        FilterOp::Ne => format!("({col} <> {} OR {col} IS NULL)", literal(engine, value)),
        FilterOp::Lt => format!("{col} < {}", literal(engine, value)),
        FilterOp::Le => format!("{col} <= {}", literal(engine, value)),
        FilterOp::Gt => format!("{col} > {}", literal(engine, value)),
        FilterOp::Ge => format!("{col} >= {}", literal(engine, value)),
        FilterOp::Contains => format!("{text} {ci} {}", like(engine, "%", value, "%")),
        FilterOp::NotContains => format!("({text} NOT {ci} {} OR {col} IS NULL)", like(engine, "%", value, "%")),
        FilterOp::StartsWith => format!("{text} {ci} {}", like(engine, "", value, "%")),
        FilterOp::EndsWith => format!("{text} {ci} {}", like(engine, "%", value, "")),
        FilterOp::IsNull => format!("{col} IS NULL"),
        FilterOp::NotNull => format!("{col} IS NOT NULL"),
        FilterOp::Empty => format!("({col} IS NULL OR {text} = '')"),
        FilterOp::NotEmpty => format!("({col} IS NOT NULL AND {text} <> '')"),
    })
}

/// `WHERE …` for a query (empty when there is no condition).
pub fn where_clause(engine: DbEngine, q: &TableQuery, cols: &[ColMeta]) -> Result<String> {
    let mut parts = Vec::new();
    for f in &q.filters {
        parts.push(condition(engine, f, cols)?);
    }
    if let Some(s) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let mut targets: Vec<&ColMeta> = cols.iter().filter(|c| is_text_type(c.data_type)).take(SEARCH_COLUMNS).collect();
        if targets.is_empty() {
            targets = cols.iter().take(SEARCH_COLUMNS).collect();
        }
        let ci = if engine == DbEngine::Postgres { "ILIKE" } else { "LIKE" };
        let pat = like(engine, "%", s, "%");
        let any: Vec<String> = targets
            .iter()
            .map(|c| format!("{} {ci} {pat}", as_text(engine, &ident(engine, c.name), c.data_type)))
            .collect();
        if !any.is_empty() {
            parts.push(format!("({})", any.join(" OR ")));
        }
    }
    if let Some(w) = q.where_sql.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        parts.push(format!("({w})"));
    }
    Ok(if parts.is_empty() { String::new() } else { format!(" WHERE {}", parts.join(" AND ")) })
}

/// The page query. Asks for one row more than the page so the UI knows there is more.
pub fn select_sql(engine: DbEngine, q: &TableQuery, cols: &[ColMeta]) -> Result<String> {
    let mut sql = format!("SELECT * FROM {}{}", table_ref(engine, &q.schema, &q.table), where_clause(engine, q, cols)?);
    if !q.sort.is_empty() {
        let keys: Vec<String> = q
            .sort
            .iter()
            .map(|k| Ok(format!("{} {}", ident(engine, find(cols, &k.column)?.name), if k.desc { "DESC" } else { "ASC" })))
            .collect::<Result<_>>()?;
        sql.push_str(&format!(" ORDER BY {}", keys.join(", ")));
    }
    let limit = q.limit.clamp(1, MAX_PAGE);
    sql.push_str(&format!(" LIMIT {}", u64::from(limit) + 1));
    if q.offset > 0 {
        sql.push_str(&format!(" OFFSET {}", q.offset));
    }
    check_single_read(engine, &sql)?;
    Ok(sql)
}

/// `SELECT COUNT(*)` with the same conditions.
pub fn count_sql(engine: DbEngine, q: &TableQuery, cols: &[ColMeta]) -> Result<String> {
    let sql = format!("SELECT COUNT(*) FROM {}{}", table_ref(engine, &q.schema, &q.table), where_clause(engine, q, cols)?);
    check_single_read(engine, &sql)?;
    Ok(sql)
}

/// A hand-written condition must not smuggle in a second statement or a write.
fn check_single_read(engine: DbEngine, sql: &str) -> Result<()> {
    let stmts = lex::split(sql, engine).map_err(Error::Other)?;
    match stmts.as_slice() {
        [one] if lex::classify(one).kind == Kind::Read => Ok(()),
        [_] => Err(Error::Other("the filter must only read data".into())),
        _ => Err(Error::Other("the filter must be a condition, not a separate statement (no ;)".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editable_table() -> (TableDetail, TableCellUpdate) {
        let detail = TableDetail {
            schema: "public".into(), name: "users".into(), kind: "table".into(), engine: Some("InnoDB".into()),
            columns: vec![ColumnDetail { name: "id".into(), data_type: "bigint".into(), ..Default::default() },
                ColumnDetail { name: "name".into(), data_type: "text".into(), nullable: true, ..Default::default() }],
            indexes: vec![super::super::IndexInfo { name: "pk".into(), columns: vec!["id".into()], primary: true, unique: true }],
            ..Default::default()
        };
        let update = TableCellUpdate { schema: "public".into(), table: "users".into(), column: "name".into(), keys: vec![("id".into(), "1".into())], original: Some("before".into()), value: Some("after".into()) };
        (detail, update)
    }

    #[test]
    fn cell_updates_parameterize_values_and_check_original() {
        let (detail, mut update) = editable_table();
        update.value = Some("'; DROP TABLE users; --".into());
        for engine in [DbEngine::Postgres, DbEngine::Mysql] {
            let plan = cell_update_plan(engine, &detail, &update).unwrap();
            assert!(!plan.sql.contains("DROP TABLE"));
            assert_eq!(plan.values, vec![update.value.clone(), Some("1".into()), Some("before".into())]);
            assert!(plan.sql.contains(if engine == DbEngine::Postgres { "IS NOT DISTINCT FROM $3::text" } else { "<=> CAST(? AS BINARY)" }));
        }
    }

    #[test]
    fn cell_updates_reject_unsafe_identity_and_types() {
        let (mut detail, mut update) = editable_table();
        update.keys.push(("id".into(), "2".into()));
        assert!(cell_update_plan(DbEngine::Postgres, &detail, &update).is_err());
        update.keys.pop();
        detail.columns[1].extra = Some("STORED GENERATED".into());
        assert!(cell_update_plan(DbEngine::Postgres, &detail, &update).is_err());
        detail.columns[1].extra = None;
        detail.columns[1].extra = Some("DEFAULT_GENERATED".into());
        assert!(cell_update_plan(DbEngine::Postgres, &detail, &update).is_ok());
        detail.columns[1].extra = None;
        detail.columns[1].data_type = "bytea".into();
        assert!(cell_update_plan(DbEngine::Postgres, &detail, &update).is_err());
        detail.columns[1].data_type = "text".into();
        detail.kind = "view".into();
        assert!(cell_update_plan(DbEngine::Postgres, &detail, &update).is_err());
        detail.kind = "table".into();
        detail.engine = Some("MyISAM".into());
        assert!(cell_update_plan(DbEngine::Mysql, &detail, &update).is_err());
    }

    #[test]
    fn cell_updates_distinguish_null_and_empty() {
        let (detail, mut update) = editable_table();
        update.original = None;
        update.value = Some(String::new());
        let plan = cell_update_plan(DbEngine::Postgres, &detail, &update).unwrap();
        assert_eq!(plan.values[0], Some(String::new()));
        assert_eq!(plan.values[2], None);
        update.column = "id".into();
        update.value = None;
        assert!(cell_update_plan(DbEngine::Postgres, &detail, &update).is_err());
        assert_eq!(editable_type("numeric(10,2)"), Some("numeric"));
        assert_eq!(editable_type("timestamp(6) with time zone"), Some("timestamptz"));
        assert_eq!(editable_type("bigint unsigned"), Some("bigint"));
        assert_eq!(editable_type("text[]"), None);
    }

    fn cols() -> Vec<ColMeta<'static>> {
        vec![
            ColMeta { name: "id", data_type: "bigint" },
            ColMeta { name: "email", data_type: "character varying(255)" },
            ColMeta { name: "created_at", data_type: "timestamp" },
        ]
    }

    fn q(table: &str) -> TableQuery {
        TableQuery { schema: "public".into(), table: table.into(), filters: vec![], search: None, where_sql: None, sort: vec![], limit: 200, offset: 0 }
    }

    #[test]
    fn literals_cannot_break_out() {
        assert_eq!(literal(DbEngine::Postgres, "it's"), "'it''s'");
        assert_eq!(literal(DbEngine::Postgres, r"a\'; DROP"), r"E'a\\''; DROP'");
        assert_eq!(literal(DbEngine::Mysql, r"x\' OR 1=1 -- "), r"'x\\'' OR 1=1 -- '");
        assert_eq!(ident(DbEngine::Postgres, "we\"ird"), "\"we\"\"ird\"");
        assert_eq!(ident(DbEngine::Mysql, "a`b"), "`a``b`");
    }

    #[test]
    fn plain_page_has_one_extra_row_and_offset() {
        let mut x = q("users");
        x.offset = 400;
        let sql = select_sql(DbEngine::Postgres, &x, &cols()).unwrap();
        assert_eq!(sql, "SELECT * FROM \"public\".\"users\" LIMIT 201 OFFSET 400");
    }

    #[test]
    fn filters_sort_and_search() {
        let mut x = q("users");
        x.filters = vec![
            ColumnFilter { column: "email".into(), op: FilterOp::Contains, value: Some("50%_off".into()) },
            ColumnFilter { column: "id".into(), op: FilterOp::Gt, value: Some("10".into()) },
            ColumnFilter { column: "created_at".into(), op: FilterOp::IsNull, value: None },
        ];
        x.sort = vec![SortKey { column: "id".into(), desc: true }];
        let sql = select_sql(DbEngine::Postgres, &x, &cols()).unwrap();
        assert!(sql.contains(r#"CAST("email" AS text) ILIKE '%50!%!_off%' ESCAPE '!'"#), "{sql}");
        assert!(sql.contains(r#""id" > '10'"#) && sql.contains(r#""created_at" IS NULL"#) && sql.ends_with(r#"ORDER BY "id" DESC LIMIT 201"#), "{sql}");

        let mut s = q("users");
        s.search = Some("bob".into());
        let sql = select_sql(DbEngine::Mysql, &s, &cols()).unwrap();
        // only the text column is searched, and MySQL needs no cast for it
        assert!(sql.contains("WHERE (`email` LIKE '%bob%' ESCAPE '!')"), "{sql}");
    }

    #[test]
    fn unknown_columns_and_smuggled_statements_are_refused() {
        let mut x = q("users");
        x.sort = vec![SortKey { column: "id; DROP TABLE users".into(), desc: false }];
        assert!(select_sql(DbEngine::Postgres, &x, &cols()).is_err());

        let mut w = q("users");
        w.where_sql = Some("id = 1; DELETE FROM users".into());
        assert!(select_sql(DbEngine::Postgres, &w, &cols()).unwrap_err().to_string().contains("no ;"));

        let mut ok = q("users");
        ok.where_sql = Some("email LIKE '%;%' AND id IN (SELECT 1)".into());
        assert!(select_sql(DbEngine::Postgres, &ok, &cols()).is_ok(), "a ; inside a string is fine");

        let mut v = q("users");
        v.filters = vec![ColumnFilter { column: "id".into(), op: FilterOp::Eq, value: None }];
        assert!(select_sql(DbEngine::Postgres, &v, &cols()).is_err(), "= needs a value");
    }

    #[test]
    fn count_uses_the_same_conditions() {
        let mut x = q("users");
        x.filters = vec![ColumnFilter { column: "email".into(), op: FilterOp::Empty, value: None }];
        assert_eq!(
            count_sql(DbEngine::Mysql, &x, &cols()).unwrap(),
            "SELECT COUNT(*) FROM `public`.`users` WHERE (`email` IS NULL OR `email` = '')"
        );
    }
}
