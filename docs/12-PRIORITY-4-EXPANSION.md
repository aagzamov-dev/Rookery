# Priority 4 — Optional expansion and adoption

Status: candidate backlog, not a commitment to implement. Start after [Priority 1](09-PRIORITY-1-STABILIZE-AND-OPTIMIZE.md), [Priority 2](10-PRIORITY-2-CORE-WORKFLOWS.md), and the selected [Priority 3](11-PRIORITY-3-APPLICATION-TOOLS.md) tools. Reorder only using user feedback and product-owner direction.

## Instructions for the implementing AI

Read `00-START-HERE.md`, actual code, applicable instructions, and current roadmap before work. Preserve existing changes. Scope one feature, verify dependency/platform versions, and reuse existing architecture. Some candidates conflict with the current v1 exclusions: do not silently expand product scope. No paid services, external data uploads, server agents, deployment, or publishing without authorization. Keep local-first behavior, typed IPC, visibility-driven collection, and explicit remote actions. Include tests, platform checks, docs, retention rules, and failure behavior in every delivered feature.

## P4-01 — Contextual web and documentation search

**Build first:** “Search selected error online” and “Search official documentation” from logs/terminal/error dialogs. Show an editable query preview and open the user's browser. Offer relevant documentation choices based on detected tools/versions. Never send a whole log buffer, host inventory, `.env`, or query result by default.

**Possible later:** An in-app results panel using a chosen search provider, only after assessing terms, cost, credentials, and maintenance. A full embedded browser is not required for the first version.

**Check/done:** Correct URL encoding, long/error-like text, URLs with secrets, provider failure, browser opening, and offline state. The user can remove sensitive material before sending. Search results are untrusted content and must not execute commands. No external service is contacted just because text is selected.

## P4-02 — SQLite and Redis tools

**Build:** SQLite browsing/querying for explicitly selected local files; Redis key/type/TTL/value inspection through direct or SSH connections. Start read-only and reuse connection management where it fits.

**Approach:** SQLite requires explicit handling of WAL files, live-file locking, backups, and downloaded snapshots; do not open a copied main DB as if it necessarily includes WAL changes. Redis should use incremental scanning and bounded value reads, not blocking whole-keyspace operations. Recognize Redis-compatible/version/cluster differences. Vault-store credentials; distinguish editing/TTL/delete actions from inspection.

**Check/done:** Large databases/keyspaces, binary values, NULL/empty data, locks, concurrent updates, Redis ACLs, clusters, TLS, expiration during browsing, disconnect, and cancellation. Scan results may contain duplicates or change while scanning; do not present them as a consistent snapshot.

## P4-03 — Connection compatibility and credential convenience

**Build candidates:** Improved SSH config import with Include/patterns/ProxyJump diagnostics; key generation and explicit public-key installation; SSH certificates/FIDO2 support where libraries/platforms allow; native biometric unlock. Existing basic imports and vault must continue to work.

**Approach:** Capability-check first. Import preview must list unsupported directives instead of silently dropping behavior. Never execute ProxyCommand from an imported file without an explicit supported execution policy and user action. Public-key installation must preserve authorized_keys, avoid duplicates, and show the destination. Biometric unlock must keep a working master-password fallback and correct OS-keychain lifecycle.

**Check/done:** Nested includes/cycles, wildcard precedence, encrypted keys, hardware-device absence, agent refusal, passphrase cancellation, remote permissions, duplicate keys, biometric unavailable/enrollment change, and vault recovery. No private key or vault secret is returned through ordinary frontend read APIs.

## P4-04 — Scheduled backups and optional health monitoring

**Build:** Scheduled local encrypted Rookery backups with retention, last-success status, and restore verification. Optional saved health-check schedules may build on P3-04. Consider direct cloud-drive integration only if users cannot use the existing sync-folder workflow.

**Approach:** Clearly state whether schedules run only while Rookery is open. Do not promise monitoring while the computer is asleep or app is closed. Background helpers, OS scheduling, cloud OAuth, or a server-side agent are separate scope decisions. Keep alerting opt-in with deduplication, cooldown, quiet periods, and recovery notices. Never prompt for credentials in an unattended job.

**Check/done:** Locked vault, missed schedule, sleep/wake, clock change, destination unavailable, retention, full disk, corruption, duplicate notifications, partial fleet failure, and app restart. Existing manual backup/device sync remains independent. Scheduled backup failures are visible and cannot silently replace the last valid backup.

## P4-05 — Distribution, onboarding, and platform expansion

**Build candidates:** Windows code signing and Apple notarization; clearer first-run import/connection diagnosis; optional in-app demo; Linux desktop support after platform/dependency evaluation; portable packaging if demand warrants it. Signing requires owner-provided accounts/certificates and may involve cost.

**Approach:** Signing and update signatures are different systems; preserve both. Keep demo data isolated from real vaults and hosts. Build a release verification matrix for install, update, uninstall, architecture, keychain, shell, and file dialogs. Add Linux as a tested platform, not just a downloadable binary.

**Check/done:** Clean install, update from supported prior versions, failed update recovery, OS trust checks, Intel/Apple Silicon as supported, data-path migration, demo exit, and fresh-user onboarding. Do not modify publishing credentials or trigger a release during implementation without authorization.

## P4-06 — Advanced workspace presentation

**Build candidates:** Detached windows, multi-monitor layouts, richer tab organization, customizable overview widgets, light/high-contrast themes, and localization. Basic resizing, readable text, density, keyboard access, and split views belong to earlier priorities.

**Approach:** Validate demand before adding UI preferences. Multiwindow requires explicit ownership of sessions, subscriptions, transactions, and dirty editors; keep one authoritative core. Theme changes should use shared tokens and reviewable previews. Localization should preserve technical names, keyboard semantics, and text expansion.

**Check/done:** Window close with unsaved work, one window locking the app, duplicate commands, display removal, OS scaling, layout restore, color contrast, right-to-left layout if supported, and translated error/action labels. Do not restore windows off-screen or lose work when a monitor disappears.

## P4-07 — Mobile companion

**Current:** Android/mobile is in the existing roadmap, but desktop reliability should land first.

**Build:** Begin with selected-server health, logs, and deliberate reconnect using reused Rust core logic. Add terminal ergonomics and secure credential restore/unlock only after the smaller companion workflow is reliable. Evaluate iOS separately rather than assuming identical platform support.

**Approach:** Validate Tauri/mobile dependencies, local-shell exclusions, background execution limits, keystore, and touch accessibility. Avoid silently syncing all secrets. Make Wi-Fi/data/battery preferences explicit. No claim of continuous background monitoring where the OS cannot provide it.

**Check/done:** Cold start, keystore unavailable, app background/foreground, interrupted SSH, mobile network change, keyboard/accessory keys, rotation, small screens, backup restore, and device loss/revocation strategy. Desktop format compatibility must be versioned and tested.

## P4-08 — Optional AI assistance

**Scope decision required:** The existing v1 roadmap excludes an AI assistant. This entry is a future proposal, not authorization to add it.

**Potential useful tasks:** Explain a selected error, summarize a selected incident interval, describe a query plan, draft a shell command, or suggest a runbook step. Start with explanations and drafts rather than autonomous operations.

**Approach:** User selects/reviews context and chooses a provider or local model. Document data transfer, costs, key storage, and retention. Treat logs/files/web results as untrusted data. Model output is not an instruction to run commands. Never automatically execute suggested shell/SQL or replay a failed operation. Preserve the app's existing production/transaction safeguards.

**Check/done:** Secret redaction limits, prompt injection in logs/docs, unsupported claims, unavailable provider, cancellation, oversized context, unsafe generated command, and inaccurate root-cause conclusions. The core product remains fully usable without AI. Do not store model keys in ordinary settings.

## P4-09 — Kubernetes, team sharing, plugins, and extra protocols

**Scope decision required:** Team sharing, plugins/macros, RDP/VNC/X11, Mosh, and other protocols are currently outside v1 scope. Kubernetes is also a substantial product expansion. Do not bundle these into a routine optimization task.

**Evaluate separately:**
- Kubernetes: only if target users need clusters; begin with context/namespace-safe read-only workload/log inspection and existing kubeconfig semantics.
- Team sharing: requires permissions, identity, revocation, auditability, secret ownership, and a hosting/local-sharing model. Existing device sync is not multiuser access control.
- Plugins: require stable APIs, permissions, lifecycle, compatibility, and distribution policy. Curated built-in capabilities may be simpler initially.
- RDP/VNC/X11/serial/Mosh: add only for a defined audience with a supported library/platform plan; avoid promising universal remote access.

**Check/done for a discovery task:** Produce a small feasibility proposal with user problem, existing alternatives, maintenance burden, licensing, threat/permission model, integration boundaries, and prototype acceptance criteria. Implementation begins only after explicit scope approval. Do not redesign the core for hypothetical future plugins.

## P4-10 — Validate demand and keep the roadmap accurate

**Work:** Observe developers completing real tasks: recover SQL after an error; find a log entry; compare a config; access a private endpoint; recover a transfer; diagnose a failed job. Record where they leave Rookery, why, frequency, severity, and workaround. Invite feedback without collecting credentials or production data.

**Prioritize:** Repeated blocking failures first, frequent workflow friction second, optional integrations last. Use reach, frequency, severity, implementation effort, and ongoing maintenance to rank candidates. Do not treat competitor feature lists as proof of demand.

**Check/done:** Each accepted candidate has a clear user problem, smallest useful version, success measure, dependencies, and owner decision. Archive duplicates and reconcile completed features with `02-ROADMAP.md`. Optional telemetry requires a separate opt-in design; interviews and local performance measurements are sufficient to begin.

## Overall completion rule

The goal is a dependable, fast server workspace. Deliver selected features in small verified changes. Keep these files current as plans; mark items implemented only with linked changes and recorded verification, and retain known limitations instead of silently removing them.
