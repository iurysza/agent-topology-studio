// @vitest-environment happy-dom
// The bar's project switcher sits above a list page that reads keys on `window` (useListKeys). A key that opens
// the switcher must stay with the switcher: it must not also open or move the list underneath.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useListKeys } from "./parts.tsx";
import { Select } from "./select.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const rows = ["review", "ship", "triage"];
const options = [{ value: "*", label: "All projects" }, { value: "a", label: "agents2" }, { value: "q", label: "quality" }];

function Page({ open }: { open: (i: number) => void }) {
  const sel = useListKeys(rows.length, open);
  return createElement(Fragment, null,
    createElement(Select, { className: "bar-proj", label: "Project: quality. Switch project", value: "q", options, width: 360, onChange: () => {} }),
    createElement("ul", null, rows.map((r, i) => createElement("li", { key: r, className: i === sel ? "sel" : "" }, r))));
}

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });
const key = (target: EventTarget, k: string) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const selected = () => [...document.querySelectorAll("li.sel")].map((li) => li.textContent);

describe("project switcher over a list page", () => {
  it("Enter and ArrowDown on the closed switcher open it without opening or moving the list", () => {
    const open = vi.fn();
    const el = document.createElement("div"); document.body.append(el);
    root = createRoot(el);
    act(() => root!.render(createElement(Page, { open })));
    key(document.body, "j");
    expect(selected()).toEqual(["review"]);

    const trigger = document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    act(() => trigger.focus());
    key(trigger, "Enter");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(selected()).toEqual(["review"]);

    key(trigger, "Escape"); // close, so ArrowDown takes the opening branch again
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    key(trigger, "ArrowDown");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(open).not.toHaveBeenCalled();
    expect(selected()).toEqual(["review"]);
  });
});
