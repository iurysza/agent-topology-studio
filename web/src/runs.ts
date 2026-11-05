// A run, replayed: pure derivations from the server's run (reference/runs-api.md) to what the graph paints. No React here.
import type { Machine } from "./types.ts";

export interface Gate { ok: boolean; output: string }
export interface Step {
  n: number; state: string; branch?: string; kind: string; role: string | null; prompt: string; template: string; ok: boolean;
  result: Record<string, unknown> | null; text?: string; event?: string; to?: string;
  at?: string | null; durationMs?: number | null; gate?: Gate;
}
/** A list entry. `path` is the journal file here; in the detail it is the state path. */
export interface Run {
  id: string; workflow: string | null; candidates?: string[]; path: string;
  startedAt: string | null; updatedAt: string; calls: number;
  status: "complete" | "partial"; outcome?: "success" | "failed"; signal?: "success" | "failed"; at?: string; reason?: string;
  fits?: boolean; mismatch?: string;
  /** The matched machine's name. */
  title?: string;
  /** Where a matched partial run is now: the last state of its path, and which visit of it. */
  current?: { state: string; visit: number };
}
export interface RunDetail extends Omit<Run, "path"> { path: string[]; steps: Step[]; visits: Record<string, number> }

export function mismatchMessage(r: Pick<Run, "fits" | "mismatch">): string | null {
  return r.fits === false && r.mismatch ? `Journal doesn't match this workflow: ${r.mismatch}` : null;
}

/** How a run reads in the UI. A partial run touched in the last few minutes is still running; older ones stopped, or mismatch when the journal doesn't fit its workflow (H2). */
export type Signal = "success" | "failed" | "running" | "stopped" | "mismatch";
export const LIVE_MS = 3 * 60_000;
export function signalOf(r: Pick<Run, "status" | "outcome" | "updatedAt" | "fits">, now = Date.now()): Signal {
  if (r.outcome) return r.outcome;
  if (r.status === "complete") return "stopped";
  if (now - Date.parse(r.updatedAt) < LIVE_MS) return "running";
  return r.fits === false ? "mismatch" : "stopped";
}

/** One stay in a state: the nth time the run entered it, and the steps made there (a fanout makes one per branch). */
export interface Visit { state: string; n: number; steps: Step[] }
/** One stop on the scrubber: a step, or a visit that has none (a final state, or the state whose agent is still running). */
export interface Frame { visit: number; step: Step | null }
/** A move between visits, numbered in order. */
export interface Hop { n: number; from: string; to: string; event: string; visit: number }
export interface Replay { visits: Visit[]; frames: Frame[]; hops: Hop[] }

/** Walk the state path; each visit takes the steps made in that state up to and including the one that left it. */
export function derive(run: Pick<RunDetail, "path" | "steps">): Replay {
  const steps = [...run.steps].sort((a, b) => a.n - b.n);
  const seen = new Map<string, number>();
  const visits: Visit[] = [];
  const enter = (state: string) => { const n = (seen.get(state) ?? 0) + 1; seen.set(state, n); const v: Visit = { state, n, steps: [] }; visits.push(v); return v; };
  let k = 0;
  const take = (v: Visit) => { while (k < steps.length && steps[k].state === v.state) { const s = steps[k++]; v.steps.push(s); if (s.to) break; } };
  for (const state of run.path) take(enter(state));
  while (k < steps.length) take(enter(steps[k].state));
  const frames: Frame[] = visits.flatMap((v, i): Frame[] => (v.steps.length ? v.steps.map((s) => ({ visit: i, step: s })) : [{ visit: i, step: null }]));
  const hops: Hop[] = [];
  visits.forEach((v, i) => { const s = v.steps.find((x) => x.to && x.event); if (s && i + 1 < visits.length) hops.push({ n: hops.length + 1, from: v.state, to: s.to!, event: s.event!, visit: i + 1 }); });
  return { visits, frames, hops };
}

/** What the graph shows at a scrubber frame. */
export interface Paint {
  visits: Map<string, number>; current: string | null; trail: Map<string, number[]>;
  branches: Map<string, { id: string; ok: boolean | null }[]>;
  pending: boolean;
}
export function paintAt(r: Replay, frame: number, machine?: Machine | null): Paint {
  const f = r.frames[Math.max(0, Math.min(frame, r.frames.length - 1))];
  const visits = new Map<string, number>(), trail = new Map<string, number[]>(), branches = new Map<string, { id: string; ok: boolean | null }[]>();
  if (!f) return { visits, current: null, trail, branches, pending: false };
  const upto = f.visit, at = f.step?.n ?? Infinity;
  r.visits.slice(0, upto + 1).forEach((v, i) => {
    visits.set(v.state, v.n);
    const runs = v.steps.filter((s) => s.branch);
    const defined = machine?.states[v.state]?.branches?.map((b) => b.id) ?? [];
    if (!defined.length && !runs.length) return;
    const shown = i < upto ? runs : runs.filter((s) => s.n <= at);
    const ids = defined.length ? defined : runs.map((s) => s.branch!);
    branches.set(v.state, ids.map((id) => { const s = shown.find((x) => x.branch === id); return { id, ok: s ? s.ok : null }; }));
  });
  for (const h of r.hops) if (h.visit <= upto) { const k = `${h.from}→${h.event}`; trail.set(k, [...(trail.get(k) ?? []), h.n]); }
  return { visits, current: r.visits[upto].state, trail, branches, pending: f.step === null };
}

/** The frame the scrubber should rest on after new data: the newest while it was at the end, else where the person left it. */
export function follow(frame: number, prevLen: number, nextLen: number): number {
  return frame >= prevLen - 1 ? nextLen - 1 : frame;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24); return d === 1 ? "yesterday" : `${d} days ago`;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return "<1 s";
  const s = Math.round(ms / 1000); if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60); return m < 60 ? `${m} min${s % 60 ? ` ${s % 60} s` : ""}` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Wall time from the first entry to the last write. */
export const span = (r: Pick<Run, "startedAt" | "updatedAt">) => (r.startedAt ? Date.parse(r.updatedAt) - Date.parse(r.startedAt) : null);
