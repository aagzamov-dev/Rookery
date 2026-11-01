#[tauri::command]
pub async fn desktop_notification_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use mac_usernotifications::{AuthorizationStatus, NotificationSettingStatus};
        let settings = mac_usernotifications::get_notification_settings()
            .await
            .map_err(|e| e.to_string())?;
        Ok(matches!(
            settings.authorization_status,
            AuthorizationStatus::Authorized | AuthorizationStatus::Ephemeral
        ) && settings.alert_enabled == NotificationSettingStatus::Enabled)
    }
    #[cfg(not(target_os = "macos"))]
    Err("This notification command is only available on macOS.".into())
}

#[tauri::command]
pub async fn desktop_notification_request_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if !mac_usernotifications::request_auth()
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(false);
        }
        desktop_notification_permission().await
    }
    #[cfg(not(target_os = "macos"))]
    Err("This notification command is only available on macOS.".into())
}

#[tauri::command]
pub async fn desktop_notification_send(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if !desktop_notification_permission().await? {
            return Err("Allow Rookery notification banners in macOS System Settings.".into());
        }
        mac_usernotifications::Notification::new()
            .title(&title)
            .message(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body);
        Err("This notification command is only available on macOS.".into())
    }
}
