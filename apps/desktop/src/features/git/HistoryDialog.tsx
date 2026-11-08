// Git history and blame of one file (read-only). Opened from the editor's tab menu or the Git view.
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { api, asCoreError } from "../../ipc/api";
import type { BlameLine } from "../../ipc/bindings/BlameLine";
import type { GitCommit } from "../../ipc/bindings/GitCommit";
import type { GitDiff } from "../../ipc/bindings/GitDiff";
import { Modal } from "../../ui/primitives";
import { DiffView } from "../editor/Dialogs";
import { langOf } from "../editor/lang";
const normalizeGitText = (text: string) => text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

import { useGitHistory, type HistoryTab as Tab, type HistoryTarget as Target } from "./history";

const date = (s: number) => (s ? new Date(s * 1000).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

/** Loaded on first use (the diff view is large). */
export default function GitHistoryDialog() {
  const target = useGitHistory((s) => s.target);
  if (!target) return null;
  return <HistoryDialog key={`${target.hostId}|${target.root}|${target.path}`} target={target} onClose={() => useGitHistory.getState().close()} />;
}

function HistoryDialog({ target, onClose }: { target: Target; onClose: () => void }) {
  const { hostId, root, path } = target;
  const [tab, setTab] = useState<Tab>(target.tab);
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [picked, setPicked] = useState<GitCommit | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [blame, setBlame] = useState<BlameLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** A commit clicked in Blame before the history was loaded. */
  const [want, setWant] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== "history" || commits) return;
    setLoading(true);
    api.gitHistory(hostId, root, path).then(
      (c) => {
        setCommits(c);
        setPicked((want && c.find((x) => x.hash.startsWith(want))) || c[0] || null);
        setLoading(false);
      },
      (e) => {
        setError(asCoreError(e).message);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `want` is read once when the list arrives
  }, [tab, commits, hostId, root, path]);

  useEffect(() => {
    if (tab !== "blame" || blame) return;
    setLoading(true);
    api.gitBlame(hostId, root, path).then(
      (b) => {
        setBlame(b);
        setLoading(false);
      },
      (e) => {
        setError(asCoreError(e).message);
        setLoading(false);
      },
    );
  }, [tab, blame, hostId, root, path]);

  useEffect(() => {
    if (!picked) return;
    let live = true;
    setDiff(null);
    api.gitFileAt(hostId, root, picked.hash, picked.path).then(
      (d) => live && setDiff(d),
      (e) => live && setError(asCoreError(e).message),
    );
    return () => {
      live = false;
    };
  }, [picked, hostId, root]);

  /** Blame rows: author/commit only on the first line of each run of the same commit. */
  const rows = useMemo(() => (blame ?? []).map((b, i, all) => ({ ...b, first: i === 0 || all[i - 1].short !== b.short })), [blame]);
  const openCommit = (short: string) => {
    const c = commits?.find((x) => x.hash.startsWith(short));
    if (c) setPicked(c);
    else setWant(short);
    setTab("history");
  };

  return (
    <Modal title={`${tab === "history" ? "History" : "Blame"}: ${path}`} onClose={onClose} width={1100}>
      <div className="flex h-[70vh] min-h-0 flex-col gap-2">
        <div className="flex items-center gap-2 text-xs">
          <div role="tablist" className="flex rounded-md border border-line p-0.5">
            {(["history", "blame"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={clsx("rounded px-2.5 py-1", tab === t ? "bg-accent-bg text-text" : "text-muted hover:text-text")}>
                {t === "history" ? "History" : "Blame"}
              </button>
            ))}
          </div>
          <span className="truncate font-mono text-muted" title={root}>
            {root}
          </span>
          {loading && <Loader2 size={13} className="animate-spin text-muted" />}
        </div>
        {error && <div role="alert" className="rounded-md border border-[#5A2D33] bg-[#33232A] px-3 py-2 text-xs text-[#FFA8A8]">{error}</div>}
        {tab === "history" ? (
          <div className="flex min-h-0 flex-1 gap-2">
            <div role="listbox" aria-label="Commits" className="w-[300px] flex-none overflow-auto rounded-md border border-line">
              {commits?.length === 0 && <div className="p-3 text-xs text-muted">No commits for this file yet.</div>}
              {commits?.map((c) => (
                <button key={c.hash} role="option" aria-selected={picked?.hash === c.hash} onClick={() => setPicked(c)} className={clsx("flex w-full flex-col gap-0.5 border-b border-line px-2.5 py-1.5 text-left", picked?.hash === c.hash ? "bg-accent-bg" : "hover:bg-panel2")}>
                  <span className="truncate text-xs text-text" title={c.subject}>
                    {c.subject}
                  </span>
                  <span className="flex gap-2 text-[11px] text-muted">
                    <span className="font-mono">{c.short}</span>
                    <span className="truncate">{c.author}</span>
                    <span className="ml-auto flex-none">{date(c.time)}</span>
                  </span>
                  {c.path !== path && <span className="truncate font-mono text-[10px] text-muted">was {c.path}</span>}
                </button>
              ))}
              {commits && commits.length >= 200 && <div className="p-2 text-[11px] text-muted">The newest 200 commits.</div>}
            </div>
            <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-line">
              {!picked ? null : !diff ? (
                <div role="status" className="p-3 text-xs text-muted">Loading…</div>
              ) : diff.notice ? (
                <div className="p-3 text-xs text-muted">{diff.notice}</div>
              ) : (
                <DiffView key={picked.hash} left={normalizeGitText(diff.left)} right={normalizeGitText(diff.right)} lang={langOf(path)} resizeId="git-history" labels={{ left: `Before ${picked.short}`, right: `${picked.short} · read-only` }} />
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto rounded-md border border-line font-mono text-xs">
            <table className="w-full border-collapse">
              <tbody>
                {rows.map((b) => (
                  <tr key={b.line} className={clsx(b.first && "border-t border-line")}>
                    <td className="w-[230px] max-w-[230px] truncate px-2 align-top text-[11px] text-muted">
                      {b.first &&
                        (/^0+$/.test(b.short) ? (
                          <span>not committed yet</span>
                        ) : (
                          <button onClick={() => openCommit(b.short)} title={`${b.summary}\n${b.author}, ${date(b.time)}`} className="truncate text-left hover:text-text">
                            {b.short} {b.author} · {new Date(b.time * 1000).toLocaleDateString()}
                          </button>
                        ))}
                    </td>
                    <td className="w-10 pr-2 text-right align-top text-muted select-none">{b.line}</td>
                    <td className="pr-3 whitespace-pre">{b.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {blame?.length === 0 && <div className="p-3 text-muted">Nothing to show.</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}
