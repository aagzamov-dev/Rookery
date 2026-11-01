// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { askConfirm, useDialogs } from "../stores/dialogs";
import { DialogHost } from "./DialogHost";

it("keeps PROD confirmation exact across focus and clicks, with browser correction disabled", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useDialogs.setState({ current: null, queue: [] });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const resolved = vi.fn();
  try {
    await act(async () => { root.render(<DialogHost />); void askConfirm({ title: "PROD backup", confirmLabel: "Write backup", typeToConfirm: "taobao" }).then(resolved); });
    const input = document.querySelector<HTMLInputElement>('[aria-label="Confirmation text"]')!;
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Write backup")!;
    expect(input.getAttribute("autocapitalize")).toBe("none");
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type("Taobao");
    expect(confirm.disabled).toBe(true);
    expect(document.body.textContent).toContain("Does not match");
    await act(async () => confirm.click());
    expect(resolved).not.toHaveBeenCalled();
    await type("taobao");
    await act(async () => { input.blur(); input.focus(); });
    expect(input.value).toBe("taobao");
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    expect(resolved).toHaveBeenCalledExactlyOnceWith(true);
    expect(document.querySelector('[aria-label="Confirmation text"]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); useDialogs.setState({ current: null, queue: [] }); vi.unstubAllGlobals(); }
});
