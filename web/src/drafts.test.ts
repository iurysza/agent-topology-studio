import { describe, expect, it } from "vitest";
import { finishSave, idle, liveErrors, pruneBuffers, requestSave } from "./drafts.ts";

describe("save queue", () => {
  it("starts one save, queues a second request instead of overlapping", () => {
    const a = requestSave(idle);
    expect(a.start).toBe(true);
    const b = requestSave(a.q);
    expect(b).toEqual({ q: { saving: true, again: true }, start: false });
    expect(requestSave(b.q).start).toBe(false);
  });
  it("saves again after a reply only when the draft changed meanwhile", () => {
    const busy = { saving: true, again: true };
    expect(finishSave(busy, true)).toEqual({ q: { saving: true, again: false }, start: true });
    expect(finishSave(busy, false)).toEqual({ q: idle, start: false });
  });
});

describe("buffers", () => {
  const text = { inputs: "x · string", "on:a": "go → b", "on:c": "next → b · why", "on:d": "back → bb", "out:b": "bad" };
  it("drops the state's own buffers and Events buffers aiming at it", () => {
    expect(Object.keys(pruneBuffers(text, "b")).sort()).toEqual(["inputs", "on:d"]);
  });
  it("prunes errors using the text buffers", () => {
    const errors = { "on:b": ["bad line"], "on:c": [], "on:d": ["x"] };
    expect(Object.keys(pruneBuffers(errors, "b", text)).sort()).toEqual(["on:d"]);
  });
  it("counts only errors for inputs and states that still exist", () => {
    expect(liveErrors({ inputs: ["i"], "on:gone": ["g"], "out:a": ["o"] }, { a: {} })).toEqual(["i", "o"]);
  });
});
