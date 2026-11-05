import { describe, expect, it } from "vitest";
import council from "../../fixtures/machines/council.json";
import { derive, follow, mismatchMessage, paintAt, signalOf, type Step } from "./runs.ts";
import type { Machine } from "./types.ts";

const m = council as unknown as Machine;
const st = (n: number, state: string, o: Partial<Step> = {}): Step => ({ n, state, kind: "task", role: "r", prompt: "", template: "", ok: true, result: null, ...o });
const vote = (n0: number, state: string, to: string) => [
  st(n0, state, { kind: "fanout", branch: "skeptic" }), st(n0 + 1, state, { kind: "fanout", branch: "auditor" }),
  st(n0 + 2, state, { kind: "fanout", branch: "pragmatist" }), st(n0 + 3, state, { kind: "fanout", role: null, event: "voted", to }),
];
// The shape the server returns for fixtures/runs/council-split: a split tally, one deliberation, then approval.
const split = {
  path: ["frame", "vote", "tally", "deliberate", "tally", "approved"],
  steps: [st(1, "frame", { event: "framed", to: "vote" }), ...vote(2, "vote", "tally"), st(6, "tally", { event: "split", to: "deliberate" }),
    ...vote(7, "deliberate", "tally"), st(11, "tally", { event: "approved", to: "approved" })],
};

describe("derive", () => {
  const r = derive(split);
  it("gives each entry of the path a visit, counting repeats", () => {
    expect(r.visits.map((v) => `${v.state}${v.n}`)).toEqual(["frame1", "vote1", "tally1", "deliberate1", "tally2", "approved1"]);
  });
  it("splits steps at the step that left the state, so a revisit gets its own steps", () => {
    expect(r.visits[2].steps.map((s) => s.n)).toEqual([6]);
    expect(r.visits[4].steps.map((s) => s.n)).toEqual([11]);
  });
  it("makes one frame per step, plus one for a visit with none (the final state)", () => {
    expect(r.frames).toHaveLength(12);
    expect(r.frames[11]).toEqual({ visit: 5, step: null });
  });
  it("numbers hops in order from the events the steps recorded", () => {
    expect(r.hops.map((h) => `${h.n}:${h.from}→${h.event}`)).toEqual(["1:frame→framed", "2:vote→voted", "3:tally→split", "4:deliberate→voted", "5:tally→approved"]);
  });
  it("keeps steps the path does not name", () => {
    expect(derive({ path: ["frame"], steps: [st(1, "frame", { event: "framed", to: "vote" }), st(2, "vote", { branch: "skeptic" })] }).visits.map((v) => v.state)).toEqual(["frame", "vote"]);
  });
});

describe("paintAt", () => {
  const r = derive(split);
  it("shows only what happened up to the frame", () => {
    const p = paintAt(r, 0, m);
    expect([...p.visits.keys()]).toEqual(["frame"]); expect(p.current).toBe("frame"); expect(p.trail.size).toBe(0);
  });
  it("lights fanout branches one by one", () => {
    const p = paintAt(r, 2, m);
    expect(p.current).toBe("vote");
    expect(p.branches.get("vote")).toEqual([{ id: "skeptic", ok: true }, { id: "auditor", ok: true }, { id: "pragmatist", ok: null }]);
  });
  it("counts a revisit and stacks hop numbers on an edge taken twice", () => {
    const p = paintAt(r, 11, m);
    expect(p.visits.get("tally")).toBe(2);
    expect(p.trail.get("vote→voted")).toEqual([2]); expect(p.trail.get("deliberate→voted")).toEqual([4]);
    expect(p.current).toBe("approved"); expect(p.pending).toBe(true);
  });
  it("clamps out-of-range frames and survives an empty run", () => {
    expect(paintAt(r, 99, m).current).toBe("approved");
    expect(paintAt(derive({ path: [], steps: [] }), 0).current).toBeNull();
  });
});

describe("mismatchMessage", () => {
  it("explains a non-fitting journal instead of calling it stopped", () => {
    expect(mismatchMessage({ fits: false, mismatch: "revise: label other, expected revise" }))
      .toBe("Journal doesn't match this workflow: revise: label other, expected revise");
  });
  it("does not label failed agents or older runs as mismatches", () => {
    expect(mismatchMessage({ fits: true })).toBeNull();
    expect(mismatchMessage({})).toBeNull();
  });
});

describe("follow and signalOf", () => {
  it("follows new frames only from the end", () => { expect(follow(4, 5, 8)).toBe(7); expect(follow(2, 5, 8)).toBe(2); });
  it("reads a recent partial run as running and an old one as stopped", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    expect(signalOf({ status: "partial", updatedAt: "2026-10-23T11:59:30Z" }, now)).toBe("running");
    expect(signalOf({ status: "partial", updatedAt: "2026-10-23T11:00:00Z" }, now)).toBe("stopped");
    expect(signalOf({ status: "complete", outcome: "failed", updatedAt: "2026-10-23T11:00:00Z" }, now)).toBe("failed");
  });
});
