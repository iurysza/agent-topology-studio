// Home-screen S6: Now rows, quiet line, workflow ledger and the last-visit snapshot (H4).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_SCOPE, DEFAULT_SEEN_MS, SEEN_KEY, flushSeen, mergedRuns, installSeenFlush, ledgerByWorkflow, nowRows, quietLine, readSeen, resetSeenForTest, seenSnapshot,
} from "./home.ts";
import type { Run } from "./runs.ts";
import type { ProjectEntry } from "./types.ts";

const now = Date.parse("2026-10-23T12:00:00Z");
const S = 1000, MIN = 60 * S, H = 60 * MIN;
const at = (ms: number) => new Date(now - ms).toISOString();

let n = 0;
function run(over: Partial<Run> & { ago: number }): Run {
  const { ago: msAgo, ...rest } = over;
  n += 1;
  return { id: `wf_${n}`, workflow: "build", path: `/j/${n}`, startedAt: at(msAgo + MIN), updatedAt: at(msAgo), calls: 1, status: "complete", ...rest };
}
const running = (msAgo: number, over: Partial<Run> = {}) => run({ status: "partial", ago: msAgo, ...over });
const failed = (msAgo: number, over: Partial<Run> = {}) => run({ outcome: "failed", ago: msAgo, ...over });
const success = (msAgo: number, over: Partial<Run> = {}) => run({ outcome: "success", ago: msAgo, ...over });
const stopped = (msAgo: number, over: Partial<Run> = {}) => run({ ago: msAgo, ...over });
const mismatch = (msAgo: number, over: Partial<Run> = {}) => run({ status: "partial", fits: false, mismatch: "x", ago: msAgo, ...over });

function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const reads: string[] = [];
  return {
    data, reads,
    getItem: (k: string) => { reads.push(k); return data.get(k) ?? null; },
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
}

beforeEach(() => resetSeenForTest());
afterEach(() => vi.unstubAllGlobals());

describe("nowRows and quietLine", () => {
  const seen = now - 2 * H;

  it("are empty and 'No runs yet.' with no runs", () => {
    expect(nowRows([], seen, now)).toEqual([]);
    expect(quietLine([], now)).toBe("No runs yet.");
  });

  it("keeps a running run even when it started before seen", () => {
    const r = running(30 * S, { startedAt: at(5 * H) });
    expect(nowRows([r], now - 10 * S, now)).toEqual([{ run: r, signal: "running" }]);
  });

  it("hides a failed run before seen and shows one after", () => {
    const before = failed(3 * H), after = failed(H);
    expect(nowRows([before, after], seen, now)).toEqual([{ run: after, signal: "failed" }]);
  });

  it("puts running first, newest first inside each group", () => {
    const f1 = failed(90 * MIN), f2 = failed(10 * MIN), r1 = running(2 * MIN), r2 = running(30 * S), st = stopped(20 * MIN);
    expect(nowRows([f1, r1, st, f2, r2], seen, now).map((x) => x.run.id)).toEqual([r2.id, r1.id, f2.id, st.id, f1.id]);
  });

  it("shows a mismatch run after seen with signal mismatch", () => {
    const m = mismatch(H);
    expect(nowRows([m], seen, now)).toEqual([{ run: m, signal: "mismatch" }]);
  });

  it("never shows success runs", () => {
    expect(nowRows([success(10 * MIN), success(3 * H)], seen, now)).toEqual([]);
  });

  it("names the newest run's signal in the quiet line", () => {
    expect(quietLine([success(3 * H), success(57 * MIN)], now)).toBe("Nothing running. Last run 57 min ago, succeeded.");
    expect(quietLine([failed(2 * H)], now)).toBe("Nothing running. Last run 2 h ago, failed.");
    expect(quietLine([stopped(5 * MIN)], now)).toBe("Nothing running. Last run 5 min ago, stopped.");
    expect(quietLine([mismatch(26 * H)], now)).toBe("Nothing running. Last run yesterday, didn't match its workflow.");
  });
});

describe("ledgerByWorkflow", () => {
  it("keeps the newest 8 signals, the newest run, and skips unmatched runs", () => {
    const runs = Array.from({ length: 10 }, (_, i) => (i % 2 ? failed((i + 1) * H) : success((i + 1) * H)));
    const newest = runs[0];
    const ledger = ledgerByWorkflow([...runs].reverse().concat(run({ workflow: null, ago: 30 * S })), now);
    expect([...ledger.keys()]).toEqual(["build"]);
    const b = ledger.get("build")!;
    expect(b.recent).toHaveLength(8);
    expect(b.recent).toEqual(["success", "failed", "success", "failed", "success", "failed", "success", "failed"]);
    expect(b.last).toEqual({ run: newest, signal: "success" });
  });

  it("honours max", () => {
    expect(ledgerByWorkflow([success(H), failed(2 * H), stopped(3 * H)], now, 2).get("build")!.recent).toEqual(["success", "failed"]);
  });
});

describe("readSeen", () => {
  const fallback = now - DEFAULT_SEEN_MS;
  it("falls back when missing, garbage or unreadable", () => {
    expect(readSeen(fakeStore(), "a", now)).toBe(fallback);
    expect(readSeen(fakeStore({ [SEEN_KEY("a")]: "garbage" }), "a", now)).toBe(fallback);
    expect(readSeen({ getItem: () => { throw new Error("SecurityError"); } }, "a", now)).toBe(fallback);
  });
  it("reads a valid ISO time", () => {
    const iso = "2026-10-20T08:00:00.000Z";
    expect(readSeen(fakeStore({ [SEEN_KEY("a")]: iso }), "a", now)).toBe(Date.parse(iso));
  });
});

describe("seenSnapshot", () => {
  it("keeps the first value for the page load, even when the store changes", () => {
    const t1 = "2026-10-20T08:00:00.000Z", t2 = "2026-10-23T11:59:00.000Z";
    const store = fakeStore({ [SEEN_KEY("a")]: t1 });
    expect(seenSnapshot("a", store, now)).toBe(Date.parse(t1));
    store.data.set(SEEN_KEY("a"), t2);
    expect(seenSnapshot("a", store, now)).toBe(Date.parse(t1));
  });

  it("returns null for the empty scope and does not read the store", () => {
    const store = fakeStore();
    expect(seenSnapshot("", store, now)).toBeNull();
    expect(store.reads).toEqual([]);
  });
});

describe("flushSeen", () => {
  it("writes now under every kept scope and never under the empty scope", () => {
    const read = fakeStore();
    seenSnapshot("a", read, now);
    seenSnapshot("b", read, now);
    seenSnapshot("", read, now);
    const store = fakeStore();
    flushSeen(store, now + MIN);
    const iso = new Date(now + MIN).toISOString();
    expect(Object.fromEntries(store.data)).toEqual({ [SEEN_KEY("a")]: iso, [SEEN_KEY("b")]: iso });
  });

  it("writes nothing when no snapshot was taken", () => {
    const store = fakeStore();
    flushSeen(store, now);
    expect(store.data.size).toBe(0);
  });
});

describe("installSeenFlush", () => {
  function fakeTarget() {
    const listeners = new Map<string, Array<() => void>>();
    return {
      listeners,
      addEventListener: ((type: string, fn: () => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); }) as Window["addEventListener"],
      fire: (type: string) => (listeners.get(type) ?? []).forEach((fn) => fn()),
      count: () => [...listeners.values()].reduce((k, l) => k + l.length, 0),
    };
  }

  it("adds its listeners once", () => {
    const target = fakeTarget();
    installSeenFlush(target, { visibilityState: "visible" });
    const first = target.count();
    installSeenFlush(target, { visibilityState: "visible" });
    expect(first).toBe(2);
    expect(target.count()).toBe(first);
  });

  it("writes on pagehide", () => {
    const store = fakeStore();
    vi.stubGlobal("localStorage", store);
    seenSnapshot("a", fakeStore(), now);
    const target = fakeTarget();
    installSeenFlush(target, { visibilityState: "visible" });
    target.fire("pagehide");
    expect([...store.data.keys()]).toEqual([SEEN_KEY("a")]);
  });

  it("writes on visibilitychange only when hidden", () => {
    const store = fakeStore();
    vi.stubGlobal("localStorage", store);
    seenSnapshot("a", fakeStore(), now);
    const doc: { visibilityState: DocumentVisibilityState } = { visibilityState: "visible" };
    const target = fakeTarget();
    installSeenFlush(target, doc);
    target.fire("visibilitychange");
    expect(store.data.size).toBe(0);
    doc.visibilityState = "hidden";
    target.fire("visibilitychange");
    expect([...store.data.keys()]).toEqual([SEEN_KEY("a")]);
  });
});

describe("blocked localStorage", () => {
  let original: PropertyDescriptor | undefined;
  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
  });
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("seenSnapshot falls back instead of throwing", () => {
    expect(seenSnapshot("s", undefined, now)).toBe(now - DEFAULT_SEEN_MS);
  });

  it("flushSeen does not throw", () => {
    seenSnapshot("s", fakeStore(), now);
    expect(() => flushSeen(undefined, now)).not.toThrow();
  });
});

describe("mergedRuns (S10)", () => {
  const proj = (id: string, lastMsAgo: number | null): ProjectEntry =>
    ({ id, root: `/h/${id}`, name: `name-${id}`, workflows: 1, lastRunAt: lastMsAgo === null ? null : at(lastMsAgo), source: "session" });
  const byProject: Record<string, Run[]> = {
    a: [success(3 * H, { id: "a1" }), failed(1 * H, { id: "a2" })],
    b: [running(2 * MIN, { id: "b1" })],
    c: [stopped(30 * MIN, { id: "c1" })],
  };
  function fake(reject: string[] = []) {
    const calls: string[] = [];
    const fetchRuns = async (id: string) => {
      calls.push(id);
      if (reject.includes(id)) throw new Error(`boom ${id}`);
      return { runs: byProject[id] ?? [] };
    };
    return { calls, fetchRuns };
  }

  it("merges runs from every project, newest updatedAt first, tagged with the project", async () => {
    const f = fake();
    const out = await mergedRuns([proj("a", H), proj("b", 2 * MIN), proj("c", 30 * MIN)], f.fetchRuns);
    expect(out.runs.map((r) => r.id)).toEqual(["b1", "c1", "a2", "a1"]);
    expect(out.runs[0]!.project).toEqual({ id: "b", name: "name-b" });
    expect(out.runs.find((r) => r.id === "a1")!.project).toEqual({ id: "a", name: "name-a" });
    expect(out.failed).toEqual([]);
  });

  it("skips a project whose fetch rejects and names it in failed", async () => {
    const f = fake(["c"]);
    const out = await mergedRuns([proj("a", H), proj("b", 2 * MIN), proj("c", 30 * MIN)], f.fetchRuns);
    expect(out.runs.map((r) => r.id)).toEqual(["b1", "a2", "a1"]);
    expect(out.failed).toEqual(["c"]);
  });

  it("names a project with a malformed response in failed and still merges the rest", async () => {
    const fetchRuns = async (id: string) => {
      if (id === "b") return {} as { runs: Run[] };
      if (id === "c") return { runs: null } as unknown as { runs: Run[] };
      return { runs: byProject[id] ?? [] };
    };
    const out = await mergedRuns([proj("a", H), proj("b", 2 * MIN), proj("c", 30 * MIN)], fetchRuns);
    expect(out.runs.map((r) => r.id)).toEqual(["a2", "a1"]);
    expect([...out.failed].sort()).toEqual(["b", "c"]);
  });

  it("does not fetch projects with no lastRunAt", async () => {
    const f = fake();
    const out = await mergedRuns([proj("a", H), proj("b", null), proj("c", null)], f.fetchRuns);
    expect(f.calls).toEqual(["a"]);
    expect(out.runs.map((r) => r.id)).toEqual(["a2", "a1"]);
  });

  it("fetches only the newest `limit` projects by lastRunAt", async () => {
    const f = fake();
    const out = await mergedRuns([proj("a", H), proj("b", 2 * MIN), proj("c", 30 * MIN)], f.fetchRuns, 2);
    expect([...f.calls].sort()).toEqual(["b", "c"]);
    expect(out.runs.map((r) => r.id)).toEqual(["b1", "c1"]);
  });

  it("starts every fetch before any settles", async () => {
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const fetchRuns = (id: string) => { started.push(id); return new Promise<{ runs: Run[] }>((res) => gates.push(() => res({ runs: [] }))); };
    const p = mergedRuns([proj("a", H), proj("b", 2 * MIN), proj("c", 30 * MIN)], fetchRuns);
    expect(started).toHaveLength(3);
    gates.forEach((g) => g());
    expect(await p).toEqual({ runs: [], failed: [] });
  });

  it("feeds nowRows unchanged", async () => {
    const out = await mergedRuns([proj("a", H), proj("b", 2 * MIN), proj("c", 30 * MIN)], fake().fetchRuns);
    const rows = nowRows(out.runs, now - 2 * H, now);
    expect(rows.map((r) => [r.run.id, r.signal, (r.run as typeof out.runs[number]).project.id])).toEqual([
      ["b1", "running", "b"], ["c1", "stopped", "c"], ["a2", "failed", "a"],
    ]);
  });

  it("uses SEEN_KEY('all') for the all projects last visit", () => {
    expect(SEEN_KEY(ALL_SCOPE)).toBe("topology-studio:seen:all");
  });
});
