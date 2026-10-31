# Priority 2 — Search, connections, files, and workspaces

Status: planned, not implemented. Start after the relevant [Priority 1](09-PRIORITY-1-STABILIZE-AND-OPTIMIZE.md) reliability gates. Next: [Priority 3](11-PRIORITY-3-APPLICATION-TOOLS.md).

## Instructions for the implementing AI

Read `00-START-HERE.md`, current specs/code, applicable AGENTS.md, and git status. Preserve user changes. Implement one scoped task at a time using Rust core logic, typed IPC, existing stores/primitives, and installed dependency APIs. No architectural rewrite. Keep saved-resource browsing offline and remote work explicit, bounded, cancellable, and visibility-aware. Never transmit file/log content externally without a user action. For new synced entities, follow the existing version/tombstone/backup rules. Run relevant tests, typecheck, and builds; update specs/roadmap/changelog. Do not commit or release unasked.

## P2-01 — Universal workspace search

**Current:** `features/palette/CommandPalette.tsx` searches hosts, applicable terminal snippets, and actions. Several feature views already have local filters.

**Build:** Extend the palette with saved database connections, open tabs, groups/tags, pinned files, recent locations, query/snippet metadata, and named workspaces when available. Show result type, server/environment, and destination. Add favorites, recent use, optional type filters, and a visible search entry point. Keep keyboard shortcuts consistent and separate navigation from execution. Saved SQL snippets must never execute as terminal snippets.

**Approach:** Start with in-memory metadata and measured ranking. Use SQLite indexing only if data volume warrants it. Never index vault values or silently scan remote servers. Offline/cached results should say so. Maintain stable keyboard selection while asynchronous providers return.

**Check/done:** Exact/prefix/fuzzy matches, duplicate names across hosts, empty state, keyboard navigation, clear scope, deleted resources, and large saved inventories. Selecting a cached result must not run a command unexpectedly. Search must remain usable while disconnected.

## P2-02 — Remote filename and content search

**Build:** Quick open by filename within a selected project root; content search with text/regex, case/whole-word options, include/exclude patterns, surrounding lines, streamed results, cancel, and saved search presets. Open a match at its line in the existing editor. Later in this task, allow explicitly selected servers with per-host results/progress.

**Approach:** Prefer an already installed suitable remote search utility, with a capability-detected fallback. Do not install tools automatically. Define matching behavior across backends. Quote all paths/patterns, avoid unsafe shell interpolation, and bound duration, bytes, matches, depth, and concurrency. Exclude binary and common generated directories by default; make exclusions visible. Do not scan `/` or whole fleets by default.

**Check/done:** Spaces/Unicode/newlines in paths, malicious-looking literal patterns, inaccessible directories, symlinks/cycles, large files, unsupported regex, network loss, cancellation, no matches, capped results, and moved/changed files. Indicate partial results and backend limitations. No silent global search-and-replace.

## P2-03 — SSH tunnels, jump hosts, and SSH-agent authentication

**Current:** `forward.rs` provides loopback forwarding used by SQL. The Tunnels page is a placeholder. Jump routes and agent login are not implemented; see P1-02.

**Build in stages:**
1. Saved local tunnels: name, source port, target address/port as seen remotely, start/stop, status, conflict message, and optional open-in-browser action.
2. Actual bastion routing with host-key verification for every hop, cycle detection, explicit route display, and reliable lease/reconnect ownership.
3. Native SSH-agent login using supported platform agents. Keep agent use distinct from agent forwarding; forwarding is a separately enabled capability.
4. Evaluate remote forwarding and SOCKS only after local forwarding is reliable; label remote bind exposure explicitly.

**Approach:** Reuse the existing session/forward foundation, keeping SQL recovery compatible. Default local listeners to loopback. Persist configuration, not live session objects. Do not auto-start every saved tunnel on launch. Check russh/platform API support against installed versions before choosing implementation.

**Check/done:** Busy ports, IPv4/IPv6, unreachable targets, many forwarded connections, stopped tunnel with active traffic, app lock/close, SSH reconnect, bastion failure, changed keys, missing agent, locked agent, and rejected identities. No unsupported route falls back silently to direct access. SQL tunnels remain reliable.

## P2-04 — Split views and named workspaces

**Current:** Server tabs contain multiple terminals but the inspected view renders one active terminal at a time. Existing tab persistence is not the same as a named split layout.

**Build:** Start with two resizable panes: terminal + logs/files/editor, or two terminals. Add pane focus/close/swap and keyboard actions. Then save named layouts with relevant hosts, paths, database tabs, and active views. Support two-server comparison without duplicating logical sessions. Add a compact recent-workspaces picker.

**Approach:** Extend the visibility reconciler so all actually visible panes collect data, hidden panes pause, and locking/window inactivity remains authoritative. Preserve one shared SSH session per host. Restore disconnected and connect lazily. Do not serialize credentials or sensitive terminal/file content into layout metadata.

**Check/done:** Resize, tab switch, focus, terminal fit, multiple visible collectors, close/reopen, dirty editor, open SQL transaction, stale resource references, restart, and narrow windows. Hidden panes do no live work; visible panes do not lose updates or state. Detached windows are deferred to P4.

## P2-05 — Transfer queue, resume, and file comparison

**Build:** Queue with progress, speed/ETA, cancel, retry, pause/resume where supported, concurrency controls, and clear overwrite policy. Resume interrupted transfers only after verifying source identity/version. Add local/remote two-pane browsing, directory comparison, and an explicit synchronization preview. Later support remote/remote transfer with the transfer route and local staging cost shown.

**Approach:** Build on P1-06 temporary-file behavior. Persist only safe job metadata needed for recovery. Compare size/time initially with an optional checksum mode; explain timestamp precision. Sync must show uploads, downloads, overwrites, skipped files, conflicts, and deletions before execution. Do not imply transactional rollback of an entire sync.

**Check/done:** Source changed during interruption, restart recovery, partial file larger than source, overwrite conflict, link traversal, cancellation, permissions, disk exhaustion, empty files, large trees, and two simultaneous transfers to one destination. Deletions require explicit selection; preview and actual execution recheck conflicts.

## P2-06 — Complete editor and file navigation workflows

**Build:** New file from editor; bookmarks/recent folders; file permissions/owner/group details; side-by-side file comparison; cross-server config diff; local text-file support where it reuses the editor cleanly. Add `.env` key comparison with values hidden by default. Preserve existing formatting, version checks, conflict merge, history, and sudo behavior.

**Approach:** Separate local and remote filesystem adapters only as needed; do not introduce a generic filesystem framework. Ownership changes must show the intended target and required privilege. For new files, refuse unexpected overwrite and preserve encoding/EOL rules. Bind compare panes to explicit source versions.

**Check/done:** File already exists, parent missing, permission denied, symlink, concurrent change, Unicode path, CRLF/BOM, dirty tabs, and hidden secret values. Comparison is read-only until the user deliberately applies changes. Clipboard behavior for hidden values is clear.

## P2-07 — Terminal history, command blocks, and session continuity

**Build:** With supported shell integration, capture command boundaries, directory, exit status, and duration; navigate/copy/export one command's output; search history per host/project. Add explicit tmux discovery/attach/create actions for persistent server-side sessions. Improve broadcast to an explicit target picker and show recipients before typing.

**Approach:** Extend existing OSC integration and terminal registry rather than scraping arbitrary prompts. Plain-terminal fallback must work without integration. History retention is configurable and local; avoid recording secret prompts and explain limits of command-text redaction. Do not promise session survival without a server-side multiplexer. Disable broadcast or require renewed selection when targets change unexpectedly.

**Check/done:** Supported shells, multiline commands, alternate screen applications, sudo prompts, interrupted commands, long output, reconnect, absent tmux, duplicate session names, and mixed production/nonproduction targets. Never duplicate a command on reconnect.

## P2-08 — Structured runbooks and multi-server results

**Current:** Snippets already support ordered workflow steps and production confirmation. Do not rebuild the snippet library.

**Build:** Extend workflows with per-step state/output/exit code, working directory, required tools, parameter inputs, cancellation, and explicit rerun. Add selected-host execution with a bounded concurrency setting and a result matrix. Support side-by-side diagnostic outputs and project-aware commands.

**Approach:** Use an execution path that can reliably observe exit status; do not infer success from terminal text. Stop-on-failure must be real. Retry-from-step is opt-in with a preview of prior side effects. Keep paste-only and interactive-terminal workflows available. No automatic rollback promise for arbitrary shell commands.

**Check/done:** Failed middle step, prompt requiring input, shell quoting, output limits, disconnected host, cancellation, rerun of non-idempotent step, and partial success across hosts. Show precise outcome per target, not one global success badge.

## P2-09 — Dashboard navigation and task progress

**Build:** Sortable dashboard list mode alongside cards, favorites/recents, saved filters, and a central task-progress panel for transfers/searches/runbooks/backups. Attention items should deep-link into the correct current tool; future disk/container diagnostics can attach when implemented. Persist useful sort/column choices.

**Approach:** Render dashboard from existing cached snapshots. Do not connect on open or introduce continuous fleet monitoring. Separate sampled health, connection status, and data age. Keep one source of task state rather than parallel frontend/backend job registries with conflicting ownership.

**Check/done:** Large inventories, stale snapshots, offline hosts, deleted resources, empty filters, navigation during a job, completed/failed task dismissal, and restored UI preferences. A failed background task remains discoverable without blocking unrelated work.

## Delivery order and references

Suggested order: P2-01/02 search, P2-03 connection compatibility, P2-05 transfers, P2-04 layouts, then remaining tasks according to user feedback. Do not implement all providers or modes in one PR.

Comparable patterns, not proof of Rookery user demand:
- [Tabby: split panes, jump hosts, agents](https://tabby.sh/)
- [MobaXterm: tunnels and multi-execution](https://mobaxterm.mobatek.net/features.html)
- [WinSCP: resume and temporary transfer files](https://winscp.net/eng/docs/resume)
