# 06 — Auto-update (TODO, planned for v0.6)

Status: **built in v0.6.0**. Only a pushed tag `vX.Y.Z` releases; pushes to `main` never do.
- App side: `tauri-plugin-updater` (signed), the banner, and Settings › About.
- CI: `.github/workflows/release.yml` (tag `v*` → Windows NSIS + macOS universal → published Release with `latest.json`) and `ci.yml` (tests on every push).

Until a release exists, updates are manual: run the newer `Rookery_x.y.z_x64-setup.exe` over the old one. Data in `%APPDATA%\Rookery` is kept.

Goal: one click, "Update 0.2.0 available → Update → restart". The update is verified with our signature, user data is untouched, and nothing personal is sent.

---

## 1. How it works

```
Developer                     Host (GitHub Releases)              User's Rookery
─────────                     ──────────────────────             ──────────────
bump version, tag  ──CI──▶    setup.exe + setup.exe.sig  ◀──(3)── download installer
build + sign                  latest.json               ◀──(1)── check: read latest.json
                                                                  (2) newer? show notes
                                                                  (4) verify signature (public key in app)
                                                                  (5) install quietly, restart
                                                                  (6) DB migrates, data kept
```

### 1.1 Keys (two different things)
| | Update signing key | OS code-signing certificate |
|---|---|---|
| Purpose | The app trusts that the update is from us | Windows / macOS trusts the publisher (no "Windows protected your PC") |
| Cost | Free (`tauri signer generate`) | Paid (Windows cert; Apple Developer $99/yr) |
| Needed for auto-update | **Yes** | No (but recommended) |
| Where | Private key + password: password manager + GitHub secret. Public key: in `tauri.conf.json` | Cert in CI secrets |

### 1.2 `latest.json` (static file, no server code)
```json
{
  "version": "0.2.0",
  "notes": "Backup to Google Drive, import from ~/.ssh/config…",
  "pub_date": "2026-11-20T10:00:00Z",
  "platforms": {
    "windows-x86_64": { "url": "https://github.com/<org>/rookery/releases/download/v0.2.0/Rookery_0.2.0_x64-setup.exe", "signature": "<contents of .sig>" },
    "darwin-aarch64": { "url": ".../Rookery_aarch64.app.tar.gz", "signature": "..." },
    "darwin-x86_64":  { "url": ".../Rookery_x64.app.tar.gz", "signature": "..." }
  }
}
```
Fixed URL the app checks: `https://github.com/<org>/rookery/releases/latest/download/latest.json`.

### 1.3 In the app
1. **Check.** On start (once a day max), or when the user clicks Settings › About › "Check for updates". This downloads only `latest.json`. The request carries no servers, vault data, IDs or telemetry. If offline, it fails silently.
2. **Compare.** If the semver is greater than the current version, show a banner: "Update 0.2.0 available · What's new · Update · Later · Skip this version".
3. **Download.** Show progress in the banner, then download into a temp folder.
4. **Verify.** Check the signature against the public key compiled into the app. On a mismatch, refuse and show "Update could not be verified". Never install unverified files.
5. **Install.**
   - Windows: close the app, run the NSIS installer in passive mode (progress bar only), relaunch.
   - macOS: replace the `.app` in place and restart.
6. **After restart.** Run DB migrations (already automatic) and show a toast: "Updated to 0.2.0 — what's new".

### 1.4 Before installing
- Warn when terminals or transfers are open: "3 terminals and 1 upload will close. Update now / After I'm done". The "after I'm done" choice installs on next quit.
- Never update while the vault is mid-write (keep the existing atomic save).

---

## 2. TODO

### Setup (one time)
- [ ] Put the project in git + a GitHub repo (private is fine; Releases work on private repos for the owner, or use a separate public "releases" repo).
- [ ] Generate the update key pair (`tauri signer generate`). Store the private key + password in a password manager **and** as GitHub secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
- [ ] Add `tauri-plugin-updater` + `tauri-plugin-process` (relaunch), capability permissions, `plugins.updater.pubkey` and `endpoints` in `tauri.conf.json`, and `bundle.createUpdaterArtifacts: true`.

### CI release pipeline
- [ ] GitHub Actions workflow with `tauri-action`. On tag `v*`: build Windows (NSIS) + macOS (universal or arm64 + x64), sign updater artifacts, create a GitHub Release with installers, `.sig` files and the generated `latest.json`.
- [x] Release notes from docs/CHANGELOG.md through .github/release-notes.md.
- [ ] Optional: Windows code-signing cert + Apple notarization secrets (removes OS warnings).

### App UI
- [ ] Settings › About: current version, "Check for updates", toggle "Check automatically on start" (default **on**, can be off — local-first).
- [ ] Update banner (notes, Update / Later / Skip this version), download progress, verify error state.
- [ ] Open-work warning (terminals / transfers) before install; "install on quit" option.
- [ ] "Updated to x.y.z" toast with notes after restart.
- [ ] Store `ui.update.skipped` / `ui.update.lastCheck` in settings (no secrets).

### Channels (P2)
- [ ] `beta.json` endpoint; Settings toggle "Get beta versions".

### Tests / checks
- [ ] Unit: version comparison, skip-version logic.
- [ ] Manual: 0.1.x → 0.2.0 on a clean Windows VM, with data present; check vault + PIN still unlock, snapshots kept.
- [ ] Manual: tampered installer (changed byte) → must be refused.
- [ ] Manual: offline start → no error popup.

---

## 4. How to release (after the one-time setup)

One-time setup:
1. GitHub → repo **Settings › Secrets and variables › Actions › New repository secret**:
   - `TAURI_SIGNING_PRIVATE_KEY` = the contents of `%USERPROFILE%\.tauri\rookery-updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the contents of `%USERPROFILE%\.tauri\rookery-updater.key.password`
2. Keep both files in your password manager too. Without them, installed apps can't be updated.

Each release:
1. Bump the version in `Cargo.toml` (workspace), `crates/rookery-tauri/tauri.conf.json`, `package.json` and `apps/desktop/package.json`.
2. Add a `## x.y.z` section to `docs/CHANGELOG.md`; it becomes the release notes and the app's "What's new" (together with any versions since the last published release, so a skipped one is not lost).
3. Commit, then tag and push the tag:
   ```
   git commit -am "Release x.y.z" && git tag vx.y.z && git push && git push --tags
   ```
   Only the tag starts a release; pushing `main` alone runs CI only. The tag must match the version in `tauri.conf.json` (otherwise the run fails), and a version that is already published is skipped. Runs never overlap, and a draft left by a failed run is replaced when you push the tag again (`git push --force origin vx.y.z` after moving it).
4. About 20 minutes later, Releases has the Windows `.exe`, the macOS `.dmg` / `.app.tar.gz`, the `.sig` files and `latest.json`. Installed apps offer the update on their next start (or via "Check for updates").

macOS without Apple notarization: the first download shows "damaged / unidentified developer". Run `xattr -dr com.apple.quarantine "/Applications/Rookery.app"` once (it removes the "downloaded from the internet" mark); updates afterwards install normally, because the updater downloads them itself.

Windows without a code-signing certificate: SmartScreen warns on the first install (More info → Run anyway). Updates install silently.

## 3. Rules

- **Never lose the private key.** Without it, installed apps can't be updated; users must reinstall manually.
- **Never leak it.** Key + control of the download URL = ability to push fake updates.
- **Forward only.** To fix a bad release, ship a higher version. Downgrades are not offered; an older build may not open a newer DB.
- **Data stays.** Updates replace program files only. `%APPDATA%\Rookery` (DB, vault, cache) is never touched by the installer.
- **Privacy.** The update check is the only request the app makes on its own. Document it in Settings and allow turning it off.
