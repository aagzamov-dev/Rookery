// One place for copy/paste: Rust clipboard first, browser clipboard as fallback.
// Errors are thrown with a readable message so callers can show them.
import { api, asCoreError } from "./api";

export async function copyText(text: string): Promise<void> {
  try {
    await api.clipboardWrite(text);
    return;
  } catch (e) {
    console.warn("clipboard_write failed, trying the browser clipboard", e);
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e2) {
      throw new Error(`Couldn't copy: ${asCoreError(e).message} / ${String(e2)}`);
    }
  }
}

export async function readClipboard(): Promise<string> {
  try {
    return await api.clipboardRead();
  } catch (e) {
    console.warn("clipboard_read failed, trying the browser clipboard", e);
    try {
      return await navigator.clipboard.readText();
    } catch (e2) {
      throw new Error(`Couldn't read the clipboard: ${asCoreError(e).message} / ${String(e2)}`);
    }
  }
}
