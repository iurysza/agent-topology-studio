// Pure editor bookkeeping: the save queue decision and the pruning of line-edit buffers.

/** One save in flight at a time. A request during a save only marks that another is due. */
export type Queue = { saving: boolean; again: boolean };
export const idle: Queue = { saving: false, again: false };

/** Ask for a save. `start` says whether the caller should run one now. */
export function requestSave(q: Queue): { q: Queue; start: boolean } {
  return q.saving ? { q: { saving: true, again: true }, start: false } : { q: { saving: true, again: false }, start: true };
}

/** A save finished. Run another when the draft changed meanwhile and can be saved. */
export function finishSave(q: Queue, due: boolean): { q: Queue; start: boolean } {
  return due ? { q: { saving: true, again: false }, start: true } : { q: idle, start: false };
}

/** Buffer keys are `inputs`, `on:<state>` and `out:<state>`. */
export const stateOf = (key: string): string | undefined => /^(?:on|out):(.+)$/.exec(key)?.[1];
const mentions = (text: string, id: string) => new RegExp(`(?:→|->)\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text);

/** Drop the buffers that would now show stale text: the state's own, and any Events buffer that targets it. */
export function pruneBuffers<T>(buffers: Record<string, T>, id: string, text: Record<string, string> = buffers as Record<string, string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(buffers)) {
    if (stateOf(k) === id) continue;
    if (k.startsWith("on:") && typeof text[k] === "string" && mentions(text[k], id)) continue;
    out[k] = v;
  }
  return out;
}

/** Line errors that still belong to something: inputs, or a state that exists. */
export function liveErrors(errors: Record<string, string[]>, states: Record<string, unknown>): string[] {
  return Object.entries(errors).flatMap(([k, v]) => { const s = stateOf(k); return s === undefined || s in states ? v : []; });
}
