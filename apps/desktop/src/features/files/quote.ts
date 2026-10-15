/** POSIX single-quote for commands typed into a terminal (same rule as rookery-core). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
