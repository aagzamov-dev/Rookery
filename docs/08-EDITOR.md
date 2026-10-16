# 08 — Editor (v0.8)

Status: **built in 0.8.0** (§9 lists what is left). Read [00-START-HERE.md](00-START-HERE.md) first.

Goal: open any text file on a server, edit it comfortably, and save it **without ever losing a change**: not yours, not someone else's.

---

## 1. Where
- **Server tab → Editor** (Ctrl+9), next to Files.
  - **Left:** the server's folders (SFTP, loaded per folder as you open it). It starts at the folder you last showed on this server, else where the Files view is, else home.
    - Click a folder to expand it; **double-click** to show only that folder (go into it).
    - The **path on top** is clickable: any part goes back up to it (long paths fold the middle into "…").
    - **Back** (Alt+←), **Up** (Alt+↑), **Home**, **Go to folder…**, **Reload**.
    - **Right-click**: Show only this folder, Open, Pin / Unpin, Refresh, cd here in terminal, Copy path.
    - The shown folder is remembered per server (`ui.editor.roots`).
  - **Right:** tabs with one file each.
- **Other ways to open a file:**
  - Files → double-click a file, or its **Edit in Rookery** button (**Edit locally** still opens it in a program on this PC);
  - **Open path…** (`Ctrl+O` in the Editor) for any path (absolute, or `~/…`).
- **Pinned files** per server (`.env`, `docker-compose.yml`, `nginx.conf`…) sit above the tree: one click opens one.
  - Setting `ui.editor.pins`: paths only, no content.

## 2. What can be opened
| Case | Behaviour |
|---|---|
| UTF-8 text ≤ 5 MB | Editable. |
| UTF-8 text 5–20 MB | Read-only (too big to edit safely here; use Files → Edit locally). |
| > 20 MB, binary (NUL bytes in the first 8 KB), not UTF-8 | Not opened: a message says why. Nothing is ever written back. |
| A UTF-8 BOM | Kept: removed for editing, written back exactly. |
| Line endings | The file's style (LF or CRLF, by majority) is kept on save; the status bar shows it. |
| Final newline | Kept as it was. |
| A symlink | The target is edited (the link stays a link). |
| No read permission | Not opened ("permission denied"). |

## 3. Editing
- **CodeMirror 6**, the same engine as the SQL editor. Language support loads only for the file type you open.
- **Languages** (by extension / name):
  - `.env*` (own highlighter);
  - JSON;
  - YAML (`docker-compose*.yml`);
  - JS / TS / JSX;
  - PHP;
  - Python;
  - HTML, CSS / SCSS, Markdown, XML, SQL;
  - shell (`.sh`, `.bashrc`…);
  - nginx (`*.conf` in nginx dirs, `nginx.conf`);
  - Dockerfile;
  - INI / TOML / `.properties`.
  - Unknown types → plain text.
- **Editing basics:**
  - line numbers, active line, bracket matching, auto-indent, folding;
  - search / replace (regex);
  - multi-cursor (Alt+click), rectangular selection (Alt+drag), go to line (Ctrl+G);
  - word wrap toggle, show whitespace toggle;
  - undo / redo history per tab;
  - the Slate Blue colours and the terminal font.
- **Format** (Shift+Alt+F):
  - JSON / YAML / JS / TS / CSS / SCSS / HTML / Markdown use Prettier, loaded on first use only;
  - `.env` gets Rookery's own tidy-up (trim, one `KEY=value` per line, keeps comments and order).
  - Formatting changes only the editor text; nothing is saved until you save.
- **Problems while typing:**
  - JSON (exact position);
  - YAML (indentation, duplicate keys);
  - `.env`: duplicate keys, spaces around `=`, value with spaces but no quotes, key with invalid characters.
  - Shown as underlines plus a count in the status bar.
- **Hide values** (`.env` only, toggle): values are shown as `••••••` on screen. Copy copies the real text; editing works normally.

## 4. Saving (the safety part)
Rookery remembers the **version** of each file when it opens it: size, modification time and a SHA-256 of the content.

**Ctrl+S**:
1. **Unchanged?** Rookery reads the file on the server again and compares its SHA-256 with the version you opened. If it differs, it does **not** write: it opens the **merge view** (§5).
2. **PROD server:** a review shows exactly what changes (old / new lines) and must be confirmed.
3. **Backup:** the version on the server is copied to this PC first (§6). If the backup fails, nothing is written.
4. **Write**, the safest way the file allows:
   - **You own the file:** write a temporary file next to it (`.<name>.rookery-<random>.tmp`), give it the original's group and permissions, then one `mv -f` replaces the original. That's atomic: a dropped connection can never leave a half-written file.
     - The rename happens only if the temp file then looks exactly like the original (one link, same group, same mode, checked with `stat` on the server). Otherwise (hard links, a group you can't set, a server without GNU `stat`) it is written in place instead.
     - An error while writing the temp file (e.g. disk full) stops the save: the original is untouched.
   - **Someone else owns it, but you may write it** (group write): write in place, so its owner, group and permissions stay exactly as they were. Not atomic, but the backup has the old version.
   - **No write permission:** the save stops with "Permission denied". You can then **Save with sudo** (asks first).
     - The text goes into a private temp file in `/tmp` (mode 600, created exclusively), then `sudo -S -p '' cp -- TMP FILE` copies it over the file; `cp` onto an existing file keeps its owner and permissions. The temp file is removed afterwards, also on failure.
     - The sudo password comes from the vault (the login's sudo password, or its login password), never shown. It is the **only** thing on sudo's stdin: with passwordless sudo nothing reads it, so it can never end up in the file.
5. **Verify:** Rookery reads the file back and checks the SHA-256 matches what you saved. That becomes the new version.

Unsaved changes show a ● on the tab (and on the Editor view button).
- Closing a file tab with unsaved changes asks **Save / Don't save** (or cancel).
- Closing the server tab or the app asks **Show them / Don't save** (or cancel); "Show them" opens the first unsaved file.

Text that is already exactly on the server is not written again. A stray `\r` inside a line is kept as a character, so saving never changes bytes you didn't edit.

## 5. Someone else changed the file
- **While you edit:** when you come back to the window, the Editor view or a file tab, Rookery checks the file's size and time; it never polls (and every save checks the content anyway).
  - A tab **without** unsaved changes reloads by itself (Ctrl+Z brings the old text back); only a new time with the same content just updates the version.
  - A tab **with** unsaved changes gets a banner: "Changed on the server 2 min ago · **Compare** · **Reload (drop mine)**".
- **When you save and it changed:** a **three-way merge**:
  - **base** = what you opened, **theirs** = on the server now, **yours** = the editor.
  - Changes in different lines are combined automatically. You see the result side by side with the server version before saving it.
  - Changes in the same lines are listed as **conflicts**. For each one: **Keep mine / Keep theirs / Keep both**, or edit the text directly.
  - Saving the merge saves with "theirs" as the new base. If the file changed *again* meanwhile, you get the merge again: no write without an up-to-date base.
- **Overwrite with mine** and **Use the server's version** exist only inside the merge view, and ask again.
- **Deleted on the server:** saving asks whether to create the file again with your text.
- **Not known:** *who* changed the file. Servers don't record that for normal edits, so Rookery shows the time and size only.

## 6. Local backups and history
- **Before every save:** the server's version is stored in `%APPDATA%\Rookery\editor-backups\<server>\<file id>\<time>.bak`, plus a small index (path, time, size, SHA-256).
- **Kept:** the last 20 per file and at most 30 days. On this PC only: never synced or included in backups, since they may contain secrets.
- **History** (button in the editor toolbar): the list of backups for the open file. Open one to compare it with the editor, then **Restore into editor**. Restoring only changes the editor; you still save.

## 7. Rust API (`crates/rookery-core/src/editor.rs`)
- `editor_open(host_id, path)` → `EditorFile`: `{ path, real_path, content, version, eol, mixed_eol, bom, read_only, read_only_reason, owned, mode }`.
- `editor_stat(host_id, path)` → `FileStamp { size, mtime, exists }`: the cheap "did it change?" check.
- `editor_save(host_id, path, content, eol, bom, base: FileVersion, mode)` → `SaveOutcome`:
  - `Saved { version, method }` (`atomic` | `in_place` | `sudo` | `unchanged`);
  - `Conflict { theirs, theirs_version, deleted }`: nothing was written;
  - `NeedsSudo { message }`.
  - `mode` = `normal` | `sudo` | `overwrite` (overwrite only from the merge view).
- `editor_backups(host_id, path)`, `editor_backup_read(host_id, path, id)`.
- **Frontend** (`apps/desktop/src/features/editor/`): `EditorWorkspace.tsx` (view, tree, tabs), `actions.ts` (open / reload / save / change checks), `docs.ts` (one CodeMirror state per tab, theme), `languages.ts`, `format.ts`, `env.ts`, `merge.ts`, `Dialogs.tsx` (merge, PROD review, history). Tab info: `stores/editor.ts`.
- **Rules:**
  - content goes webview → Rust → server only;
  - file contents are never logged;
  - paths are absolute and normalised (no `..`);
  - temporary files are named `.<name>.rookery-<random>.tmp` and removed on any failure;
  - every remote command quotes paths with `shell_quote`.

## 8. Done checks
- **Rust unit tests:** EOL / BOM round trip; binary and non-UTF-8 detection; a stray `\r` is kept; the backup index (prune to 20 and 30 days, one copy per version); path normalisation.
- **Frontend tests:** language pick by file name; the three-way merge (no conflict / conflict / both sides identical); the `.env` formatter and linter.
- **Manual, on a real server:**
  - edit and save (atomic);
  - change the file in a terminal meanwhile → merge;
  - a root-owned file → "Permission denied" → sudo;
  - CRLF file stays CRLF;
  - a big log opens read-only;
  - a binary is refused;
  - PROD asks for review;
  - History restores.

## 9. Later (not in 0.8.0)
- Docker → a compose project → **Edit compose file** (the container list does not know the compose file path yet).
- Create a new file from the Editor (today: create it in a terminal or upload it, then open it).
- Edit files inside Docker containers (`docker cp` / `docker exec cat` through the same safe save).
- Search across a folder (grep) and Ctrl+P across the whole project.
- Split view of two files.
- Local files on this PC.
- Recreate button after editing a compose file / `.env`.
