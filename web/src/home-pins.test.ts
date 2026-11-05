// Home-screen S1 pins: run helpers as they behave on ce48164. S4 changes one signalOf line (see H2).
import { describe, expect, it } from "vitest";
import { ago, duration, mismatchMessage, signalOf, type Run } from "./runs.ts";

const now = Date.parse("2026-10-23T12:00:00Z");
const at = (ms: number) => new Date(now - ms).toISOString();
const S = 1000, MIN = 60 * S, H = 60 * MIN;

describe("signalOf", () => {
  const sig = (r: Pick<Run, "status" | "outcome" | "updatedAt" | "fits">) => signalOf(r, now);
  it("uses the outcome when there is one", () => {
    expect(sig({ status: "complete", outcome: "success", updatedAt: at(H) })).toBe("success");
    expect(sig({ status: "complete", outcome: "failed", updatedAt: at(H) })).toBe("failed");
  });
  it("reads a complete run without outcome as stopped, however fresh", () => {
    expect(sig({ status: "complete", updatedAt: at(H) })).toBe("stopped");
    expect(sig({ status: "complete", updatedAt: at(30 * S) })).toBe("stopped");
  });
  it("reads a partial run as running while fresh, then stopped", () => {
    expect(sig({ status: "partial", updatedAt: at(30 * S) })).toBe("running");
    expect(sig({ status: "partial", updatedAt: at(H) })).toBe("stopped");
    expect(sig({ status: "partial", updatedAt: at(H), fits: false })).toBe("mismatch"); // H2: mismatch is its own signal
    expect(sig({ status: "partial", updatedAt: at(30 * S), fits: false })).toBe("running");
  });
});

describe("ago", () => {
  it("formats elapsed time", () => {
    expect([30 * S, 5 * MIN, 2 * H, 26 * H, 72 * H].map((ms) => ago(at(ms), now)))
      .toEqual(["just now", "5 min ago", "2 h ago", "yesterday", "3 days ago"]);
  });
});

describe("duration", () => {
  it("formats a span", () => {
    expect([500, 45 * S, 125 * S, 3700 * S].map(duration)).toEqual(["<1 s", "45 s", "2 min 5 s", "1 h 1 min"]);
  });
});

describe("mismatchMessage", () => {
  it("speaks only for a run that does not fit and says why", () => {
    expect(mismatchMessage({ fits: true, mismatch: "x" })).toBeNull();
    expect(mismatchMessage({ fits: false, mismatch: "council: label coder:a1, expected frame" }))
      .toBe("Journal doesn't match this workflow: council: label coder:a1, expected frame");
    expect(mismatchMessage({ fits: false })).toBeNull();
  });
});
