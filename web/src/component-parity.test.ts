// @vitest-environment happy-dom
// Pins for the clean-room rewrite of graph.tsx, editor.tsx and parts.tsx (ADR-0009).
// Written and run against the old code first. They pin what a user or a caller sees: labels, roles, classes the
// stylesheet reads, callbacks, keys and saving. They do not pin geometry. Only the browser's missing pieces are
// emulated (layout sizes, ResizeObserver delivery, hit testing) and the server is faked at fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fit, layoutMachine, MachineGraph, Thumb, type Draw, type RunView, type View } from "./graph.tsx";
import { Editor, KindGlyph, useMeasuredHeight } from "./editor.tsx";
import { Block, CopyPath, PageHead, ProblemList, Rich, Sep, useDir, useListKeys, useNow } from "./parts.tsx";
import { plan } from "./mock/machines.ts";
import { isUnsaved, unsavedWhat } from "./unsaved.ts";
import type { Paint } from "./runs.ts";
import type { Machine, Role } from "./types.ts";

// SAFETY: React reads this optional global flag to enable act diagnostics.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------- browser emulation: one layout size for every box, real ResizeObserver delivery, a hit test ----------

const box = { width: 800, height: 600 };

const observers = new Set<FakeResizeObserver>();

class FakeResizeObserver implements ResizeObserver {
  targets = new Set<Element>();
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element) {
    this.targets.add(el);
    observers.add(this);
    queueMicrotask(() => { if (this.targets.has(el)) this.deliver([el]); }); // a browser reports the first size after observe
  }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); observers.delete(this); }
  deliver(els: Element[]) {
    const size: ResizeObserverSize = { inlineSize: box.width, blockSize: box.height };
    const entries: ResizeObserverEntry[] = els.map((target) => ({ target, contentRect: new DOMRect(0, 0, box.width, box.height), borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size] }));

    this.cb(entries, this);
  }
}

const resize = (width: number, height = box.height) => act(() => {
  box.width = width; box.height = height;

  for (const o of observers) o.deliver([...o.targets]);
});

let hit: Element | null = null; // what document.elementFromPoint finds under the pointer

type Patched = Element | Document | Navigator;

const saved: [Patched, string, PropertyDescriptor | undefined][] = [];

const patch = (target: Patched, name: string, desc: PropertyDescriptor) => {
  saved.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
  Object.defineProperty(target, name, { configurable: true, ...desc });
};

beforeEach(() => {
  box.width = 800; box.height = 600; hit = null;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);

  for (const proto of [Element.prototype, HTMLElement.prototype]) {
    patch(proto, "clientWidth", { get: () => box.width });
    patch(proto, "clientHeight", { get: () => box.height });
  }

  patch(HTMLElement.prototype, "offsetWidth", { get: () => box.width });
  patch(HTMLElement.prototype, "offsetHeight", { get: () => box.height });
  patch(Element.prototype, "getBoundingClientRect", { value: () => new DOMRect(0, 0, box.width, box.height) });
  patch(document, "elementFromPoint", { value: () => hit });
  localStorage.clear();
});

let root: Root | null = null;

let host: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  document.body.style.overflow = "";
  observers.clear();

  for (const [target, name, desc] of saved.splice(0).reverse()) {
    if (desc) Object.defineProperty(target, name, desc); else Reflect.deleteProperty(target, name);
  }

  vi.unstubAllGlobals();
  vi.useRealTimers();
  location.hash = "";
});

const mount = async (el: ReactElement) => {
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
  await act(async () => {});

  return host;
};

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) => {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(ev); });

  return ev;
};

const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });

const dblclick = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); });

const pointer = (target: EventTarget, type: string, x: number, y: number) =>
  act(() => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 })); });

const type = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => act(() => {
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});

const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

const $ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => scope.querySelector<T>(sel);

const $$ = <T extends Element = Element>(sel: string, scope: ParentNode = document) => [...scope.querySelectorAll<T>(sel)];

const byLabel = <T extends Element = HTMLElement>(label: string, scope: ParentNode = document) => $<T>(`[aria-label="${label}"]`, scope);

// ---------- graph ----------

const node = (id: string, scope: ParentNode = host) => $(`[data-node="${id}"]`, scope);

const edgeOf = (event: string, toTitle: string, scope: ParentNode = host) =>
  $$("g.e", scope).find((g) => $$("title", g).some((t) => t.textContent === `Transition ${event} → ${toTitle}`)) ?? null;

function GraphHost({ machine, view = {}, onSelect, draw, run, spy, height = 300 }: { machine: Machine; view?: View; onSelect?: (s: string) => void; draw?: Draw; run?: RunView; spy?: (open: boolean) => void; height?: number }) {
  const [full, setFull] = useState(false);

  return h(MachineGraph, { machine, view, height, onSelect, draw, run, full, setFull: (o: boolean) => { spy?.(o); setFull(o); }, readout: h("span", { className: "test-readout" }, "the readout") });
}

const openFull = () => {
  const btn = $<HTMLButtonElement>(".tools button", host)!;
  act(() => btn.focus());
  click(btn);

  return btn;
};

const pct = () => parseInt($('.full [aria-label="Fit to screen"]')!.textContent ?? "", 10);

const canvas = () => $<SVGSVGElement>(".full svg.canvas")!;

describe("graph: pure helpers", () => {
  it("fit picks a scale that keeps the whole machine inside the box and under the cap", () => {
    for (const [W, H] of [[800, 400], [300, 600], [1200, 200]]) {
      const { l, s } = fit(plan, W, H, 1.2);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1.2);
      expect(l.w * s).toBeLessThanOrEqual(W + 0.5);
      expect(l.h * s).toBeLessThanOrEqual(H + 0.5);
    }
  });
  it("every node box sits inside the layout, so a fitted drawing never overflows", () => {
    for (const dir of ["LR", "TB"] as const) for (const detail of [false, true]) {
      const l = layoutMachine(plan, dir, detail);

      for (const n of l.nodes) {
        expect(n.x - n.w / 2).toBeGreaterThanOrEqual(0);
        expect(n.y - n.h / 2).toBeGreaterThanOrEqual(0);
        expect(n.x + n.w / 2).toBeLessThanOrEqual(l.w);
        expect(n.y + n.h / 2).toBeLessThanOrEqual(l.h);
      }
    }
  });
  it("edge keys read from→event, finals carry their outcome, and only task and decision states carry a role", () => {
    const m = structuredClone(plan);
    m.states.split = { kind: "fanout", title: "Split", role: "lead", branches: [], on: { joined: { to: "approved" } } };
    m.states.lost = { kind: "final", title: "Lost", outcome: "failure" };
    const l = layoutMachine(m, "LR");
    expect(l.edges.map((e) => e.key).sort()).toContain("challenge→changes");
    expect(l.edges.find((e) => e.key === "challenge→changes")).toMatchObject({ from: "challenge", to: "revise", event: "changes" });
    const n = (id: string) => l.nodes.find((x) => x.id === id)!;
    expect(n("approved").outcome).toBe("success");
    expect(n("lost").outcome).toBe("failure");
    expect(n("draft").role).toBe("lead");
    expect(n("split").role).toBeUndefined();
  });
});

describe("graph: inline", () => {
  it("draws at the measured width, follows resizes, and stops observing on unmount", async () => {
    await mount(h(GraphHost, { machine: plan, height: 100 }));
    expect($<HTMLElement>(".gview", host)!.style.height).toBe("240px");
    const svg = $("svg.graph", host)!;
    expect(classes(svg)).toEqual(expect.arrayContaining(["graph", "edit"]));
    expect(classes(svg)).not.toContain("pick");
    expect(svg.getAttribute("width")).toBe("800");
    await resize(520);
    expect($("svg.graph", host)!.getAttribute("width")).toBe("520");
    expect(observers.size).toBeGreaterThan(0);
    act(() => root!.unmount()); root = null;
    expect([...observers].every((o) => o.targets.size === 0)).toBe(true);
  });

  it("marks the selection, its ways out, problems, missing targets and kinds", async () => {
    const m = structuredClone(plan); m.states.explain.on = { done: { to: "approved" }, later: { to: "ghost" } };
    const view: View = { selected: "draft", edges: new Set(["draft→drafted"]), targets: new Set(["challenge"]), problems: new Set(["revise"]), roleColor: (r) => (r === "lead" ? "blue" : null) };
    await mount(h(GraphHost, { machine: m, view, onSelect: vi.fn() }));
    expect(classes(node("draft"))).toEqual(expect.arrayContaining(["n", "lit", "sel", "k-task"]));
    expect(classes(node("challenge"))).toEqual(expect.arrayContaining(["n", "walked", "k-decision"]));
    expect(classes(node("challenge"))).not.toContain("sel");
    expect(classes(node("revise"))).toEqual(expect.arrayContaining(["prob", "idle"]));
    expect(classes(node("approved"))).toEqual(expect.arrayContaining(["idle", "k-final"]));
    expect(classes(node("ghost"))).toContain("missing");
    expect(node("ghost")!.textContent).toContain("ghost ?");
    expect($$("title", node("ghost")!).map((t) => t.textContent)).toContain("not written yet");
    expect(classes(edgeOf("drafted", "Challenge the plan"))).toContain("walked");
    expect(classes(edgeOf("approved", "Explain the plan"))).toContain("idle");
    expect(edgeOf("later", "not written yet")).not.toBeNull();
    const dot = $(".rsw", node("draft")!)!;
    expect(classes(dot)).toEqual(expect.arrayContaining(["sw", "c-blue"]));
    expect(dot.textContent).toBe("lead");
    expect(classes($(".rsw", node("challenge")!))).toEqual(["rsw", "sw"]);
    expect(classes($("svg.graph", host))).toContain("pick");
  });

  it("selects a state by click, Enter or Space, but never a missing one", async () => {
    const m = structuredClone(plan); m.states.explain.on = { later: { to: "ghost" } };
    const onSelect = vi.fn();
    await mount(h(GraphHost, { machine: m, onSelect }));
    const d = node("draft")!;
    expect(d.getAttribute("role")).toBe("button");
    expect(d.getAttribute("tabindex")).toBe("0");
    expect(d.getAttribute("aria-label")).toBe("draft: Draft the plan");
    click(d); key(d, "Enter"); key(d, " ");
    expect(onSelect.mock.calls).toEqual([["draft"], ["draft"], ["draft"]]);
    click(node("ghost")!);
    expect(node("ghost")!.getAttribute("role")).toBeNull();
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("a graph without a select handler has no clickable states and no drawing controls", async () => {
    await mount(h(GraphHost, { machine: plan }));
    expect(node("draft")!.getAttribute("role")).toBeNull();
    expect($$(".plus, .x", host)).toHaveLength(0);
  });

  it("paints a replay: visited, current, trail, hop chips, visit badges, branch results and the end", async () => {
    const m: Machine = { id: "r", name: "R", description: "d", initial: "a", states: {
      a: { kind: "task", title: "A", role: "lead", on: { go: { to: "f" }, skip: { to: "won" } } },
      f: { kind: "fanout", title: "F", branches: [], on: { joined: { to: "lost" } } },
      won: { kind: "final", title: "Won", outcome: "success" },
      lost: { kind: "final", title: "Lost", outcome: "failure" },
    } };

    const run: Paint = {
      visits: new Map([["a", 2], ["f", 1], ["lost", 1]]), current: "lost", pending: false,
      trail: new Map([["a→go", [1, 3]], ["f→joined", [4]]]),
      branches: new Map([["f", [{ id: "x", ok: true }, { id: "y", ok: false }, { id: "z", ok: null }]]]),
    };

    await mount(h(GraphHost, { machine: m, view: { run } }));
    expect(classes(node("a"))).toContain("visited");
    expect(classes(node("won"))).toContain("unvisited");
    expect(classes(node("lost"))).toEqual(expect.arrayContaining(["visited", "now", "end-failure"]));
    expect(classes(edgeOf("go", "F"))).toContain("trail");
    expect(classes(edgeOf("skip", "Won"))).toContain("untaken");
    expect(classes(edgeOf("joined", "Lost"))).toEqual(expect.arrayContaining(["trail", "end-failure"]));
    const hops = $$(".hop", edgeOf("go", "F")!);
    expect(hops.map((x) => x.textContent)).toEqual(["1Step 1: a → f", "3Step 3: a → f"]);
    expect($(".vb", node("a")!)!.textContent).toBe("×2Visited 2 times");
    expect($(".vb", node("f")!)).toBeNull();
    const br = $$(".br", node("f")!);
    expect(br.map((b) => classes(b).filter((c) => c !== "br"))).toEqual([["ok"], ["bad"], ["wait"]]);
    expect(br.map((b) => b.textContent)).toEqual(["x: ok", "y: failed", "z: no result yet"]);
  });
});

describe("graph: full screen", () => {
  it("opens as a modal over the page, focuses Close, locks scroll, and restores all three on Escape", async () => {
    const spy = vi.fn();
    await mount(h(GraphHost, { machine: plan, onSelect: vi.fn(), spy }));
    const btn = $(".tools button", host)!;
    expect(btn.textContent).toContain("Full screen");
    expect(btn.getAttribute("title")).toBe("Full screen (f)");
    openFull();
    expect(spy).toHaveBeenLastCalledWith(true);
    const dlg = $('[role="dialog"]')!;
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(dlg.getAttribute("aria-label")).toBe("Workflow, full screen");
    expect(classes(dlg)).toContain("full");
    expect(host.contains(dlg)).toBe(false);
    expect(document.activeElement?.textContent).toBe("Close");
    expect(document.body.style.overflow).toBe("hidden");
    expect($(".full-title")!.textContent).toBe("the readout");
    expect($(".legend")!.textContent).toContain("ways out of the selected state");
    expect($(".legend")!.textContent).toContain("drag to pan · pinch or ⌘ scroll to zoom · 0 fits");
    key(document.body, "Escape");
    expect(spy).toHaveBeenLastCalledWith(false);
    expect($(".full")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(btn);
  });

  it("f and the Close button also close it", async () => {
    await mount(h(GraphHost, { machine: plan }));
    openFull(); key(document.body, "f");
    expect($(".full")).toBeNull();
    openFull(); click($(".full-tools button.pill")!);
    expect($(".full")).toBeNull();
  });

  it("zooms with keys and buttons, fits with 0 and the percent button, and swallows the keys it handles", async () => {
    await mount(h(GraphHost, { machine: plan }));
    const page = vi.fn();
    window.addEventListener("keydown", page);

    try {
      openFull();
      const fitted = pct();
      expect(fitted).toBeGreaterThan(0);
      const plus = key(document.body, "+");
      expect(plus.defaultPrevented).toBe(true);
      expect(pct()).toBeGreaterThan(fitted);
      key(document.body, "0");
      expect(pct()).toBe(fitted);
      key(document.body, "-");
      expect(pct()).toBeLessThan(fitted);
      key(document.body, "0"); key(document.body, "=");
      expect(pct()).toBeGreaterThan(fitted);
      key(document.body, "0"); key(document.body, "_");
      expect(pct()).toBeLessThan(fitted);
      key(document.body, "0"); click(byLabel("Zoom in")!);
      expect(pct()).toBeGreaterThan(fitted);
      click(byLabel("Fit to screen")!);
      expect(pct()).toBe(fitted);
      click(byLabel("Zoom out")!);
      expect(pct()).toBeLessThan(fitted);

      for (let i = 0; i < 40; i++) key(document.body, "-");
      expect(pct()).toBeGreaterThanOrEqual(15);

      for (let i = 0; i < 60; i++) key(document.body, "+");
      expect(pct()).toBeLessThanOrEqual(400);
      expect(page).not.toHaveBeenCalled();
      const other = key(document.body, "x");
      expect(other.defaultPrevented).toBe(false);
      expect(page).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", page);
    }
  });

  it("ignores its keys while an input has focus", async () => {
    await mount(h(GraphHost, { machine: plan }));
    openFull();
    const input = document.createElement("input"); $(".full")!.append(input);
    key(input, "Escape"); key(input, "+");
    expect($(".full")).not.toBeNull();
  });

  it("walks states: select by click, ArrowRight follows the first way out, ArrowLeft goes back, Escape clears then closes", async () => {
    const spy = vi.fn();
    await mount(h(GraphHost, { machine: plan, onSelect: vi.fn(), spy }));
    openFull();
    const full = $(".full")!;
    click(node("draft", full)!);
    expect(classes(canvas())).toContain("has-sel");
    expect(classes(node("draft", full))).toContain("sel");
    expect($(".full-title")!.textContent).toBe("Plan a changedraft · 1 way out");
    expect(byLabel("State draft")).not.toBeNull();
    expect(classes(edgeOf("drafted", "Challenge the plan", full))).toContain("walked");
    key(document.body, "ArrowRight");
    expect(byLabel("State challenge")).not.toBeNull();
    expect($(".full-title")!.textContent).toBe("Plan a changechallenge · 2 ways out");
    key(document.body, "ArrowLeft");
    expect(byLabel("State draft")).not.toBeNull();
    key(document.body, "ArrowLeft"); // history is empty again
    expect(byLabel("State draft")).not.toBeNull();
    key(document.body, "Escape");
    expect(byLabel("State draft")).toBeNull();
    expect(classes(canvas())).not.toContain("has-sel");
    expect($(".full-title")!.textContent).toBe("the readout");
    expect(spy).not.toHaveBeenLastCalledWith(false);
    key(document.body, "Escape");
    expect($(".full")).toBeNull();
  });

  it("a click on empty canvas clears the selection; a drag pans without zooming", async () => {
    await mount(h(GraphHost, { machine: plan, onSelect: vi.fn() }));
    openFull();
    click(node("draft", $(".full")!)!);
    const before = canvas().innerHTML, zoom = pct();
    pointer(canvas(), "pointerdown", 300, 300);
    pointer(canvas(), "pointermove", 360, 340);
    pointer(canvas(), "pointerup", 360, 340);
    expect(canvas().innerHTML).not.toBe(before);
    expect(pct()).toBe(zoom);
    expect(byLabel("State draft")).not.toBeNull();
    pointer(canvas(), "pointerdown", 300, 300);
    pointer(canvas(), "pointerup", 300, 300);
    expect(byLabel("State draft")).toBeNull();
  });

  it("the wheel pans, ⌘ or ctrl wheel zooms, and a wheel over the card is left to the card", async () => {
    await mount(h(GraphHost, { machine: plan, onSelect: vi.fn() }));
    openFull();
    const full = $(".full")!, zoom = pct(), before = canvas().innerHTML;

    const wheel = (target: Element, init: WheelEventInit) => {
      const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 400, clientY: 300, ...init });
      // happy-dom drops the modifier flags from WheelEventInit; a browser keeps them.
      Object.defineProperty(ev, "ctrlKey", { value: !!init.ctrlKey });
      Object.defineProperty(ev, "metaKey", { value: !!init.metaKey });
      act(() => { target.dispatchEvent(ev); });

      return ev;
    };

    expect(wheel(full, { deltaY: 40 }).defaultPrevented).toBe(true);
    expect(pct()).toBe(zoom);
    expect(canvas().innerHTML).not.toBe(before);
    expect(wheel(full, { deltaY: -100, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(pct()).toBeGreaterThan(zoom);
    const z2 = pct();
    wheel(full, { deltaY: 100, metaKey: true });
    expect(pct()).toBeLessThan(z2);
    click(node("draft", full)!);
    const card = byLabel("State draft")!;
    expect(wheel(card, { deltaY: 40, ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("the card's Edit picks the state for the inspector and leaves full screen", async () => {
    const onSelect = vi.fn(), spy = vi.fn();
    await mount(h(GraphHost, { machine: plan, onSelect, spy }));
    openFull();
    click(node("challenge", $(".full")!)!);
    const edit = $$(".scard button").find((b) => b.textContent === "Edit")!;
    click(edit);
    expect(onSelect).toHaveBeenCalledWith("challenge");
    expect(spy).toHaveBeenLastCalledWith(false);
    expect($(".full")).toBeNull();
  });

  it("in a replay it opens on the run's state, shows the run section, and offers no Edit", async () => {
    const run: RunView = { open: "challenge", section: (id) => h("p", { className: "run-sect" }, `run of ${id}`) };
    await mount(h(GraphHost, { machine: plan, onSelect: vi.fn(), run }));
    openFull();
    expect(byLabel("State challenge")).not.toBeNull();
    expect($(".run-sect")!.textContent).toBe("run of challenge");
    expect($$(".scard button").some((b) => b.textContent === "Edit")).toBe(false);
    expect($(".legend")!.textContent).toContain("the path this run took");
    expect($(".legend")!.textContent).not.toContain("ways out of the selected state");
  });
});

describe("graph: drawing by hand", () => {
  const draw = (o: Partial<Draw> = {}): Draw => ({ onAdd: vi.fn(), onConnect: vi.fn(), onRetitle: vi.fn(), eventName: vi.fn(() => "next"), onArm: vi.fn(), onRemove: vi.fn(), onKeep: vi.fn(), ...o });

  it("offers + on every existing non-final state and × on every existing state", async () => {
    const m = structuredClone(plan); m.states.explain.on = { done: { to: "approved" }, later: { to: "ghost" } };
    await mount(h(GraphHost, { machine: m, onSelect: vi.fn(), draw: draw() }));
    expect($$('[aria-label^="Add a state after"]', host).map((x) => x.getAttribute("aria-label")).sort()).toEqual(
      ["challenge", "draft", "explain", "revise"].map((id) => `Add a state after ${id}, or drag to connect`));
    expect($$('[aria-label^="Remove "]', host).map((x) => x.getAttribute("aria-label")).sort()).toEqual(
      ["approved", "challenge", "draft", "explain", "revise"].map((id) => `Remove ${id}`));
    expect(byLabel("Add a state after draft, or drag to connect")!.getAttribute("role")).toBe("button");
  });

  it("a click on + adds after that state; so does a drag dropped on nothing or on itself", async () => {
    const d = draw();
    await mount(h(GraphHost, { machine: plan, onSelect: vi.fn(), draw: d }));
    const plus = byLabel("Add a state after draft, or drag to connect")!;
    pointer(plus, "pointerdown", 100, 100); pointer(window, "pointerup", 100, 100);
    pointer(plus, "pointerdown", 100, 100); pointer(window, "pointermove", 300, 300); pointer(window, "pointerup", 300, 300);
    hit = node("draft");
    pointer(plus, "pointerdown", 100, 100); pointer(window, "pointermove", 300, 300); pointer(window, "pointerup", 300, 300);
    expect(d.onAdd).toHaveBeenCalledTimes(3);
    expect(vi.mocked(d.onAdd).mock.calls.every(([from]) => from === "draft")).toBe(true);
    expect(d.onConnect).not.toHaveBeenCalled();
    expect($(".drag-line", host)).toBeNull();
  });

  it("dragging + onto another state shows a line and a drop target, then asks for the event name", async () => {
    const d = draw();
    await mount(h(GraphHost, { machine: plan, onSelect: vi.fn(), draw: d }));
    const plus = byLabel("Add a state after draft, or drag to connect")!;
    pointer(plus, "pointerdown", 100, 100);
    hit = $("text", node("explain")!); // the pointer is over a part of the state
    pointer(window, "pointermove", 300, 300);
    expect($(".drag-line", host)).not.toBeNull();
    expect(classes(node("explain"))).toContain("drop");
    expect(classes(node("draft"))).not.toContain("drop");
    pointer(window, "pointerup", 300, 300);
    expect($(".drag-line", host)).toBeNull();
    expect(classes(node("explain"))).not.toContain("drop");
    expect(d.onAdd).not.toHaveBeenCalled();
    expect(d.eventName).toHaveBeenCalledWith("draft", "explain");
    const ask = $(".ask-inline", host)!;
    expect(ask.textContent).toContain("Transition from draft to explain");
    const input = byLabel<HTMLInputElement>("Event name", ask)!;
    expect(input.value).toBe("next");
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("spellcheck")).toBe("false");
    type(input, "  go  ");
    key(input, "Enter");
    expect(d.onConnect).toHaveBeenCalledExactlyOnceWith("draft", "explain", "go");
    expect($(".ask-inline", host)).toBeNull();
  });

  it("the event name defaults to the target id, and Escape, blur or a blank name connect nothing", async () => {
    const d = draw({ eventName: undefined });
    await mount(h(GraphHost, { machine: plan, onSelect: vi.fn(), draw: d }));
    const page = vi.fn();
    window.addEventListener("keydown", page);

    try {
      const drag = () => { const plus = byLabel("Add a state after draft, or drag to connect")!; hit = node("revise"); pointer(plus, "pointerdown", 100, 100); pointer(window, "pointermove", 300, 300); pointer(window, "pointerup", 300, 300);

 return byLabel<HTMLInputElement>("Event name")!; };

      expect(drag().value).toBe("revise");
      key(byLabel("Event name")!, "Escape");
      expect($(".ask-inline", host)).toBeNull();
      expect(page).not.toHaveBeenCalled();
      const blurred = drag();
      act(() => blurred.blur());
      expect($(".ask-inline", host)).toBeNull();
      const input = drag(); type(input, "   "); key(input, "Enter");
      expect($(".ask-inline", host)).toBeNull();
      expect(d.onConnect).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", page);
    }
  });

  it("double-click retitles in place; an empty title stays empty", async () => {
    const d = draw();
    const m = structuredClone(plan); m.states.explain.title = "";
    await mount(h(GraphHost, { machine: m, onSelect: vi.fn(), draw: d }));
    dblclick(node("draft")!);
    const ask = $(".ask-inline", host)!;
    expect(ask.textContent).toContain("Title of draft");
    const input = byLabel<HTMLInputElement>("Title", ask)!;
    expect(input.value).toBe("Draft the plan");
    expect(document.activeElement).toBe(input);
    type(input, " A new title "); key(input, "Enter");
    expect(d.onRetitle).toHaveBeenCalledExactlyOnceWith("draft", "A new title");
    dblclick(node("explain")!);
    expect(byLabel<HTMLInputElement>("Title")!.value).toBe("");
  });

  it("× arms a state; the armed confirm removes it or keeps it", async () => {
    const d = draw({ armed: "challenge" });
    await mount(h(GraphHost, { machine: plan, onSelect: vi.fn(), draw: d }));
    click(byLabel("Remove draft")!);
    expect(d.onArm).toHaveBeenCalledExactlyOnceWith("draft");
    expect(classes(node("challenge"))).toContain("armed");
    const confirm = $('[role="alertdialog"]', host)!;
    expect(confirm.getAttribute("aria-label")).toBe("Remove challenge?");
    const [remove, keepIt] = $$("button", confirm);
    expect(remove.textContent).toBe("Remove challenge");
    expect(document.activeElement).toBe(remove);
    expect(keepIt.textContent).toBe("Keep it");
    click(remove);
    expect(d.onRemove).toHaveBeenCalledExactlyOnceWith("challenge");
    click(keepIt);
    expect(d.onKeep).toHaveBeenCalledTimes(1);
  });
});

describe("graph: thumb", () => {
  it("draws one block per state, round blocks for finals, and only forward links", async () => {
    await mount(h(Thumb, { machine: plan }));
    const svg = $("svg.thumb", host)!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("height")).toBe("52");
    const w = Number(svg.getAttribute("width"));
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThanOrEqual(150);
    expect($$("rect", svg)).toHaveLength(5);
    expect($$("rect.fin", svg)).toHaveLength(1);
    expect($$("path", svg)).toHaveLength(4); // five links; revise → challenge closes a loop
  });
  it("fits a custom box and survives a machine with no states", async () => {
    await mount(h("div", null, h(Thumb, { machine: plan, w: 60, h: 20 }), h(Thumb, { machine: { ...plan, states: {} } })));
    const [small, empty] = $$("svg.thumb", host);
    expect(small.getAttribute("height")).toBe("20");
    expect(Number(small.getAttribute("width"))).toBeLessThanOrEqual(60);
    const ew = Number(empty.getAttribute("width"));
    expect(Number.isFinite(ew) && ew > 0).toBe(true);
    expect($$("rect", empty)).toHaveLength(0);
  });
});

// ---------- editor ----------

const roles: Role[] = [{ name: "lead", color: "blue" }, { name: "oracle", color: "purple" }, { name: "scribe", color: "yellow" }];

const CODE = "export default machine({\n  id: \"plan\",\n});";

type Call = { method: string; url: string; body?: { machine: Machine; hash: string } };

let calls: Call[] = [];

let served: Machine = plan;

let loadError: string | null = null; // when set, reading the workflow file fails with this message

let onSave: (n: number) => [number, string] = () => [200, JSON.stringify({ code: "// saved 1", hash: "h2", warnings: [] })];

const reply = (status: number, json: string) => Promise.resolve(new Response(json, { status }));

const fakeServer = () => vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body });

  if (url === "/api/project") return reply(200, JSON.stringify({ dir: "/tmp/demo", roles, workflows: [] }));

  if (url === "/api/workflows/plan" && method === "GET" && loadError) return reply(500, JSON.stringify({ error: loadError }));

  if (url === "/api/workflows/plan" && method === "GET") return reply(200, JSON.stringify({ machine: served, code: CODE, hash: "h1", problems: [], warnings: [] }));

  if (url === "/api/workflows/plan" && method === "PUT") return reply(...onSave(calls.filter((c) => c.method === "PUT").length));

  if (url === "/api/compile") return reply(200, JSON.stringify({ code: `// compiled ${body.machine.name}`, problems: [], warnings: [] }));

  return reply(404, JSON.stringify({ error: `No workflow ${url.split("/").pop()}` }));
});

const BACK = { label: "Home", href: "#/home" };

const openEditor = async (id = "plan") => { await mount(h(Editor, { id, back: BACK })); await settle();

 return host; };

const status = () => $(".top .sub", host)!.lastElementChild!.textContent;

const saveBtn = () => $$<HTMLButtonElement>(".top .actions button", host).find((b) => b.textContent === "Save");

const discardBtn = () => $$<HTMLButtonElement>(".top .actions button", host).find((b) => b.textContent === "Discard");

const blk = (id: string) => $(`.blk[data-blk="${id}"]`, host);

const openBlk = (id: string) => click($(".sum", blk(id)!)!);

const field = (label: string, scope: ParentNode = host) =>
  $$("label.field", scope).find((l) => $(".label", l)?.textContent === label)?.querySelector<HTMLInputElement>("input,textarea") ?? null;

const selectedBlk = () => $$(".blk.sel", host).map((b) => b.getAttribute("data-blk"));

const puts = () => calls.filter((c) => c.method === "PUT");

const gets = () => calls.filter((c) => c.method === "GET" && c.url === "/api/workflows/plan");

describe("editor", () => {
  beforeEach(() => { calls = []; served = plan; loadError = null; onSave = () => [200, JSON.stringify({ code: "// saved 1", hash: "h2", warnings: [] })]; fakeServer(); });

  it("shows a loading box, then explains a workflow it could not open", async () => {
    host = document.createElement("div"); document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(h(Editor, { id: "nope", back: BACK })));
    expect($(".loading", host)).not.toBeNull();
    await settle();
    expect($("h1", host)!.textContent).toBe("nope");
    expect($(".top .sub", host)!.textContent).toBe("Could not open this workflow");
    expect($<HTMLAnchorElement>("a.back", host)!.getAttribute("href")).toBe("#/home");
    expect($('p.problem[role="alert"]', host)!.textContent).toBe("No workflow nope");
  });

  it("opens clean: name, counts, file path, Runs link, and Save disabled", async () => {
    await openEditor();
    expect($("h1", host)!.textContent).toBe("Plan a change");
    expect($(".top .sub", host)!.textContent).toContain("plan5 states");
    expect(status()).toBe("saved");
    expect(byLabel("Copy path /tmp/demo/.pi/workflows/plan.js", host)).not.toBeNull();
    const runs = $<HTMLAnchorElement>(".top .actions a", host)!;
    expect(runs.textContent).toBe("Runs");
    expect(runs.getAttribute("href")).toBe("#/runs?workflow=plan");
    expect(runs.getAttribute("title")).toBe("Runs of plan");
    expect(saveBtn()!.disabled).toBe(true);
    expect(classes(saveBtn()!)).not.toContain("primary");
    expect(saveBtn()!.getAttribute("title")).toBe("Save now (⌘S)");
    expect(discardBtn()).toBeUndefined();
    expect(isUnsaved()).toBe(false);
    expect($(".problems", host)!.textContent).toContain("Nothing to fix. ⌘S saves.");
  });

  it("an edit marks the draft unsaved and raises the leave guard; Save sends it once and clears both", async () => {
    await openEditor();
    openBlk("head");
    type(field("Name")!, "Plan B");
    expect($("h1", host)!.textContent).toBe("Plan B");
    expect(status()).toBe("unsaved");
    expect(isUnsaved()).toBe(true);
    expect(unsavedWhat()).toBe("“Plan B”");
    expect(saveBtn()!.disabled).toBe(false);
    expect(classes(saveBtn()!)).toEqual(expect.arrayContaining(["pill", "primary"]));
    expect(discardBtn()!.getAttribute("title")).toBe("Drop unsaved changes and reload the file");
    expect(puts()).toHaveLength(0); // no autosave
    click(saveBtn()!);
    await settle();
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body!.hash).toBe("h1");
    expect(puts()[0].body!.machine.name).toBe("Plan B");
    expect(status()).toBe("saved");
    expect(isUnsaved()).toBe(false);
    expect(saveBtn()!.disabled).toBe(true);
    expect(discardBtn()).toBeUndefined();
  });

  it("⌘S and ctrl S save from inside an input, with the hash from the last save", async () => {
    onSave = (n) => [200, JSON.stringify({ code: `// saved ${n}`, hash: `h${n + 1}`, warnings: [] })];
    await openEditor();
    openBlk("head");
    type(field("Name")!, "One");
    const ev = key(field("Name")!, "s", { metaKey: true });
    expect(ev.defaultPrevented).toBe(true);
    await settle();
    type(field("Name")!, "Two");
    key(field("Name")!, "S", { ctrlKey: true });
    await settle();
    expect(puts().map((c) => [c.body!.machine.name, c.body!.hash])).toEqual([["One", "h1"], ["Two", "h2"]]);
    key(document.body, "s", { metaKey: true }); // nothing changed: nothing sent
    await settle();
    expect(puts()).toHaveLength(2);
  });

  it("a conflict offers only Reload, which reads the file again", async () => {
    onSave = () => [409, JSON.stringify({ error: "Changed on disk" })];
    await openEditor();
    openBlk("head");
    type(field("Name")!, "Plan B");
    click(saveBtn()!);
    await settle();
    expect(status()).toBe("changed on disk");
    expect(classes($(".top .sub", host)!.lastElementChild)).toContain("warn");
    expect(saveBtn()).toBeUndefined();
    expect(discardBtn()).toBeUndefined();
    expect($(".problems", host)!.textContent).toContain("Changed on disk");
    key(document.body, "s", { metaKey: true });
    await settle();
    expect(puts()).toHaveLength(1);
    const loads = gets().length;
    click($$(".top .actions button", host).find((b) => b.textContent === "Reload")!);
    await settle();
    expect(gets()).toHaveLength(loads + 1);
    expect($("h1", host)!.textContent).toBe("Plan a change");
    expect(status()).toBe("saved");
  });

  it("a failed save says why and keeps the draft", async () => {
    onSave = () => [500, JSON.stringify({ error: "disk full" })];
    await openEditor();
    openBlk("head");
    type(field("Name")!, "Plan B");
    click(saveBtn()!);
    await settle();
    expect(status()).toBe("not saved");
    expect($(".problems", host)!.textContent).toContain("Could not save: disk full");
    expect($("h1", host)!.textContent).toBe("Plan B");
    expect(isUnsaved()).toBe(true);
  });

  it("Discard drops the draft and reads the file again", async () => {
    await openEditor();
    openBlk("head");
    type(field("Name")!, "Plan B");
    const loads = gets().length;
    click(discardBtn()!);
    await settle();
    expect(gets()).toHaveLength(loads + 1);
    expect($("h1", host)!.textContent).toBe("Plan a change");
    expect(isUnsaved()).toBe(false);
    expect(selectedBlk()).toEqual([]);
    expect(puts()).toHaveLength(0);
  });

  const expectLoadFailure = () => {
    expect($(".top .sub", host)!.textContent).toBe("Could not open this workflow");
    expect($('p.problem[role="alert"]', host)!.textContent).toBe("file vanished");
    expect($<HTMLAnchorElement>("a.back", host)!.getAttribute("href")).toBe("#/home");
    expect($(".blk[data-blk]", host)).toBeNull();
    expect(saveBtn()).toBeUndefined();
  };

  it("a Discard whose reload fails shows the open error, not the old draft", async () => {
    await openEditor();
    openBlk("head");
    type(field("Name")!, "Plan B");
    loadError = "file vanished";
    click(discardBtn()!);
    await settle();
    expect(gets()).toHaveLength(2);
    expectLoadFailure();
  });

  it("a conflict Reload that fails shows the open error, not the old draft", async () => {
    onSave = () => [409, JSON.stringify({ error: "Changed on disk" })];
    await openEditor();
    openBlk("head");
    type(field("Name")!, "Plan B");
    click(saveBtn()!);
    await settle();
    loadError = "file vanished";
    click($$(".top .actions button", host).find((b) => b.textContent === "Reload")!);
    await settle();
    expect(gets()).toHaveLength(2);
    expectLoadFailure();
  });

  it("leaving the page drops the leave guard", async () => {
    await openEditor();
    openBlk("head");
    type(field("Name")!, "Plan B");
    expect(isUnsaved()).toBe(true);
    act(() => root!.unmount()); root = null;
    expect(isUnsaved()).toBe(false);
  });

  it("problems block saving, mark the state, and a click on one opens that state", async () => {
    served = structuredClone(plan); delete served.states.draft.role;
    await openEditor();
    expect(status()).toBe("1 problem");
    expect(classes($(".top .sub", host)!.lastElementChild)).toContain("warn");
    expect($(".problems .p-h", host)!.textContent).toBe("1 problem, not saved");
    expect(classes(node("draft"))).toContain("prob");
    expect($(".block.t-waiting", $(".sum", blk("state:draft")!)!)).not.toBeNull();
    openBlk("head");
    type(field("Name")!, "Plan B");
    expect(saveBtn()!.disabled).toBe(true);
    key(document.body, "s", { metaKey: true });
    await settle();
    expect(puts()).toHaveLength(0);
    click($(".problems button.p", host)!);
    expect(selectedBlk()).toEqual(["state:draft"]);
  });

  it("the inspector is an accordion: one block open, a summary click opens it", async () => {
    await openEditor();
    expect($$(".blk[data-blk]", host).map((b) => b.getAttribute("data-blk"))).toEqual(["head", "inputs", "state:draft", "state:challenge", "state:revise", "state:explain", "state:approved"]);
    expect($$(".body", host)).toHaveLength(0);
    openBlk("state:challenge");
    expect(selectedBlk()).toEqual(["state:challenge"]);
    expect($(".sum", blk("state:challenge")!)!.getAttribute("aria-expanded")).toBe("true");
    expect($(".sum", blk("head")!)!.getAttribute("aria-expanded")).toBe("false");
    expect($$(".body", host)).toHaveLength(1);
    openBlk("state:challenge");
    expect(selectedBlk()).toEqual(["state:challenge"]);
    const draft = $(".sum", blk("state:draft")!)!;
    expect($("code.s-id", draft)!.textContent).toBe("draft");
    expect($(".s-t", draft)!.textContent).toBe("Draft the plan");
    expect($(".tag", draft)!.textContent).toBe("start");
    expect($(".tag", $(".sum", blk("state:challenge")!)!)).toBeNull();
    expect($(".insp-h", host)!.textContent).toBe("States5starts at draft");
    expect($(".s-t", $(".sum", blk("inputs")!)!)!.textContent).toBe("goal, slug");
  });

  it("keys: j and k walk the blocks, Escape clears then goes back, keys in a field stay in the field", async () => {
    await openEditor();
    key(document.body, "j");
    expect(selectedBlk()).toEqual(["head"]);
    key(document.body, "j"); key(document.body, "ArrowDown");
    expect(selectedBlk()).toEqual(["state:draft"]);
    key(document.body, "k");
    expect(selectedBlk()).toEqual(["inputs"]);
    key(document.body, "ArrowUp"); key(document.body, "k");
    expect(selectedBlk()).toEqual(["head"]);

    for (let i = 0; i < 9; i++) key(document.body, "j");
    expect(selectedBlk()).toEqual(["state:approved"]);
    expect(key(document.body, "j", { altKey: true }).defaultPrevented).toBe(false);
    openBlk("head");
    const name = field("Name")!;
    act(() => name.focus());
    key(name, "j");
    expect(selectedBlk()).toEqual(["head"]);
    key(name, "Escape");
    expect(document.activeElement).not.toBe(name);
    expect(selectedBlk()).toEqual(["head"]);
    key(document.body, "Escape");
    expect(selectedBlk()).toEqual([]);
    expect(location.hash).toBe("");
    key(document.body, "Escape");
    expect(location.hash).toBe("#/home");
  });

  it("Delete arms the selected state, Escape disarms, Enter removes and notes the transitions it cut", async () => {
    await openEditor();
    openBlk("state:challenge");
    key(document.body, "Delete");
    expect(byLabel("Remove challenge?", host)!.getAttribute("role")).toBe("alertdialog");
    key(document.body, "Escape");
    expect(byLabel("Remove challenge?", host)).toBeNull();
    expect(selectedBlk()).toEqual(["state:challenge"]);
    key(document.body, "Backspace");
    key(document.body, "Enter");
    expect(blk("state:challenge")).toBeNull();
    expect($(".top .sub", host)!.textContent).toContain("4 states");
    expect(selectedBlk()).toEqual([]);
    const notes = $$(".p-note", host).map((n) => n.textContent);
    expect(notes).toHaveLength(2);
    expect(notes.join("\n")).toContain("drafted");
    expect(notes.join("\n")).toContain("revised");
  });

  it("the graph's × selects and arms a state; its confirm removes it", async () => {
    await openEditor();
    click(byLabel("Remove explain", host)!);
    await settle();
    expect(selectedBlk()).toEqual(["state:explain"]);
    click($$("button", byLabel("Remove explain?", host)!).find((b) => b.textContent === "Remove explain")!);
    expect(blk("state:explain")).toBeNull();
  });

  it("a graph click selects the state; f opens full screen and its Escape stays inside it", async () => {
    await openEditor();
    click(node("revise")!);
    expect(selectedBlk()).toEqual(["state:revise"]);
    expect(classes(node("revise"))).toContain("sel");
    expect(classes(node("challenge"))).toContain("walked");
    key(document.body, "f");
    expect($(".full")).not.toBeNull();
    key(document.body, "j");
    expect(selectedBlk()).toEqual(["state:revise"]);
    key(document.body, "Escape");
    expect($(".full")).toBeNull();
    expect(selectedBlk()).toEqual(["state:revise"]);
  });

  it("+ Add state adds, opens and focuses the new state's title", async () => {
    await openEditor();
    click($(".blk.add .sum", host)!);
    expect($(".top .sub", host)!.textContent).toContain("6 states");
    const [sel] = selectedBlk();
    expect(sel).toMatch(/^state:/);
    const id = sel!.slice(6);
    expect(document.activeElement).toBe($(`[data-title-for="${id}"]`, host));
  });

  it("the drawing hint shows until the graph is first used to add a state", async () => {
    await openEditor();
    const hint = "Hover a state for + and ×, drag from + to connect, double-click to rename";
    expect($(".stage-foot", host)!.textContent).toBe(hint);
    const plus = byLabel("Add a state after draft, or drag to connect", host)!;
    pointer(plus, "pointerdown", 100, 100); pointer(window, "pointerup", 100, 100);
    expect($(".top .sub", host)!.textContent).toContain("6 states");
    const [sel] = selectedBlk();
    expect(document.activeElement).toBe($(`[data-title-for="${sel!.slice(6)}"]`, host));
    expect($(".stage-foot", host)).toBeNull();
    expect(localStorage.getItem("topology:hint:draw")).not.toBeNull();
  });

  it("the DSL tab shows the numbered, highlighted script and recompiles after edits", async () => {
    await openEditor();
    const tabs = $$('[role="tablist"][aria-label="Stage"] [role="tab"]', host);
    expect(tabs.map((t) => [t.id, t.textContent, t.getAttribute("aria-selected")])).toEqual([["tab-graph", "State machine", "true"], ["tab-script", "DSL", "false"]]);
    click(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(classes(tabs[1])).toContain("on");
    expect($('[role="tabpanel"]', host)!.getAttribute("aria-labelledby")).toBe("tab-script");
    const pre = byLabel("The compiled script", host)!;
    expect($(".dsl-gutter", pre)!.textContent).toBe("1\n2\n3");
    expect($("code", pre)!.textContent).toBe(CODE);
    expect($$("code [class^='hl-']", pre).length).toBeGreaterThan(0);
    expect($(".gview", host)).toBeNull();
    key(document.body, "f");
    expect($(".full")).toBeNull();
    openBlk("head");
    type(field("Name")!, "Plan C");
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(calls.some((c) => c.url === "/api/compile")).toBe(true);
    expect($("code", byLabel("The compiled script", host)!)!.textContent).toBe("// compiled Plan C");
    click(tabs[0]);
    expect($(".gview", host)).not.toBeNull();
  });
});

describe("editor: follow-up regressions", () => {
  beforeEach(() => { calls = []; served = plan; loadError = null; onSave = () => [200, JSON.stringify({ code: "// saved 1", hash: "h2", warnings: [] })]; fakeServer(); });

  // plan with a fanout between explain and approved; the second branch's role is given
  const withFanout = (roleB: string) => {
    const m = structuredClone(plan);
    m.states.explain.on = { done: { to: "split" } };
    m.states.split = { kind: "fanout", title: "Split", branches: [
      { id: "a", role: "lead", prompt: "one" }, { id: "b", role: roleB, prompt: "two" }, { id: "c", role: "oracle", prompt: "three" },
    ], on: { joined: { to: "approved" } } };

    return m;
  };

  const branches = () => $$(".branch", blk("state:split")!);

  const roleLinks = (scope: ParentNode) => $$<HTMLAnchorElement>("a", scope).filter((a) => a.textContent === "Open role").map((a) => a.getAttribute("href"));

  it("fanout branches: numbered headers, an editable ID that keeps focus and saves, Remove only above two", async () => {
    served = withFanout("scribe");
    await openEditor();
    openBlk("state:split");
    expect(branches().map((b) => $(".branch-h .label", b)!.textContent)).toEqual(["Branch 1", "Branch 2", "Branch 3"]);
    const id = field("ID", branches()[0])!;
    expect(id.value).toBe("a");
    type(id, "ax");
    expect(document.activeElement).toBe(field("ID", branches()[0]));
    expect(field("ID", branches()[0])!.value).toBe("ax");
    type(field("ID", branches()[0])!, "axe");
    expect(document.activeElement).toBe(field("ID", branches()[0]));
    const removes = () => branches().map((b) => $$(".branch-h button", b).find((x) => x.textContent === "Remove") ?? null);
    expect(removes().every((r) => r !== null)).toBe(true);
    click(removes()[1]!);
    expect(branches().map((b) => field("ID", b)!.value)).toEqual(["axe", "c"]);
    expect(removes()).toEqual([null, null]);
    click(saveBtn()!);
    await settle();
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body!.machine.states.split.branches!.map((b) => b.id)).toEqual(["axe", "c"]);
  });

  it("Open role links a known role on task, decision and branch fields, and not an unknown one", async () => {
    served = withFanout("nobody");
    await openEditor();
    openBlk("state:draft");
    expect(roleLinks(blk("state:draft")!)).toEqual(["#/roles/lead"]);
    openBlk("state:challenge");
    expect(roleLinks(blk("state:challenge")!)).toEqual(["#/roles/oracle"]);
    openBlk("state:split");
    expect(branches().map((b) => roleLinks(b))).toEqual([["#/roles/lead"], [], ["#/roles/oracle"]]);
  });

  it("the inspector's Remove this state removes at once; the graph × still asks first", async () => {
    await openEditor();
    openBlk("state:explain");
    click($$("button", blk("state:explain")!).find((b) => b.textContent === "Remove this state")!);
    expect(blk("state:explain")).toBeNull();
    expect($('[role="alertdialog"]', host)).toBeNull();
    expect($(".top .sub", host)!.textContent).toContain("4 states");
    click(byLabel("Remove revise", host)!);
    await settle();
    expect(blk("state:revise")).not.toBeNull();
    expect(byLabel("Remove revise?", host)!.getAttribute("role")).toBe("alertdialog");
  });

  it("the inline graph draws from the element's width when ResizeObserver has not reported yet", async () => {
    const held: ResizeObserverCallback[] = []; // a background tab: observers are attached but never called

    class SilentResizeObserver implements ResizeObserver {
      constructor(cb: ResizeObserverCallback) { held.push(cb); }
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", SilentResizeObserver);
    box.width = 640;
    await mount(h(GraphHost, { machine: plan, onSelect: vi.fn() }));
    expect(held.length).toBeGreaterThan(0);
    expect($("svg.graph", host)!.getAttribute("width")).toBe("640");
    expect($$("[data-node]", host).map((n) => n.getAttribute("data-node")).sort()).toEqual(["approved", "challenge", "draft", "explain", "revise"]);
  });
});

describe("editor: exported pieces", () => {
  it("KindGlyph draws a 14px decorative glyph per kind", async () => {
    await mount(h("div", null, ...["task", "decision", "fanout", "final"].map((k) => h(KindGlyph, { key: k, kind: k }))));
    const svgs = $$("svg.kglyph", host);
    expect(svgs.map((s) => classes(s))).toEqual([["kglyph", "k-task"], ["kglyph", "k-decision"], ["kglyph", "k-fanout"], ["kglyph", "k-final"]]);

    for (const s of svgs) { expect(s.getAttribute("width")).toBe("14"); expect(s.getAttribute("aria-hidden")).toBe("true"); }
  });
  it("useMeasuredHeight follows the element's height and lets go of it", async () => {
    function Probe() { const [ref, height] = useMeasuredHeight<HTMLDivElement>();

 return h("div", { ref, className: "probe" }, String(height)); }

    await mount(h(Probe));
    expect($(".probe", host)!.textContent).toBe("600");
    await resize(800, 333);
    expect($(".probe", host)!.textContent).toBe("333");
    act(() => root!.unmount()); root = null;
    expect([...observers].every((o) => o.targets.size === 0)).toBe(true);
  });
});

// ---------- parts ----------

describe("parts", () => {
  it("Rich sets backtick spans as code and leaves the rest as text", async () => {
    await mount(h("div", null, h("p", { className: "a" }, h(Rich, { text: "State `draft` needs `role` now" })), h("p", { className: "b" }, h(Rich, { text: "a lone ` tick" }))));
    expect($$(".a code", host).map((c) => c.textContent)).toEqual(["draft", "role"]);
    expect($(".a", host)!.textContent).toBe("State draft needs role now");
    expect($$(".b code", host)).toHaveLength(0);
    expect($(".b", host)!.textContent).toBe("a lone ` tick");
  });

  it("Block and Sep are decorative marks with stable classes", async () => {
    await mount(h("div", null, h(Block), h(Block, { tone: "waiting", size: 9 }), h(Sep)));
    const [plain, waiting] = $$("svg.block", host);
    expect(classes(plain)).toEqual(["block", "t-none"]);
    expect(plain.getAttribute("width")).toBe("10");
    expect(classes(waiting)).toEqual(["block", "t-waiting"]);
    expect(waiting.getAttribute("height")).toBe("9");
    expect(plain.getAttribute("aria-hidden")).toBe("true");
    expect($("span.sep", host)!.getAttribute("aria-hidden")).toBe("true");
  });

  it("PageHead shows back, title, sub and actions only when given", async () => {
    await mount(h("div", null,
      h(PageHead, { back: { label: "Home", href: "#/" }, title: "Title", sub: "Sub", actions: h("button", null, "Go") }),
      h(PageHead, { title: "Bare" })));
    const [full, bare] = $$("header.top", host);
    expect($<HTMLAnchorElement>("a.back", full)!.getAttribute("href")).toBe("#/");
    expect($("a.back", full)!.textContent).toBe("Home");
    expect($(".head-row .head-text h1", full)!.textContent).toBe("Title");
    expect($(".sub", full)!.textContent).toBe("Sub");
    expect($(".actions button", full)!.textContent).toBe("Go");
    expect($("h1", bare)!.textContent).toBe("Bare");
    expect($("a.back, .sub, .actions", bare)).toBeNull();
  });

  it("ProblemList: ok text, warning and problem headings, four rows then an expander, picks and notes", async () => {
    const onPick = vi.fn();
    const list = (props: Partial<Parameters<typeof ProblemList>[0]>) => h(ProblemList, { problems: [], okText: "All good", onPick, ...props });
    await mount(h("div", null,
      h("div", { className: "ok" }, list({})),
      h("div", { className: "w1" }, list({ warnings: ["one"] })),
      h("div", { className: "w2" }, list({ warnings: ["one", "two"] })),
      h("div", { className: "many" }, list({ problems: ["p `a`", "p2", "p3"], warnings: ["w1", "w2", "w3"], notes: ["Removed `x`"], action: h("button", { className: "act" }, "Reload") }))));
    expect($('.ok [role="status"] .quiet', host)!.textContent).toBe("All good");
    expect($(".w1 .p-h", host)!.textContent).toBe("1 warning");
    expect($(".w2 .p-h", host)!.textContent).toBe("2 warnings");
    expect($(".w2 .p-h svg.block.t-none", host)).not.toBeNull();
    const many = $(".many .problems", host)!;
    expect($(".p-h", many)!.textContent).toBe("3 problems, not saved");
    expect($(".p-h svg.block.t-waiting", many)).not.toBeNull();
    expect($(".act", many)).not.toBeNull();
    const rows = () => $$("button.p", many).map((b) => b.textContent);
    expect(rows()).toEqual(["p a", "p2", "p3", "w1"]);
    expect($("button.p code", many)!.textContent).toBe("a");
    const more = $("button.link", many)!;
    expect(more.textContent).toBe("Show 2 more");
    click(more);
    expect(rows()).toEqual(["p a", "p2", "p3", "w1", "w2", "w3"]);
    expect(more.textContent).toBe("Show fewer");
    click(more);
    expect(rows()).toHaveLength(4);
    click($$("button.p", many)[3]);
    expect(onPick).toHaveBeenCalledExactlyOnceWith("w1");
    expect($(".p-note", many)!.textContent).toBe("Removed x");
    expect($(".p-note code", many)!.textContent).toBe("x");
    expect($(".p-h", $(".problems", host)!)).toBeNull();
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("CopyPath shows the short path, copies the full one, and says Copied for a moment", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writeText = vi.fn(() => Promise.resolve());
    patch(navigator, "clipboard", { value: { writeText } });
    await mount(h(CopyPath, { path: "/Users/me/dev/app/.pi/workflows/plan.js", shown: "~/dev/app/.pi/workflows/plan.js" }));
    const btn = $<HTMLButtonElement>("button.path", host)!;
    expect(btn.type).toBe("button");
    expect(btn.getAttribute("title")).toBe("/Users/me/dev/app/.pi/workflows/plan.js\nClick to copy");
    expect(btn.getAttribute("aria-label")).toBe("Copy path /Users/me/dev/app/.pi/workflows/plan.js");
    expect($(".p-head bdi", btn)!.textContent).toBe("~/dev/app/.pi/workflows");
    expect($(".p-tail", btn)!.textContent).toBe("/plan.js");
    expect($(".p-ok", btn)!.getAttribute("aria-live")).toBe("polite");
    await act(async () => { btn.click(); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("/Users/me/dev/app/.pi/workflows/plan.js");
    expect(classes(btn)).toContain("done");
    expect($(".p-ok", btn)!.textContent).toBe("Copied");
    act(() => { vi.advanceTimersByTime(1000); });
    await act(async () => { btn.click(); }); // a second copy restarts the pause
    act(() => { vi.advanceTimersByTime(1000); });
    expect(classes(btn)).toContain("done");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(classes(btn)).not.toContain("done");
    expect($(".p-ok", btn)!.textContent).toBe("");
  });

  it("CopyPath stays quiet when the clipboard refuses or is missing", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    patch(navigator, "clipboard", { value: { writeText } });
    await mount(h(CopyPath, { path: "/a/b.js" }));
    const btn = $<HTMLButtonElement>("button.path", host)!;
    expect($(".p-head bdi", btn)!.textContent).toBe("/a");
    await act(async () => { btn.click(); });
    expect(writeText).toHaveBeenCalled();
    expect(classes(btn)).not.toContain("done");
    patch(navigator, "clipboard", { value: undefined });
    await act(async () => { btn.click(); });
    expect(classes(btn)).not.toContain("done");
  });

  it("useDir starts empty and then gives the project root", async () => {
    vi.stubGlobal("fetch", () => reply(200, JSON.stringify({ dir: "/tmp/demo", roles: [], workflows: [] })));
    const seen: string[] = [];

    function Probe() { const d = useDir(); seen.push(d);

 return h("span", { className: "dir" }, d); }

    await mount(h(Probe));
    await settle();
    expect(seen[0]).toBe("");
    expect($(".dir", host)!.textContent).toBe("/tmp/demo");
  });

  it("useNow ticks every interval and stops when unmounted", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(1_000_000);

    function Probe() { return h("span", { className: "now" }, String(useNow(5000))); }

    await mount(h(Probe));
    expect($(".now", host)!.textContent).toBe("1000000");
    act(() => { vi.advanceTimersByTime(5000); });
    expect($(".now", host)!.textContent).toBe("1005000");
    act(() => root!.unmount()); root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("useListKeys: j and k move and clamp, Enter opens, focused links and fields keep their keys, the rest go to extra", async () => {
    const open = vi.fn(), extra = vi.fn();

    function List({ count }: { count: number }) {
      const sel = useListKeys(count, open, extra);

      return h("div", null, h("span", { className: "sel" }, String(sel)), h("button", { className: "btn" }, "b"), h("a", { className: "lnk", href: "#/x" }, "l"), h("input", { className: "inp" }));
    }

    await mount(h(List, { count: 3 }));
    const sel = () => $(".sel", host)!.textContent;
    expect(sel()).toBe("-1");
    key(document.body, "Enter"); // nothing selected yet: Enter is just another key for extra
    expect(open).not.toHaveBeenCalled();
    expect(extra).toHaveBeenCalledTimes(1);
    extra.mockClear();
    expect(key(document.body, "j").defaultPrevented).toBe(true);
    expect(sel()).toBe("0");
    key(document.body, "k");
    expect(sel()).toBe("0");
    key(document.body, "ArrowDown"); key(document.body, "j"); key(document.body, "j");
    expect(sel()).toBe("2");
    key(document.body, "ArrowUp");
    expect(sel()).toBe("1");
    key(document.body, "Enter");
    expect(open).toHaveBeenCalledExactlyOnceWith(1);
    key($(".btn", host)!, "Enter"); key($(".lnk", host)!, "Enter");
    expect(open).toHaveBeenCalledTimes(1);
    key($(".inp", host)!, "j"); key(document.body, "j", { metaKey: true }); key(document.body, "j", { ctrlKey: true });
    expect(sel()).toBe("1");
    expect(extra).not.toHaveBeenCalled();
    key(document.body, "x");
    expect(extra).toHaveBeenCalledTimes(1);
    expect(extra.mock.calls[0][0].key).toBe("x");
    await act(async () => { root!.render(h(List, { count: 1 })); });
    expect(sel()).toBe("0");
  });

  it("useListKeys can drive a selection the caller owns", async () => {
    function Owned() {
      const pair = useState(2);
      const sel = useListKeys(5, () => {}, undefined, pair);

      return h("span", { className: "o" }, `${sel}/${pair[0]}`);
    }

    await mount(h(Owned));
    expect($(".o", host)!.textContent).toBe("2/2");
    key(document.body, "j");
    expect($(".o", host)!.textContent).toBe("3/3");
  });
});
