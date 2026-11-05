// The prompt editor's Undo and Redo ride the textarea's own stack (the one the $ picker and chip deletes already
// write to through execCommand). The browser will not say what is on that stack, so we count: every `input`
// event's inputType moves the count, and a step that changed nothing tells us that side is empty.

export interface Hist { undo: number; redo: number }
export const fresh: Hist = { undo: 0, redo: 0 };

/** The counts after one input event. An edit clears redo, as the browser does. */
export function step(h: Hist, inputType: string): Hist {
  if (inputType === "historyUndo") return { undo: Math.max(0, h.undo - 1), redo: h.redo + 1 };
  if (inputType === "historyRedo") return { undo: h.undo + 1, redo: Math.max(0, h.redo - 1) };
  return { undo: h.undo + 1, redo: 0 };
}

/** After asking for an undo or redo that left the text as it was: that side of the stack was empty. */
export const exhausted = (h: Hist, side: "undo" | "redo"): Hist => (side === "undo" ? { ...h, undo: 0 } : { ...h, redo: 0 });

/** ⌘Z / Ctrl+Z undoes; ⇧⌘Z, ⇧Ctrl+Z and Ctrl+Y redo. */
export function historyKey(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }): "undo" | "redo" | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && e.ctrlKey && !e.metaKey) return "redo";
  return null;
}
