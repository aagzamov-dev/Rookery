use rook_core::model::*;
use rook_core::{new_id, CoreEvent, Error, Result};
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
    cached: Option<MetricsSample>,
}

#[tauri::command]
pub async fn subscribe(
    s: State<'_, AppState>,
    host_id: String,
    source: String,
    interval_ms: Option<u32>,
) -> Result<Subscribed> {
    let (sub_id, cached) = s.core.subscriptions.subscribe(&host_id, &source, interval_ms).await?;
    Ok(Subscribed { sub_id, cached })
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

/// Dev aid: what is running right now (host, source, refcount).
#[tauri::command]
pub async fn debug_active_subscriptions(s: State<'_, AppState>) -> Result<Vec<(String, String, u32)>> {
    Ok(s.core.subscriptions.active().await)
}
