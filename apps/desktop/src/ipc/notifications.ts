import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isMac } from "../keys/chord";

export const desktopNotifications = {
  permission: () => isMac ? invoke<boolean>("desktop_notification_permission") : isPermissionGranted(),
  requestPermission: async () => isMac
    ? invoke<boolean>("desktop_notification_request_permission")
    : await requestPermission() === "granted",
  send: async (payload: { title: string; body: string }) => {
    if (isMac) await invoke<void>("desktop_notification_send", payload);
    else sendNotification(payload);
  },
};
