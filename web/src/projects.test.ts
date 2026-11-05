// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Projects, rankProjects, tilde } from "./projects.tsx";
import { LIVE_MS, type Run } from "./runs.ts";
import { ALL_SCOPE, mergedRuns, resetSeenForTest, SEEN_KEY, type ScopedRun } from "./home.ts";
import type { ProjectEntry } from "./types.ts";

const p = (name: string, root: string): ProjectEntry => ({ id: `${name}-00000000`, root, name, workflows: 1, lastRunAt: null, source: "session" });
const list = [
  p("agent-config", "/Users/me/code/tools/agent-config"),
  p("quality", "/Users/me/code/topology-studio/quality"),
  p("machine-mvp", "/Users/me/code/topology-studio/machine-mvp"),
  p("topo-notes", "/Users/me/notes/topo-notes"),
];

describe("rankProjects", () => {
  it("keeps the server order with no query", () => {
    expect(rankProjects(list, "  ").map((x) => x.name)).toEqual(["agent-config", "quality", "machine-mvp", "topo-notes"]);
  });
  it("ranks name matches before path matches, case-insensitive", () => {
    expect(rankProjects(list, "TOPO").map((x) => x.name)).toEqual(["topo-notes", "quality", "machine-mvp"]);
  });
  it("matches inside the name before the path", () => {
    expect(rankProjects(list, "mvp").map((x) => x.name)).toEqual(["machine-mvp"]);
    expect(rankProjects(list, "tools").map((x) => x.name)).toEqual(["agent-config"]);
  });
  it("returns nothing for no match", () => {
    expect(rankProjects(list, "zzz")).toEqual([]);
  });
});

describe("tilde", () => {
  it("shortens a home folder and leaves other paths alone", () => {
    expect(tilde("/Users/me/dev/app")).toBe("~/dev/app");
    expect(tilde("/home/me/dev/app")).toBe("~/dev/app");
    expect(tilde("/Users/me")).toBe("~");
    expect(tilde("/opt/app")).toBe("/opt/app");
    expect(tilde("~/dev/app")).toBe("~/dev/app");
  });
});

// The page in a real DOM: keys go to the body or the input, as a browser sends them, and the hash is what Enter opened.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
const mount = (projects: ProjectEntry[]) => {
  const el = document.createElement("div"); document.body.append(el);
  root = createRoot(el);
  act(() => root!.render(createElement(Projects, { projects, warnings: [] })));
  return el;
};
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; location.hash = ""; vi.useRealTimers(); });
const input = () => document.querySelector<HTMLInputElement>(".proj-search input")!;
const key = (target: EventTarget, k: string) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const type = (text: string) => act(() => {
  const el = input(); el.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const selected = () => [...document.querySelectorAll(".proj-rows .row.sel .r-title")].map((a) => a.textContent);
const opened = (x: ProjectEntry) => `#/p/${x.id}/`;

describe("Projects keyboard selection", () => {
  // "topo" matches topo-notes by name, then quality and machine-mvp by path: three. "machine" matches two.
  const five = [...list, p("machine-tools", "/Users/me/dev/machine-tools")];

  it("j j j, then a query with 2 matches, then Enter in the input opens the top match", () => {
    mount(five);
    key(document.body, "j"); key(document.body, "j"); key(document.body, "j");
    expect(selected()).toEqual(["machine-mvp"]); // row 3; the stale index 2 would clamp to machine-tools below
    type("machine");
    expect(rankProjects(five, "machine").map((x) => x.name)).toEqual(["machine-mvp", "machine-tools"]);
    expect(selected()).toEqual(["machine-mvp"]);
    key(input(), "Enter");
    expect(location.hash).toBe(opened(five[2]));
  });

  it("third row, /, filter to 1 result, ArrowDown, Enter opens that result", () => {
    mount(five);
    key(document.body, "j"); key(document.body, "j"); key(document.body, "j");
    key(document.body, "/");
    expect(document.activeElement).toBe(input());
    type("agent-config");
    key(input(), "ArrowDown");
    expect(document.activeElement).not.toBe(input());
    expect(selected()).toEqual(["agent-config"]);
    key(document.body, "Enter");
    expect(location.hash).toBe(opened(five[0]));
  });

  it("no prior selection, a query, ArrowDown, Enter opens the first match", () => {
    mount(five);
    type("topo");
    key(input(), "ArrowDown");
    expect(selected()).toEqual(["topo-notes"]);
    key(document.body, "Enter");
    expect(location.hash).toBe(opened(five[3]));
  });

  it("ArrowDown with no results only blurs, and Enter opens nothing", () => {
    mount(five);
    type("zzz");
    key(input(), "ArrowDown");
    key(document.body, "Enter");
    expect(location.hash).toBe("");
  });
});

describe("Projects live dot", () => {
  it("shows for a run under LIVE_MS old, goes once the clock passes it, and stops its timer on unmount", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const t0 = Date.parse("2026-10-24T12:00:00Z"); vi.setSystemTime(t0);
    const recent = { ...p("agents2", "/Users/me/dev/agents2"), lastRunAt: new Date(t0 - LIVE_MS + 1000).toISOString() };
    mount([recent]);
    const dot = () => document.querySelector('.proj-live[aria-label="Ran in the last 3 minutes"]');
    expect(dot()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(30_000 + 1000); });
    expect(dot()).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    act(() => root!.unmount()); root = null;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Projects with merged runs (S11)", () => {
  const t = Date.now();
  const at = (min: number) => new Date(t - min * 60_000).toISOString();
  const a = { ...p("alpha", "/Users/me/dev/alpha"), lastRunAt: at(10) }, b = { ...p("beta", "/Users/me/dev/beta"), lastRunAt: at(20) };
  const scoped = (id: string, proj: ProjectEntry, o: Partial<ScopedRun>): ScopedRun =>
    ({ id, workflow: "build", path: "", startedAt: null, updatedAt: at(10), calls: 1, status: "complete", outcome: "success", project: { id: proj.id, name: proj.name }, ...o });
  const runs = [scoped("f1", a, { outcome: "failed", reason: "lead gave up" }), scoped("s1", b, { updatedAt: at(20) })];
  beforeEach(() => { resetSeenForTest(); localStorage.clear(); localStorage.setItem(SEEN_KEY(ALL_SCOPE), at(60)); });
  const mountWith = async (loadRuns: () => Promise<{ runs: ScopedRun[]; failed: string[] }>) => {
    const el = document.createElement("div"); document.body.append(el);
    root = createRoot(el);
    await act(async () => { root!.render(createElement(Projects, { projects: [a, b], warnings: [], loadRuns })); });
    await act(async () => {});
    return el;
  };

  it("puts Now above the list, names the project first and links the run under its project", async () => {
    const el = await mountWith(() => Promise.resolve({ runs, failed: [] }));
    const row = el.querySelector(".h-now .nrow")!;
    expect(el.querySelector(".h-now")!.compareDocumentPosition(el.querySelector(".proj-rows")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.firstElementChild!.className).toBe("n-proj");
    expect(row.querySelector(".n-proj")!.textContent).toBe("alpha");
    expect(row.querySelector(".n-title")!.getAttribute("href")).toBe(`#/p/${a.id}/runs/f1`);
    expect(el.querySelectorAll(".h-now .nrow")).toHaveLength(1); // the success is not news
  });
  it("gives each project row its newest run's signal", async () => {
    const el = await mountWith(() => Promise.resolve({ runs, failed: [] }));
    const dots = [...el.querySelectorAll(".proj-rows .proj-last")].map((d) => d.getAttribute("aria-label"));
    expect(dots).toEqual(["Last run failed 10 min ago", "Last run succeeded 20 min ago"]);
  });
  it("is one quiet line when nothing needs you, and no band when the runs do not load", async () => {
    const quiet = await mountWith(() => Promise.resolve({ runs: [runs[1]], failed: [] }));
    expect(quiet.querySelector(".h-now")).toBeNull();
    expect(quiet.querySelector(".h-quiet")!.textContent).toBe("Nothing running. Last run 20 min ago, succeeded.");
    act(() => root!.unmount()); root = null; document.body.innerHTML = "";
    const failed = await mountWith(() => Promise.reject(new Error("down")));
    expect(failed.querySelector(".h-now, .h-quiet, .proj-last")).toBeNull();
    expect(failed.querySelectorAll(".proj-rows .row")).toHaveLength(2);
  });

  // The real adapter over a fake fetch: `down` lists the project ids whose fetch rejects on this tick.
  const plain = (r: ScopedRun): Run => { const { project: _, ...run } = r; return run; };
  const byProject: Record<string, Run[]> = { [a.id]: [plain(runs[0])], [b.id]: [plain(runs[1])] };
  let down = new Set<string>();
  const fakeFetchRuns = (id: string) => down.has(id) ? Promise.reject(new Error("down")) : Promise.resolve({ runs: byProject[id]! });
  const load = () => mergedRuns([a, b], fakeFetchRuns);
  const tick = async () => { await act(async () => { vi.advanceTimersByTime(5000); }); await act(async () => {}); };
  const labels = (el: Element) => [...el.querySelectorAll(".proj-rows .proj-last")].map((d) => d.getAttribute("aria-label"));
  beforeEach(() => { down = new Set(); vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); });

  it("shows no band, quiet line or dots when every project fails on the first load", async () => {
    down = new Set([a.id, b.id]);
    const el = await mountWith(load);
    expect(el.querySelector(".h-now, .h-quiet, .proj-last")).toBeNull();
  });
  it("keeps the earlier rows when every project fails on a later tick", async () => {
    const el = await mountWith(load);
    expect(el.querySelectorAll(".h-now .nrow")).toHaveLength(1);
    down = new Set([a.id, b.id]);
    await tick();
    expect(el.querySelectorAll(".h-now .nrow")).toHaveLength(1);
    expect(labels(el)).toEqual(["Last run failed 10 min ago", "Last run succeeded 20 min ago"]);
  });
  it("keeps a failed project's earlier dot and drops the quiet line", async () => {
    byProject[a.id] = [plain({ ...runs[0], outcome: "success", reason: undefined })];
    try {
      const el = await mountWith(load);
      expect(el.querySelector(".h-quiet")).not.toBeNull();
      down = new Set([b.id]);
      await tick();
      expect(labels(el)).toEqual(["Last run succeeded 10 min ago", "Last run succeeded 20 min ago"]);
      expect(el.querySelector(".h-quiet")).toBeNull();
    } finally { byProject[a.id] = [plain(runs[0])]; }
  });
  it("times the dot from the newest run, not the project's lastRunAt", async () => {
    const stale = { ...a, lastRunAt: at(90) };
    const el = document.createElement("div"); document.body.append(el);
    root = createRoot(el);
    await act(async () => { root!.render(createElement(Projects, { projects: [stale], warnings: [], loadRuns: () => Promise.resolve({ runs: [runs[0]], failed: [] }) })); });
    await act(async () => {});
    const dot = el.querySelector(".proj-rows .proj-last")!;
    expect(dot.getAttribute("aria-label")).toBe("Last run failed 10 min ago");
    expect(dot.textContent).toBe("10 min ago");
  });
});
