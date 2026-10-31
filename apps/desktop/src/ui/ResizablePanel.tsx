import { useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { clampPanelWidth, saveNumber, storedNumber } from "./panelSize";

export function ResizablePanel({ id, label, initialWidth, side = "left", minWidth = 180, maxWidth = 480, maxViewportRatio = 0.45, minRemainingWidth = 0, className, children }: {
  id: string; label: string; initialWidth: number; side?: "left" | "right"; minWidth?: number; maxWidth?: number; maxViewportRatio?: number; minRemainingWidth?: number; className?: string; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const clamp = (value: number) => {
    const available = minRemainingWidth > 0 && panel.current?.parentElement ? panel.current.parentElement.clientWidth - minRemainingWidth : Infinity;
    return clampPanelWidth(value, minWidth, Math.min(maxWidth, available), window.innerWidth, maxViewportRatio);
  };
  const [width, setWidth] = useState(() => clamp(storedNumber(`ui.panel.${id}`, initialWidth)));
  const update = (value: number) => {
    const next = clamp(value);
    setWidth(next);
    saveNumber(`ui.panel.${id}`, next);
  };
  return (
    <div ref={panel} className={clsx("relative min-h-0 flex-none", className)} style={{ width, maxWidth: minRemainingWidth > 0 ? `min(${maxViewportRatio * 100}vw, calc(100% - ${minRemainingWidth}px))` : `${maxViewportRatio * 100}vw`, minWidth }}>
      {children}
      <div role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={Math.round(width)} tabIndex={0}
        className={`absolute inset-y-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-accent-line focus:bg-accent-line focus:outline-none ${side === "left" ? "right-0" : "left-0"}`}
        onPointerDown={(event) => { if (event.button === 0) { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); } }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
          update(side === "left" ? event.clientX - bounds.left : bounds.right - event.clientX);
        }}
        onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          update((panel.current?.getBoundingClientRect().width ?? width) + (event.key === "ArrowRight" ? 16 : -16) * (side === "left" ? 1 : -1));
        }}
      />
    </div>
  );
}
