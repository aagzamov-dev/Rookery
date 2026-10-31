# Priority 3 — Application workspaces and diagnostics

Status: planned, not implemented. Depends on stable [Priority 1](09-PRIORITY-1-STABILIZE-AND-OPTIMIZE.md) behavior and relevant [Priority 2](10-PRIORITY-2-CORE-WORKFLOWS.md) navigation, execution, and connection tools. Later expansion: [Priority 4](12-PRIORITY-4-EXPANSION.md).

## Instructions for the implementing AI

Read `00-START-HERE.md`, applicable instructions, actual feature code, dependency versions, and git status. Preserve user work. Implement one vertical slice at a time with existing Rust core/typed IPC/UI patterns. Detect capabilities and privileges; do not assume every Linux host has systemd, Docker, Python, or GNU utilities. No silent installs, remote mutations, hosted accounts, or always-on polling. Remote collection is explicit or opt-in. Test against disposable services; update specs/roadmap/changelog and state limitations. Do not commit/release unasked.

## P3-01 — Application workspace

**Build:** A named application such as “Shop production” links a host, project directory, database connections, Compose project/containers, logs, service units, URLs, pinned config files, and runbooks. Offer an overview and direct navigation to existing tools. Separate environment instances so staging resources cannot be mistaken for production.

**Approach:** Store references and metadata, not duplicate credentials/resource records. Discovery starts only for a user-selected root and asks the user to confirm associations. Reuse P2 named layouts. Handle deletion, moved paths, renamed containers, backup/sync versioning, and tombstones explicitly. Start with manual association before broad auto-detection.

**Check/done:** Multiple apps on one host, one app across hosts, duplicate names, deleted references, missing permissions, offline cached view, backup round trip, and environment switching. Opening the overview alone must not trigger unrestricted scans or connections.

## P3-02 — Unified log investigation

**Build:** Select container, systemd, and application-file sources; merge timestamped entries with source labels; filter by time/level/text/regex; save presets; load surrounding context; export selected/matching results; bookmark events. Add JSON field expansion/filtering, multiline stack-trace grouping, request-ID correlation, and server/local/UTC display.

**Approach:** Build on P1 log correctness and virtualization. Historical retrieval is a separate explicit, bounded job, not a claim that the in-memory buffer contains all history. Account for clock skew, timezone-less records, rotated files, source-specific ordering, and unavailable intervals. Search rotated/compressed logs only when supported and explicitly selected. Redact/review exports where needed.

**Check/done:** Same timestamps, repeated messages, multiline/invalid JSON, missing time, mixed timezones, reconnect overlap, truncated/capped output, log rotation, cancellation, and partial source failure. Show incomplete history and uncertain ordering honestly. No dropped entries from timestamp-only deduplication.

## P3-03 — Cron, systemd timers, and service diagnostics

**Build:** Read-only cron/timer inventory with command, user, timezone assumptions, next scheduled time when determinable, enabled state, and links to logs. Show systemd unit config, drop-ins, dependencies, restart count, and recent journal events. Add scoped edit/enable/disable/run-now actions only after read-only behavior is reliable.

**Approach:** Distinguish user crontabs, system cron directories, and systemd timers. Do not infer a successful run from the schedule alone; last-run/result requires actual recorded evidence. Preserve comments and unsupported expressions when editing. Preview changes, back up config, validate, and show required privileges. Reuse safe editor saves and runbooks.

**Check/done:** User/system jobs, permissions, disabled timers, missed runs, DST/timezones, macros, environment variables, overlapping jobs, and hosts without systemd. A cron expression preview is not a guarantee of exact runtime under every daemon.

## P3-04 — Network and endpoint diagnostics

**Build:** Listening ports mapped to process/service/container; TCP reachability; HTTP tester with method/headers/body/status/timing; DNS comparison from PC versus server; TLS hostname/chain/expiry details. Allow saved HTTP/TCP health checks associated with an app.

**Approach:** Every request shows where it runs and its target. Reuse tunnels where appropriate. Bound response size, timeouts, redirects, and concurrency. Protect saved authorization headers in the vault; don't record secrets in request history. Health checks are manual or explicitly scheduled while the app is running. Distinguish a local network failure from remote service failure.

**Check/done:** DNS failure, IPv6, redirects, TLS mismatch, expired certificate, private target through tunnel, port conflict, permission-limited process mapping, huge response, timeout, and cancellation. Do not disable TLS verification silently or probe unrelated networks.

## P3-05 — Disk, process, and server capability tools

**Build:** All relevant mounts with space/inode/read-only information; on-demand large-directory explorer; process details including command line, parent, cwd, open files, and ports when permissions allow. Add OS/runtime/tool version inventory and reboot/update-required indications for supported distributions.

**Approach:** Existing collectors show root-disk/basic process data; extend them incrementally. Expensive recursive disk scans are cancellable jobs scoped to a chosen filesystem/directory, not every metrics tick. Mask sensitive command arguments in exports. Treat package/update checks as optional distro-specific work; never install updates automatically.

**Check/done:** Multiple mounts, network mounts, inode exhaustion, inaccessible paths, deleted-but-open files, disappearing processes/PID reuse, absent tools, non-GNU output, and scan cancellation. Clearly distinguish exact values, estimates, and unsupported fields. Recheck identity before process actions.

## P3-06 — Docker Compose and container inspection

**Build:** Container details for ports, mounts, networks, labels, restart policy, and health failures. Discover Compose file locations when metadata permits; let users correct them. Open/edit config with existing editor; validate before applying; preview services affected by pull/recreate; show progress and post-action health. Add container event timeline, image sizes/references, volume relationships, and cleanup previews.

**Approach:** Reuse SSH Docker access; do not expose a Docker API port. Detect Compose versions/features. Keep “restart” distinct from “recreate with new configuration.” Resolve remote versus local paths correctly. Cleanup must identify resources and data implications. Browsing volumes or container files starts read-only; optional writes reuse backup/conflict principles where technically possible.

**Check/done:** Multiple Compose files/projects, missing labels, renamed services, unavailable images, health failures, stopped containers, rootless Docker, permission errors, interruption, shared volumes, and retained image digests. Do not promise deployment rollback unless prior artifacts/config and rollback behavior are actually available.

## P3-07 — Laravel and worker operations

**Current:** Laravel snippet pack and `.env` connection import already exist. Extend them instead of adding duplicate command buttons elsewhere.

**Build:** App/PHP/Laravel version and deployment commit; selected config/log shortcuts; pending migration view; cache status/actions; queue worker/failed-job diagnostics; Supervisor process/config links; scheduler listing and timezone; deployment runbook with prechecks, selected steps, health check, and recorded outcome.

**Approach:** Detect the application's framework/runtime version and available Artisan commands, including container execution context. Avoid assuming the latest Laravel APIs. Read-only discovery first. Restart/retry/migration/cache actions name the app and environment and use existing production safeguards. Queue depth/failed jobs depend on driver and available APIs; display unsupported states rather than fabricated zeros.

**Check/done:** Older Laravel, several apps per host, nonstandard paths, container runtime, missing PHP/extensions, permission errors, alternate queue drivers, failed migration, unavailable Supervisor, and scheduler timezone. A deploy that fails health checks must not be marked successful. Retrying a job can duplicate external side effects: show that before retry.

## P3-08 — Database diagnostics and comparison

**Build:** Active queries/connections, blocking locks, long transactions, primary/replica labels when verifiable, and a simple EXPLAIN tree/table. Add schema comparison for tables/columns/indexes/constraints and bounded result snapshots for before/after comparison. Offer typed parameters for reusable SQL snippets.

**Approach:** Use engine/version-specific introspection and permissions; no universal guessed SQL. Default to estimated plans. EXPLAIN ANALYZE can execute the statement and must be explicitly requested. Comparison is read-only first; show schema differences without automatically applying migrations. Parameter binding must use driver mechanisms, not text concatenation. Preserve P1 transaction/recovery controls.

**Check/done:** PostgreSQL/MySQL/MariaDB differences, limited privileges, unsupported plan fields, large schemas, different collations/timezones, NULL values, duplicate/nonunique comparison keys, and partial snapshots. Explain that a fetched-row snapshot does not represent an entire table. Cancelling another session's query is an explicit privileged action.

## P3-09 — Database import, export, and backup operations

**Build:** CSV/JSON import mapping with preview/type validation and a bounded dry run; large-result streaming export; database dump/restore job with tool versions, destination, progress, and verification. Keep this distinct from Rookery's own encrypted settings backup.

**Approach:** Stage on disposable targets where possible. Use compatible installed native tools when necessary, discover capabilities, and pass credentials securely rather than command-line arguments. Preview schema/data writes and partial-failure policy. Do not assume every restore is atomic or every dump is consistent without engine-specific options.

**Check/done:** Encoding, delimiters, NULL/empty string, dates/timezones, JSON precision, duplicate keys, incompatible tool/server versions, out-of-space, cancel, network interruption, and restore failure. Verification must report what was checked; producing a dump file alone does not prove restorability.

## P3-10 — Remote Git and incident evidence

**Build:** Project branch/commit/dirty-file view, read-only diffs and comparison with an explicitly selected revision. Link deployment records to commits/config edits/container events. Export selected log ranges, diagnostic results, versions, and user notes as an incident bundle.

**Approach:** Reuse the project path and existing editor/diff UI; do not turn this into a full Git IDE. Do not fetch/pull/reset or modify repositories during passive discovery. Evidence export is previewed, scoped, and redacted; no background upload. Clearly label timestamps, collection source, and missing intervals.

**Check/done:** No Git repository, detached HEAD, shallow clone, dirty files, missing ref, huge diff, absent Git, credentials in output, and incomplete timeline. A timeline is correlation, not proof of causation.

## References and delivery

Build application associations and one complete investigation path first, for example: app → error logs → container → config → validated reload. Add other tools based on observed usage.

- [Docker unified log search/presets](https://docs.docker.com/desktop/use-desktop/logs/)
- [Portainer log ranges/export](https://docs.portainer.io/user/docker/containers/logs)
- [Laravel scheduling and schedule:list](https://laravel.com/framework/docs/12.x/scheduling)
- [DBeaver execution plans](https://dbeaver.com/docs/team-edition/desktop/Query-Execution-Plan/)
- [DBeaver data comparison](https://dbeaver.com/docs/dbeaver/Data-compare/)

These are reference patterns. Recheck current documentation and the user's installed server versions during implementation; they are not evidence of demand from Rookery users.
