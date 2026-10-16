// Shortcuts into SQL (docs/07 §2.4). Pure helpers, unit-tested in sql.test.ts.

/** Images the Docker view offers "Open in SQL" for (the same rule as Rust `engine_of_image`). */
export function isDatabaseImage(image: string): boolean {
  const name = (image.split("/").pop() ?? image).split(/[:@]/)[0].toLowerCase();
  return !name.includes("exporter") && /postgres|postgis|timescale|mysql|mariadb|percona/.test(name);
}

/** This computer, as a connection address. */
export const isLocalAddress = (a: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(a.trim().toLowerCase());
