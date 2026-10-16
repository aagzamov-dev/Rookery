import { describe, expect, it } from "vitest";
import { charToIndex, splitSql, statementAt } from "./split";
import { classifySql, kindOf } from "./classify";

const texts = (sql: string, d: "postgres" | "mysql" = "postgres") => splitSql(sql, d).statements.map((s) => s.text);

describe("splitSql", () => {
  it("splits only on top-level semicolons", () => {
    expect(texts("select 'a;b' as x; -- c;omment\nselect \"we;ird\" from t /* ; */;\n\n;select 2")).toEqual([
      "select 'a;b' as x",
      "-- c;omment\nselect \"we;ird\" from t /* ; */",
      "select 2",
    ]);
  });

  it("keeps dollar-quoted bodies together; $1 is a parameter", () => {
    const f = "create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql; select $1;";
    expect(texts(f)).toHaveLength(2);
    expect(texts("do $$ begin perform 1; end $$; select 1")).toHaveLength(2);
  });

  it("handles nested comments and E'' strings (Postgres)", () => {
    expect(texts("/* a /* b; */ c; */ select 1; select 2")).toHaveLength(2);
    expect(texts("select E'it\\'s;'; select 'a\\'; select 1")).toEqual(["select E'it\\'s;'", "select 'a\\'", "select 1"]);
  });

  it("knows MySQL quoting and refuses DELIMITER", () => {
    const my = "select 'it\\'s;' , `we;ird`, \"str;\" from t; # c;omment\nselect 2";
    expect(texts(my, "mysql")).toEqual(["select 'it\\'s;' , `we;ird`, \"str;\" from t", "# c;omment\nselect 2"]);
    expect(splitSql("DELIMITER $$\ncreate procedure p() begin select 1; end $$", "mysql").error).toMatch(/DELIMITER/);
    expect(texts("   ;  -- nothing\n ; ", "mysql")).toEqual([]);
  });

  it("collects words outside strings and comments", () => {
    const [s] = splitSql("delete from t /* where */ -- where\n where 'where' = x", "postgres").statements;
    expect(s.words).toEqual(["delete", "from", "t", "where", "x"]);
  });

  it("finds the statement at the cursor", () => {
    const sql = "select 1;\n\nselect 2;  ";
    const { statements } = splitSql(sql, "postgres");
    expect(statementAt(statements, 3)?.text).toBe("select 1");
    expect(statementAt(statements, 10)?.text).toBe("select 1"); // blank line after the first ;
    expect(statementAt(statements, sql.indexOf("2"))?.text).toBe("select 2");
    expect(statementAt(statements, sql.length)?.text).toBe("select 2");
  });

  it("maps Rust char positions to JS indices", () => {
    const t = "select '😀', x";
    expect(t.slice(charToIndex(t, 10))).toBe(", x");
  });
});

const risk = (sql: string, d: "postgres" | "mysql" = "postgres") => classifySql(splitSql(sql, d).statements, d);

describe("classifySql", () => {
  it("lets reads run without asking", () => {
    expect(risk("select * from users where id = 1")).toEqual({ writes: false, reasons: [], mysqlDdl: false });
    expect(risk("select 1; select 2").reasons).toEqual([]);
  });

  it("asks for UPDATE / DELETE without WHERE", () => {
    expect(risk("delete from orders").reasons[0]).toMatch(/DELETE without WHERE/);
    expect(risk("update users set admin = true").reasons[0]).toMatch(/UPDATE without WHERE/);
    expect(risk("delete from orders where id = 4").reasons).toEqual([]);
    // the word inside a comment or string does not count
    expect(risk("delete from orders -- where id = 4").reasons).toHaveLength(1);
  });

  it("asks for DROP, TRUNCATE, ALTER, GRANT / REVOKE", () => {
    expect(risk("drop table t").reasons[0]).toMatch(/DROP/);
    expect(risk("truncate t").reasons[0]).toMatch(/TRUNCATE/);
    expect(risk("alter table t add c int").reasons[0]).toMatch(/ALTER/);
    expect(risk("grant select on t to bob").reasons[0]).toMatch(/permissions/);
  });

  it("asks for several statements when one of them writes", () => {
    expect(risk("select 1; update t set a = 1 where id = 2").reasons[0]).toMatch(/2 statements/);
  });

  it("flags MySQL DDL (it commits at once)", () => {
    expect(risk("alter table t add c int", "mysql").mysqlDdl).toBe(true);
    expect(risk("create temporary table t (a int)", "mysql").mysqlDdl).toBe(false);
    expect(risk("alter table t add c int").mysqlDdl).toBe(false);
  });

  it("knows statement kinds", () => {
    const k = (sql: string) => kindOf(splitSql(sql, "postgres").statements[0]);
    expect(k("with d as (delete from t returning *) select * from d")).toBe("write");
    expect(k("explain analyze update t set a = 1")).toBe("write");
    expect(k("explain select 1")).toBe("read");
    expect(k("rollback to savepoint a")).toBe("session");
    expect(k("commit")).toBe("tx");
  });
});

describe("csv", () => {
  it("quotes only when needed and writes NULL as empty", async () => {
    const { toCsv, toTsv, numericColumns } = await import("./csv");
    expect(toCsv(["id", "note"], [["1", 'say "hi", ok'], ["2", null], ["3", " pad"]])).toBe('id,note\r\n1,"say ""hi"", ok"\r\n2,\r\n3," pad"\r\n');
    expect(toTsv([["a\tb", "line1\nline2", null]])).toBe("a b\tline1 line2\t");
    expect(numericColumns([false, false, true], [["1.5", "x", "a"], [null, "2", "b"], ["-3e2", "3", "c"]])).toEqual([true, false, true]);
  });
});
