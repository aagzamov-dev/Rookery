import { useEffect, useRef, useState } from "react";
import { api, asCoreError } from "../../ipc/api";
import { useLogs } from "../../stores/logs";
import { LogViewer, type Props } from "./LogViewer";
import { dateInputValue, fileHistoryInRange, HISTORY_LINES, yesterdayRange } from "./history";

type HistoryProps = Props & { hostId: string; source: "docker" | "file"; target: string; visible: boolean };

export function HistoryLogViewer({ hostId, source, target, visible, ...viewer }: HistoryProps) {
  const [range, setRange] = useState<"live" | "yesterday" | "custom">("live");
  const initial = yesterdayRange();
  const [since, setSince] = useState(() => dateInputValue(initial.since));
  const [until, setUntil] = useState(() => dateInputValue(initial.until));
  const [history, setHistory] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const active = useRef(visible);
  active.current = visible;
  const stream = `${source}:${target}`;

  useEffect(() => () => { generation.current++; useLogs.getState().setPaused(hostId, stream, false); }, [hostId, stream]);
  useEffect(() => { if (!visible) { generation.current++; setBusy(false); } }, [visible]);

  const changeDate = (value: string, field: "since" | "until") => {
    generation.current++;
    setHistory([]); setStatus(null); setBusy(false);
    if (field === "since") setSince(value); else setUntil(value);
  };
  const latest = () => {
    generation.current++;
    setRange("live");
    setBusy(false);
    setStatus(null);
    useLogs.getState().setPaused(hostId, stream, false);
  };
  const load = async (from: Date, to: Date) => {
    if (!active.current) return;
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
      setStatus("Choose a valid start and end time.");
      return;
    }
    const request = ++generation.current;
    useLogs.getState().setPaused(hostId, stream, true);
    setBusy(true);
    setHistory([]);
    setStatus(null);
    try {
      const lines = await api.logHistory(hostId, source, target, from.toISOString(), to.toISOString());
      if (!active.current || generation.current !== request) return;
      const selected = source === "file" ? fileHistoryInRange(lines, +from, +to) : { lines, recognized: true };
      setHistory(selected.lines);
      setStatus(!selected.recognized ? "No supported timestamps in this file window. Time filtering supports ISO and YYYY-MM-DD HH:mm:ss; dates without a zone use this computer’s time zone." : `${selected.lines.length} lines in the selected period. Partial history; older and rotated logs may be absent.`);
    } catch (error) {
      if (active.current && generation.current === request) setStatus(asCoreError(error).message);
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };

  return <div className="flex h-full min-h-0 flex-col bg-term">
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs">
      <select aria-label="Log period" className="rounded border border-line bg-bg px-2 py-1" value={range} onChange={(event) => {
        const next = event.target.value as typeof range;
        if (next === "live") { latest(); return; }
        generation.current++;
        setHistory([]);
        setStatus(null);
        setBusy(false);
        setRange(next);
        useLogs.getState().setPaused(hostId, stream, true);
        if (next === "yesterday") {
          const dates = yesterdayRange();
          setSince(dateInputValue(dates.since)); setUntil(dateInputValue(dates.until));
          void load(dates.since, dates.until);
        }
      }}>
        <option value="live">Latest · live</option><option value="yesterday">Yesterday</option><option value="custom">Choose time…</option>
      </select>
      {range === "custom" && <>
        <input aria-label="Logs from" type="datetime-local" value={since} onChange={(e) => changeDate(e.target.value, "since")} className="rounded border border-line bg-bg px-1 py-1" />
        <span>to</span>
        <input aria-label="Logs until" type="datetime-local" value={until} onChange={(e) => changeDate(e.target.value, "until")} className="rounded border border-line bg-bg px-1 py-1" />
        <button disabled={busy || !visible} className="rounded border border-line px-2 py-1" onClick={() => void load(new Date(since), new Date(until))}>Load</button>
      </>}
      {range !== "live" && <button className="ml-auto text-accent" onClick={latest}>Latest / follow</button>}
    </div>
    <div className="px-3 py-1 text-[11px] text-muted">
      {range === "live" ? "Starts / resumes with up to 500 Docker lines or 200 file lines; keeps 5,000 lines / 4 MiB locally. Gaps may be omitted." : `Partial history: at most ${HISTORY_LINES.toLocaleString()} lines${source === "file" ? " from up to 20,000 lines in the final 2 MiB of this file; ISO / YYYY-MM-DD timestamps only" : " in this period"}. No rotated files scanned. Local time selection.`}
      {busy ? " Loading…" : status ? ` ${status}` : ""}
    </div>
    <div className="min-h-0 flex-1">
      <LogViewer {...viewer} lines={range === "live" ? viewer.lines : history} live={range === "live" && visible && viewer.live} ended={range === "live" ? viewer.ended : null} dropped={range === "live" ? viewer.dropped : 0} onClear={range === "live" ? viewer.onClear : () => setHistory([])} />
    </div>
  </div>;
}
