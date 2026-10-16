<p align="center">
  <img src="https://raw.githubusercontent.com/aagzamov-dev/Rookery/main/docs/screenshots/dashboard.png" alt="Rookery" width="860" />
</p>

## What's new in {{VERSION}}

{{CHANGES}}

## Download

| Platform | File |
|---|---|
| **Windows 10 / 11** (64-bit) | [Rookery_{{VERSION}}_x64-setup.exe](https://github.com/aagzamov-dev/Rookery/releases/download/{{TAG}}/Rookery_{{VERSION}}_x64-setup.exe) |
| **macOS** (Apple Silicon & Intel) | [Rookery_{{VERSION}}_universal.dmg](https://github.com/aagzamov-dev/Rookery/releases/download/{{TAG}}/Rookery_{{VERSION}}_universal.dmg) |

**Already using Rookery?** You don't need to download anything. The app offers this update on its next start, or use **Settings › About › Check for updates**. Your servers, logins and settings are kept.

## First install

- **Windows:** the installer is per-user (no admin rights). Rookery isn't code-signed yet, so SmartScreen may say "Windows protected your PC": click **More info → Run anyway**.
- **macOS:** open the `.dmg` and drag Rookery to Applications. Rookery isn't signed by Apple yet, so macOS blocks it the first time ("damaged" or "unidentified developer"). Run this once in Terminal, then open Rookery:
  ```
  xattr -dr com.apple.quarantine "/Applications/Rookery.app"
  ```
  It removes the "downloaded from the internet" mark that makes macOS block unsigned apps. Updates afterwards install normally.
- **Coming from MobaXterm, PuTTY or `~/.ssh/config`?** The welcome screen imports your servers.
- **Using Rookery on another computer?** Open **Backup & sync** and choose the same sync folder and password.

<sub>Update files (`.sig`, `latest.json`) are for the in-app updater: every update is verified with Rookery's signing key before it installs.</sub>
