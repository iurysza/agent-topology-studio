// One select for the whole app: a trigger that looks like the inputs and a popover list, the same surface as
// the `$` picker. Keys: ↑↓ move, Enter picks, Esc closes, typing filters. A press outside closes it.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface Option { value: string; label: string; description?: string; swatch?: string; glyph?: ReactNode }

// ---------- the pure part ----------

/** Options matching what was typed: label prefix first, then anywhere in the label, then in the description. */
export function filterOptions(options: Option[], query: string): Option[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  const score = (o: Option) => (o.label.toLowerCase().startsWith(q) ? 0 : o.label.toLowerCase().includes(q) ? 1 : (o.description ?? "").toLowerCase().includes(q) ? 2 : -1);
  return options.map((o) => [o, score(o)] as const).filter(([, s]) => s >= 0).sort((a, b) => a[1] - b[1]).map(([o]) => o);
}

/** The highlight after a key: arrows wrap, Home and End jump. Null when the key does not move it. */
export function moveHighlight(at: number, key: string, n: number): number | null {
  if (!n) return null;
  if (key === "ArrowDown") return (at + 1) % n;
  if (key === "ArrowUp") return (at - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

/** The query after a key: printable characters add, Backspace removes. Null when the key is not typing. */
export function typeQuery(query: string, key: string): string | null {
  if (key === "Backspace") return query ? query.slice(0, -1) : null;
  return key.length === 1 && (key !== " " || query) ? query + key : null;
}

// ---------- the drawn part ----------

const Check = () => <svg className="sel-check" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6l4.5-5.2" /></svg>;
const Chevron = () => <svg className="sel-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 3.8 5 6.3l2.5-2.5" /></svg>;

export function Select({ value, options, onChange, label, id, className = "", placeholder = "Choose…", mono, width = 320 }: {
  value: string; options: Option[]; onChange: (v: string) => void; label?: string; id?: string; className?: string; placeholder?: string; mono?: boolean; width?: number;
}) {
  const auto = useId(), listId = `${id ?? auto}-list`;
  const btn = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [hi, setHi] = useState(0);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const shown = useMemo(() => filterOptions(options, query), [options, query]);
  const cur = options.find((o) => o.value === value);
  const show = () => { setQuery(""); setHi(Math.max(0, options.findIndex((o) => o.value === value))); setOpen(true); btn.current?.focus(); };
  const close = (refocus = true) => { setOpen(false); setQuery(""); if (refocus) btn.current?.focus(); };
  const pick = (o: Option | undefined) => { if (!o) return; if (o.value !== value) onChange(o.value); close(); };

  useLayoutEffect(() => { setHi((h) => (query ? 0 : Math.min(h, Math.max(0, shown.length - 1)))); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { pop.current?.querySelector(".sel-o.on")?.scrollIntoView({ block: "nearest" }); }, [hi, open]);
  // Portalled with position: fixed under the trigger; flips above when the room below is short.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = btn.current?.getBoundingClientRect(); if (!r) return;
      const vw = window.innerWidth, vh = window.innerHeight, gap = 4, edge = 8, want = 300;
      const w = Math.min(Math.max(r.width, width), vw - 2 * edge), left = Math.max(edge, Math.min(r.left, vw - w - edge));
      const below = vh - r.bottom - gap - edge, above = r.top - gap - edge;
      if (below >= want || below >= above) setPos({ left, width: w, top: r.bottom + gap, maxHeight: Math.min(want, below), transformOrigin: "top left" });
      else setPos({ left, width: w, bottom: vh - r.top + gap, maxHeight: Math.min(want, above), transformOrigin: "bottom left" });
    };
    place();
    window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open, width]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { const t = e.target as Node; if (!pop.current?.contains(t) && !btn.current?.contains(t)) close(false); };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); show(); } // the list under the bar must not also take the key
      return;
    }
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Enter" || (e.key === "Tab" && shown.length)) { e.preventDefault(); pick(shown[hi]); return; }
    const m = moveHighlight(hi, e.key, shown.length);
    if (m !== null) { e.preventDefault(); setHi(m); return; }
    const q = typeQuery(query, e.key);
    if (q !== null) { e.preventDefault(); setQuery(q); }
  };

  const lead = cur?.glyph ?? (cur?.swatch !== undefined ? <span className={cur.swatch} aria-hidden="true" /> : null);
  return (
    <>
      <button ref={btn} type="button" id={id} className={`sel-t${mono ? " mono" : ""}${lead ? " lead" : ""}${open ? " open" : ""} ${className}`}
        role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-label={label}
        aria-activedescendant={open && shown.length ? `${listId}-${hi}` : undefined}
        onClick={() => (open ? close() : show())} onKeyDown={onKey}>
        {lead ? <span className="sel-lead">{lead}</span> : null}
        <span className={`sel-v${cur ? "" : " ph"}`}>{cur?.label ?? (value || placeholder)}</span>
        <Chevron />
      </button>
      {open && pos ? createPortal(
        <div ref={pop} className="sel-pop" id={listId} role="listbox" aria-label={label} style={pos} onMouseDown={(e) => e.preventDefault()}>
          {query ? <div className="sel-q" aria-live="polite"><span className="dim">Filter</span><code>{query}</code></div> : null}
          {shown.length ? shown.map((o, i) => (
            <div key={o.value} id={`${listId}-${i}`} role="option" aria-selected={o.value === value}
              className={`sel-o${i === hi ? " on" : ""}${o.value === value ? " cur" : ""}${o.description ? " two" : ""}`}
              onMouseEnter={() => setHi(i)} onClick={() => pick(o)}>
              {o.glyph ? <span className="sel-lead">{o.glyph}</span> : o.swatch !== undefined ? <span className="sel-lead"><span className={o.swatch} aria-hidden="true" /></span> : null}
              <span className="sel-txt">
                <span className={`sel-n${mono ? " mono" : ""}`}>{o.label}</span>
                {o.description ? <span className="sel-d">{o.description}</span> : null}
              </span>
              {o.value === value ? <Check /> : null}
            </div>
          )) : <span className="sym-g">Nothing matches “{query}”</span>}
        </div>, document.body,
      ) : null}
    </>
  );
}
