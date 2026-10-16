use rookery_core::model::*;
use rookery_core::{new_id, CoreEvent, Error, Result};
use serde::Serialize;
use tauri::State;

use crate::AppState;

// ------------------------------------------------------------------ vault

#[tauri::command]
pub fn vault_status(s: State<'_, AppState>) -> VaultStatus {
    s.core.vault.lock().status()
}

#[tauri::command]
pub fn vault_create(s: State<'_, AppState>, master: String) -> Result<VaultStatus> {
    let mut v = s.core.vault.lock();
    v.create(&master)?;
    let _ = s.core.events.send(CoreEvent::VaultUnlocked);
    Ok(v.status())
}

#[tauri::command]
pub fn vault_unlock_master(s: State<'_, AppState>, master: String) -> Result<VaultStatus> {
    let mut v = s.core.vault.lock();
    v.unlock_master(&master)?;
    let _ = s.core.events.send(CoreEvent::VaultUnlocked);
    Ok(v.status())
}

#[tauri::command]
pub fn vault_unlock_pin(s: State<'_, AppState>, pin: String) -> Result<VaultStatus> {
    let mut v = s.core.vault.lock();
    v.unlock_pin(&pin)?;
    let _ = s.core.events.send(CoreEvent::VaultUnlocked);
    Ok(v.status())
}

#[tauri::command]
pub fn vault_set_pin(s: State<'_, AppState>, pin: String) -> Result<VaultStatus> {
    let mut v = s.core.vault.lock();
    v.set_pin(&pin)?;
    Ok(v.status())
}

#[tauri::command]
pub async fn vault_lock(s: State<'_, AppState>, close_sessions: bool) -> Result<VaultStatus> {
    if close_sessions {
        s.attachments.lock().clear();
    }
    s.core.lock(close_sessions).await;
    Ok(s.core.vault.lock().status())
}

// ---------------------------------------------------------- groups, hosts

#[tauri::command]
pub fn groups_list(s: State<'_, AppState>) -> Result<Vec<Group>> {
    s.core.db.list_groups()
}

#[tauri::command]
pub fn group_save(s: State<'_, AppState>, group: Group) -> Result<Group> {
    s.core.db.save_group(group)
}

#[tauri::command]
pub fn group_delete(s: State<'_, AppState>, id: String) -> Result<()> {
    s.core.db.delete_group(&id)
}

#[tauri::command]
pub fn hosts_list(s: State<'_, AppState>) -> Result<Vec<Host>> {
    s.core.db.list_hosts()
}

#[tauri::command]
pub fn host_save(s: State<'_, AppState>, host: Host) -> Result<Host> {
    if host.name.trim().is_empty() || host.address.trim().is_empty() {
        return Err(Error::Other("name and address are required".into()));
    }
    s.core.db.save_host(host)
}

#[tauri::command]
pub async fn host_delete(s: State<'_, AppState>, id: String) -> Result<()> {
    s.core.connections.close(&id).await;
    s.core.db.delete_host(&id)
}

#[tauri::command]
pub fn host_trust_key(s: State<'_, AppState>, host_id: String, fingerprint: String) -> Result<()> {
    s.core.connections.trust_pending_key(&host_id, &fingerprint)
}

// -------------------------------------------------------------- identities

#[tauri::command]
pub fn identities_list(s: State<'_, AppState>) -> Result<Vec<Identity>> {
    let v = s.core.vault.lock();
    let mut list = s.core.db.list_identities()?;
    for i in &mut list {
        i.has_password = v.has(&i.secret_id("password"));
        i.has_key = v.has(&i.secret_id("key"));
        i.has_passphrase = v.has(&i.secret_id("passphrase"));
        i.has_sudo = v.has(&i.secret_id("sudo"));
    }
    Ok(list)
}

/// Secrets: `None` = keep as is, `Some("")` = delete, `Some(value)` = set.
#[tauri::command]
pub fn identity_save(
    s: State<'_, AppState>,
    identity: Identity,
    password: Option<String>,
    key: Option<String>,
    passphrase: Option<String>,
    sudo: Option<String>,
) -> Result<Identity> {
    let saved = s.core.db.save_identity(identity)?;
    let mut v = s.core.vault.lock();
    for (kind, value) in [("password", password), ("key", key), ("passphrase", passphrase), ("sudo", sudo)] {
        match value {
            None => {}
            Some(x) if x.is_empty() => v.delete(&saved.secret_id(kind))?,
            Some(x) => v.set(&saved.secret_id(kind), &x)?,
        }
    }
    Ok(saved)
}

#[tauri::command]
pub fn identity_delete(s: State<'_, AppState>, id: String) -> Result<()> {
    s.core.vault.lock().delete_prefix(&format!("identity:{id}:"))?;
    s.core.db.delete_identity(&id)
}

// ---------------------------------------------------------------- sessions

/// Called when a server tab is focused for the first time. Returns an attach id
/// the tab passes to `session_detach` when it closes.
#[tauri::command]
pub async fn session_attach(s: State<'_, AppState>, host_id: String) -> Result<String> {
    let lease = s.core.connections.acquire(&host_id).await?;
    let id = new_id();
    s.attachments.lock().insert(id.clone(), lease);
    Ok(id)
}

#[tauri::command]
pub fn session_detach(s: State<'_, AppState>, attach_id: String) {
    s.attachments.lock().remove(&attach_id); // drop → grace timer
}

/// Called once when the webview loads. A reload (dev hot-reload, crash) leaves the old
/// page's tab leases, terminals and collectors running; drop them so nothing leaks and
/// sessions close after their grace period unless the new page reopens them.
#[tauri::command]
pub async fn frontend_ready(s: State<'_, AppState>) -> Result<()> {
    s.attachments.lock().clear();
    s.core.subscriptions.stop_all().await;
    s.core.terminals.close_all().await;
    s.core.local.close_all();
    Ok(())
}

#[tauri::command]
pub fn session_info(s: State<'_, AppState>, host_id: String) -> SessionInfo {
    s.core.connections.info(&host_id)
}

#[tauri::command]
pub fn sessions_all(s: State<'_, AppState>) -> Vec<SessionInfo> {
    s.core.connections.all_info()
}

// --------------------------------------------------------------- terminals

#[tauri::command]
pub async fn term_open(s: State<'_, AppState>, req: TermOpen) -> Result<String> {
    s.core.terminals.open(req).await
}

#[tauri::command]
pub fn term_write(s: State<'_, AppState>, term_id: String, data: String) -> Result<()> {
    s.core.terminals.write(&term_id, data.into_bytes())
}

#[tauri::command]
pub fn term_resize(s: State<'_, AppState>, term_id: String, cols: u16, rows: u16) -> Result<()> {
    s.core.terminals.resize(&term_id, cols, rows)
}

#[tauri::command]
pub fn term_close(s: State<'_, AppState>, term_id: String) -> Result<()> {
    s.core.terminals.close(&term_id)
}

// ----------------------------------------------------------- subscriptions

#[derive(Serialize)]
pub struct Subscribed {
    sub_id: String,
    /// Last value for this source (metrics sample, container list…), shown before the next update.
    cached: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn subscribe(
    s: State<'_, AppState>,
    host_id: String,
    source: String,
    params: Option<SubParams>,
) -> Result<Subscribed> {
    let (sub_id, cached) = s.core.subscriptions.subscribe(&host_id, &source, params.unwrap_or_default()).await?;
    Ok(Subscribed { sub_id, cached })
}

// ------------------------------------------------------------------- files

#[tauri::command]
pub async fn sftp_home(s: State<'_, AppState>, host_id: String) -> Result<String> {
    s.core.sftp.home(&host_id).await
}

#[tauri::command]
pub async fn sftp_list(s: State<'_, AppState>, host_id: String, path: String) -> Result<Vec<FileEntry>> {
    s.core.sftp.list(&host_id, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(s: State<'_, AppState>, host_id: String, path: String) -> Result<()> {
    s.core.sftp.mkdir(&host_id, &path).await
}

#[tauri::command]
pub async fn sftp_rename(s: State<'_, AppState>, host_id: String, from: String, to: String) -> Result<()> {
    s.core.sftp.rename(&host_id, &from, &to).await
}

#[tauri::command]
pub async fn sftp_delete(s: State<'_, AppState>, host_id: String, path: String, is_dir: bool, recursive: bool) -> Result<()> {
    s.core.sftp.delete(&host_id, &path, is_dir, recursive).await
}

#[tauri::command]
pub async fn sftp_upload(
    s: State<'_, AppState>,
    host_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    for p in local_paths {
        let path = std::path::PathBuf::from(&p);
        if path.is_dir() {
            ids.push(s.core.sftp.upload_dir(&host_id, path, &remote_dir).await?);
        } else {
            ids.push(s.core.sftp.upload(&host_id, path, &remote_dir).await?);
        }
    }
    Ok(ids)
}

#[tauri::command]
pub async fn sftp_download(s: State<'_, AppState>, host_id: String, remote: String, local: String) -> Result<String> {
    s.core.sftp.download(&host_id, &remote, local.into()).await
}

#[tauri::command]
pub async fn sftp_close(s: State<'_, AppState>, host_id: String) -> Result<()> {
    s.core.sftp.close(&host_id).await;
    Ok(())
}

#[tauri::command]
pub fn transfer_cancel(s: State<'_, AppState>, id: String) {
    s.core.sftp.cancel(&id);
}

/// Returns the local copy's path; the webview opens it with the OS default app.
#[tauri::command]
pub async fn edit_open(s: State<'_, AppState>, host_id: String, remote: String) -> Result<String> {
    Ok(s.core.sftp.edit_open(&host_id, &remote).await?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn edit_upload(s: State<'_, AppState>, host_id: String, remote: String, force: bool) -> Result<()> {
    s.core.sftp.edit_upload(&host_id, &remote, force).await
}

#[tauri::command]
pub fn edit_stop(s: State<'_, AppState>, host_id: String, remote: String) {
    s.core.sftp.edit_stop(&host_id, &remote);
}

// ------------------------------------------------------- docker, services

#[tauri::command]
pub async fn docker_action(
    s: State<'_, AppState>,
    host_id: String,
    container: String,
    action: rookery_core::actions::DockerAction,
) -> Result<()> {
    rookery_core::actions::docker_action(&s.core.connections, &host_id, &container, action).await
}

#[tauri::command]
pub async fn services_list(s: State<'_, AppState>, host_id: String) -> Result<Vec<Service>> {
    rookery_core::actions::services_list(&s.core.connections, &host_id).await
}

#[tauri::command]
pub async fn shell_integration_install(s: State<'_, AppState>, host_id: String) -> Result<u32> {
    rookery_core::actions::install_shell_integration(&s.core.connections, &host_id).await
}

#[tauri::command]
pub async fn unsubscribe(s: State<'_, AppState>, sub_id: String) -> Result<()> {
    s.core.subscriptions.unsubscribe(&sub_id).await;
    Ok(())
}

#[tauri::command]
pub fn refresh_effective(s: State<'_, AppState>, host_id: String) -> Result<EffectiveRefresh> {
    let host = s.core.db.get_host(&host_id)?;
    s.core.db.effective_refresh(&host)
}

// ----------------------------------------------------------- dashboard sync

#[tauri::command]
pub fn snapshots_list(s: State<'_, AppState>) -> Result<Vec<Snapshot>> {
    s.core.db.list_snapshots()
}

#[tauri::command]
pub fn sync_status(s: State<'_, AppState>) -> Result<SyncStatus> {
    s.core.sync.status()
}

/// Async so the engine can spawn onto the runtime.
#[tauri::command]
pub async fn sync_run(s: State<'_, AppState>, scope: SyncScope) -> Result<String> {
    s.core.sync.run(scope, false)
}

#[tauri::command]
pub fn sync_cancel(s: State<'_, AppState>, job_id: String) {
    s.core.sync.cancel(&job_id);
}

#[tauri::command]
pub async fn sync_settings_set(s: State<'_, AppState>, settings: SyncSettings) -> Result<SyncSettings> {
    s.core.sync.set_settings(settings)
}

#[tauri::command]
pub fn refresh_global_set(s: State<'_, AppState>, setting: RefreshSetting) -> Result<RefreshSetting> {
    let mut setting = setting;
    if setting.mode == RefreshMode::Inherit {
        setting.mode = RefreshMode::Auto;
    }
    s.core.db.set_setting("refresh.global", &setting)?;
    s.core.db.global_refresh()
}

/// Auto-sync switch for groups (`"ungrouped"` = hosts without a group).
#[tauri::command]
pub fn sync_set_auto(s: State<'_, AppState>, group_ids: Vec<String>, on: bool) -> Result<()> {
    s.core.db.set_auto_sync(&group_ids, on)
}

#[tauri::command]
pub fn sync_window_visible(s: State<'_, AppState>, visible: bool) {
    s.core.sync.set_visible(visible);
}

// --------------------------------------------------------- backup & device sync

/// Run blocking work (Argon2id, file IO) off the async workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| Error::Other(e.to_string()))?
}

#[tauri::command]
pub fn backup_status(s: State<'_, AppState>) -> Result<BackupStatus> {
    s.core.backup.status()
}

#[tauri::command]
pub fn backup_set_config(s: State<'_, AppState>, folder: Option<String>, auto: bool, device_name: String) -> Result<BackupStatus> {
    s.core.backup.set_config(folder, auto, device_name)
}

/// The secret goes straight into the vault; it never comes back to the webview.
#[tauri::command]
pub async fn backup_set_password(s: State<'_, AppState>, password: String) -> Result<()> {
    let b = s.core.backup.clone();
    blocking(move || b.set_password(&password)).await
}

#[tauri::command]
pub async fn backup_sync_now(s: State<'_, AppState>) -> Result<BackupStatus> {
    s.core.backup.sync_now(true).await
}

/// `password` None = the saved sync password.
#[tauri::command]
pub async fn backup_export(s: State<'_, AppState>, path: String, password: Option<String>) -> Result<()> {
    let b = s.core.backup.clone();
    blocking(move || b.export_file(std::path::Path::new(&path), password.as_deref())).await
}

#[tauri::command]
pub async fn backup_inspect(s: State<'_, AppState>, path: String, password: Option<String>) -> Result<BackupInfo> {
    let b = s.core.backup.clone();
    blocking(move || b.inspect_file(std::path::Path::new(&path), password.as_deref())).await
}

#[tauri::command]
pub async fn backup_import(s: State<'_, AppState>, path: String, password: Option<String>, mode: ImportMode) -> Result<MergeSummary> {
    let b = s.core.backup.clone();
    blocking(move || b.import_file(std::path::Path::new(&path), password.as_deref(), mode)).await
}

/// Put a file on the clipboard (paste it into Telegram, Explorer, mail…).
#[tauri::command]
pub async fn file_copy_to_clipboard(path: String) -> Result<()> {
    if !std::path::Path::new(&path).is_file() {
        return Err(Error::NotFound(path));
    }
    blocking(move || {
        #[cfg(windows)]
        let out = {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let lit = path.replace('\'', "''");
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &format!("Set-Clipboard -LiteralPath '{lit}'")])
                .creation_flags(CREATE_NO_WINDOW)
                .output()?
        };
        #[cfg(target_os = "macos")]
        let out = {
            let lit = path.replace('\\', "\\\\").replace('"', "\\\"");
            std::process::Command::new("osascript")
                .args(["-e", &format!("set the clipboard to (POSIX file \"{lit}\")")])
                .output()?
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        let out: std::process::Output = return Err(Error::Other("copying files is not supported here; use Show in folder".into()));
        if out.status.success() {
            Ok(())
        } else {
            Err(Error::Other(String::from_utf8_lossy(&out.stderr).trim().to_string()))
        }
    })
    .await
}

// ---------------------------------------------------------------- snippets

#[tauri::command]
pub fn snippets_list(s: State<'_, AppState>) -> Result<Vec<Snippet>> {
    s.core.db.list_snippets()
}

#[tauri::command]
pub fn snippet_save(s: State<'_, AppState>, snippet: Snippet) -> Result<Snippet> {
    s.core.db.save_snippet(snippet)
}

#[tauri::command]
pub fn snippet_delete(s: State<'_, AppState>, id: String) -> Result<()> {
    s.core.db.delete_snippet(&id)
}

// ------------------------------------------------------------- UI settings

/// Only `ui.*` keys are writable from the webview (keybindings, terminal prefs…).
fn ui_key(key: &str) -> Result<()> {
    if key.starts_with("ui.") && key.len() < 64 {
        Ok(())
    } else {
        Err(Error::Other(format!("setting '{key}' is not a UI setting")))
    }
}

#[tauri::command]
pub fn setting_get(s: State<'_, AppState>, key: String) -> Result<Option<serde_json::Value>> {
    ui_key(&key)?;
    s.core.db.get_setting(&key)
}

#[tauri::command]
pub fn setting_set(s: State<'_, AppState>, key: String, value: serde_json::Value) -> Result<()> {
    ui_key(&key)?;
    s.core.db.set_setting(&key, &value)
}

// ------------------------------------------------------------ known hosts

#[tauri::command]
pub fn known_hosts_list(s: State<'_, AppState>) -> Result<Vec<KnownHost>> {
    s.core.db.list_known_hosts()
}

#[tauri::command]
pub fn known_host_forget(s: State<'_, AppState>, host_id: String) -> Result<()> {
    s.core.db.forget_host_key(&host_id)
}

// --------------------------------------------------------- local terminals

#[tauri::command]
pub fn local_shells() -> Vec<LocalShell> {
    rookery_core::local::available_shells()
}

#[tauri::command]
pub fn local_term_open(s: State<'_, AppState>, shell_id: String, cols: u16, rows: u16) -> Result<String> {
    s.core.local.open(&shell_id, cols, rows)
}

#[tauri::command]
pub fn local_term_write(s: State<'_, AppState>, term_id: String, data: String) -> Result<()> {
    s.core.local.write(&term_id, data.as_bytes())
}

#[tauri::command]
pub fn local_term_resize(s: State<'_, AppState>, term_id: String, cols: u16, rows: u16) -> Result<()> {
    s.core.local.resize(&term_id, cols, rows)
}

#[tauri::command]
pub fn local_term_close(s: State<'_, AppState>, term_id: String) {
    s.core.local.close(&term_id);
}

// -------------------------------------------------------------- processes

#[tauri::command]
pub async fn processes_list(s: State<'_, AppState>, host_id: String) -> Result<Vec<Process>> {
    rookery_core::actions::processes_list(&s.core.connections, &host_id).await
}

#[tauri::command]
pub async fn process_kill(s: State<'_, AppState>, host_id: String, pid: u32, force: bool) -> Result<()> {
    rookery_core::actions::process_kill(&s.core.connections, &host_id, pid, force).await
}

// -------------------------------------------------------------- sudo fill

/// Types the saved sudo password into a terminal. The secret goes vault → SSH channel
/// and never passes through the webview.
#[tauri::command]
pub fn term_sudo_fill(s: State<'_, AppState>, term_id: String) -> Result<()> {
    let host_id = s.core.terminals.host_of(&term_id).ok_or_else(|| Error::NotFound("terminal".into()))?;
    let host = s.core.db.get_host(&host_id)?;
    let ident_id = s
        .core
        .db
        .resolve_identity_id(&host)?
        .ok_or_else(|| Error::SecretRequired("this host has no login identity".into()))?;
    let ident = s.core.db.get_identity(&ident_id)?;
    let secret = {
        let v = s.core.vault.lock();
        match v.get(&ident.secret_id("sudo"))? {
            Some(x) => x,
            None if ident.auth == AuthKind::Password => v
                .get(&ident.secret_id("password"))?
                .ok_or_else(|| Error::SecretRequired("no sudo password saved for this login".into()))?,
            None => return Err(Error::SecretRequired("no sudo password saved for this login — add it in the host editor".into())),
        }
    };
    let mut bytes = secret.as_bytes().to_vec();
    bytes.push(b'\r');
    s.core.terminals.write(&term_id, bytes)
}

// ------------------------------------------------------- import / export

const FILE_MAX: u64 = 5 * 1024 * 1024;

/// Read a text file the user picked in a dialog (snippet / keymap / theme import).
#[tauri::command]
pub fn file_read_text(path: String) -> Result<String> {
    let meta = std::fs::metadata(&path)?;
    if meta.len() > FILE_MAX {
        return Err(Error::Other("file is larger than 5 MB".into()));
    }
    Ok(std::fs::read_to_string(&path)?)
}

/// Write a text file the user picked in a save dialog (exports).
#[tauri::command]
pub fn file_write_text(path: String, content: String) -> Result<()> {
    if content.len() as u64 > FILE_MAX {
        return Err(Error::Other("export is larger than 5 MB".into()));
    }
    Ok(std::fs::write(&path, content)?)
}

// --------------------------------------------------------------- clipboard

/// Clipboard through the Rust side of the plugin (no webview permission layer involved).
#[tauri::command]
pub fn clipboard_write(app: tauri::AppHandle, text: String) -> Result<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text).map_err(|e| Error::Other(format!("clipboard: {e}")))
}

#[tauri::command]
pub fn clipboard_read(app: tauri::AppHandle) -> Result<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().map_err(|e| Error::Other(format!("clipboard: {e}")))
}

/// Dev aid: what is running right now (host, source, refcount).
#[tauri::command]
pub async fn debug_active_subscriptions(s: State<'_, AppState>) -> Result<Vec<(String, String, u32)>> {
    Ok(s.core.subscriptions.active().await)
}
