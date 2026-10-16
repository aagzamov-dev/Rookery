//! Builds the schema tree from the text rows of the catalog queries (same shape for both engines).

use std::collections::BTreeMap;

use super::{ColumnInfo, IndexInfo, SchemaInfo, TableInfo};

pub type TextRow = Vec<Option<String>>;

/// Separator between index column names in the index query.
pub const COL_SEP: char = '\u{1f}';

fn s(r: &TextRow, i: usize) -> String {
    r.get(i).cloned().flatten().unwrap_or_default()
}

fn flag(r: &TextRow, i: usize) -> bool {
    matches!(s(r, i).to_ascii_lowercase().as_str(), "t" | "true" | "yes" | "1")
}

fn table_kind(raw: &str) -> &'static str {
    match raw {
        "v" | "VIEW" | "SYSTEM VIEW" => "view",
        "m" => "matview",
        "p" => "partitioned",
        "f" => "foreign",
        _ => "table",
    }
}

/// - `schemas`: [name] (so empty schemas still show)
/// - `tables`: [schema, table, kind, rows_est]
/// - `columns`: [schema, table, column, type, nullable, default] in column order
/// - `indexes`: [schema, table, index, unique, primary, columns joined by [`COL_SEP`]]
pub fn build(schemas: &[TextRow], tables: &[TextRow], columns: &[TextRow], indexes: &[TextRow]) -> Vec<SchemaInfo> {
    let mut tree: BTreeMap<String, BTreeMap<String, TableInfo>> = BTreeMap::new();
    for r in schemas {
        tree.entry(s(r, 0)).or_default();
    }
    for r in tables {
        let rows_est = s(r, 3).parse::<f64>().ok().map(|v| v as i64).filter(|v| *v >= 0);
        tree.entry(s(r, 0)).or_default().insert(
            s(r, 1),
            TableInfo { name: s(r, 1), kind: table_kind(&s(r, 2)).into(), rows_est, columns: vec![], indexes: vec![] },
        );
    }
    for r in columns {
        if let Some(t) = tree.get_mut(&s(r, 0)).and_then(|m| m.get_mut(&s(r, 1))) {
            t.columns.push(ColumnInfo {
                name: s(r, 2),
                data_type: s(r, 3),
                nullable: flag(r, 4),
                default: r.get(5).cloned().flatten(),
                key: None,
            });
        }
    }
    for r in indexes {
        if let Some(t) = tree.get_mut(&s(r, 0)).and_then(|m| m.get_mut(&s(r, 1))) {
            let cols: Vec<String> = s(r, 5).split(COL_SEP).filter(|c| !c.is_empty()).map(String::from).collect();
            t.indexes.push(IndexInfo { name: s(r, 2), unique: flag(r, 3) || flag(r, 4), primary: flag(r, 4), columns: cols });
        }
    }
    tree.into_iter()
        .map(|(name, tables)| SchemaInfo {
            name,
            tables: tables
                .into_values()
                .map(|mut t| {
                    mark_keys(&mut t);
                    t
                })
                .collect(),
        })
        .collect()
}

/// PRI for primary-key columns, UNI for single-column unique indexes, MUL for the first column of others.
fn mark_keys(t: &mut TableInfo) {
    for c in &mut t.columns {
        let in_pk = t.indexes.iter().any(|i| i.primary && i.columns.contains(&c.name));
        let uni = t.indexes.iter().any(|i| i.unique && i.columns.len() == 1 && i.columns[0] == c.name);
        let mul = t.indexes.iter().any(|i| i.columns.first() == Some(&c.name));
        c.key = if in_pk {
            Some("PRI".into())
        } else if uni {
            Some("UNI".into())
        } else if mul {
            Some("MUL".into())
        } else {
            None
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(v: &[Option<&str>]) -> TextRow {
        v.iter().map(|x| x.map(String::from)).collect()
    }

    #[test]
    fn postgres_catalog_rows_become_a_tree() {
        let schemas = vec![row(&[Some("public")]), row(&[Some("audit")])];
        let tables = vec![
            row(&[Some("public"), Some("users"), Some("r"), Some("1234")]),
            row(&[Some("public"), Some("active_users"), Some("v"), Some("-1")]),
        ];
        let columns = vec![
            row(&[Some("public"), Some("users"), Some("id"), Some("bigint"), Some("f"), Some("nextval('users_id_seq'::regclass)")]),
            row(&[Some("public"), Some("users"), Some("email"), Some("character varying(255)"), Some("f"), None]),
            row(&[Some("public"), Some("users"), Some("team_id"), Some("integer"), Some("t"), None]),
            row(&[Some("public"), Some("ghost"), Some("x"), Some("int"), Some("t"), None]), // unknown table: ignored
        ];
        let sep = COL_SEP.to_string();
        let indexes = vec![
            row(&[Some("public"), Some("users"), Some("users_pkey"), Some("t"), Some("t"), Some("id")]),
            row(&[Some("public"), Some("users"), Some("users_email_key"), Some("t"), Some("f"), Some("email")]),
            row(&[Some("public"), Some("users"), Some("users_team"), Some("f"), Some("f"), Some(&format!("team_id{sep}email"))]),
        ];
        let tree = build(&schemas, &tables, &columns, &indexes);
        assert_eq!(tree.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["audit", "public"]);
        let public = &tree[1];
        assert_eq!(public.tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["active_users", "users"]);
        assert_eq!(public.tables[0].kind, "view");
        assert_eq!(public.tables[0].rows_est, None);
        let users = &public.tables[1];
        assert_eq!(users.rows_est, Some(1234));
        let keys: Vec<Option<&str>> = users.columns.iter().map(|c| c.key.as_deref()).collect();
        assert_eq!(keys, vec![Some("PRI"), Some("UNI"), Some("MUL")]);
        assert!(!users.columns[0].nullable && users.columns[2].nullable);
        assert_eq!(users.indexes[2].columns, vec!["team_id".to_string(), "email".to_string()]);
    }

    #[test]
    fn mysql_catalog_rows_become_a_tree() {
        let tables = vec![
            row(&[Some("shop"), Some("orders"), Some("BASE TABLE"), Some("812")]),
            row(&[Some("shop"), Some("v_sales"), Some("VIEW"), None]),
        ];
        let columns = vec![row(&[Some("shop"), Some("orders"), Some("id"), Some("int unsigned"), Some("NO"), None])];
        let indexes = vec![row(&[Some("shop"), Some("orders"), Some("PRIMARY"), Some("1"), Some("1"), Some("id")])];
        let tree = build(&[], &tables, &columns, &indexes);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].tables[0].columns[0].key.as_deref(), Some("PRI"));
        assert_eq!(tree[0].tables[1].kind, "view");
    }
}
