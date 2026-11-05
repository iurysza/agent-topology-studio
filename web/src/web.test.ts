import { describe, expect, it } from "vitest";
import { layoutMachine, thumbBox } from "./graph.tsx";
import { eventDrafts, fieldDrafts, readEvents, readFields } from "./rows.tsx";
import { chipAt, snapCaret, filterRefs, graphOrder, pickGroups, pickQuery, refsAt, segments } from "./symbols.tsx";
import { chipInfoLines } from "./chipinfo.tsx";
import { chipValue } from "./chipvalue.ts";
import type { Step } from "./runs.ts";
import { build, plan } from "./mock/machines.ts";
import { addAfter, connect, removeState, renameState } from "./ops.ts";
import { namedStates, validate } from "./validate.ts";

describe("graph layout", () => {
  for (const m of [plan, build]) for (const dir of ["LR", "TB"] as const) for (const detail of [false, true])
    it(`${m.id} ${dir}${detail ? " detail" : ""}: every node and edge gets a finite position`, () => {
      const l = layoutMachine(m, dir, detail);
      expect(l.nodes.map((n) => n.id).sort()).toEqual(Object.keys(m.states).sort());
      for (const n of l.nodes) for (const v of [n.x, n.y, n.w, n.h]) expect(Number.isFinite(v)).toBe(true);
      const events = Object.values(m.states).reduce((a, s) => a + Object.keys(s.on ?? {}).length, 0);
      expect(l.edges).toHaveLength(events);
      for (const e of l.edges) { expect(Number.isFinite(e.lx) && Number.isFinite(e.ly)).toBe(true); for (const p of e.points) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true); }
      expect(l.w > 0 && l.h > 0).toBe(true);
    });
  it("thumb of a machine with no states keeps a finite, positive svg size", () => {
    // dagre lays out an empty graph at -Infinity; Thumb feeds those sizes straight in
    for (const [gw, gh] of [[-Infinity, -Infinity], [undefined, undefined], [NaN, NaN]]) {
      const b = thumbBox(gw, gh, 150, 52);
      for (const v of [b.sw, b.sh, b.sx, b.sy, b.ox, b.oy]) expect(Number.isFinite(v)).toBe(true);
      expect(b.sw > 0 && b.sh > 0).toBe(true);
    }
  });
  it("draws a target that does not exist yet as a missing node", () => {
    const m = structuredClone(plan); m.states.draft.on = { drafted: { to: "ghost" } };
    expect(layoutMachine(m, "LR").nodes.find((n) => n.id === "ghost")?.missing).toBe(true);
  });
});

describe("ops", () => {
  it("addAfter adds a task entered by a fresh event", () => {
    const r = addAfter(plan, "explain");
    expect(r.id).toBe("step");
    expect(r.event).toBe("done_2");
    expect(r.m.states.explain.on?.done_2.to).toBe("step");
    expect(r.m.states.step.kind).toBe("task");
    expect(plan.states.step).toBeUndefined();
  });
  it("addAfter re-points a fanout's one event", () => {
    const r = addAfter(build, "review");
    expect(Object.keys(r.m.states.review.on!)).toEqual(["done"]);
    expect(r.m.states.review.on!.done.to).toBe(r.id);
  });
  it("connect adds an event, and replaces a fanout's", () => {
    expect(connect(plan, "draft", "approved", "skip").states.draft.on).toEqual({ drafted: { to: "challenge" }, skip: { to: "approved" } });
    expect(connect(build, "review", "qa", "skip").states.review.on).toEqual({ skip: { to: "qa" } });
    expect(connect(plan, "approved", "draft", "again")).toBe(plan);
  });
  it("removeState drops the state and the events into it", () => {
    const r = removeState(plan, "revise");
    expect(r.m.states.revise).toBeUndefined();
    expect(r.m.states.challenge.on?.changes).toBeUndefined();
    expect(r.removed).toHaveLength(1);
  });
  it("renameState re-points events and the initial state", () => {
    const m = renameState(plan, "draft", "write");
    expect(m.initial).toBe("write");
    expect(Object.keys(m.states)[0]).toBe("write");
    expect(renameState(plan, "draft", "Bad Id")).toBe(plan);
    expect(renameState(plan, "draft", "revise")).toBe(plan);
  });
});

describe("rows", () => {
  const n = (() => { let i = 0; return () => ++i; })();
  it("fields round-trip", () => {
    expect(readFields(fieldDrafts(build.inputs, n), true)).toEqual({ value: build.inputs ?? {}, errors: Object.keys(build.inputs ?? {}).map(() => null) });
    const out = build.states.agree.output;
    expect(readFields(fieldDrafts(out, n), false).value).toEqual(out ?? {});
  });
  it("events round-trip", () => {
    const on = build.states.qa.on;
    expect(readEvents(eventDrafts(on, n), build.states, "qa").value).toEqual(on);
  });
  it("reports bad rows with the old messages", () => {
    const f = (name: string, type = "string", def = "") => readFields([{ k: 1, name, type, required: false, def, description: "" }], true).errors[0];
    expect(f("Bad")).toBe("Field `Bad`: use snake_case");
    expect(f("x", "text")).toBe("Field `x`: unknown type `text`");
    expect(f("n", "number", "abc")).toBe("Field `n`: default must be a number");
    expect(f("")).toBeNull();
    const e = readEvents([{ k: 1, name: "done", to: "nowhere", description: "" }], build.states, "qa");
    expect(e.notes[0]).toBe("State `qa` event `done` targets unknown state `nowhere`.");
    expect(e.value).toEqual({ done: { to: "nowhere" } });
    expect(readEvents([{ k: 1, name: "Done", to: "qa", description: "" }], build.states, "qa").errors[0]).toBe("Event `Done`: use snake_case");
  });
});

describe("validate", () => {
  it("the mock machines are clean", () => {
    for (const m of [plan, build]) expect(validate(m).problems).toEqual([]);
  });
  it("names the states a problem is about", () => {
    const { m } = removeState(plan, "approved");
    const ps = validate(m).problems;
    expect(ps.length).toBeGreaterThan(0);
    expect(namedStates("State `qa` event `x` targets unknown state `y`.")).toEqual(["qa"]);
  });
});

describe("symbols", () => {
  const refs = refsAt(build, "agree");
  it("marks each placeholder with its kind", () => {
    const s = segments("A {{inputs.dir}} B {{results.review.a.text}} {{visit}} {{inputs.nope}}", refs);
    expect(s.filter((x) => "kind" in x).map((x) => ("kind" in x ? x.kind : ""))).toEqual(["input", "result", "meta", "unknown"]);
    expect(s.map((x) => x.text).join("")).toBe("A {{inputs.dir}} B {{results.review.a.text}} {{visit}} {{inputs.nope}}");
  });
  it("finds the chip beside the caret", () => {
    const t = "x {{visit}} y";
    expect(chipAt(t, 11, "before")).toEqual([2, 11]);
    expect(chipAt(t, 2, "after")).toEqual([2, 11]);
    expect(chipAt(t, 12, "before")).toBeNull();
  });
  it("treats a caret inside a chip as on the chip", () => {
    const t = "x {{visit}} y";
    expect(chipAt(t, 5, "before")).toEqual([2, 11]);
    expect(chipAt(t, 3, "after")).toEqual([2, 11]);
    expect(chipAt(t, 1, "after")).toBeNull();
  });
  it("snaps a caret inside a chip to its edge", () => {
    const t = "x {{visit}} y";
    expect(snapCaret(t, 5, "left")).toBe(2);
    expect(snapCaret(t, 3, "right")).toBe(11);
    expect(snapCaret(t, 4, "near")).toBe(2);
    expect(snapCaret(t, 8, "near")).toBe(11);
    expect(snapCaret(t, 2, "right")).toBe(2);
    expect(snapCaret(t, 11, "left")).toBe(11);
    expect(snapCaret(t, 12, "near")).toBe(12);
  });
  it("opens on $ and closes on a space", () => {
    expect(pickQuery("see $inp", 8)).toEqual({ start: 4, query: "inp" });
    expect(pickQuery("see $inp x", 10)).toBeNull();
  });
  it("filters by prefix first and never offers the state's own results", () => {
    expect(filterRefs(refs, "inputs.d")[0].path).toBe("inputs.dir");
    expect(refs.some((r) => r.path.startsWith("results.agree."))).toBe(false);
  });
  it("groups the picker: inputs, states in graph order with short names and event last, then run", () => {
    const gs = pickGroups(build, refs, "");
    expect(gs[0].label).toBe("Inputs");
    expect(gs[0].rows.map((r) => r.name)).toContain("dir");
    expect(gs.at(-1)!.label).toBe("Run");
    expect(gs.at(-1)!.rows.map((r) => r.ref.path)).toEqual(["run.history", "visit"]);
    const states = gs.filter((g) => g.state).map((g) => g.key);
    expect(states).toEqual(graphOrder(build).filter((id) => states.includes(id)));
    const review = gs.find((g) => g.key === "review")!;
    expect(review.rows.map((r) => r.name)).toEqual(["a.text", "b.text"]);
    for (const g of gs.filter((x) => x.state)) {
      const ev = g.rows.findIndex((r) => r.name === "event");
      if (ev >= 0) { expect(ev).toBe(g.rows.length - 1); expect(g.rows[ev].dim).toBe(true); }
    }
    expect(gs.flatMap((g) => g.rows).every((r) => !r.ref.path.startsWith("results.agree."))).toBe(true);
  });
  it("filters the picker by state id, field name or description", () => {
    expect(pickGroups(build, refs, "review").map((g) => g.key)).toEqual(["review"]);
    const sum = pickGroups(build, refs, "summary");
    expect(sum.flatMap((g) => g.rows.map((r) => r.ref.path))).toContain("results.build.summary");
    expect(sum.every((g) => g.rows.every((r) => r.name.includes("summary") || (r.ref.description ?? "").toLowerCase().includes("summary")))).toBe(true);
    expect(pickGroups(build, refs, "zzz")).toEqual([]);
  });
});

describe("chip info", () => {
  it("shows path in braces, label, description and origin for a known reference", () => {
    expect(chipInfoLines({ path: "results.vote.skeptic.text", kind: "result", label: "skeptic text", from: "vote", description: "What the skeptic said" }))
      .toEqual({ kind: "result", path: "{{results.vote.skeptic.text}}", label: "skeptic text", description: "What the skeptic said", from: "vote" });
  });
  it("drops a label that only repeats the path, and empty fields", () => {
    expect(chipInfoLines({ path: "inputs.dir", kind: "input", label: "inputs.dir", description: "" })).toEqual({ kind: "input", path: "{{inputs.dir}}" });
  });
  it("warns for an unknown reference", () => {
    expect(chipInfoLines({ path: "nope", kind: "unknown" })).toEqual({ kind: "unknown", path: "{{nope}}", warn: "Not available to this prompt" });
  });
});

describe("chip values in a run", () => {
  const st = (n: number, state: string, more: Partial<Step> = {}): Step => ({ n, state, kind: "agent", role: null, prompt: "", template: "", ok: true, result: null, ...more });
  const steps: Step[] = [
    st(1, "frame", { result: { event: "framed", brief: "The brief" }, event: "framed", to: "vote" }),
    st(2, "vote", { branch: "skeptic", result: { text: "approve" }, text: "approve" }),
    st(3, "vote", { result: { skeptic: { text: "approve" }, meta: { a: 1 } }, event: "voted", to: "tally" }),
    st(4, "tally", { result: null, text: "plain words", event: "blocked", to: "blocked" }),
  ];
  it("reads a state's field", () => expect(chipValue("results.frame.brief", steps, "vote")).toEqual({ text: "The brief" }));
  it("falls back to the step text", () => expect(chipValue("results.tally.text", steps, "x")).toEqual({ text: "plain words" }));
  it("pretty-prints objects", () => expect(chipValue("results.vote.meta", steps, "x")).toEqual({ text: '{\n  "a": 1\n}' }));
  it("reads a fanout branch", () => expect(chipValue("results.vote.skeptic.text", steps, "x")).toEqual({ text: "approve" }));
  it("walks the history", () => expect(chipValue("run.history", steps, "x")).toEqual({ text: "frame → framed\nvote → voted\ntally → blocked" }));
  it("counts the visit", () => {
    expect(chipValue("visit", steps.slice(0, 1), "vote")).toEqual({ text: "1" });
    expect(chipValue("visit", [...steps, st(5, "frame", { event: "framed", to: "vote" })], "frame")).toEqual({ text: "3" });
  });
  it("says inputs are not recorded", () => expect(chipValue("inputs.pr", steps, "x")).toEqual({ missing: "Inputs are not recorded in the journal" }));
  it("says when there is no value", () => {
    expect(chipValue("results.frame.nope", steps, "x")).toEqual({ missing: "No value in this run" });
    expect(chipValue("whatever", steps, "x")).toEqual({ missing: "No value in this run" });
  });
});
