export const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;
export const FIELD_NAME = /^[a-z][a-z0-9_]*$/;

/** A field of the machine's inputs or a state's output, as far as references read it. */
export type RefField = { readonly description?: string };

export type RefBranch = { readonly id?: string; readonly prompt?: string };

export type RefState = {
  readonly kind?: string;
  readonly prompt?: string;
  readonly output?: Readonly<Record<string, RefField>>;
  readonly branches?: RefBranch[];
};

/** The parts of a machine that references read. The machine may be unvalidated, so every part is checked again. */
export type RefMachine = {
  readonly inputs?: Readonly<Record<string, RefField>>;
  readonly states?: Readonly<Record<string, RefState>>;
};

export type RefKind = 'input' | 'result' | 'meta';

export type Ref = { path: string; kind: RefKind; label: string; from?: string; description?: string };

export type UnknownRef = { at: string; path: string };

const object = <T>(value: T): value is T & object => value !== null && typeof value === 'object' && !Array.isArray(value);

const entries = <T>(value: Readonly<Record<string, T>> | undefined): [string, T][] => object(value) ? Object.entries(value) : [];

/** References available to a state or a fanout branch, excluding that state's own results. */
export function references(machine: RefMachine | null | undefined, at?: string): Ref[] {
  const refs: Ref[] = [], current = typeof at === 'string' ? at.split('.')[0] : undefined;
  for (const [name, field] of entries(machine?.inputs)) refs.push({ path: `inputs.${name}`, kind: 'input', label: name, ...(typeof field?.description === 'string' ? { description: field.description } : {}) });
  for (const [id, state] of entries(machine?.states)) {
    if (id === current || !object(state)) continue;
    const result = (field: string, description?: string) => refs.push({ path: `results.${id}.${field}`, kind: 'result', label: field, from: id, ...(typeof description === 'string' ? { description } : {}) });
    if (state.kind === 'fanout') {
      for (const branch of Array.isArray(state.branches) ? state.branches : []) if (object(branch) && typeof branch.id === 'string') result(`${branch.id}.text`);
    } else if (state.kind === 'task' || state.kind === 'decision') {
      const output = entries(state.output);
      for (const [name, field] of output) result(name, field?.description);
      if (!output.length) result('text');
      result('event');
    }
  }
  refs.push({ path: 'visit', kind: 'meta', label: 'visit' }, { path: 'run.history', kind: 'meta', label: 'run.history' });
  return refs;
}

export function unknownRefs(machine: RefMachine | null | undefined): UnknownRef[] {
  const unknown: UnknownRef[] = [];
  const check = (at: string, prompt: string | undefined) => {
    if (typeof prompt !== 'string') return;
    const known = new Set(references(machine, at).map(ref => ref.path));
    for (const match of prompt.matchAll(PLACEHOLDER)) if (!known.has(match[1])) unknown.push({ at, path: match[1] });
  };
  for (const [id, state] of entries(machine?.states)) {
    if (!object(state)) continue;
    if (state.kind === 'task' || state.kind === 'decision') check(id, state.prompt);
    if (state.kind === 'fanout') for (const branch of Array.isArray(state.branches) ? state.branches : []) if (object(branch) && typeof branch.id === 'string') check(`${id}.${branch.id}`, branch.prompt);
  }
  return unknown;
}
