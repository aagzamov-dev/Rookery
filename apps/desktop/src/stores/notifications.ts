import { useVault } from "./vault";
import { create } from "zustand";
import { desktopNotifications } from "../ipc/notifications";

type Permission = "unknown" | "granted" | "denied" | "unavailable";
type Notice = { id: string; title: string; body: string; at: number; read: boolean };
export const useNotifications = create<{
  items: Notice[];
  permission: Permission;
  requesting: boolean;
  deliveryError: string | null;
  add: (title: string, body: string, id?: string) => void;
  markRead: () => void;
  clear: () => void;
  enable: () => Promise<void>;
  test: () => Promise<void>;
}>((set, get) => ({
  items: [], permission: "unknown", requesting: false, deliveryError: null,
  add: (title, body, id = crypto.randomUUID()) => {
    if (get().items.some((item) => item.id === id)) return;
    set((state) => ({ items: [{ id, title, body, at: Date.now(), read: false }, ...state.items].slice(0, 100) }));
    void (async () => {
      try {
        const granted = await desktopNotifications.permission();
        set({ permission: granted ? "granted" : "denied" });
        if (granted) {
          const unlocked = useVault.getState().status?.unlocked;
          await desktopNotifications.send(unlocked ? { title, body } : { title: "Rookery notification", body: "Open Rookery to view the notification." });
          set({ deliveryError: null });
        }
      } catch (error) { set({ deliveryError: error instanceof Error ? error.message : String(error) }); }
    })();
  },
  test: async () => {
    if (get().requesting) return;
    await get().enable();
    get().add("Rookery test notification", "This is a test notification from Rookery.");
  },
  markRead: () => set((state) => ({ items: state.items.map((item) => ({ ...item, read: true })) })),
  clear: () => set({ items: [] }),
  enable: async () => {
    if (get().requesting) return;
    set({ requesting: true });
    try {
      const granted = await desktopNotifications.permission();
      set({ permission: granted || await desktopNotifications.requestPermission() ? "granted" : "denied" });
    } catch (error) { set({ permission: "unavailable", deliveryError: error instanceof Error ? error.message : String(error) }); }
    finally { set({ requesting: false }); }
  },
}));

export function notify(title: string, body: string) {
  useNotifications.getState().add(title, body);
}
