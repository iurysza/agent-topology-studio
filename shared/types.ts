// The machine, as spec section 1 defines it, for shared/ and server/. web/src/types.ts keeps the web's own view (D12).
export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface Field { type: FieldType; required?: boolean; description?: string; default?: unknown }

export interface Transition { to: string; description?: string }

export interface Branch { id: string; role: string; prompt: string; gate?: string }

export type Kind = 'task' | 'decision' | 'fanout' | 'final';

export interface State {
  kind: Kind; title: string;
  role?: string; prompt?: string; gate?: string; output?: Record<string, Field>;
  branches?: Branch[];
  on?: Record<string, Transition>;
  maxVisits?: number;
  outcome?: 'success' | 'failure';
}

export interface Machine {
  id: string; name: string; description: string; whenToUse?: string;
  inputs?: Record<string, Field>; initial: string; states: Record<string, State>;
}

/** A project role: its name, or a role object that has one. */
export type RoleRef = string | { name: string };

export type ValidateOptions = { roles?: ReadonlyArray<RoleRef> | null; fileName?: string };
