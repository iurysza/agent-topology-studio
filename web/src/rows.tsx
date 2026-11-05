// Inputs, Output and Transitions as rows: one item per row, its parts as controls, problems under the row.
// Each list keeps its own drafts, so a half-typed or wrong row stays on screen without reaching the machine.
// A name commits on blur; every other part commits as it changes. Rows with a problem are left out of the
// machine and reported through onErrors, which the editor counts as problems (nothing saves until fixed).
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Field, FieldType, State, Transition } from "./types.ts";
import { KindGlyph } from "./editor.tsx";
import { Select } from "./select.tsx";

const NAME = /^[a-z][a-z0-9_]*$/;

/** User-facing words for a state's `on` map. The format calls each key an event; the UI calls the row a transition. */
export const TRANSITIONS = { label: "Transitions", one: "Transition", add: "+ Add transition" } as const;
export function transitionHint(kind: string): string | null {
  if (kind === "fanout") return "`failed` fires when a branch fails or the gate rejects.";
  return kind === "final" ? null : "The agent reports one when it finishes; the run moves to that state.";
}
/** The hint as a muted line, backticked words as code. */
export function TransitionHint({ kind }: { kind: string }) {
  const h = transitionHint(kind);
  return h ? <p className="tr-hint">{h.split("`").map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</p> : null;
}
const TYPES: FieldType[] = ["string", "number", "boolean", "array", "object"];

// ---------- the pure part: drafts in, a record and its problems out ----------

export interface FieldDraft { k: number; name: string; type: string; required: boolean; def: string; description: string }
export interface EventDraft { k: number; name: string; to: string; description: string }

const showDefault = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** A default as written, read as its type. `undefined` when blank; an error message when it does not fit. */
export function readDefault(type: string, text: string): { value?: unknown; error?: string } {
  const t = text.trim();
  if (!t) return {};
  if (type === "string") return { value: text };
  if (type === "number") { const n = Number(t); return Number.isFinite(n) ? { value: n } : { error: "default must be a number" }; }
  if (type === "boolean") return t === "true" ? { value: true } : t === "false" ? { value: false } : { error: "default must be true or false" };
  try {
    const v = JSON.parse(t);
    if (type === "array" ? Array.isArray(v) : v !== null && typeof v === "object" && !Array.isArray(v)) return { value: v };
  } catch { /* falls through */ }
  return { error: `default must be ${type === "array" ? "a JSON array" : "a JSON object"}` };
}

export function fieldDrafts(f: Record<string, Field> | undefined, next: () => number): FieldDraft[] {
  return Object.entries(f ?? {}).map(([name, v]) => ({ k: next(), name, type: v.type, required: !!v.required, def: showDefault(v.default), description: v.description ?? "" }));
}

/** Each draft's problem (or none), and the record of the drafts that have none. A row without a name is left out quietly. */
export function readFields(rows: FieldDraft[], withDefault: boolean): { value: Record<string, Field>; errors: (string | null)[] } {
  const value: Record<string, Field> = {};
  const count = new Map<string, number>(); for (const r of rows) count.set(r.name.trim(), (count.get(r.name.trim()) ?? 0) + 1);
  const errors = rows.map((r) => {
    const name = r.name.trim();
    if (!name) return null;
    if (!NAME.test(name)) return `Field \`${name}\`: use snake_case`;
    if ((count.get(name) ?? 0) > 1) return `Field \`${name}\`: used twice`;
    if (!TYPES.includes(r.type as FieldType)) return `Field \`${name}\`: unknown type \`${r.type}\``;
    const d = withDefault ? readDefault(r.type, r.def) : {};
    if (d.error) return `Field \`${name}\`: ${d.error}`;
    const f: Field = { type: r.type as FieldType };
    if (r.required) f.required = true;
    if (d.value !== undefined) f.default = d.value;
    if (r.description.trim()) f.description = r.description;
    value[name] = f;
    return null;
  });
  return { value, errors };
}

export function eventDrafts(on: Record<string, Transition> | undefined, next: () => number): EventDraft[] {
  return Object.entries(on ?? {}).map(([name, t]) => ({ k: next(), name, to: t.to, description: t.description ?? "" }));
}

/** Like readFields. A target that is not a state is shown but kept: the validator reports it, and dropping the event would lose it. */
export function readEvents(rows: EventDraft[], states: Record<string, unknown>, from: string): { value: Record<string, Transition>; errors: (string | null)[]; notes: (string | null)[] } {
  const value: Record<string, Transition> = {};
  const count = new Map<string, number>(); for (const r of rows) count.set(r.name.trim(), (count.get(r.name.trim()) ?? 0) + 1);
  const notes = rows.map((r) => (r.name.trim() && r.to && !(r.to in states) ? `State \`${from}\` event \`${r.name.trim()}\` targets unknown state \`${r.to}\`.` : null));
  const errors = rows.map((r) => {
    const name = r.name.trim();
    if (!name) return null;
    if (!NAME.test(name)) return `Event \`${name}\`: use snake_case`;
    if ((count.get(name) ?? 0) > 1) return `Event \`${name}\`: used twice`;
    if (!r.to) return `Event \`${name}\`: pick the state it goes to`;
    const t: Transition = { to: r.to };
    if (r.description.trim()) t.description = r.description;
    value[name] = t;
    return null;
  });
  return { value, errors, notes };
}

// ---------- the drawn part ----------

const Remove = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" className="rx" aria-label={label} title={label} onClick={onClick}>
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8" /></svg>
  </button>
);
const Msg = ({ text }: { text: string | null }) => (text ? <p className="row-msg" role="alert">{rich(text)}</p> : null);
const rich = (t: string): ReactNode[] => t.split(/`([^`]+)`/).map((s, i) => (i % 2 ? <code key={i}>{s}</code> : s));

/** Rows a list could not commit, kept by the editor while the block is closed, so a wrong row is still there when you come back. */
export interface Keep<D> { rows?: D[]; set: (rows: D[] | undefined) => void }

/** Drafts in step with the machine: a change from elsewhere (the graph, a rename) reloads them. */
function useRows<T, D extends { k: number }>(value: T, load: (v: T, next: () => number) => D[], read: (rows: D[]) => { value: unknown; errors: (string | null)[] },
  onChange: (v: never) => void, onErrors: (e: string[]) => void, keep?: Keep<D>) {
  const n = useRef(Math.max(0, ...(keep?.rows ?? []).map((r) => r.k))); const next = () => ++n.current;
  const [rows, setRows] = useState<D[]>(() => keep?.rows ?? load(value, next));
  const [shown, setShown] = useState(() => read(rows).errors);
  const fresh = useRef(0);
  const json = JSON.stringify(value ?? {});
  const emitted = useRef(json);
  const commit = (rs: D[]) => {
    const r = read(rs), errs = r.errors.filter((e): e is string => !!e);
    setRows(rs); setShown(r.errors);
    const out = JSON.stringify(r.value);
    if (out !== json) { emitted.current = out; (onChange as (v: unknown) => void)(r.value); }
    onErrors(errs); keep?.set(errs.length ? rs : undefined);
  };
  useEffect(() => {
    if (json === emitted.current) return;
    emitted.current = json;
    const rs = load(value, next), errs = read(rs).errors;
    setRows(rs); setShown(errs); onErrors(errs.filter((e): e is string => !!e)); keep?.set(undefined);
  });
  const set = (i: number, patch: Partial<D>, now = true) => { const rs = rows.map((r, j) => (j === i ? { ...r, ...patch } : r)); if (now) commit(rs); else setRows(rs); };
  const add = (d: Omit<D, "k">) => { const k = next(); fresh.current = k; setRows([...rows, { ...d, k } as D]); };
  return { rows, shown, commit, set, add, fresh };
}

export function FieldRows({ label, value, withDefault, onChange, onErrors, keep, hint, add = "Add field" }: {
  label: string; value: Record<string, Field> | undefined; withDefault?: boolean; hint?: ReactNode; add?: string;
  onChange: (v: Record<string, Field>) => void; onErrors: (errors: string[]) => void; keep?: Keep<FieldDraft>;
}) {
  const { rows, shown, commit, set, add: addRow, fresh } = useRows(value, fieldDrafts, (rs) => readFields(rs, !!withDefault), onChange, onErrors, keep);
  return (
    <div className="field rows-ed" role="group" aria-label={label}>
      <span className="k label">{label}</span>
      {rows.length ? (
        <ul className="rl">
          {rows.map((r, i) => {
            const err = shown[i];
            const badName = !!err && /snake_case|used twice/.test(err), badType = !!err && /unknown type/.test(err), badDef = !!err && /default/.test(err);
            return (
              <li key={r.k} className={`ri${err ? " bad" : ""}`}>
                <div className="ri-1">
                  <input className={`mono${badName ? " bad" : ""}`} value={r.name} placeholder="name" spellCheck={false} aria-label="Name" aria-invalid={badName || undefined}
                    autoFocus={r.k === fresh.current}
                    onChange={(e) => set(i, { name: e.target.value }, false)} onBlur={() => commit(rows)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
                  <Select value={r.type} label="Type" className={`sm${badType ? " bad" : ""}`} mono width={160} onChange={(v) => set(i, { type: v })}
                    options={[...(!TYPES.includes(r.type as FieldType) ? [{ value: r.type, label: r.type }] : []), ...TYPES.map((t) => ({ value: t, label: t }))]} />
                  <label className="req" title="The agent must hand it back">
                    <input type="checkbox" checked={r.required} onChange={(e) => set(i, { required: e.target.checked })} />required
                  </label>
                  <Remove label={`Remove ${r.name || "this field"}`} onClick={() => commit(rows.filter((_, j) => j !== i))} />
                </div>
                <div className={`ri-2${withDefault ? " two" : ""}`}>
                  {withDefault ? <input className={`mono quiet-in${badDef ? " bad" : ""}`} value={r.def} placeholder="default" spellCheck={false} aria-label="Default" aria-invalid={badDef || undefined}
                    onChange={(e) => set(i, { def: e.target.value }, false)} onBlur={() => commit(rows)} /> : null}
                  <input className="quiet-in" value={r.description} placeholder="Description" aria-label="Description"
                    onChange={(e) => set(i, { description: e.target.value }, false)} onBlur={() => commit(rows)} />
                </div>
                <Msg text={err} />
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="rl-foot">
        <button type="button" className="link rl-add" onClick={() => addRow({ name: "", type: "string", required: false, def: "", description: "" })}>+ {add}</button>
        {hint ? <span className="hint">{hint}</span> : null}
      </div>
    </div>
  );
}

export function EventRows({ label = TRANSITIONS.label, from, value, states, max, onChange, onErrors, keep, hint }: {
  label?: string; from: string; value: Record<string, Transition> | undefined; states: Record<string, State>; max?: number; hint?: ReactNode;
  onChange: (v: Record<string, Transition>) => void; onErrors: (errors: string[]) => void; keep?: Keep<EventDraft>;
}) {
  const { rows, shown, commit, set, add, fresh } = useRows(value, eventDrafts, (rs) => readEvents(rs, states, from), onChange, onErrors, keep);
  const notes = readEvents(rows, states, from).notes;
  const ids = Object.keys(states);
  const going = ids.filter((s) => states[s].kind !== "final"), ending = ids.filter((s) => states[s].kind === "final");
  const full = max !== undefined && rows.length >= max;
  return (
    <div className="field rows-ed" role="group" aria-label={label}>
      <span className="k label">{label}</span>
      {states[from] ? <TransitionHint kind={states[from].kind} /> : null}
      {rows.length ? (
        <ul className="rl">
          {rows.map((r, i) => {
            const err = shown[i], note = notes[i];
            const badName = !!err && /snake_case|used twice/.test(err), badTo = (!!err && /pick the state/.test(err)) || !!note;
            return (
              <li key={r.k} className={`ri ev${err || note ? " bad" : ""}`}>
                <div className="ri-1">
                  <input autoFocus={r.k === fresh.current} className={`mono${badName ? " bad" : ""}`} value={r.name} placeholder="event" spellCheck={false} aria-label="Event name" aria-invalid={badName || undefined}
                    onChange={(e) => set(i, { name: e.target.value }, false)} onBlur={() => commit(rows)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
                  <span className="to" aria-hidden="true">→</span>
                  <Select value={r.to} label="Goes to" className={`sm${badTo ? " bad" : ""}`} mono placeholder="Pick a state" width={260} onChange={(v) => set(i, { to: v })}
                    options={[
                      ...(r.to && !(r.to in states) ? [{ value: r.to, label: r.to, description: "Missing" }] : []),
                      ...going.map((s) => ({ value: s, label: s, description: s === from ? "Itself" : states[s].title || undefined, glyph: <KindGlyph kind={states[s].kind} /> })),
                      ...ending.map((s) => ({ value: s, label: s, description: "Final: ends the run", glyph: <KindGlyph kind="final" /> })),
                    ]} />
                  <Remove label={`Remove ${r.name ? `transition ${r.name}` : "this transition"}`} onClick={() => commit(rows.filter((_, j) => j !== i))} />
                </div>
                <div className="ri-2">
                  <input className="quiet-in" value={r.description} placeholder="When to fire it" aria-label="Description"
                    onChange={(e) => set(i, { description: e.target.value }, false)} onBlur={() => commit(rows)} />
                </div>
                <Msg text={err ?? note} />
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="rl-foot">
        {!full ? <button type="button" className="link rl-add" onClick={() => add({ name: "", to: "", description: "" })}>{TRANSITIONS.add}</button> : null}
        {hint ? <span className="hint">{hint}</span> : null}
      </div>
    </div>
  );
}
