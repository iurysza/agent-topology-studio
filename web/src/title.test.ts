// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { PLAIN_TITLE, showProjectTitle } from "./title.ts";

type P = { name?: string; dir: string };
const deferred = () => {
  let resolve!: (p: P) => void, reject!: (e: unknown) => void;
  const promise = new Promise<P>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

// main.tsx runs showProjectTitle in an effect keyed on the project; the effect cleanup is the returned cancel.
describe("tab title on a project switch", () => {
  beforeEach(() => { document.title = PLAIN_TITLE; });

  it("falls back to the plain name when the next project fails, not the old name", async () => {
    const a = deferred();
    const cancelA = showProjectTitle(() => a.promise);
    a.resolve({ name: "A", dir: "/x/a" }); await flush();
    expect(document.title).toBe("A · Topology studio");

    cancelA();
    const b = deferred();
    showProjectTitle(() => b.promise);
    expect(document.title).toBe(PLAIN_TITLE);
    b.reject(new Error("down")); await flush();
    expect(document.title).toBe(PLAIN_TITLE);
  });

  it("drops the old project's late answer after the switch", async () => {
    const a = deferred(), b = deferred();
    const cancelA = showProjectTitle(() => a.promise);
    cancelA();
    showProjectTitle(() => b.promise);
    b.resolve({ name: "B", dir: "/x/b" }); await flush();
    a.resolve({ name: "A", dir: "/x/a" }); await flush();
    expect(document.title).toBe("B · Topology studio");
  });

  it("names the project by its folder when it has no name", async () => {
    showProjectTitle(() => Promise.resolve({ dir: "/x/playground/" })); await flush();
    expect(document.title).toBe("playground · Topology studio");
  });
});
