// A reference chip in read-only prompts, with a small popover that says what the reference is. Hover opens it
// after a beat; click, Enter or Space pins it; Esc, an outside press or a scroll closes it. One is open at a time.
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { ChipValue } from "./chipvalue.ts";
import { Dialog } from "./dialog.tsx";
import { Markdown } from "./markdown.tsx";
import type { Ref, RefKind } from "./symbols.tsx";

export type ChipRef = Ref | { path: string; kind: "unknown"; label?: undefined; from?: undefined; description?: undefined };

export interface ChipLines { kind: RefKind | "unknown"; path: string; label?: string; description?: string; from?: string; warn?: string }

/** What the popover shows for a reference: path in braces, then label, description and origin when known. */
export function chipInfoLines(ref: ChipRef): ChipLines {
  const path = `{{${ref.path}}}`;
  if (ref.kind === "unknown") return { kind: "unknown", path, warn: "Not available to this prompt" };
  return {
    kind: ref.kind, path,
    label: ref.label && ref.label !== ref.path ? ref.label : undefined,
    description: ref.description || undefined,
    from: ref.from || undefined,
  };
}

/** In a run, what each reference held: Markdown provides it, chips read it. Absent outside runs. */
export const ChipValues = createContext<((path: string) => ChipValue) | null>(null);

// the one open chip's close function, so opening another shuts it
let closeOpen: (() => void) | null = null;
const OPEN_MS = 150, CLOSE_MS = 100;

export function Chip({ info, path, kind, value }: { info?: Ref; path: string; kind: RefKind | "unknown"; value?: ChipValue }) {
  const lookup = useContext(ChipValues);
  const v = kind === "unknown" ? undefined : value ?? lookup?.(path);
  const full = v && "text" in v ? v.text : null;
  const [reading, setReading] = useState(false);
  const id = useId(), el = useRef<HTMLSpanElement>(null), pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const clear = () => window.clearTimeout(timer.current);
  const close = () => { clear(); setOpen(false); setPinned(false); };
  const closeRef = useRef(close); closeRef.current = close;
  const mine = useRef(() => closeRef.current()).current;
  const show = () => { clear(); if (closeOpen && closeOpen !== mine) closeOpen(); closeOpen = mine; setOpen(true); };
  useEffect(() => () => { clear(); if (closeOpen === mine) closeOpen = null; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const later = (fn: () => void, ms: number) => { clear(); timer.current = window.setTimeout(fn, ms); };
  const enter = (e: PointerEvent) => { if (e.pointerType === "touch") return; if (open) clear(); else later(show, OPEN_MS); };
  const leave = (e: PointerEvent) => { if (e.pointerType === "touch") return; if (pinned) return; later(close, CLOSE_MS); };
  const read = () => { close(); setReading(true); };
  const toggle = () => { if (full !== null) read(); else if (pinned) close(); else { show(); setPinned(true); } };
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };

  // place under the chip, flipping above when short of room near the bottom
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const c = el.current?.getBoundingClientRect(); if (!c) return;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 6, edge = 8, w = Math.min(v ? 340 : 280, vw - 2 * edge), h = pop.current?.offsetHeight ?? 120;
    const left = Math.max(edge, Math.min(c.left, vw - w - edge));
    const below = vh - c.bottom - gap - edge >= h || c.top < h + gap + edge;
    setPos(below ? { left, top: c.bottom + gap, width: w } : { left, bottom: vh - c.top + gap, width: w, "--rise": "-2px" } as CSSProperties);
  }, [open]);
  // Esc, an outside press, or any scroll closes it
  useEffect(() => {
    if (!open) return;
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); el.current?.focus(); } };
    const down = (e: globalThis.PointerEvent) => { const t = e.target as Node; if (!el.current?.contains(t) && !pop.current?.contains(t)) close(); };
    const scroll = (e: Event) => { if (!pop.current?.contains(e.target as Node)) close(); };
    window.addEventListener("keydown", esc, true); document.addEventListener("pointerdown", down, true); window.addEventListener("scroll", scroll, true);
    return () => { window.removeEventListener("keydown", esc, true); document.removeEventListener("pointerdown", down, true); window.removeEventListener("scroll", scroll, true); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const l = chipInfoLines(info ?? { path, kind: "unknown" });
  return <>
    <span ref={el} className={`chip c-${kind}${open ? " on" : ""}`} tabIndex={0} role="button" aria-expanded={open} aria-describedby={open ? id : undefined}
      onPointerEnter={enter} onPointerLeave={leave} onClick={toggle} onKeyDown={key}><b>{"{{"}</b>{path}<b>{"}}"}</b></span>
    {open && createPortal(
      <div ref={pop} id={id} role={full !== null ? "dialog" : "tooltip"} aria-label={full !== null ? l.path : undefined} className="chip-info" style={pos ?? { visibility: "hidden", left: 0, top: 0 }}
        onPointerEnter={enter} onPointerLeave={leave}>
        <div className="ci-path"><span className={`sym-dot c-${l.kind}`} /><code>{l.path}</code></div>
        {l.label ? <div className="ci-label">{l.label}</div> : null}
        {l.description ? <p className="ci-desc">{l.description}</p> : null}
        {l.from ? <div className="ci-from">from <code>{l.from}</code></div> : null}
        {l.warn ? <div className="ci-warn">{l.warn}</div> : null}
        {v ? <div className="ci-val">
          <div className="ci-vh"><span className="ci-vl">Value in this run</span>
            {full !== null ? <button type="button" className="pill sm ghost ci-open" onClick={read}>Open</button> : null}</div>
          {full !== null ? <div className="ci-pre"><Markdown className="md" soft text={full} refs={[]} /></div> : <div className="ci-miss">{(v as { missing: string }).missing}</div>}
        </div> : null}
      </div>, document.body)}
    {full !== null ? <Dialog open={reading} onClose={() => setReading(false)} label={l.path} className="pd cv">
      <div className="pd-wrap">
        <div className="pd-h"><div className="pd-title"><code>{l.path}</code>{l.from ? <span className="pd-name">from <code>{l.from}</code></span> : null}</div>
          <span className="dim">Value in this run</span></div>
        <div className="pd-body" tabIndex={0}><div className="pd-preview"><Markdown className="md doc" soft text={full} refs={[]} /></div></div>
        <div className="pd-f"><span className="hint dim">Esc closes</span><button type="button" className="pill quiet" onClick={() => setReading(false)}>Close</button></div>
      </div>
    </Dialog> : null}
  </>;
}
