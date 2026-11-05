// The writing dialog for a long prompt: a state's (with the $ picker) or a role's. It edits the same draft as the
// inline field, so Done only closes; nothing reaches disk until Save. Undo and Redo drive the textarea's own stack.
import { useRef, useState, type ReactNode } from "react";
import { Dialog } from "./dialog.tsx";
import { Markdown } from "./markdown.tsx";
import { CopyPath } from "./parts.tsx";
import { exhausted, fresh, historyKey, step, type Hist } from "./history.ts";
import type { Ref } from "./symbols.tsx";

export interface EditorSlot { textareaRef: (el: HTMLTextAreaElement | null) => void; onInputType: (t: string) => void }

export function PromptDialog({ open, onClose, heading, path, text, refs, editor }: {
  open: boolean; onClose: () => void; heading: ReactNode; path?: string; text: string; refs: Ref[];
  /** draws the textarea; it must report its element and each input event's inputType */
  editor: (slot: EditorSlot) => ReactNode;
}) {
  const [view, setView] = useState<"write" | "preview">("write");
  const [h, setH] = useState<Hist>(fresh);
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const moved = useRef(false);
  const onInputType = (t: string) => { moved.current = true; setH((x) => step(x, t)); };
  const history = (side: "undo" | "redo") => {
    const el = ta.current; if (!el) return;
    el.focus(); moved.current = false;
    document.execCommand(side);
    if (!moved.current) setH((x) => exhausted(x, side));
  };
  const onKey = (e: React.KeyboardEvent) => {
    const side = historyKey(e);
    // In the textarea the browser undoes by itself; elsewhere in the dialog the keys reach the same stack.
    if (!side || e.target === ta.current || view !== "write") return;
    e.preventDefault(); history(side);
  };
  const close = () => { setView("write"); setH(fresh); onClose(); };
  return (
    <Dialog open={open} onClose={close} label="Prompt editor" className="pd" initialFocus=".pd-body textarea">
      <div className="pd-wrap" onKeyDown={onKey}>
        <header className="pd-h">
          <div className="pd-title">{heading}</div>
          {path ? <CopyPath path={path} /> : null}
        </header>
        <div className="pd-bar">
          <div className="pd-hist">
            <button type="button" className="pill quiet sm" disabled={view !== "write" || !h.undo} onMouseDown={(e) => e.preventDefault()} onClick={() => history("undo")} title="Undo (⌘Z)" aria-label="Undo"><UndoIcon />Undo</button>
            <button type="button" className="pill quiet sm" disabled={view !== "write" || !h.redo} onMouseDown={(e) => e.preventDefault()} onClick={() => history("redo")} title="Redo (⇧⌘Z)" aria-label="Redo"><UndoIcon flip />Redo</button>
          </div>
          <div className="seg sm" role="tablist" aria-label="Prompt view">
            {(["write", "preview"] as const).map((v) => <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => { setView(v); if (v === "preview") requestAnimationFrame(() => document.querySelector<HTMLElement>(".pd-preview")?.focus({ preventScroll: true })); }}>{v === "write" ? "Write" : "Preview"}</button>)}
          </div>
        </div>
        <div className="pd-body">
          {view === "write" ? editor({ textareaRef: (el) => { ta.current = el; }, onInputType })
            : <div className="pd-preview" tabIndex={0} aria-label="Prompt preview">{text.trim() ? <Markdown className="md doc" text={text} refs={refs} /> : <p className="quiet">Nothing to preview yet.</p>}</div>}
        </div>
        <footer className="pd-f">
          <span className="hint">Edits go into the draft. Save writes them to disk.</span>
          <button type="button" className="pill primary" onClick={close}>Done</button>
        </footer>
      </div>
    </Dialog>
  );
}

const UndoIcon = ({ flip }: { flip?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={flip ? { transform: "scaleX(-1)" } : undefined}>
    <path d="M4.5 3 2 5.5 4.5 8M2 5.5h6.25a3.25 3.25 0 0 1 0 6.5H6" />
  </svg>
);
