// Dev only: runs to build the Runs pages against while /api/runs 404s. A finished council, one still voting, one failed and one whose journal no longer fits.
import type { Run, RunDetail, Step } from "./runs.ts";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const step = (n: number, state: string, kind: string, role: string | null, at: string, o: Partial<Step> = {}): Step =>
  ({ n, state, kind, role, prompt: "", template: "", ok: true, result: null, at, ...o });
const ballot = (verdict: string, why: string) => `verdict: ${verdict}\nconfidence: high\nveto: no\nreasons:\n- ${why}\nconditions: none`;
const brief = "Decide whether explicit save is safe to merge. Checks: no autosave path left; leave guard fires on hash change.";

const council: RunDetail = {
  id: "council-fixture", workflow: "council", startedAt: ago(184), updatedAt: ago(171), calls: 5, status: "complete", outcome: "success",
  path: ["frame", "vote", "tally", "approved"], visits: { frame: 1, vote: 1, tally: 1 }, title: "Council",
  steps: [
    step(1, "frame", "task", "lead", ago(182), { prompt: "Question: **Merge the explicit-save change?**\n\nWrite a brief with 3–6 checks.", result: { event: "framed", brief }, event: "framed", to: "vote", durationMs: 41_000 }),
    step(2, "vote", "fanout", "skeptic", ago(178), { branch: "skeptic", prompt: "Vote. Lens: **correctness**.", text: ballot("approve", "unsaved.ts:3 guards every hash change"), result: { text: ballot("approve", "") }, durationMs: 62_000 }),
    step(3, "vote", "fanout", "auditor", ago(177), { branch: "auditor", prompt: "Vote. Lens: **tests**.", text: ballot("approve", "web.test.ts covers the leave guard"), result: { text: "approve" },
      gate: { ok: true, output: "> vitest run --root web\n Test Files  4 passed (4)\n      Tests  29 passed (29)" } }),
    step(4, "vote", "fanout", "pragmatist", ago(176), { branch: "pragmatist", ok: false, prompt: "Vote. Lens: **cost of being wrong**.", text: "Timed out before writing a ballot." }),
    step(5, "vote", "fanout", null, ago(176), { result: { skeptic: "approve", auditor: "approve" }, event: "voted", to: "tally" }),
    step(6, "tally", "decision", "judge", ago(172), { prompt: "Tally the ballots.", result: { event: "approved", decision: "approve" }, event: "approved", to: "approved",
      gate: { ok: true, output: "> npm test\n# pass 41\n# fail 0" } }),
  ],
};

const live: RunDetail = {
  id: "council-fixture-live", workflow: "council", startedAt: ago(3), updatedAt: ago(0.2), calls: 2, status: "partial",
  path: ["frame", "vote"], visits: { frame: 1, vote: 1 }, title: "Council", current: { state: "vote", visit: 1 },
  steps: [
    step(1, "frame", "task", "lead", ago(3), { prompt: "Question: **Ship the Runs page?**", result: { event: "framed", brief }, event: "framed", to: "vote" }),
    step(2, "vote", "fanout", "skeptic", ago(1), { branch: "skeptic", prompt: "Vote. Lens: **correctness**.", text: ballot("approve", "runs.ts derive is pure") }),
  ],
};

const failed: RunDetail = {
  id: "council-fixture-failed", workflow: "council", startedAt: ago(96), updatedAt: ago(90), calls: 1, status: "complete", outcome: "failed",
  reason: "lead gave up: no brief", at: "frame", path: ["frame"], visits: { frame: 1 }, title: "Council",
  steps: [step(1, "frame", "task", "lead", ago(95), { ok: false, prompt: "Question: **Drop the legacy loader?**", text: "No brief: the question names no checks." })],
};

const mismatch: RunDetail = {
  id: "council-fixture-mismatch", workflow: "council", startedAt: ago(64), updatedAt: ago(57), calls: 3, status: "partial",
  fits: false, mismatch: "council: label coder:a1, expected frame", path: [], visits: {}, steps: [],
};

export const fixtureRuns: RunDetail[] = [live, council, failed, mismatch];
export const fixtureList = (): Run[] => fixtureRuns.map(({ steps: _s, visits: _v, path: _p, ...r }) => ({ ...r, path: `.pi/workflows/${r.id}.workflow.jsonl` }));
