import type { BackupTable } from "../../ipc/bindings/BackupTable";
import type { TableSelection } from "../../ipc/bindings/TableSelection";

export const tableKey = (table: { schema: string; name: string }) => JSON.stringify([table.schema, table.name]);
export const mb = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`;
export function tableTotals(tables: BackupTable[], selection: TableSelection[]) {
  const modes = new Map(selection.map((table) => [tableKey(table), table.mode]));
  return tables.reduce((total, table) => {
    total.data += table.data_bytes;
    total.index += table.index_bytes;
    if (modes.get(tableKey(table)) === "data") total.selected += table.data_bytes + table.index_bytes;
    return total;
  }, { data: 0, index: 0, selected: 0 });
}
