// Pure edits shared by the canvas, inspector and CLI.
import { PLACEHOLDER } from './refs.ts';
import type { Field, Kind, Machine, State, Transition } from './types.ts';

/** The state fields the inspector and `studio set` edit. */
type FieldKey = 'title' | 'role' | 'kind' | 'prompt' | 'gate' | 'maxVisits' | 'outcome';

/** What addAfter returns: the new machine, the new state's id and the event that enters it. */
export type Added = { m: Machine; id: string; event: string };

/** What addState returns. */
export type AddedState = { m: Machine; id: string };

/** What removeState returns: the new machine and one message per removed event. */
export type Removal = { m: Machine; removed: string[] };

const fieldKeys: readonly FieldKey[] = ['title', 'role', 'kind', 'prompt', 'gate', 'maxVisits', 'outcome'];

const kinds: readonly Kind[] = ['task', 'decision', 'fanout', 'final'];

const isFieldKey = (key: string): key is FieldKey => fieldKeys.some(k => k === key);

const isKind = <V>(value: V): value is V & Kind => kinds.some(k => k === value);

const own = <T>(value: Readonly<Record<string, T>> | undefined, key: string): T | undefined => value && Object.hasOwn(value, key) ? value[key] : undefined;
const freeId = <T>(taken: Readonly<Record<string, T>>, base: string): string => { if (!Object.hasOwn(taken, base)) return base; let n = 2; while (Object.hasOwn(taken, `${base}_${n}`)) n++; return `${base}_${n}`; };
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '') || 'next';

/** A new task after from. A fanout keeps and re-points its single event. */
export function addAfter(m: Machine, from: string, role = 'coder'): Added {
  const c = structuredClone(m), id = freeId(c.states, 'step'), src = own(c.states, from);
  c.states[id] = { kind: 'task', title: 'New step', role, prompt: 'What the agent does.', on: {} };

  // Callers pass an existing state. A missing one fails here, as reading `src.kind` did in the JS.
  if (src === undefined) throw new TypeError("Cannot read properties of undefined (reading 'kind')");

  if (src.kind === 'fanout' && src.on && Object.keys(src.on).length) {
    const event = Object.keys(src.on)[0];
    src.on = { [event]: { ...src.on[event], to: id } };
    return { m: c, id, event };
  }
  const event = freeId(src.on ?? {}, 'done');
  src.on = { ...src.on, [event]: { to: id } };
  return { m: c, id, event };
}
export const eventNameFor = (m: Machine, from: string, to: string): string => freeId(own(m.states, from)?.on ?? {}, slug(to));

/** Fanouts replace their event; finals cannot connect. */
export function connect(m: Machine, from: string, to: string, event: string): Machine {
  const c = structuredClone(m), src = own(c.states, from);
  if (!src || src.kind === 'final') return m;
  const name = slug(event);
  src.on = src.kind === 'fanout' ? { [name]: { to } } : { ...src.on, [name]: { to } };
  return c;
}
export function retitle(m: Machine, id: string, title: string): Machine {
  const c = structuredClone(m), state = own(c.states, id);
  if (state) state.title = title;
  return c;
}
export function removeState(m: Machine, id: string): Removal {
  const c = structuredClone(m), removed: string[] = [];
  delete c.states[id];
  for (const [sid, s] of Object.entries(c.states)) { const on = s.on; if (on) for (const [event, t] of Object.entries(on)) if (t.to === id) { delete on[event]; removed.push(`Removed event \`${event}\` from \`${sid}\`: it led to \`${id}\``); } }
  if (c.initial === id) c.initial = Object.keys(c.states)[0] ?? '';
  return { m: c, removed };
}
export function renameState(m: Machine, from: string, to: string): Machine {
  if (!to || to === from || !/^[a-z][a-z0-9_]*$/.test(to) || Object.hasOwn(m.states, to) || !Object.hasOwn(m.states, from)) return m;
  const c = structuredClone(m);
  c.states = Object.fromEntries(Object.entries(c.states).map(([key, value]) => [key === from ? to : key, value]));
  const prefix = `results.${from}.`;
  const rewrite = (prompt: string) => prompt.replace(PLACEHOLDER, (match: string, ref: string) => ref.startsWith(prefix) ? match.replace(ref, `results.${to}.${ref.slice(prefix.length)}`) : match);
  for (const s of Object.values(c.states)) {
    for (const t of Object.values(s.on ?? {})) if (t.to === from) t.to = to;
    if (typeof s.prompt === 'string') s.prompt = rewrite(s.prompt);
    for (const b of s.branches ?? []) if (typeof b.prompt === 'string') b.prompt = rewrite(b.prompt);
  }
  if (c.initial === from) c.initial = to;
  return c;
}
export function addState(m: Machine, role = 'coder'): AddedState {
  const c = structuredClone(m), id = freeId(c.states, 'state');
  c.states[id] = { kind: 'task', title: 'New state', role, prompt: 'What the agent does.', on: {} };
  return { m: c, id };
}
export function setKind(s: State, kind: Kind, role = 'coder'): State {
  const base = { kind, title: s.title, ...(s.maxVisits && kind !== 'final' ? { maxVisits: s.maxVisits } : {}) };
  if (kind === 'final') return { kind, title: s.title, outcome: s.outcome ?? 'success' };
  if (kind === 'fanout') {
    const first = Object.entries(s.on ?? {})[0], r = s.role ?? role, p = s.prompt ?? '';
    return { ...base, branches: s.branches ?? [{ id: 'a', role: r, prompt: p }, { id: 'b', role: r, prompt: p }], on: first ? { [first[0]]: first[1] } : {} };
  }
  const r = s.role ?? s.branches?.[0]?.role ?? role;
  return { ...base, role: r, prompt: s.prompt ?? s.branches?.[0]?.prompt ?? '', ...(kind === 'task' && s.gate !== undefined ? { gate: s.gate } : {}), ...(s.output ? { output: s.output } : {}), on: s.on ?? {} };
}
export function clean(m: Machine): Machine {
  const c = structuredClone(m);
  if (c.inputs && !Object.keys(c.inputs).length) delete c.inputs;
  if (c.whenToUse === '') delete c.whenToUse;
  for (const s of Object.values(c.states)) {
    if (s.output && !Object.keys(s.output).length) delete s.output;
    for (const t of Object.values(s.on ?? {})) if (!t.description) delete t.description;
  }
  return c;
}
// The value is not checked here, as in the JS: the CLI passes argv text, and validateMachine checks the saved machine.
// So the result can hold a value that is not a valid State field, such as `kind: 'wait'`.
export function setField<V>(m: Machine, state: string, key: string, value: V): Machine {
  if (!own(m.states, state) || !isFieldKey(key)) return m;
  const c = structuredClone(m), s = c.states[state];
  // setKind(s, value) for a value that is not a Kind takes its decision path, then keeps that value as `kind`.
  if (key === 'kind') c.states = { ...c.states, [state]: isKind(value) ? setKind(s, value) : Object.assign(setKind(s, 'decision'), { kind: value }) };
  // Reflect.deleteProperty is `delete s[key]`; TypeScript rejects `delete` on the required `title` and `kind`.
  else if (value === undefined || (key === 'gate' && value === '')) Reflect.deleteProperty(s, key);
  else Object.assign(s, { [key]: value });
  return c;
}
export function setInput(m: Machine, name: string, field: Field): Machine {
  const c = structuredClone(m);
  c.inputs = { ...c.inputs, [name]: structuredClone(field) };
  return c;
}
export function removeInput(m: Machine, name: string): Machine {
  const c = structuredClone(m);
  if (c.inputs) delete c.inputs[name];
  return c;
}
export function setOutput(m: Machine, state: string, name: string, field: Field): Machine {
  if (!own(m.states, state)) return m;
  const c = structuredClone(m), s = c.states[state];
  s.output = { ...s.output, [name]: structuredClone(field) };
  return c;
}
export function removeOutput(m: Machine, state: string, name: string): Machine {
  if (!own(m.states, state)) return m;
  const c = structuredClone(m), output = c.states[state].output;
  if (output) delete output[name];
  return c;
}
export function setEvent(m: Machine, from: string, event: string, { to, description }: Transition): Machine {
  const s = own(m.states, from);
  if (!s || s.kind === 'final') return m;
  const c = structuredClone(m), transition = { to, ...(description === undefined ? {} : { description }) };
  c.states[from].on = { ...(s.kind === 'fanout' ? {} : c.states[from].on ?? {}), [event]: transition };
  return c;
}
export function removeEvent(m: Machine, from: string, event: string): Machine {
  if (!own(m.states, from)) return m;
  const c = structuredClone(m), on = c.states[from].on;
  if (on) delete on[event];
  return c;
}
