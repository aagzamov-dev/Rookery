import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { columnOrder, EMPTY_LAYOUT, moveColumn } from "./tableLayout";
import { filterText } from "./TableView";

describe("table grid layout", () => {
  const names = ["id", "email", "name", "created_at"];

  it("keeps the saved order, adds new columns at the end, leaves hidden ones out", () => {
    const layout = { ...EMPTY_LAYOUT, order: ["name", "id", "gone"], hidden: ["email"] };
    expect(columnOrder(names, layout).map((i) => names[i])).toEqual(["name", "id", "created_at"]);
    expect(columnOrder(names, EMPTY_LAYOUT)).toEqual([0, 1, 2, 3]);
  });

  it("moves a column by display position and keeps hidden ones", () => {
    const layout = { ...EMPTY_LAYOUT, hidden: ["email"] };
    const order = columnOrder(names, layout); // id, name, created_at
    expect(moveColumn(names, order, 2, 0)).toEqual(["created_at", "id", "name", "email"]);
  });

  it("describes filters in words", () => {
    expect(filterText({ column: "email", op: "contains", value: "bob" })).toBe("email contains bob");
    expect(filterText({ column: "deleted_at", op: "is_null", value: null })).toBe("deleted_at is NULL");
    expect(filterText({ column: "id", op: "ge", value: "10" })).toBe("id ≥ 10");
  });
});
