// Home logic, pure apart from the last-visit snapshot (H4): which runs need attention now, the quiet line, and each workflow's ledger. No React here.
import { ago, signalOf, type Run, type Signal } from "./runs.ts";
import type { ProjectEntry } from "./types.ts";

export const SEEN_KEY = (scope: string) => `topology-studio:seen:${scope}`;
/** H4: the last-visit scope for the all projects home. A single project scoped inside all mode uses its id. */
export const ALL_SCOPE = "all";
export const DEFAULT_SEEN_MS = 24 * 60 * 60_000;

type ReadStore = Pick<Storage, "getItem">;
type WriteStore = Pick<Storage, "setItem">;
// Reading the localStorage global can throw SecurityError when storage is blocked, even under typeof.
const browserStore = (): Storage | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

/** H4: parse a stored value. Missing, bad or unreadable gives now - DEFAULT_SEEN_MS. Never throws. */
export function readSeen(store: ReadStore, scope: string, now: number): number {
  const fallback = now - DEFAULT_SEEN_MS;
  try {
    const raw = store.getItem(SEEN_KEY(scope));
    const t = raw == null ? NaN : Date.parse(raw);
    return Number.isFinite(t) ? t : fallback;
  } catch {
    return fallback;
  }
}

export function writeSeen(store: WriteStore, scope: string, now: number): void {
  try {
    store.setItem(SEEN_KEY(scope), new Date(now).toISOString());
  } catch {
    // Storage can be unavailable (Safari private mode). The next visit falls back to the default.
  }
}

const snapshot = new Map<string, number>();
let installed = false;

/** H4: one snapshot per page load. The first call for a scope reads the store and keeps the value in a module-scope Map. Later calls return the kept value. Returns null for scope "", and does not remember it. */
export function seenSnapshot(scope: string, store?: ReadStore, now = Date.now()): number | null {
  if (scope === "") return null;
  const kept = snapshot.get(scope);
  if (kept !== undefined) return kept;
  const s = store ?? browserStore();
  const value = s ? readSeen(s, scope, now) : now - DEFAULT_SEEN_MS;
  snapshot.set(scope, value);
  return value;
}

/** H4: write now for every scope seenSnapshot has kept. Called on pagehide and on visibilitychange to hidden. Never on unmount. */
export function flushSeen(store?: WriteStore, now = Date.now()): void {
  const s = store ?? browserStore();
  if (!s) return;
  for (const scope of snapshot.keys()) writeSeen(s, scope, now);
}

/** H4: register the pagehide and visibilitychange listeners once per page load. Safe to call many times. */
export function installSeenFlush(target?: Pick<Window, "addEventListener">, doc?: Pick<Document, "visibilityState">): void {
  if (installed) return;
  const t = target ?? (typeof window === "undefined" ? undefined : window);
  const d = doc ?? (typeof document === "undefined" ? undefined : document);
  if (!t) return;
  installed = true;
  t.addEventListener("pagehide", () => flushSeen());
  t.addEventListener("visibilitychange", () => { if (d?.visibilityState === "hidden") flushSeen(); });
}

/** Test only: clear the module-scope snapshot and the listener guard. */
export function resetSeenForTest(): void {
  snapshot.clear();
  installed = false;
}

export type NowRow = { run: Run; signal: Signal };
const newestFirst = (a: Run, b: Run) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

/** Running runs first (newest updatedAt first), then failed, stopped and mismatch runs updated after `seen`, newest first. */
export function nowRows(runs: Run[], seen: number, now: number): NowRow[] {
  const sorted = [...runs].sort(newestFirst);
  const rows = sorted.map((run) => ({ run, signal: signalOf(run, now) }));
  const running = rows.filter((r) => r.signal === "running");
  const since = rows.filter((r) => r.signal !== "running" && r.signal !== "success" && Date.parse(r.run.updatedAt) > seen);
  return [...running, ...since];
}

const QUIET_WORD: Record<Signal, string> = {
  success: "succeeded", failed: "failed", stopped: "stopped", mismatch: "didn't match its workflow", running: "still running",
};

/** The one quiet line when nowRows is empty. */
export function quietLine(runs: Run[], now: number): string {
  const last = [...runs].sort(newestFirst)[0];
  if (!last) return "No runs yet.";
  return `Nothing running. Last run ${ago(last.updatedAt, now)}, ${QUIET_WORD[signalOf(last, now)]}.`;
}

export type ScopedRun = Run & { project: { id: string; name: string } };

/** Runs from the newest `limit` projects by lastRunAt, merged and sorted by updatedAt. A project whose fetch fails is skipped and its id listed in `failed`.
 * Projects with lastRunAt null are not fetched. Fetches run in parallel. This is the one adapter over the all-projects API shape (H9). */
export async function mergedRuns(
  projects: ProjectEntry[], fetchRuns: (id: string) => Promise<{ runs: Run[] }>, limit = 10,
): Promise<{ runs: ScopedRun[]; failed: string[] }> {
  const picked = projects
    .filter((p): p is ProjectEntry & { lastRunAt: string } => p.lastRunAt !== null)
    .sort((a, b) => Date.parse(b.lastRunAt) - Date.parse(a.lastRunAt))
    .slice(0, Math.max(0, limit));
  const settled = await Promise.allSettled(picked.map((p) => fetchRuns(p.id)));
  const runs: ScopedRun[] = [];
  const failed: string[] = [];
  settled.forEach((s, i) => {
    const p = picked[i]!;
    if (s.status === "rejected" || !Array.isArray(s.value?.runs)) { failed.push(p.id); return; }
    for (const run of s.value.runs) runs.push({ ...run, project: { id: p.id, name: p.name } });
  });
  return { runs: runs.sort(newestFirst), failed };
}

export type WorkflowLedger = { last: { run: Run; signal: Signal } | null; recent: Signal[] };

/** Per workflow id: its newest run and the signals of its newest `max` runs, newest first. Unmatched runs (workflow null) are skipped. */
export function ledgerByWorkflow(runs: Run[], now: number, max = 8): Map<string, WorkflowLedger> {
  const out = new Map<string, WorkflowLedger>();
  for (const run of [...runs].sort(newestFirst)) {
    if (run.workflow === null) continue;
    const signal = signalOf(run, now);
    const entry = out.get(run.workflow) ?? { last: { run, signal }, recent: [] };
    if (entry.recent.length < max) entry.recent.push(signal);
    out.set(run.workflow, entry);
  }
  return out;
}
