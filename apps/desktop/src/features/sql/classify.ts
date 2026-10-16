// Risk check before a script is sent (docs/07 §6). The server and the Rust side enforce
// read-only; this only decides when to ask first.
import type { Stmt } from "./split";

export type Kind = "read" | "write" | "ddl" | "tx" | "session";

const has = (s: Stmt, w: string) => s.words.some((x) => x.toUpperCase() === w);
const first = (s: Stmt) => (s.words[0] ?? "").toUpperCase();

/** What a statement does (same rules as `lex::classify` in Rust). */
export function kindOf(s: Stmt): Kind {
  const f = first(s);
  const data = ["INSERT", "UPDATE", "DELETE", "MERGE"].some((w) => has(s, w));
  switch (f) {
    case "SELECT":
      return has(s, "INTO") || pairs(s, "FOR", "UPDATE") || pairs(s, "FOR", "SHARE") ? "write" : "read";
    case "WITH":
      return data || has(s, "INTO") ? "write" : "read";
    case "EXPLAIN":
      return (has(s, "ANALYZE") || has(s, "ANALYSE")) && data ? "write" : "read";
    case "SHOW":
    case "DESCRIBE":
    case "DESC":
    case "VALUES":
    case "TABLE":
    case "HELP":
      return "read";
    case "BEGIN":
    case "START":
    case "COMMIT":
    case "END":
    case "ABORT":
      return "tx";
    case "ROLLBACK":
      return has(s, "TO") ? "session" : "tx";
    case "SAVEPOINT":
    case "RELEASE":
    case "SET":
    case "RESET":
    case "USE":
    case "LISTEN":
    case "UNLISTEN":
    case "DISCARD":
    case "DEALLOCATE":
    case "PREPARE":
      return "session";
    case "CREATE":
    case "ALTER":
    case "DROP":
    case "TRUNCATE":
    case "RENAME":
    case "GRANT":
    case "REVOKE":
    case "COMMENT":
    case "REINDEX":
    case "CLUSTER":
    case "VACUUM":
    case "ANALYZE":
    case "ANALYSE":
    case "REFRESH":
    case "OPTIMIZE":
    case "REPAIR":
      return "ddl";
    default:
      return "write";
  }
}

function pairs(s: Stmt, a: string, b: string) {
  for (let i = 0; i + 1 < s.words.length; i++) {
    if (s.words[i].toUpperCase() === a && s.words[i + 1].toUpperCase() === b) return true;
  }
  return false;
}

export interface Risk {
  /** Statements that change data or schema. */
  writes: boolean;
  /** Reasons to ask before running (empty = just run). */
  reasons: string[];
  /** DDL on MySQL: it commits any open transaction at once. */
  mysqlDdl: boolean;
}

export function classifySql(stmts: Stmt[], dialect: "postgres" | "mysql"): Risk {
  const reasons: string[] = [];
  let writes = false;
  let mysqlDdl = false;
  for (const s of stmts) {
    const k = kindOf(s);
    const f = first(s);
    if (k === "write" || k === "ddl") writes = true;
    if (k === "ddl" && dialect === "mysql" && !(f === "CREATE" && has(s, "TEMPORARY"))) mysqlDdl = true;
    if ((f === "UPDATE" || f === "DELETE") && !has(s, "WHERE")) reasons.push(`${f} without WHERE changes every row of the table`);
    if (f === "DROP") reasons.push("DROP removes it for good");
    if (f === "TRUNCATE") reasons.push("TRUNCATE empties the table");
    if (f === "ALTER") reasons.push("ALTER changes the table structure");
    if (f === "GRANT" || f === "REVOKE") reasons.push(`${f} changes permissions`);
  }
  if (stmts.length > 1 && writes) reasons.push(`${stmts.length} statements in one run, some of them change data`);
  return { writes, reasons: [...new Set(reasons)], mysqlDdl };
}
