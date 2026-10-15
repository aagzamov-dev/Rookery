//! Tauri glue: commands forward to `rookery-core`, core events are forwarded to the
//! webview on the single `core` channel (docs/01-ARCHITECTURE.md §6).

mod commands;

use std::collections::HashMap;

use parking_lot::Mutex;
use rookery_core::ssh::Lease;
use rookery_core::Core;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub core: Core,
    /// Leases held by open server tabs (attach_id → lease). A tab keeps its
    /// session alive even when no terminal or collector is running.
    pub attachments: Mutex<HashMap<String, Lease>>,
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,russh=warn".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let core = Core::init(Core::default_data_dir()).map_err(|e| e.to_string())?;

            // Forward core events to the frontend.
            let mut rx = core.subscribe_events();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tokio::sync::broadcast::error::RecvError;
                loop {
                    match rx.recv().await {
                        Ok(ev) => {
                            let _ = handle.emit("core", ev);
                        }
                        Err(RecvError::Lagged(n)) => tracing::warn!("ui event channel lagged by {n}"),
                        Err(RecvError::Closed) => break,
                    }
                }
            });

            // Auto-sync scheduler: idle unless a group's Auto-sync switch is on.
            tauri::async_runtime::spawn(core.sync.clone().run_scheduler());

            app.manage(AppState { core, attachments: Mutex::new(HashMap::new()) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::vault_create,
            commands::vault_unlock_master,
            commands::vault_unlock_pin,
            commands::vault_set_pin,
            commands::vault_lock,
            commands::groups_list,
            commands::group_save,
            commands::group_delete,
            commands::hosts_list,
            commands::host_save,
            commands::host_delete,
            commands::identities_list,
            commands::identity_save,
            commands::identity_delete,
            commands::frontend_ready,
            commands::clipboard_write,
            commands::clipboard_read,
            commands::known_hosts_list,
            commands::known_host_forget,
            commands::local_shells,
            commands::local_term_open,
            commands::local_term_write,
            commands::local_term_resize,
            commands::local_term_close,
            commands::processes_list,
            commands::process_kill,
            commands::term_sudo_fill,
            commands::file_read_text,
            commands::file_write_text,
            commands::session_attach,
            commands::session_detach,
            commands::session_info,
            commands::sessions_all,
            commands::host_trust_key,
            commands::term_open,
            commands::term_write,
            commands::term_resize,
            commands::term_close,
            commands::subscribe,
            commands::unsubscribe,
            commands::refresh_effective,
            commands::snapshots_list,
            commands::sync_status,
            commands::sync_run,
            commands::sync_cancel,
            commands::sync_settings_set,
            commands::refresh_global_set,
            commands::sync_set_auto,
            commands::sync_window_visible,
            commands::snippets_list,
            commands::snippet_save,
            commands::snippet_delete,
            commands::setting_get,
            commands::setting_set,
            commands::sftp_home,
            commands::sftp_list,
            commands::sftp_mkdir,
            commands::sftp_rename,
            commands::sftp_delete,
            commands::sftp_upload,
            commands::sftp_download,
            commands::sftp_close,
            commands::transfer_cancel,
            commands::edit_open,
            commands::edit_upload,
            commands::edit_stop,
            commands::docker_action,
            commands::services_list,
            commands::shell_integration_install,
            commands::debug_active_subscriptions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rookery");
}
