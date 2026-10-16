// CSV / TSV for result copy and export. NULL becomes an empty field.

type Cell = string | null;

function csvField(v: Cell): string {
  if (v == null) return "";
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(columns: string[], rows: Cell[][]): string {
  const lines = [columns.map(csvField).join(",")];
  for (const r of rows) lines.push(r.map(csvField).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Tab-separated (pastes into spreadsheets); tabs / newlines inside values become spaces. */
export function toTsv(rows: Cell[][]): string {
  return rows.map((r) => r.map((v) => (v ?? "").replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");
}

const NUM = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Right-align a column when the driver says it is numeric, or every value looks like a number. */
export function numericColumns(declared: boolean[], rows: Cell[][]): boolean[] {
  return declared.map((d, c) => {
    if (d) return true;
    let seen = 0;
    for (let r = 0; r < rows.length && r < 200; r++) {
      const v = rows[r][c];
      if (v == null) continue;
      if (!NUM.test(v)) return false;
      seen++;
    }
    return seen > 0;
  });
}
