// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { EventRows, transitionHint } from "./rows.tsx";

// SAFETY: React reads this optional global flag to enable act diagnostics.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("transition copy", () => {
  it("names the section and the add button Transitions", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => { root.render(createElement(EventRows, { from: "task", value: undefined, states: {}, onChange: vi.fn(), onErrors: vi.fn() })); });
      expect(host.querySelector(".label")?.textContent).toBe("Transitions");
      expect(host.querySelector("button.rl-add")?.textContent).toBe("+ Add transition");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it("hints per kind", () => {
    expect(transitionHint("task")).toBe("The agent reports one when it finishes; the run moves to that state.");
    expect(transitionHint("decision")).toBe(transitionHint("task"));
    expect(transitionHint("fanout")).toBe("`failed` fires when a branch fails or the gate rejects.");
    expect(transitionHint("final")).toBeNull();
  });
});
