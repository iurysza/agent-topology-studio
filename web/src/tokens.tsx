// A token field for a comma list (a role's tools and skills). The value stays the same `a, b` string the file
// holds; each entry is drawn as a chip. Typing opens suggestions like the `$` picker; Enter, Tab or comma commits,
// Backspace on an empty input takes the last chip. ⌘Z and ⇧⌘Z undo and redo chip changes.
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

// ---------- the pure part ----------

export const parseTokens = (s: string) => [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))];
export const joinTokens = (t: string[]) => t.join(", ");
/** The list with one more entry; blanks and repeats change nothing. */
export const addToken = (t: string[], raw: string) => { const v = raw.trim().replace(/,+$/, "").trim(); return !v || t.includes(v) ? t : [...t, v]; };
export const removeToken = (t: string[], i: number) => t.filter((_, j) => j !== i);
/** Suggestions not yet chosen that match the query: prefix first, then anywhere. Case-insensitive. */
export function suggest(all: string[], chosen: string[], query: string): string[] {
  const q = query.trim().toLowerCase(), free = all.filter((x) => !chosen.includes(x));
  if (!q) return free;
  const pre = free.filter((x) => x.toLowerCase().startsWith(q)), mid = free.filter((x) => !x.toLowerCase().startsWith(q) && x.toLowerCase().includes(q));
  return [...pre, ...mid];
}

// ---------- the drawn part ----------

export function TokenField({ label, value, onChange, suggestions, placeholder, hint, kind = "tool" }: {
  label: string; value: string; onChange: (v: string) => void; suggestions: string[]; placeholder?: string; hint?: string; kind?: "tool" | "skill";
}) {
  const tokens = useMemo(() => parseTokens(value), [value]);
  const [text, setText] = useState(""), [focus, setFocus] = useState(false), [hi, setHi] = useState(0), [shut, setShut] = useState(false);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const box = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), pop = useRef<HTMLDivElement>(null);
  const past = useRef<string[]>([]), future = useRef<string[]>([]);
  const shown = useMemo(() => suggest(suggestions, tokens, text).slice(0, 40), [suggestions, tokens, text]);
  const open = focus && !shut && shown.length > 0;
  const id = `tok-${label.toLowerCase()}`;
  // Every chip change goes through here, so undo sees it.
  const commit = (next: string[]) => { const s = joinTokens(next); if (s === joinTokens(tokens)) return; past.current.push(value); future.current = []; onChange(s); };
  const take = (raw: string) => { commit(addToken(tokens, raw)); setText(""); setShut(false); };
  useLayoutEffect(() => { setHi(0); }, [text]);
  useLayoutEffect(() => { pop.current?.querySelector(".sym-o.on")?.scrollIntoView({ block: "nearest" }); }, [hi]);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = box.current?.getBoundingClientRect(); if (!r) return;
      const vh = window.innerHeight, gap = 4, edge = 8, below = vh - r.bottom - gap - edge;
      setPos(below >= 160 ? { left: r.left, width: Math.max(240, r.width), top: r.bottom + gap, maxHeight: Math.min(240, below) } : { left: r.left, width: Math.max(240, r.width), bottom: vh - r.top + gap, maxHeight: Math.min(240, r.top - gap - edge), transformOrigin: "bottom left" });
    };
    place();
    window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open, tokens.length]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    // With the input empty, ⌘Z belongs to the chips; with text in it, the browser undoes the typing.
    if (mod && e.key.toLowerCase() === "z" && !text) {
      const redo = e.shiftKey, from = redo ? future.current : past.current, to = redo ? past.current : future.current;
      const prev = from.pop();
      if (prev !== undefined) { e.preventDefault(); to.push(value); onChange(prev); }
      return;
    }
    if (mod || e.altKey) return;
    if (open) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % shown.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h - 1 + shown.length) % shown.length); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setShut(true); return; }
    }
    // Enter and Tab take the highlighted suggestion, or the typed text when nothing matches; a comma takes the text as typed.
    // Tab with nothing typed moves focus as usual.
    if (e.key === "Enter" || e.key === "," || (e.key === "Tab" && text.trim())) {
      e.preventDefault();
      take(e.key !== "," && open && shown[hi] ? shown[hi] : text);
      return;
    }
    if (e.key === "Backspace" && !text && tokens.length) { e.preventDefault(); commit(removeToken(tokens, tokens.length - 1)); }
  };

  return (
    <div className="field tok">
      <label className="k label" htmlFor={id}>{label}</label>
      <div ref={box} className={`tok-box${focus ? " focus" : ""}`} onPointerDown={(e) => { if (e.target === box.current) { e.preventDefault(); input.current?.focus(); } }}>
        {tokens.map((t, i) => (
          <span key={t} className={`tok-chip k-${kind}${suggestions.length && !suggestions.includes(t) ? " odd" : ""}`} title={suggestions.length && !suggestions.includes(t) ? "Not in Pi's catalog" : undefined}>
            <code>{t}</code>
            <button type="button" tabIndex={-1} aria-label={`Remove ${t}`} onMouseDown={(e) => e.preventDefault()} onClick={() => commit(removeToken(tokens, i))}>
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 1.5l5 5M6.5 1.5l-5 5" /></svg>
            </button>
          </span>
        ))}
        <input ref={input} id={id} className="tok-in mono" value={text} spellCheck={false} autoComplete="off" placeholder={tokens.length ? "" : placeholder}
          role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={open ? `${id}-${hi}` : undefined}
          onChange={(e) => { const v = e.target.value; if (v.includes(",")) { const parts = v.split(","); let t = tokens; for (const p of parts.slice(0, -1)) t = addToken(t, p); commit(t); setText(parts[parts.length - 1]); } else { setText(v); setShut(false); } }}
          onKeyDown={onKey} onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); setShut(false); if (text.trim()) take(text); }} />
      </div>
      {open && pos ? createPortal(
        <div ref={pop} className="sym-pick tok-pick" id={`${id}-list`} role="listbox" aria-label={`${label} suggestions`} style={pos} onMouseDown={(e) => e.preventDefault()}>
          {shown.map((s, i) => (
            <div key={s} id={`${id}-${i}`} role="option" aria-selected={i === hi} className={`sym-o${i === hi ? " on" : ""}`} onMouseEnter={() => setHi(i)} onClick={() => take(s)}>
              <span className={`sym-dot tok-dot k-${kind}`} aria-hidden="true" /><code>{s}</code>
            </div>
          ))}
          <span className="sym-foot"><kbd>↑</kbd><kbd>↓</kbd> choose <kbd>↵</kbd> add <kbd>⌫</kbd> remove last <kbd>esc</kbd> close</span>
        </div>, document.body,
      ) : null}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}
