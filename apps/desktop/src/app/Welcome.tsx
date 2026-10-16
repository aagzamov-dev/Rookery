import { useEffect, useState } from "react";
import { Download, FolderSync, Plus, Server } from "lucide-react";
import { api } from "../ipc/api";
import { useHosts } from "../stores/hosts";
import { useTabs } from "../stores/tabs";
import { Modal } from "../ui/primitives";

const KEY = "ui.onboarded";

/** First run: add a server, import from MobaXterm / PuTTY / ~/.ssh/config, or restore from another device. */
export function Welcome({ onNewHost, onImport }: { onNewHost: () => void; onImport: () => void }) {
  const loaded = useHosts((s) => s.loaded);
  const empty = useHosts((s) => s.hosts.length === 0);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    if (!empty) {
      void api.settingSet(KEY, true).catch(() => {});
      return;
    }
    void api
      .settingGet<boolean>(KEY)
      .then((done) => setShow(!done))
      .catch(() => {});
  }, [loaded, empty]);

  if (!show) return null;
  const finish = (then: () => void) => {
    setShow(false);
    void api.settingSet(KEY, true).catch(() => {});
    then();
  };
  const choice = (icon: React.ReactNode, title: string, hint: string, go: () => void) => (
    <button onClick={() => finish(go)} className="flex items-start gap-3 rounded-xl border border-line bg-panel2 p-3.5 text-left hover:border-accent-line">
      <span className="mt-0.5 text-accent">{icon}</span>
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold">{title}</span>
        <span className="text-xs leading-relaxed text-muted">{hint}</span>
      </span>
    </button>
  );

  return (
    <Modal title="Welcome to Rookery" onClose={() => finish(() => {})} width={560}>
      <p className="m-0 flex items-center gap-2 text-muted">
        <Server size={15} /> Everything stays on this computer, encrypted. How do you want to start?
      </p>
      <div className="grid gap-2">
        {choice(<Plus size={16} />, "Add a server", "Name, address and login. Nothing connects until you open it.", onNewHost)}
        {choice(<Download size={16} />, "Import my servers", "From MobaXterm, PuTTY or ~/.ssh/config. You choose which ones.", onImport)}
        {choice(
          <FolderSync size={16} />,
          "I use Rookery on another computer",
          "Join your sync folder or import a backup file: servers, logins, snippets and shortcuts come over.",
          () => useTabs.getState().openPage("backup"),
        )}
      </div>
    </Modal>
  );
}
