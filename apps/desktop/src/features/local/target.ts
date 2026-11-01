export const COMPUTER_ID = "__computer__";
export const COMPUTER_TAB_ID = `server:${COMPUTER_ID}`;
export const isAbsolutePath = (path: string) =>
  path.startsWith("/") ||
  /^[A-Za-z]:[/\\]/.test(path) ||
  path.startsWith("\\\\");
export const normalizeLocalPath = (path: string) =>
  /^[A-Za-z]:[/\\]/.test(path) || path.startsWith("\\\\")
    ? path.replaceAll("\\", "/")
    : path;
