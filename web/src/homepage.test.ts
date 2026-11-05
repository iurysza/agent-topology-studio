// @vitest-environment happy-dom
// Home-screen S7: Enter on a ledger link leaves the row alone, and the last-run link says what happened.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Home, Ledger, NOW_MAX } from "./homepage.tsx";
import { href } from "./route.ts";
import type { Run, Signal } from "./runs.ts";
import { resetSeenForTest, SEEN_KEY } from "./home.ts";

const now = Date.now();
const run = (o: Partial<Run>): Run => ({ id: "r1", workflow: "review", path: "", startedAt: null, updatedAt: new Date(now - 5 * 60_000).toISOString(), calls: 1, status: "complete", outcome: "success", ...o });

// The real API client over a faked server: two editable workflows (no shapes on file) and one run of `review`.
const project = { dir: "/tmp/demo", roles: [], workflows: [{ id: "review", editable: true }, { id: "deploy", editable: true }] };
const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
beforeEach(() => vi.stubGlobal("fetch", (url: string) =>
  url.endsWith("/project") ? reply(200, project) : url.includes("/runs") ? reply(200, { runs: [run({})] }) : reply(404, { error: "no file" })));
afterEach(() => { vi.unstubAllGlobals(); });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
const mount = async (el: ReturnType<typeof createElement>) => {
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
  await act(async () => {}); // let the project, the shapes and the runs settle
  return host;
};
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });
const key = (target: EventTarget, k: string) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });

describe("Home keys", () => {
  it("Enter on the last-run link or the strip does not also open the editor", async () => {
    const onOpen = vi.fn();
    const host = await mount(createElement(Home, { onOpen }));
    key(document.body, "j");
    const last = host.querySelector<HTMLAnchorElement>(".h-last")!, strip = host.querySelector<HTMLAnchorElement>(".h-strip")!;
    expect(last).toBeTruthy(); expect(strip).toBeTruthy();
    last.focus(); key(last, "Enter");
    strip.focus(); key(strip, "Enter");
    expect(onOpen).not.toHaveBeenCalled();
    key(strip, "j"); // j still moves while a link has focus
    expect(host.querySelector(".row.sel")?.getAttribute("data-row")).toBe("1");
  });
  it("Enter on the page still opens the selected row", async () => {
    const onOpen = vi.fn();
    await mount(createElement(Home, { onOpen }));
    key(document.body, "j"); key(document.body, "Enter");
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("review");
  });
});

describe("Now band", () => {
  const stub = (runs: Run[]) => vi.stubGlobal("fetch", (url: string) =>
    url.endsWith("/project") ? reply(200, project) : url.includes("/runs") ? reply(200, { runs }) : reply(404, { error: "no file" }));
  beforeEach(() => { resetSeenForTest(); localStorage.clear(); localStorage.setItem(SEEN_KEY(project.dir), new Date(now - 60 * 60_000).toISOString()); });
  it("lists running first, then what failed since the last visit, and Enter on a Now row opens the run", async () => {
    stub([
      run({ id: "f1", status: "complete", outcome: "failed", reason: "lead gave up", updatedAt: new Date(now - 10 * 60_000).toISOString() }),
      run({ id: "live", status: "partial", outcome: undefined, startedAt: new Date(now - 3 * 60_000).toISOString(), updatedAt: new Date(now - 5_000).toISOString(), current: { state: "vote", visit: 2 } }),
      run({ id: "old", status: "complete", outcome: "failed", updatedAt: new Date(now - 3 * 60 * 60_000).toISOString() }),
    ]);
    const onOpen = vi.fn();
    const host = await mount(createElement(Home, { onOpen }));
    const rows = [...host.querySelectorAll(".nrow")];
    expect(rows.map((r) => r.querySelector(".n-id")!.textContent)).toEqual(["live", "f1"]);
    expect(rows[0].querySelector(".n-detail")!.textContent).toBe("at vote, visit 2");
    expect(rows[0].querySelector(".n-watch")!.getAttribute("href")).toBe("#/runs/live");
    expect(rows[1].querySelector(".n-detail")!.textContent).toBe("lead gave up");
    expect(host.querySelector(".h-quiet")).toBeNull();
    key(document.body, "j"); key(document.body, "j");
    expect(host.querySelector(".row.sel")?.getAttribute("data-row")).toBe("1");
    key(document.body, "Enter");
    expect(location.hash).toBe("#/runs/f1");
    key(document.body, "j"); key(document.body, "Enter");
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("review");
  });
  it("shows at most five rows, then an N more line, and the keys go from the fifth row to the first workflow", async () => {
    stub(Array.from({ length: 7 }, (_, i) => run({ id: `f${i}`, outcome: "failed", updatedAt: new Date(now - (10 + i) * 60_000).toISOString() })));
    const onOpen = vi.fn();
    const host = await mount(createElement(Home, { onOpen }));
    expect(host.querySelectorAll(".nrow")).toHaveLength(NOW_MAX);
    const more = host.querySelector<HTMLAnchorElement>(".h-more")!;
    expect(more.textContent).toBe("2 more");
    expect(more.getAttribute("href")).toBe(href("#/runs"));
    for (let i = 0; i < NOW_MAX; i++) key(document.body, "j");
    expect(host.querySelector(".nrow.sel")?.getAttribute("data-row")).toBe("4");
    key(document.body, "ArrowDown");
    expect(host.querySelector(".nrow.sel")).toBeNull();
    expect(host.querySelector(".mrow.sel")?.getAttribute("data-row")).toBe(String(NOW_MAX));
    key(document.body, "Enter");
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("review");
  });
  it("is one quiet line, with no heading, when nothing needs you", async () => {
    stub([run({})]);
    const host = await mount(createElement(Home, { onOpen: vi.fn() }));
    expect(host.querySelector(".h-now")).toBeNull();
    expect(host.querySelector(".h-quiet")!.textContent).toBe("Nothing running. Last run 5 min ago, succeeded.");
  });
});

describe("Ledger last-run link", () => {
  const words: [Signal, string][] = [["success", "succeeded"], ["failed", "failed"], ["running", "running"], ["stopped", "stopped"], ["mismatch", "did not match"]];
  it.each(words)("names the workflow, the %s outcome and the time", async (signal, word) => {
    const r = run({});
    const host = await mount(createElement(Ledger, { id: "review", now, ledger: { last: { run: r, signal }, recent: [signal] } }));
    const last = host.querySelector(".h-last")!;
    expect(last.getAttribute("aria-label")).toBe(`Last run of review ${word} 5 min ago. Open run.`);
    expect(last.getAttribute("title")).toBe(`Last run ${word}, r1`);
    expect(host.querySelector(".h-strip")!.getAttribute("aria-label")).toBe(`Recent runs: 1 ${word}`);
  });
});
