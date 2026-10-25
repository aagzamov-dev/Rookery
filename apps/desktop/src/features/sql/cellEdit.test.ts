import { describe, expect, it } from "vitest";
import type { TableDetail } from "../../ipc/bindings/TableDetail";
import { cellIdentity, editableType } from "./cellEdit";

const detail: TableDetail = {
  schema: "public",
  name: "users",
  kind: "table",
  engine: "InnoDB",
  collation: null,
  comment: null,
  create_sql: null,
  rows_est: null,
  size_bytes: null,
  foreign_keys: [],
  referenced_by: [],
  columns: [
    { name: "id", data_type: "bigint", nullable: false, default: null, key: "PRI", extra: null, comment: null },
    { name: "name", data_type: "text", nullable: true, default: null, key: null, extra: null, comment: null },
  ],
  indexes: [{ name: "pk", columns: ["id"], primary: true, unique: true }],
};

describe("cell edit eligibility", () => {
  it("identifies a row with the original key, including when editing the key", () => {
    expect(cellIdentity(detail, "postgres", ["name", "id"], ["Alice", "42"], "id")).toEqual({ keys: [["id", "42"]], reason: null });
  });
  it("requires every column of a composite key and allows empty text keys", () => {
    const composite = { ...detail, indexes: [{ name: "pk", columns: ["id", "name"], primary: true, unique: true }] };
    expect(cellIdentity(composite, "mysql", ["id", "name"], ["1", ""], "name").keys).toEqual([
      ["id", "1"],
      ["name", ""],
    ]);
    expect(cellIdentity(composite, "mysql", ["id", "name"], ["1", null], "name").reason).toBeTruthy();
  });
  it("falls back to a complete unique key", () => {
    const unique = { ...detail, indexes: [...detail.indexes, { name: "name_unique", columns: ["name"], primary: false, unique: true }] };
    expect(cellIdentity(unique, "postgres", ["name"], ["Alice"], "name").keys).toEqual([["name", "Alice"]]);
    expect(cellIdentity({ ...detail, indexes: [] }, "postgres", ["id", "name"], ["1", "Alice"], "name").reason).toBeTruthy();
  });
  it("allows editable columns with database-generated defaults", () => {
    const defaults = { ...detail, columns: detail.columns.map((c) => (c.name === "name" ? { ...c, extra: "DEFAULT_GENERATED" } : c)) };
    expect(cellIdentity(defaults, "mysql", ["id", "name"], ["1", "Alice"], "name").reason).toBeNull();
  });
  it("rejects views, nontransactional tables, generated and binary columns", () => {
    for (const d of [
      { ...detail, kind: "view" },
      { ...detail, engine: "MyISAM" },
      { ...detail, columns: detail.columns.map((c) => (c.name === "name" ? { ...c, extra: "STORED GENERATED" } : c)) },
      { ...detail, columns: detail.columns.map((c) => (c.name === "name" ? { ...c, data_type: "blob" } : c)) },
    ])
      expect(cellIdentity(d, "mysql", ["id", "name"], ["1", "Alice"], "name").reason).toBeTruthy();
  });
  it("supports ordinary scalar types while excluding lossy binary and array representations", () => {
    for (const t of ["jsonb", "numeric(10,2)", "bigint unsigned", "timestamp(6) with time zone", "varchar(255)"]) expect(editableType(t)).toBe(true);
    for (const t of ["bytea", "blob", "text[]", "geometry", "bit(8)"]) expect(editableType(t)).toBe(false);
  });
});
