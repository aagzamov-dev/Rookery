// Promise-based dialogs: `await askConfirm(...)` from anywhere (terminal registry, snippet runner).
import { create } from "zustand";

let nextId = 1;

export interface ConfirmRequest {
  id: number;
  kind: "confirm";
  title: string;
  body?: string;
  /** Shown in a monospace preview box (command, pasted text). */
  preview?: string;
  confirmLabel: string;
  danger?: boolean;
  /** The confirm button stays off until this exact text is typed (PROD database name). */
  typeToConfirm?: string;
  resolve: (ok: boolean) => void;
}

export interface ChoiceRequest {
  id: number;
  kind: "choice";
  title: string;
  body?: string;
  /** Buttons, left to right; Cancel is always added. */
  choices: { id: string; label: string; variant?: "primary" | "danger" | "outline" }[];
  resolve: (choice: string | null) => void;
}

export interface VarsRequest {
  id: number;
  kind: "vars";
  title: string;
  command: string;
  vars: { name: string; value: string }[];
  resolve: (values: Record<string, string> | null) => void;
}

export interface TextRequest {
  id: number;
  kind: "text";
  title: string;
  label: string;
  value: string;
  confirmLabel: string;
  /** Masked input (passwords). */
  secret?: boolean;
  /** Select only this part on open (e.g. the name without extension). */
  selectUntil?: number;
  resolve: (value: string | null) => void;
}

type Request = ConfirmRequest | VarsRequest | TextRequest | ChoiceRequest;

interface DialogsState {
  current: Request | null;
  queue: Request[];
  push: (r: Request) => void;
  done: () => void;
}

export const useDialogs = create<DialogsState>((set, get) => ({
  current: null,
  queue: [],
  push: (r) => (get().current ? set({ queue: [...get().queue, r] }) : set({ current: r })),
  done: () => {
    const [next, ...rest] = get().queue;
    set({ current: next ?? null, queue: rest });
  },
}));

export function askConfirm(opts: Omit<ConfirmRequest, "id" | "kind" | "resolve">): Promise<boolean> {
  return new Promise((resolve) => useDialogs.getState().push({ id: nextId++, kind: "confirm", ...opts, resolve }));
}

export function askText(opts: Omit<TextRequest, "id" | "kind" | "resolve">): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().push({ id: nextId++, kind: "text", ...opts, resolve }));
}

export function askVars(opts: Omit<VarsRequest, "id" | "kind" | "resolve">): Promise<Record<string, string> | null> {
  return new Promise((resolve) => useDialogs.getState().push({ id: nextId++, kind: "vars", ...opts, resolve }));
}

/** Several answers (e.g. Commit / Rollback); resolves to the chosen id, or null for Cancel. */
export function askChoice(opts: Omit<ChoiceRequest, "id" | "kind" | "resolve">): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().push({ id: nextId++, kind: "choice", ...opts, resolve }));
}
