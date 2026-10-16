//! A small SQL lexer: split a script into statements and tell what each one does.
//!
//! It only has to know where strings, quoted names, comments and dollar quotes start and
//! end, so `;` inside them never splits a statement and words inside them never count.
//! The frontend has the same splitter (`features/sql/split.ts`) for "run statement at
//! cursor"; this one is the authority for what is sent to the server.

use crate::model::DbEngine;

/// One statement of a script. Offsets are byte offsets into the script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    pub start: usize,
    pub end: usize,
    /// Words outside strings / quoted names / comments, original case.
    pub words: Vec<String>,
}

impl Statement {
    pub fn text<'a>(&self, script: &'a str) -> &'a str {
        &script[self.start..self.end]
    }

    fn first(&self) -> String {
        self.words.first().map(|w| w.to_ascii_uppercase()).unwrap_or_default()
    }

    fn has(&self, w: &str) -> bool {
        self.words.iter().any(|x| x.eq_ignore_ascii_case(w))
    }

    /// Two words next to each other, e.g. `READ WRITE`.
    fn has_pair(&self, a: &str, b: &str) -> bool {
        self.words.windows(2).any(|p| p[0].eq_ignore_ascii_case(a) && p[1].eq_ignore_ascii_case(b))
    }
}

/// Split a script on top-level `;`. Empty statements (only spaces / comments) are dropped.
pub fn split(script: &str, engine: DbEngine) -> Result<Vec<Statement>, String> {
    let mysql = engine == DbEngine::Mysql;
    let b = script.as_bytes();
    let mut out = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;

    let finish = |start: usize, end: usize, words: &mut Vec<String>, out: &mut Vec<Statement>| {
        if !words.is_empty() {
            let text = &script[start..end];
            let lead = text.len() - text.trim_start().len();
            let trail = text.len() - text.trim_end().len();
            out.push(Statement { start: start + lead, end: end - trail, words: std::mem::take(words) });
        }
    };

    while i < b.len() {
        let c = b[i];
        match c {
            b';' => {
                finish(start, i, &mut words, &mut out);
                start = i + 1;
                i += 1;
            }
            b'-' if b.get(i + 1) == Some(&b'-') => i = skip_line(b, i),
            b'#' if mysql => i = skip_line(b, i),
            b'/' if b.get(i + 1) == Some(&b'*') => i = skip_block(b, i, !mysql),
            b'\'' => {
                // E'..' (Postgres) allows backslash escapes; MySQL always does.
                let e_string = !mysql
                    && words.last().is_some_and(|w| w.eq_ignore_ascii_case("e"))
                    && i > 0
                    && (b[i - 1] == b'e' || b[i - 1] == b'E');
                if e_string {
                    words.pop();
                }
                i = skip_quoted(b, i, b'\'', mysql || e_string);
            }
            b'"' => i = skip_quoted(b, i, b'"', mysql),
            b'`' if mysql => i = skip_quoted(b, i, b'`', false),
            b'$' if !mysql && (i == 0 || !is_word(b[i - 1])) => match dollar_tag(b, i) {
                Some(tag_end) => {
                    let tag = &b[i..tag_end];
                    i = find(b, tag_end, tag).map(|p| p + tag.len()).unwrap_or(b.len());
                }
                None => i += 1,
            },
            c if c.is_ascii_alphabetic() || c == b'_' || c >= 0x80 => {
                let s = i;
                while i < b.len() && (is_word(b[i]) || b[i] >= 0x80) {
                    i += 1;
                }
                // Keep char boundaries: a multi-byte char ends where the next ASCII starts.
                let w = &script[s..i];
                if mysql && words.is_empty() && w.eq_ignore_ascii_case("delimiter") {
                    return Err("DELIMITER is a mysql command-line feature and is not supported here; separate statements with ;".into());
                }
                words.push(w.to_string());
            }
            _ => i += 1,
        }
    }
    finish(start, b.len(), &mut words, &mut out);
    Ok(out)
}

fn is_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$'
}

fn skip_line(b: &[u8], i: usize) -> usize {
    b[i..].iter().position(|&c| c == b'\n').map(|p| i + p + 1).unwrap_or(b.len())
}

/// `/* … */`; Postgres block comments nest, MySQL ones don't.
fn skip_block(b: &[u8], mut i: usize, nest: bool) -> usize {
    let mut depth = 0;
    while i < b.len() {
        if b[i] == b'/' && b.get(i + 1) == Some(&b'*') && (nest || depth == 0) {
            depth += 1;
            i += 2;
        } else if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return i;
            }
        } else {
            i += 1;
        }
    }
    b.len()
}

/// A quoted string or name. A doubled quote is an escaped quote; `backslash` also allows `\'`.
fn skip_quoted(b: &[u8], mut i: usize, q: u8, backslash: bool) -> usize {
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' if backslash => i += 2,
            c if c == q => {
                if b.get(i + 1) == Some(&q) {
                    i += 2;
                } else {
                    return i + 1;
                }
            }
            _ => i += 1,
        }
    }
    b.len()
}

/// `$tag$` or `$$` at `i`: returns the end of the opening tag. `$1` (a parameter) is not a tag.
fn dollar_tag(b: &[u8], i: usize) -> Option<usize> {
    let mut j = i + 1;
    if j < b.len() && b[j].is_ascii_digit() {
        return None;
    }
    while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
        j += 1;
    }
    (j < b.len() && b[j] == b'$').then_some(j + 1)
}

fn find(b: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    b[from..].windows(needle.len()).position(|w| w == needle).map(|p| from + p)
}

// ----------------------------------------------------------------- classify

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// SELECT, SHOW, EXPLAIN, … : never changes data.
    Read,
    /// INSERT / UPDATE / DELETE / CALL / anything unknown.
    Write,
    /// CREATE / ALTER / DROP / TRUNCATE / GRANT … (MySQL commits these at once).
    Ddl,
    Begin,
    Commit,
    Rollback,
    /// SET, SAVEPOINT, ROLLBACK TO, LISTEN … : session state only.
    Session,
    /// MySQL `USE db`.
    Use,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Info {
    pub kind: Kind,
    /// Postgres refuses it inside a transaction (VACUUM, CREATE DATABASE, … CONCURRENTLY).
    pub no_tx: bool,
}

impl Info {
    pub fn changes_data(&self) -> bool {
        matches!(self.kind, Kind::Write | Kind::Ddl)
    }
}

const DATA_WORDS: &[&str] = &["INSERT", "UPDATE", "DELETE", "MERGE"];

pub fn classify(s: &Statement) -> Info {
    let first = s.first();
    let any_data = || DATA_WORDS.iter().any(|w| s.has(w));
    let kind = match first.as_str() {
        "SELECT" => {
            if s.has("INTO") || s.has_pair("FOR", "UPDATE") || s.has_pair("FOR", "SHARE") || s.has_pair("NO", "KEY") {
                Kind::Write
            } else {
                Kind::Read
            }
        }
        "WITH" => {
            if any_data() || s.has("INTO") {
                Kind::Write
            } else {
                Kind::Read
            }
        }
        // EXPLAIN ANALYZE really runs the statement.
        "EXPLAIN" => {
            if (s.has("ANALYZE") || s.has("ANALYSE")) && any_data() {
                Kind::Write
            } else {
                Kind::Read
            }
        }
        "SHOW" | "DESCRIBE" | "DESC" | "VALUES" | "TABLE" | "HELP" => Kind::Read,
        "BEGIN" | "START" => Kind::Begin,
        "COMMIT" | "END" => Kind::Commit,
        "ROLLBACK" | "ABORT" if !s.has("TO") => Kind::Rollback,
        "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "SET" | "RESET" | "LISTEN" | "UNLISTEN" | "DISCARD" | "DEALLOCATE"
        | "PREPARE" => Kind::Session,
        "USE" => Kind::Use,
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "GRANT" | "REVOKE" | "COMMENT" | "REINDEX" | "CLUSTER"
        | "VACUUM" | "ANALYZE" | "ANALYSE" | "REFRESH" | "OPTIMIZE" | "REPAIR" => Kind::Ddl,
        _ => Kind::Write,
    };
    let no_tx = matches!(first.as_str(), "VACUUM")
        || s.has("CONCURRENTLY")
        || (matches!(first.as_str(), "CREATE" | "DROP") && (s.has_pair(first.as_str(), "DATABASE") || s.has("TABLESPACE")))
        || s.has_pair("ALTER", "SYSTEM");
    Info { kind, no_tx }
}

/// Session variables that switch read-only mode.
const READ_ONLY_VARS: &[&str] = &["default_transaction_read_only", "transaction_read_only", "tx_read_only"];

/// While a session is read-only, refuse statements that would switch read-only off.
/// The server enforces read-only; this stops the editor from simply undoing it.
pub fn read_only_guard(s: &Statement) -> Option<&'static str> {
    let first = s.first();
    let toggles = matches!(first.as_str(), "SET" | "RESET" | "BEGIN" | "START")
        && (s.has_pair("READ", "WRITE") || READ_ONLY_VARS.iter().any(|v| s.has(v)) || (first == "RESET" && s.has("ALL")));
    // `SELECT set_config('default_transaction_read_only', 'off', false)` looks like a read.
    if toggles || first == "DISCARD" || s.has("set_config") {
        return Some("This connection is read-only. Use \u{1F512} → Allow changes instead of switching it off in SQL.");
    }
    None
}

/// Index of the char at byte offset `byte` (error positions are counted in chars).
pub fn char_index(script: &str, byte: usize) -> usize {
    script[..byte.min(script.len())].chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(script: &str, engine: DbEngine) -> Vec<String> {
        split(script, engine).unwrap().iter().map(|s| s.text(script).to_string()).collect()
    }

    #[test]
    fn splits_on_top_level_semicolons_only() {
        let pg = "select 'a;b' as x; -- c;omment\nselect \"we;ird\" from t /* ; */;\n\n;select 2";
        assert_eq!(texts(pg, DbEngine::Postgres), vec!["select 'a;b' as x", "-- c;omment\nselect \"we;ird\" from t /* ; */", "select 2"]);
        // dollar quotes keep the function body together; $1 is a parameter
        let f = "create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql; select $1;";
        assert_eq!(split(f, DbEngine::Postgres).unwrap().len(), 2);
        assert_eq!(texts("do $$ begin perform 1; end $$; select 1", DbEngine::Postgres).len(), 2);
        // nested comments (Postgres)
        assert_eq!(texts("/* a /* b; */ c; */ select 1; select 2", DbEngine::Postgres).len(), 2);
        // E'' strings allow \' (Postgres), plain strings don't
        assert_eq!(texts(r"select E'it\'s;'; select 'a\'; select 1", DbEngine::Postgres), vec![r"select E'it\'s;'", r"select 'a\'", "select 1"]);
    }

    #[test]
    fn mysql_quoting_and_delimiter() {
        let my = "select 'it\\'s;' , `we;ird`, \"str;\" from t; # c;omment\nselect 2";
        assert_eq!(texts(my, DbEngine::Mysql), vec!["select 'it\\'s;' , `we;ird`, \"str;\" from t", "# c;omment\nselect 2"]);
        assert!(split("DELIMITER $$\ncreate procedure p() begin select 1; end $$", DbEngine::Mysql).is_err());
        assert!(texts("   ;  -- nothing\n ; ", DbEngine::Mysql).is_empty());
    }

    #[test]
    fn words_skip_strings_and_comments() {
        let s = &split("delete from t /* where */ -- where\n where 'where' = x", DbEngine::Postgres).unwrap()[0];
        assert_eq!(s.words, vec!["delete", "from", "t", "where", "x"]);
        let s = &split("SELECT 'é'::text AS café", DbEngine::Postgres).unwrap()[0];
        assert_eq!(s.words.last().map(String::as_str), Some("café"));
    }

    fn kind(sql: &str) -> Info {
        classify(&split(sql, DbEngine::Postgres).unwrap()[0])
    }

    #[test]
    fn classifies_statements() {
        assert_eq!(kind("SELECT * FROM users").kind, Kind::Read);
        assert_eq!(kind("  (select 1)").kind, Kind::Read);
        assert_eq!(kind("with x as (select 1) select * from x").kind, Kind::Read);
        assert_eq!(kind("with d as (delete from t returning *) select * from d").kind, Kind::Write);
        assert_eq!(kind("explain select 1").kind, Kind::Read);
        assert_eq!(kind("explain analyze delete from t").kind, Kind::Write);
        assert_eq!(kind("select * into backup_t from t").kind, Kind::Write);
        assert_eq!(kind("select * from t for update").kind, Kind::Write);
        assert_eq!(kind("update t set a = 1").kind, Kind::Write);
        assert_eq!(kind("call do_it()").kind, Kind::Write);
        assert_eq!(kind("frobnicate").kind, Kind::Write, "unknown counts as a write");
        assert_eq!(kind("drop table t").kind, Kind::Ddl);
        assert_eq!(kind("begin").kind, Kind::Begin);
        assert_eq!(kind("start transaction").kind, Kind::Begin);
        assert_eq!(kind("commit").kind, Kind::Commit);
        assert_eq!(kind("rollback").kind, Kind::Rollback);
        assert_eq!(kind("rollback to savepoint a").kind, Kind::Session);
        assert_eq!(kind("set search_path = app").kind, Kind::Session);
        assert!(kind("vacuum analyze t").no_tx);
        assert!(kind("create index concurrently i on t(a)").no_tx);
        assert!(kind("create database shop2").no_tx);
        assert!(!kind("create table t(a int)").no_tx);
    }

    #[test]
    fn guard_refuses_switching_read_only_off() {
        let g = |sql: &str, e| read_only_guard(&split(sql, e).unwrap()[0]).is_some();
        use DbEngine::*;
        assert!(g("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE", Postgres));
        assert!(g("set default_transaction_read_only = off", Postgres));
        assert!(g("SET transaction_read_only TO off", Postgres));
        assert!(g("begin read write", Postgres));
        assert!(g("START TRANSACTION READ WRITE", Postgres));
        assert!(g("reset all", Postgres));
        assert!(g("discard all", Postgres));
        assert!(g("select set_config('default_transaction_read_only', 'off', false)", Postgres));
        assert!(g("select pg_catalog.set_config('transaction_read_only', 'off', true)", Postgres));
        assert!(g("SET SESSION TRANSACTION READ WRITE", Mysql));
        assert!(g("set @@session.transaction_read_only = 0", Mysql));
        assert!(g("SET tx_read_only = 0", Mysql));
        // reading the setting, or a string that mentions it, is fine
        assert!(!g("select @@transaction_read_only", Mysql));
        assert!(!g("select 'read write'", Postgres));
        assert!(!g("set search_path = app", Postgres));
        assert!(!g("begin", Postgres));
    }

    #[test]
    fn char_positions() {
        let s = "select 'é', x";
        assert_eq!(char_index(s, s.find(", x").unwrap()), 10);
    }
}
