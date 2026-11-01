import { needsLockScreen, useVault } from "../stores/vault";
import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { useNotifications } from "../stores/notifications";
import { Button, IconButton, Modal } from "./primitives";

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const locked = useVault((state) => needsLockScreen(state.status, state.pinSkipped));
  useEffect(() => { if (locked) setOpen(false); }, [locked]);
  const { items, markRead, clear } = useNotifications();
  const unread = items.filter((item) => !item.read).length;
  return <>
    <IconButton label={`Notifications${unread ? ` (${unread} unread)` : ""}`} onClick={() => { markRead(); setOpen(true); }}><Bell size={17} />{unread > 0 && <span className="text-xs">{unread}</span>}</IconButton>
    {open && !locked && <Modal title="Notifications" onClose={() => setOpen(false)} footer={<><Button onClick={clear} disabled={!items.length}>Clear all</Button><Button onClick={() => setOpen(false)}>Close</Button></>}>
      <div className="space-y-3">
        <p className="m-0 text-xs text-muted">Notifications always appear here while Rookery is open.</p>
        <DesktopNotificationPermission />
        {!items.length && <p className="text-sm text-muted">No notifications yet.</p>}
        {items.map((item) => <article key={item.id} className="rounded-lg border border-line p-3 text-sm"><b>{item.title}</b><p className="my-1 whitespace-pre-wrap break-words">{item.body}</p><time className="text-xs text-muted">{new Date(item.at).toLocaleString()}</time></article>)}
      </div>
    </Modal>}
  </>;
}

export function DesktopNotificationPermission({ showTest = false }: { showTest?: boolean }) {
  const { permission, requesting, enable, test, deliveryError } = useNotifications();
  return <div className="space-y-2">
    {permission === "granted" ? <p className="text-xs text-muted">Desktop notification permission granted.</p> : <Button disabled={requesting} onClick={() => void enable()}>{requesting ? "Requesting permission…" : "Enable desktop notifications"}</Button>}
    {showTest && <Button disabled={requesting} onClick={() => void test()}>Test notification</Button>}
    {permission === "denied" && <p className="text-xs text-muted">Allow Rookery notifications and banners in macOS System Settings or Windows Settings, then try again.</p>}
    {permission === "unavailable" && <p className="text-xs text-muted">Desktop notifications are unavailable. You can still read notifications here.</p>}
    {deliveryError && <p role="alert" className="text-xs text-muted">Desktop notification could not be sent: {deliveryError}</p>}
  </div>;
}
