import type { DbEngine } from "../../ipc/bindings/DbEngine";
import type { TableDetail } from "../../ipc/bindings/TableDetail";

export function editableType(type: string): boolean {
  const name = type
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+unsigned$/, "")
    .trim();
  return /^(text|tinytext|mediumtext|longtext|character varying|varchar|character|char|smallint|tinyint|integer|int|mediumint|bigint|numeric|decimal|real|float|double precision|double|boolean|bool|uuid|json|jsonb|date|timestamp(?: with(?:out)? time zone)?|datetime|time(?: with(?:out)? time zone)?)$/.test(
    name,
  );
}

export function cellIdentity(
  detail: TableDetail | null,
  engine: DbEngine,
  names: string[],
  row: (string | null)[],
  column: string,
): { keys: [string, string][]; reason: string | null } {
  const no = (reason: string) => ({ keys: [], reason });
  if (!detail) return no("Table details are loading.");
  if (!["table", "partitioned"].includes(detail.kind)) return no("Only base tables can be edited.");
  if (engine === "mysql" && detail.engine?.toLowerCase() !== "innodb") return no("Editing requires an InnoDB table.");
  const field = detail.columns.find((c) => c.name === column);
  if (!field || !editableType(field.data_type)) return no("This column type cannot be edited as text.");
  if (/^(generated|identity)$|(stored|virtual) generated/i.test(field.extra ?? "")) return no("Generated and identity columns cannot be edited.");
  const index = [...detail.indexes]
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .find(
      (i) =>
        (i.primary || i.unique) &&
        i.columns.length > 0 &&
        i.columns.every((name) => {
          const c = detail.columns.find((f) => f.name === name);
          return c && editableType(c.data_type) && names.includes(name) && row[names.indexOf(name)] != null;
        }),
    );
  if (!index) return no("This row needs a complete primary or unique key before it can be edited.");
  return { keys: index.columns.map((name) => [name, row[names.indexOf(name)]!]), reason: null };
}
