import { useEffect, useRef } from "react";
import { terminalRegistry, type TermOptions } from "./registry";

interface Props {
  termKey: string;
  hostId: string;
  visible: boolean;
  opts: TermOptions;
}

/** Hosts one registry terminal. Stays mounted while its server tab exists. */
export function TerminalPane({ termKey, hostId, visible, opts }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) terminalRegistry.attach(termKey, hostId, ref.current, opts);
    // Disposal happens when the slot or tab is closed, not on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termKey, hostId]);

  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      terminalRegistry.fit(termKey);
      terminalRegistry.focus(termKey);
    });
    const ro = new ResizeObserver(() => terminalRegistry.fit(termKey));
    if (ref.current) ro.observe(ref.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [visible, termKey]);

  return <div ref={ref} className="h-full w-full bg-term" style={{ display: visible ? "block" : "none" }} />;
}
