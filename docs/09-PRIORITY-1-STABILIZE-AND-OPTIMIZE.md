# Priority 1 — Stabilize and optimize current features

Status: implementation and regression checks completed locally on `codex/priority-1-stabilize`; release validation limits are recorded below. Created 2026-10-25. No commit or push.

This is the first of four implementation plans. Finish reliability work before expanding the product. Continue with [Priority 2](10-PRIORITY-2-CORE-WORKFLOWS.md), [Priority 3](11-PRIORITY-3-APPLICATION-TOOLS.md), then [Priority 4](12-PRIORITY-4-EXPANSION.md). Each task is independently deliverable; the files are not instructions to implement everything at once.

## Instructions for the implementing AI

- Read `00-START-HERE.md`, current architecture/specs, applicable AGENTS.md, and the actual code first. Some older specifications describe planned behavior rather than implemented behavior.
- Inspect `git status` and preserve existing changes. Check installed dependency versions before using APIs. Use the Rust core, typed IPC, existing stores, shared UI, and visibility subscription engine. Do not rewrite the architecture.
- Keep changes limited to the selected task. No new accounts, paid services, server agents, automatic remote changes, or dependency upgrades unless required and authorized.
- Record reproduction, root cause, changed behavior, verification, and remaining limits. Never describe an inspection hypothesis as a confirmed bug.
- Run relevant frontend/Rust tests, typecheck, and desktop build when appropriate. Core tests generate TS bindings: inspect those changes. Use disposable databases/servers for integration tests, never user production data.
- Update existing roadmap/spec/changelog entries after implementation. Do not commit, publish, or release unless requested.

## P1-01 — SQL errors must not leave the connection unusable

**Reported problem:** Sometimes SQL returns an error and subsequent operations fail until the user disconnects and reconnects. The user confirmed MySQL and PostgreSQL after laptop sleep or internet loss: disconnect/retry could leave the tab unusable. The original error text is unavailable. This is the highest priority.

**Current behavior:** `crates/rookery-core/src/sql/manager.rs` already has `ensure_conn`, connection watchers, fatal-error invalidation, idle close, cancellation, and PostgreSQL savepoints. Do not add a competing recovery system. The inspected `Conn::is_closed` checks PostgreSQL but returns false for MySQL. Some savepoint cleanup errors are ignored. These are investigation leads, not a proven explanation of the report.

**Inspect:** `sql/{manager,pg,mysql}.rs`, `forward.rs`, `ssh.rs`, `apps/desktop/src/stores/sql.ts`, `ipc/events.ts`, and `features/sql/{SqlTab,DbTab,ServerDbView,TableView,SchemaTree}.tsx`.

**Work:**
1. Reproduce with PostgreSQL and MySQL/MariaDB, direct and SSH routes. Capture sanitized engine error codes, query/session IDs, connection generation, transaction state, and lifecycle transitions. Do not log passwords, SQL literals, or connection URLs containing credentials.
2. Separate ordinary statement errors, aborted transactions, permission errors, timeouts/cancellation, transport failures, authentication failures, and stale UI state. A syntax error must not require reconnecting.
3. Verify every failed request releases busy/query state and emits a terminal result, including schema loading, table browsing, cell updates, commit/rollback, and cancellation.
4. Invalidate unusable driver connections consistently. Check MySQL driver health/error APIs against the installed version; avoid an extra ping before every query without evidence it is needed.
5. Verify PostgreSQL savepoint rollback/release failures are handled explicitly and transaction state matches the server. Do not hide a failed cleanup behind the original statement error.
6. Inspect SSH forward lifecycle after SSH reconnect. Ensure a subsequent DB connection uses a working forward/session instead of stale endpoints or handles.
7. Serialize recovery per session and ignore stale generation events. Reapply database selection, read-only protection, timeout, and other required session settings.
8. Show Connected / Reconnecting / Connection lost / Authentication required accurately. Keep query drafts, selected table, and useful results. Offer a focused reconnect action if automatic recovery cannot proceed.
9. Reconnect for the next user-requested operation. Never silently replay an already submitted statement or multi-statement script. Even SELECT can invoke side effects. A lost response to COMMIT/write can mean an unknown outcome; do not claim rollback without evidence.

**Check:** Valid query after syntax error; failed statement within a transaction; cancel then query; timeout then query; row cap then query; idle expiry; database restart; killed connection; Wi-Fi/SSH loss; recovery while two UI operations arrive; schema/table refresh after error; expired credentials; commit-response loss. Verify temporary write permission does not become permanent through reconnect.

**Done:** Recoverable errors no longer require manual disconnect/connect. Unrecoverable cases explain the reason and recovery action. No silent duplicate execution, stuck spinner, lost draft, or incorrect transaction-success message. Add regression tests for the reproduced root cause and relevant lifecycle races; identify unavailable integration environments explicitly.

## P1-02 — Make existing SSH behavior honest and recoverable

**Current:** `ssh.rs` logs a warning for `jump_host_id` and attempts a direct connection. SSH-agent authentication returns an unsupported-feature error. Tunnels is a placeholder in `features/pages/Pages.tsx`.

**Work:** Reject unsupported configured routes clearly rather than silently connecting directly. Make unsupported authentication/routes unavailable or clearly labeled in forms/import previews. Distinguish network, key verification, authentication, and permission failures. Preserve terminal/editor state during reconnect. Full jump-host and agent implementation belongs to P2-03.

**Check/done:** Unsupported routes do not initiate direct connections. Retry does not create duplicate sessions or streams. A bad password, changed host key, offline host, sleep/wake, and reconnect each produce an accurate state and useful next action. Never weaken host-key checks.

## P1-03 — Correct log delivery and reconnection

**Current:** `stores/logs.ts` keeps 5,000 lines and discards timestamped lines at or before `lastTs`. Distinct entries sharing one timestamp can be discarded. `subscriptions.rs` already batches log events.

**Work:** Preserve distinct equal-timestamp entries and handle overlap at reconnect boundaries without global text deduplication. Inspect timestamp precision/order assumptions. Make file rotation, truncation, stream end, and resume gaps explicit. Add byte/maximum-line-size limits alongside line limits. Keep batching and visible-only streaming.

**Check/done:** Multiple identical messages at the same timestamp remain distinct when emitted separately; reconnect overlap does not multiply lines; very long lines cannot grow memory without bound; rotation and partial UTF-8 chunks are handled. Show truncation/gaps honestly. Test the actual stream/store boundary.

## P1-04 — Reduce rendering and retained-memory cost

**Current:** `LogViewer.tsx` reparses the full buffer and renders up to 2,000 matching rows. `FileBrowser.tsx` renders all entries. SQL results already use TanStack Virtual. Views remain mounted, and server stats bars have individual timers. Editor languages and formatters already load dynamically.

**Work:** Establish measurements first. Reuse installed virtualization for large files/log lists; handle wrapped log heights. Parse new log entries incrementally where profiling justifies it. Avoid timers/expensive derived work in hidden views. Inspect retained SQL runs, early events, terminal buffers, and editor documents on close. Consider lazy feature imports only after measuring bundle startup cost. Retain dirty editors and active terminals; never evict them to meet a memory target.

**Check/done:** Benchmark representative large directories, rapid/long logs, many hosts, multiple SQL results, and repeated tab open/close. Record before/after cold start, interaction latency, render time, and memory on the same machine. Establish explicit budgets from the baseline. Verify scroll, selection, search, keyboard focus, and tab restoration remain correct. No speculative blanket memoization.

## P1-05 — Bound concurrency and recover event loss

**Current:** One core event channel feeds the UI; the Tauri forwarder logs broadcast lag. Dashboard sync already has concurrency control.

**Work:** Inventory transfer/query/collector task lifetimes. Add bounded queues or limits where missing, cancellation cleanup, and timeouts appropriate to each operation. Handle dropped events by type: refresh replaceable snapshots, mark log gaps, and settle query state from authoritative status without replaying SQL. Verify stale async results cannot overwrite newer selections.

**Check/done:** Stress simultaneous logs, transfers, SQL, navigation, and disconnect. The app remains responsive; closing a view/tab stops owned work as intended; no orphan task or permanently busy control. Preserve the single typed event channel unless measurement proves a change necessary.

## P1-06 — Harden existing file transfers and editor saves

**Current:** Downloads use a temporary local filename; inspected uploads write directly to the final remote path. Safe editor saves already have version checks, backups, merge, and read-back verification. New resume/queue UI is P2-05.

**Work:** Review upload overwrite behavior, partial-file naming collisions, interrupted cleanup, disk-full handling, cancellation, and permissions. Use temporary upload plus rename when supported and compatible with ownership/link semantics; explain fallback behavior. Verify ZIP/unzip failures and missing Python are actionable. Check save-conflict handling and avoid regressing existing backups/permissions.

**Check/done:** Two simultaneous same-name transfers, network loss, cancel, full disk, denied permissions, symbolic/hard links, Unicode paths, archive failure, and external edit during save. Existing files and unsaved edits are not silently lost. No automatic deletion of recovery data without a defined policy.

## P1-07 — Improve current UI clarity and accessibility

**Work:** Keep the existing design system. Add consistent loading/empty/error/retry states, readable secondary text, clear Live/Cached/Paused/Disconnected labels, labeled overflow actions, and meaningful tooltips. Fix shared modal focus trapping, focus restoration, keyboard navigation, and accessible names. Make existing fixed panels resizable with persisted bounds. Hide or clearly label unfinished pages; remove obsolete release promises. Make toolbars usable at narrow widths and OS scaling.

**Inspect:** `ui/primitives.tsx`, `ui/ContextMenu.tsx`, `Shell.tsx`, `ServerTab.tsx`, dashboard, Docker, SQL, files, and shared dialogs.

**Check/done:** Keyboard-only operation; nested dialogs; Escape behavior; 125–200% scaling; small window; long server/database names; error recovery; no focus behind modal. Offer comfortable/compact density without changing the visual identity or hiding critical production context.

## P1-08 — Verify database safety and large-result behavior

**Work:** Audit existing cell editing, filters, pagination, transaction review, and result limits as functional behavior. Keep server-enforced read-only protection. Check identity-based updates under concurrent row changes, large NULL/JSON/text values, result cleanup, and cancellation. Align roadmap claims: cell-edit code already exists and must be assessed before scheduling it as new.

**Check/done:** Primary/composite unique keys, rows changed externally, unsupported column types, MySQL implicit DDL commits, expired write allowance, tab close during transaction, and lock during work. Avoid unexpectedly expensive exact counts or unbounded result accumulation. Run checks on disposable databases.

## P1-09 — Validate backup, restore, and workspace lifecycle

**Work:** Exercise existing encrypted exports, device sync merges/deletions, interrupted writes, wrong passwords, corrupt files, and lock/unlock. Verify restored tabs connect lazily and close cleanup releases resources. Distinguish credential-vault protection from plaintext local history/editor backups. Keep secrets out of diagnostics and document retention accurately.

**Check/done:** Backup round trip and merge preserve expected entities/settings; failed restore cannot leave a half-applied state; no automatic fleet connections on launch; user drafts and secrets are not unexpectedly included in exports. Use temporary data directories, not the user's vault.

## P1-10 — Improve CI, diagnostics, and documentation

**Current:** Main CI runs on Windows with typecheck, frontend tests, and core Rust tests. Release workflow also builds platform artifacts; that does not replace PR-time coverage.

**Work:** Add appropriate macOS coverage and desktop compilation checks. Add focused integration fixtures for SSH/SFTP, PostgreSQL, MySQL/MariaDB and lifecycle failures; make required services explicit. Add UI coverage for critical recovery/merge/transaction paths. Provide a user-reviewed, sanitized diagnostic export. Reconcile architecture/spec/roadmap with current dependencies and implementation.

**Check/done:** CI failures are reproducible; unavailable integration tests are visibly skipped, not reported as passing. Generated bindings match Rust types. Tests target behavior and failures rather than implementation details. Publish measured limitations and do not claim the whole application was live-tested from static inspection.

## Exit gate

Prioritize P1-01 through P1-03 immediately. Proceed to new features after the reported SQL failure is reproduced/fixed or precisely isolated with remaining evidence documented, and the relevant existing workflows pass regression checks. Do not use unrelated cleanup to delay the SQL fix.


## Implementation record — 2026-10-25

### Changes by task

| Task | Implemented |
|---|---|
| P1-01 SQL recovery | Driver health checks for both engines; bounded initialization/cancellation/operations; interruptible reconnect and close; serialized work; failed transaction/savepoint cleanup invalidation; metadata savepoints; transaction outcome warnings; failed database switch keeps the previous selection; explicit Reconnect without losing drafts/results. Session revisions reject stale status snapshots. |
| P1-02 SSH | Reject unsupported host/group jump routes and agent authentication before connecting. Bound connection/authentication and disconnect waits. Forwarders own and abort their active streams, cap concurrent streams, and fetch the current SSH handle for each connection. |
| P1-03 Logs | Preserve repeated equal-timestamp messages; remove counted reconnect overlap; cap lines, retained text and individual lines; show incomplete history/paused state; flush final unterminated output and preserve split UTF-8. |
| P1-04 Performance | Virtualize files and wrapped logs; reuse parsed logs and time formatting; lazy-load SQL and file editors; stop hidden stats timers; bound listing caches, early SQL events, notices and results; release results on tab close. |
| P1-05 Lifetimes/events | Four active transfers; race-free task registration; typed event-loss notification; authoritative SQL/transfer/session/sync refresh; visible gaps in logs/terminal output; reject stale navigation results. SQL is never replayed during resynchronization. |
| P1-06 Transfers | Private, exclusive temporary uploads; replace only owned regular single-link files with matching metadata; preserve mode/group; refuse changed destinations and links; exclusive installation for new files; unique temporary downloads; expose partial recovery paths; invalidate broken SFTP channels and replace them after SSH reconnect. |
| P1-07 UI | Modal focus trap/restoration and nested-dialog Escape handling; keyboard file navigation/actions; resizable persisted SQL sidebars and keyboard editor splitter; compact/comfortable controls; stacked Docker/log panels in narrow windows; unfinished Tunnels labeled Planned. |
| P1-08 SQL safety | Existing read-only, transaction, cell identity/stale-value checks retained and integration-tested. Added 16 MiB result-value budget and 200-statement script limit, transaction checks before commit/rollback, and expired-write reset failure handling. |
| P1-09 Restore | SQLite savepoint covers merge/replace; vault writes deferred until all mutations succeed; encrypted vault checkpoint restored on runtime failure. Tests cover late restore failure, vault persistence failure and existing wrong-password/corrupt backup paths. |
| P1-10 Delivery | macOS/Windows CI tests and desktop compilation; PostgreSQL/MySQL service tests; reusable SSH/SFTP fixture; privacy-limited diagnostics preview/export; frontend lifecycle tests and manual browser smoke checks. |

### Confirmed failure mechanisms

- MySQL health checks previously always returned false for “closed”.
- Stalled work held the SQL connection mutex, so disconnect/retry could wait behind it. Recovery now interrupts the operation before taking that mutex.
- PostgreSQL driver tasks could outlive the session. Dropping the connection now aborts its owned task.
- Some savepoint cleanup failures were ignored, and expired-write cleanup could report Connected after failure.
- SSH forward streams were spawned without being owned by the forwarder's lifetime; cached SFTP channels could belong to an old SSH handle.
- Equal-timestamp logs were discarded even when they were separate emissions. Older file-list requests could overwrite a newer navigation.

A network failure does not prove whether a submitted write or COMMIT succeeded. Reconnect preserves the editor and existing output but does not replay SQL. Verify pending changes before submitting them again.

### Verification and measurements

- Core regression suite, including configured PostgreSQL 16.15, MySQL 8.0.46 and OpenSSH/SFTP fixtures: **181 tests passed**. Local-database discovery is a smoke check, not an assertion that every local engine exists.
- Frontend: **95 tests passed**; TypeScript check and production Vite build passed. Desktop Rust compilation checked separately.
- SQL integration covers statement errors, errors inside transactions, metadata errors inside a transaction, cancellation, timeouts, killed connections, row caps, read-only/write mode, stale cell edits, and reconnect/disconnect while work is stalled.
- SSH integration covers host-key trust, rejected jump routes, SQL through SSH, cancellation through the forward, lease cleanup, private staged uploads, concurrent external changes, symbolic links, Unicode names and SFTP replacement after reconnect.
- Restore tests use temporary data directories and never the user's vault.
- Browser smoke: modal Shift+Tab wraps to the final dialog button; file ArrowDown moves focus/selection; large directories and logs render; wrapped logs reach the final line. Demo fixtures: `demo.html?scene=files&stress=1` (10,000 files), `demo.html?scene=docker&stress=1` (5,000 lines).
- At a 578×767 browser viewport, 10,000 files rendered **25 rows**; 5,000 unwrapped log lines rendered **29 rows** (13 after wrapping in that sample). Previous implementations rendered every file and up to 2,000 log rows.
- Same-machine Node measurement using the actual log parsing helpers: 5,000 lines previously took **114–181 ms** per pass; updated initial parse **8 ms**, unchanged-buffer cached pass **0.36–0.43 ms**. This is parsing cost, not an end-to-end UI frame/launch benchmark.
- Vite main JS chunk: **1,574.94 → approximately 1,394.5 kB**, gzip **467.68 → approximately 410 kB**. Editors still load on demand. A large-chunk warning remains; no claim of a measured native cold-start improvement.
- Current budgets: 5,000 log lines / approximately 4 MiB UTF-16 retained text per stream / 32 Ki characters per line; 20 directory listings per host; four transfers; 32 forwarded streams; 16 MiB SQL result values per run. These are per-view/run bounds, not a global process-memory ceiling.

### Remaining release checks and limitations

- Actual OS sleep/wake, airplane-mode toggling, native 125–200% scaling and long-duration multi-host soak testing require a native app session. Tests model stalled work and kill real database connections; they do not claim to have suspended the user's laptop.
- MariaDB, Windows runtime behavior, disk-full SFTP failures, every archive failure and every server permission/filesystem configuration were not live-tested here. CI definitions are updated, but remote CI has not run because nothing was pushed.
- Upload replacement relies on GNU `stat`, `chmod`, `chgrp`, and same-directory filesystem operations. Unsupported ownership, symlink/hard-link or metadata cases fail instead of falling back to destructive truncation. Metadata checking cannot eliminate every external-writer race. Cancellation can leave private recovery files; there is no automatic deletion policy.
- SQLite and the encrypted vault remain separate files. Runtime errors roll back, but abrupt process/power loss between their durable writes is not a cross-file atomic transaction. A journal/recovery protocol would be required for that stronger guarantee.
- A lost event cannot reconstruct missing result rows, terminal bytes or log lines. The UI marks output incomplete and refreshes authoritative status; it never reruns a command to recreate output. File-tail resume has no durable byte cursor, and Docker resume depends on source timestamps/retention.
- Existing editor backup/history data remains plaintext on the local device as documented. The diagnostic export includes only an allowlist of states/counts, version and timestamp; users review it before saving. It does not include raw errors, SQL, hosts, file paths, log content or credentials.

### Reproduce checks

Run `npm --workspace apps/desktop test`, `npm run typecheck`, `npm --workspace apps/desktop run build`, `cargo test -p rookery-core`, and `cargo build -p rookery-tauri`.

For integration tests, set `ROOKERY_TEST_PG_URL` and `ROOKERY_TEST_MYSQL_URL` to **disposable** databases, then run `cargo test -p rookery-core real_ -- --ignored`. For SSH/SFTP, build `scripts/fixtures/ssh.Dockerfile`, publish only on loopback, set `ROOKERY_TEST_SSH` and `ROOKERY_TEST_SSH_DB`, and run `cargo test -p rookery-core through_a_server_end_to_end -- --ignored`. The fixture's fixed password is test-only. Never expose it publicly or point these tests at production.
