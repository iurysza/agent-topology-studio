// What a `{{path}}` chip held in one run, read back from the journal. Pure; no React.
// `steps` are the steps made before the prompt was sent (so the values are what that prompt saw).
import type { Step } from "./runs.ts";

export type ChipValue = { text: string } | { missing: string };

const NONE: ChipValue = { missing: "No value in this run" };
const show = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
};
const pick = (o: unknown, k: string): unknown =>
  o && typeof o === "object" && Object.hasOwn(o as object, k) ? (o as Record<string, unknown>)[k] : undefined;

/** The latest step in `state` (outside a fanout branch) whose record has `field`, else its text. */
function field(steps: Step[], state: string, key: string, branch?: string): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.state !== state) continue;
    if (branch !== undefined) {
      if (!s.branch) { const v = show(pick(pick(s.result, branch), key)); if (v !== null) return v; }
      else if (s.branch === branch) { const v = show(pick(s.result, key)) ?? (key === "text" ? s.text ?? null : null); if (v !== null) return v; }
      continue;
    }
    if (s.branch) continue;
    const v = show(pick(s.result, key)) ?? (key === "text" ? s.text ?? null : null);
    if (v !== null) return v;
  }
  return null;
}

export function chipValue(path: string, steps: Step[], stateId: string): ChipValue {
  const sorted = [...steps].sort((a, b) => a.n - b.n);
  const parts = path.split(".");
  if (parts[0] === "inputs") return { missing: "Inputs are not recorded in the journal" };
  if (path === "visit") return { text: String(sorted.filter((s) => s.state === stateId && !s.branch && s.to).length + 1) };
  if (path === "run.history") {
    const lines = sorted.filter((s) => !s.branch && s.event).map((s) => `${s.state} → ${s.event}`);
    return lines.length ? { text: lines.join("\n") } : { missing: "Nothing walked yet in this run" };
  }
  if (parts[0] === "results" && (parts.length === 3 || parts.length === 4)) {
    const v = parts.length === 3 ? field(sorted, parts[1], parts[2]) : field(sorted, parts[1], parts[3], parts[2]);
    return v === null ? NONE : { text: v };
  }
  return NONE;
}
