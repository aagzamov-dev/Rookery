import clsx from "clsx";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { X } from "lucide-react";

type Variant = "primary" | "ghost" | "outline" | "danger";

export function Button({
  variant = "outline",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex h-8 items-center justify-center gap-2 rounded-md px-3 text-[13px] whitespace-nowrap",
        variant === "primary" && "bg-accent font-semibold text-bg hover:brightness-110",
        variant === "outline" && "border border-line bg-transparent text-text hover:bg-panel2",
        variant === "ghost" && "bg-transparent text-muted hover:bg-panel2 hover:text-text",
        variant === "danger" && "border border-[#5A2D33] bg-[#33232A] text-prod-fg hover:brightness-125",
        className,
      )}
    />
  );
}

export function IconButton({ label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      {...rest}
      className={clsx("grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text", className)}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function TextInput({ className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return (
    <input
      {...rest}
      className={clsx(
        "h-9 rounded-lg border border-line bg-panel px-3 text-text outline-none placeholder:text-[#6B7690] focus:border-accent-line",
        mono && "font-mono",
        className,
      )}
    />
  );
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={clsx("h-9 rounded-lg border border-line bg-panel px-2.5 text-text outline-none focus:border-accent-line", className)}
    />
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 560,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="flex max-h-[90vh] w-full flex-col rounded-xl border border-line bg-panel shadow-2xl"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
          <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
          <IconButton label="Close" className="ml-auto" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="flex flex-col gap-4 overflow-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function EnvTag({ env }: { env: string }) {
  if (env === "none") return null;
  const map: Record<string, string> = {
    prod: "bg-prod-bg text-prod-fg",
    staging: "bg-[#44391A] text-[#F7CB6A]",
    dev: "bg-[#2B3F66] text-[#BCD3FF]",
    lab: "bg-[#1e3d33] text-[#86E0B6]",
    client: "bg-[#2B3F66] text-[#BCD3FF]",
  };
  return (
    <span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase", map[env])}>{env}</span>
  );
}

export function StatusDot({ state }: { state?: string }) {
  const color =
    state === "connected" ? "bg-ok" : state === "connecting" || state === "reconnecting" ? "bg-warn" : state === "error" ? "bg-bad" : "bg-[#6B7690]";
  return <span aria-hidden className={clsx("inline-block h-[7px] w-[7px] flex-none rounded-full", color)} />;
}
