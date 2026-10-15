import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check } from "lucide-react";

export type MenuItem =
  | { kind?: "item"; label: string; icon?: ReactNode; onClick: () => void; checked?: boolean; disabled?: boolean; danger?: boolean }
  | { kind: "separator" }
  | { kind: "label"; label: string };

/** Right-click menu at the pointer. Closes on outside click, Esc, scroll or blur. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    el.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [x, y]);

  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
        const i = list.indexOf(document.activeElement as HTMLButtonElement);
        list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
      }
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[200px] rounded-lg border border-line bg-panel p-1 shadow-xl"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.kind === "separator" ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : it.kind === "label" ? (
          <div key={i} className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold text-muted">
            {it.label}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
            className={clsx(
              "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] outline-none disabled:opacity-40",
              it.danger ? "text-prod-fg hover:bg-[#33232A] focus:bg-[#33232A]" : "hover:bg-panel2 focus:bg-panel2",
            )}
          >
            <span className="grid w-4 place-items-center text-muted">{it.checked ? <Check size={13} className="text-accent" /> : it.icon}</span>
            <span className="flex-1">{it.label}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** `const menu = useContextMenu(); <div onContextMenu={menu.open(items)}>…{menu.node}` */
export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  return {
    open: (items: MenuItem[] | (() => MenuItem[])) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setState({ x: e.clientX, y: e.clientY, items: typeof items === "function" ? items() : items });
    },
    node: state && <ContextMenu x={state.x} y={state.y} items={state.items} onClose={() => setState(null)} />,
  };
}
