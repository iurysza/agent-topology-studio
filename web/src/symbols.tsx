// Prompts with typed references. The text is still the plain `{{path}}` string; the textarea draws it and owns the
// caret, and a mirror behind it paints each placeholder's background as a chip tinted by what it points at. Typing `$` opens a picker of the references
// this prompt may use; Backspace and Delete take a chip out whole.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PLACEHOLDER, references } from "../../shared/refs.ts";
import type { Machine } from "./types.ts";
import { KindGlyph } from "./editor.tsx";

export type RefKind = "input" | "result" | "meta";
export interface Ref { path: string; kind: RefKind; label: string; from?: string; description?: string }
export const refsAt = (m: Machine, at: string) => references(m, at) as Ref[];

// ---------- the pure part ----------

export type Segment = { text: string } | { text: string; path: string; kind: RefKind | "unknown" };
const placeholders = () => new RegExp(PLACEHOLDER.source, "g");

/** The prompt cut into plain runs and placeholders, each placeholder marked with the kind it refers to. */
export function segments(text: string, refs: Ref[]): Segment[] {
  const kinds = new Map(refs.map((r) => [r.path, r.kind]));
  const out: Segment[] = []; let at = 0;
  for (const mt of text.matchAll(placeholders())) {
    if (mt.index > at) out.push({ text: text.slice(at, mt.index) });
    out.push({ text: mt[0], path: mt[1], kind: kinds.get(mt[1]) ?? "unknown" });
    at = mt.index + mt[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** The placeholder the caret sits strictly inside, or that ends at (side "before") or starts at (side "after")
 *  the caret, as [start, end]. */
export function chipAt(text: string, caret: number, side: "before" | "after"): [number, number] | null {
  for (const mt of text.matchAll(placeholders())) {
    const s = mt.index, e = s + mt[0].length;
    if ((s < caret && caret < e) || (side === "before" ? e === caret : s === caret)) return [s, e];
  }
  return null;
}

/** A caret strictly inside a placeholder moves to its edge: the start going left, the end going right, else the
 *  nearer one (ties go to the end). Anywhere else it stays. */
export function snapCaret(text: string, caret: number, dir: "left" | "right" | "near"): number {
  for (const mt of text.matchAll(placeholders())) {
    const s = mt.index, e = s + mt[0].length;
    if (s < caret && caret < e) return dir === "left" ? s : dir === "right" ? e : caret - s < e - caret ? s : e;
  }
  return caret;
}

/** An open `$query` just before the caret: the `$` position and what follows it. Whitespace or a brace closes it. */
export function pickQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret), i = before.lastIndexOf("$");
  if (i < 0) return null;
  const q = before.slice(i + 1);
  return /^[\w.]*$/.test(q) ? { start: i, query: q } : null;
}

/** References matching the query: path prefix first, then anywhere in the path or description. */
export function filterRefs(refs: Ref[], query: string): Ref[] {
  const q = query.toLowerCase();
  if (!q) return refs;
  const score = (r: Ref) => (r.path.toLowerCase().startsWith(q) || r.label.toLowerCase().startsWith(q) ? 0 : r.path.toLowerCase().includes(q) ? 1 : (r.description ?? "").toLowerCase().includes(q) ? 2 : -1);
  return refs.map((r) => [r, score(r)] as const).filter(([, s]) => s >= 0).sort((a, b) => a[1] - b[1]).map(([r]) => r);
}

/** States in graph order: breadth first from `initial` along each state's events, then any the walk missed. */
export function graphOrder(m: Machine): string[] {
  const seen = new Set<string>(), queue = m.states[m.initial] ? [m.initial] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const t of Object.values(m.states[id]?.on ?? {})) if (m.states[t.to] && !seen.has(t.to)) queue.push(t.to);
  }
  return [...seen, ...Object.keys(m.states).filter((id) => !seen.has(id))];
}

export interface PickRow { ref: Ref; name: string; dim: boolean }
export interface PickGroup { key: string; label: string; state?: { id: string; kind: string; title: string }; rows: PickRow[] }

/** The picker's rows: Inputs, then one group per state in graph order (event last, dimmed), then Run. The query
 *  matches a state id, a field name, a description or the full path; a group whose id matches keeps all its rows. */
export function pickGroups(m: Machine, refs: Ref[], query: string): PickGroup[] {
  const q = query.toLowerCase().replace(/^\$/, "");
  const hit = (...xs: (string | undefined)[]) => !q || xs.some((x) => x?.toLowerCase().includes(q));
  const groups: PickGroup[] = [];
  const add = (g: PickGroup) => { if (g.rows.length) groups.push(g); };
  const inputs = refs.filter((r) => r.kind === "input");
  add({ key: "inputs", label: "Inputs", rows: inputs.filter((r) => hit(r.label, r.description, r.path)).map((r) => ({ ref: r, name: r.label, dim: false })) });
  for (const id of graphOrder(m)) {
    const own = refs.filter((r) => r.kind === "result" && r.from === id);
    if (!own.length) continue;
    const st = m.states[id], whole = !!q && (id.toLowerCase().includes(q) || st.title?.toLowerCase().includes(q));
    const rows = own.filter((r) => whole || hit(r.label, r.description, r.path))
      .map((r) => ({ ref: r, name: r.label, dim: r.label === "event" }))
      .sort((a, b) => Number(a.dim) - Number(b.dim));
    add({ key: id, label: id, state: { id, kind: st.kind, title: st.title }, rows });
  }
  const meta = refs.filter((r) => r.kind === "meta").sort((a, b) => (a.path === "run.history" ? -1 : b.path === "run.history" ? 1 : 0));
  add({ key: "run", label: "Run", rows: meta.filter((r) => hit(r.label, r.description, r.path)).map((r) => ({ ref: r, name: r.path, dim: false })) });
  return groups;
}

// ---------- the drawn part ----------

export function SymbolField({ label, value, machine, at, onChange, hint, onExpand, big, textareaRef, onInputType, uid = at }: {
  label: string; value: string; machine: Machine; at: string; onChange: (v: string) => void; hint?: ReactNode;
  /** draws the expand button at the field's top-right */
  onExpand?: () => void;
  /** the writing dialog's larger setting */
  big?: boolean;
  textareaRef?: (el: HTMLTextAreaElement | null) => void;
  /** every input event's inputType, for the dialog's undo and redo counts */
  onInputType?: (t: string) => void;
  /** keeps ids unique when the same prompt shows twice (inline and in the dialog) */
  uid?: string;
}) {
  const ta = useRef<HTMLTextAreaElement | null>(null), mirror = useRef<HTMLDivElement>(null), mark = useRef<HTMLSpanElement>(null);
  const refs = useMemo(() => refsAt(machine, at), [machine, at]);
  const segs = useMemo(() => segments(value, refs), [value, refs]);
  const unknown = useMemo(() => [...new Set(segs.flatMap((s) => ("kind" in s && s.kind === "unknown" ? [s.path] : [])))], [segs]);
  const [caret, setCaret] = useState<number | null>(null);
  const [shut, setShut] = useState<number | null>(null); // the `$` the user closed with Escape
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const open = caret === null ? null : pickQuery(value, caret);
  const picking = open && open.start !== shut ? open : null;
  // Escape closes one `$`; once that `$` is gone, a new one opens the picker again.
  useLayoutEffect(() => { if (shut !== null && value[shut] !== "$") setShut(null); }, [value, shut]);
  const groups = useMemo(() => (picking ? pickGroups(machine, refs, picking.query) : []), [picking?.query, picking?.start, refs, machine]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.ref)), [groups]);
  const pending = useRef<number | null>(null);

  // after an insert or chip removal, put the caret where it belongs
  useLayoutEffect(() => { const c = pending.current; if (c !== null && ta.current) { ta.current.setSelectionRange(c, c); pending.current = null; setCaret(c); } }, [value]);
  // The picker is portalled to the body with position: fixed, so no scroll container clips it. It hangs under the `$`
  // and flips above the field when the space below is short; it follows the `$` on scroll and resize.
  const pick = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!picking) { setPos(null); return; }
    const place = () => {
      const m = mark.current?.getBoundingClientRect(), f = ta.current?.getBoundingClientRect();
      if (!m || !f) return;
      const vw = window.innerWidth, vh = window.innerHeight, gap = 4, edge = 8, want = 280;
      const left = Math.max(edge, Math.min(m.left - 8, vw - 300 - edge));
      const below = vh - m.bottom - gap - edge, above = Math.min(m.top, f.top) - gap - edge;
      if (below >= want || below >= above) setPos({ left, top: m.bottom + gap, maxHeight: Math.min(want, Math.max(84, below)), transformOrigin: "top left" });
      else setPos({ left, bottom: vh - Math.min(m.top, f.top) + gap, maxHeight: Math.min(want, above), transformOrigin: "bottom left" });
    };
    place();
    window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [picking?.start, value]); // eslint-disable-line react-hooks/exhaustive-deps
  // a press outside the field and the picker closes it
  useEffect(() => {
    if (!picking) return;
    const down = (e: PointerEvent) => { const t = e.target as Node; if (!pick.current?.contains(t) && !ta.current?.contains(t)) setShut(picking.start); };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [picking?.start]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { setHi(0); }, [picking?.query, picking?.start]);
  useLayoutEffect(() => { pick.current?.querySelector(".sym-o.on")?.scrollIntoView({ block: "nearest" }); }, [hi]);

  // A chip is one unit: a caret or selection edge that lands inside one moves to its edge. Arrow keys say which way.
  const dir = useRef<"left" | "right" | "near">("near"), dragging = useRef(false);
  const sync = () => {
    const t = ta.current; if (!t) return;
    const s = t.selectionStart, e = t.selectionEnd, d = dir.current;
    if (dragging.current) { /* the click after release snaps */ }
    else if (s === e) { const n = snapCaret(t.value, s, d); if (n !== s) t.setSelectionRange(n, n); }
    else { const ns = snapCaret(t.value, s, d === "near" ? "left" : d), ne = snapCaret(t.value, e, d === "near" ? "right" : d); if (ns !== s || ne !== e) t.setSelectionRange(ns, ne, t.selectionDirection); }
    setCaret(t.selectionStart === t.selectionEnd ? t.selectionStart : null);
    if (mirror.current) mirror.current.scrollTop = t.scrollTop;
  };
  const scrolled = () => { const t = ta.current; if (t && mirror.current) mirror.current.scrollTop = t.scrollTop; };
  useLayoutEffect(scrolled, [value]);
  // In development, a mirror that wraps differently from the textarea shows up as a height mismatch.
  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return;
    const t = ta.current, m = mirror.current;
    if (t && m && Math.abs(t.scrollHeight - m.scrollHeight) > 1) console.warn(`SymbolField ${uid}: textarea and mirror wrap differently (${t.scrollHeight}px vs ${m.scrollHeight}px)`);
  }, [value, uid]);
  // Edits go through the textarea's own editing path so ⌘Z and ⇧⌘Z undo and redo them; the `input` event lands in
  // onChange as usual. Only when the browser refuses execCommand do we set the value ourselves.
  const replace = (s: number, e: number, by: string) => {
    const t = ta.current;
    if (t) {
      t.focus(); t.setSelectionRange(s, e);
      if (by ? document.execCommand("insertText", false, by) : document.execCommand("delete")) return;
      t.setRangeText(by, s, e, "end");
      t.dispatchEvent(new InputEvent("input", { inputType: by ? "insertText" : "deleteContentBackward", data: by || null, bubbles: true }));
      return;
    }
    pending.current = s + by.length; onChange(value.slice(0, s) + by + value.slice(e));
  };
  const insert = (r: Ref) => { if (picking && caret !== null) replace(picking.start, caret, `{{${r.path}}}`); };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget, c = t.selectionStart, collapsed = c === t.selectionEnd;
    dir.current = e.key === "ArrowLeft" || e.key === "Home" ? "left" : e.key === "ArrowRight" || e.key === "End" ? "right" : "near";
    if (picking && shown.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % shown.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h - 1 + shown.length) % shown.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insert(shown[Math.min(hi, shown.length - 1)]); return; }
    }
    if (picking && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setShut(picking.start); return; }
    if (collapsed && (e.key === "Backspace" || e.key === "Delete") && !e.altKey && !e.metaKey) {
      const chip = chipAt(t.value, c, e.key === "Backspace" ? "before" : "after");
      if (chip) { e.preventDefault(); replace(chip[0], chip[1], ""); }
    }
  };

  // The mirror renders the same characters as the textarea, behind it and clear, so chips may only paint: no padding, no font change.
  let offset = 0;
  const body = segs.map((s, i) => {
    const start = offset; offset += s.text.length;
    const cut = picking && picking.start >= start && picking.start < offset ? picking.start - start : -1;
    const plain = (t: string, k: string) => (cut < 0 ? t : <span key={k}>{t.slice(0, cut)}<span ref={mark} className="sym-mark">{t[cut]}</span>{t.slice(cut + 1)}</span>);
    if (!("kind" in s)) return <span key={i}>{plain(s.text, `p${i}`)}</span>;
    return <span key={i} className={`chip c-${s.kind}`}><b>{"{{"}</b>{s.path}<b>{"}}"}</b></span>;
  });

  return (
    <div className={`field sym${big ? " big" : ""}`}>
      {big ? <label className="sr-only" htmlFor={`sym-${uid}`}>{label}</label> : (
        <div className="field-h"><label className="k label" htmlFor={`sym-${uid}`}>{label}</label>
          {onExpand ? <button type="button" className="expand" onClick={onExpand} title="Open the prompt in a larger editor" aria-label={`Expand ${label}`}><ExpandIcon /></button> : null}
        </div>
      )}
      <div className="sym-box">
        <div ref={mirror} className="sym-mirror" aria-hidden="true">{body}{"\n"}</div>
        <textarea id={`sym-${uid}`} ref={(el) => { ta.current = el; textareaRef?.(el); }} className="prose" value={value} spellCheck={false} rows={3}
          role="combobox" aria-expanded={!!(picking && shown.length)} aria-controls={`sym-list-${uid}`} aria-autocomplete="list"
          aria-activedescendant={picking && shown.length ? `sym-${uid}-${Math.min(hi, shown.length - 1)}` : undefined}
          onChange={(e) => { onInputType?.((e.nativeEvent as InputEvent).inputType ?? ""); onChange(e.target.value); setCaret(e.target.selectionStart); }}
          onKeyDown={onKey} onKeyUp={sync} onPointerDown={() => { dir.current = "near"; dragging.current = true; }} onPointerUp={() => { dragging.current = false; }} onClick={sync} onSelect={sync} onScroll={scrolled} onBlur={() => setCaret(null)} />
        {picking && pos ? createPortal(
          <div ref={pick} className="sym-pick" id={`sym-list-${uid}`} role="listbox" aria-label="References" style={pos} onMouseDown={(e) => e.preventDefault()}>
            {shown.length ? groups.map((g) => (
              <div key={g.key} role="group" aria-label={g.state ? `${g.state.id} ${g.state.title}` : g.label}>
                {g.state
                  ? <span className="sym-g st"><KindGlyph kind={g.state.kind} /><code>{g.state.id}</code>{g.state.title && g.state.title !== g.state.id ? <span className="t">{g.state.title}</span> : null}</span>
                  : <span className="sym-g">{g.label}</span>}
                {g.rows.map(({ ref: r, name, dim }) => { const i = shown.indexOf(r); return (
                  <div key={r.path} id={`sym-${uid}-${i}`} role="option" aria-selected={i === hi} title={`{{${r.path}}}`} className={`sym-o${i === hi ? " on" : ""}${dim ? " dim" : ""}`} onMouseEnter={() => setHi(i)} onClick={() => insert(r)}>
                    <span className={`sym-dot c-${r.kind}`} aria-hidden="true" /><code>{name}</code>{r.description ? <span className="d">{r.description}</span> : null}
                  </div>
                ); })}
              </div>
            )) : <span className="sym-g">Nothing called “{picking.query}” here</span>}
            <span className="sym-foot"><kbd>↑</kbd><kbd>↓</kbd> choose <kbd>↵</kbd> insert <kbd>esc</kbd> close</span>
          </div>, document.body,
        ) : null}
      </div>
      {unknown.length ? <span className="hint sym-unknown" role="status">Not available here: {unknown.map((p, i) => <code key={p}>{i ? " " : ""}{p}</code>)}</span> : null}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** Two corners pulling apart: open larger. 1.5px stroke beside 13px regular text. */
export const ExpandIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8.5 2.5h3v3M11.5 2.5 8 6M5.5 11.5h-3v-3M2.5 11.5 6 8" />
  </svg>
);
