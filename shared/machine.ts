import { parse } from 'acorn';
import type { VariableDeclaration } from 'acorn';
import { literal } from './literal.ts';
import { runner } from './runner.ts';
import { gateProblem } from './gate.ts';
import { unknownRefs, FIELD_NAME } from './refs.ts';
import type { FieldType, Machine, ValidateOptions } from './types.ts';

export type { Branch, Field, FieldType, Kind, Machine, RoleRef, State, Transition, ValidateOptions } from './types.ts';

/** Any value that untrusted input can hold. validateMachine narrows it one check at a time. */
type Untrusted = string | number | bigint | boolean | symbol | null | undefined | Function | Untrusted[] | UntrustedObject;

type UntrustedObject = { readonly [key: string]: Untrusted };

const object = <T>(value: T): value is T & UntrustedObject => value !== null && typeof value === 'object' && !Array.isArray(value);

// Names the parsed object literal as a Machine without checking its fields, as at base. Callers run validateMachine on it.
const extracted = <T>(value: T): value is T & Machine => object(value);

const text = <T>(value: T): value is T & string => typeof value === 'string' && value.trim().length > 0;

const integer = <T>(value: T): value is T & number => Number.isInteger(value);

const oneOf = <T extends string>(list: readonly T[], value: Untrusted): value is T => list.some(item => item === value);

const idPattern = FIELD_NAME;

const types = ['string', 'number', 'boolean', 'array', 'object'] satisfies FieldType[];

type Validation = { problems: string[]; warnings: string[] };

// A placeholder value is shell data, so a gate may use it only where single quotes hold (ADR-0001).
const gateProblems = (command: string, label: string): string[] => (problem => problem === null ? [] : [`${label} gate ${problem}`])(gateProblem(command));

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- untrusted JSON validator
export function validateMachine(machine: unknown, { roles = null, fileName }: ValidateOptions = {}): Validation {
  const problems: string[] = [], warnings: string[] = [];
  const checkName = (value: Untrusted, label: string) => { if (typeof value === 'string' && Object.hasOwn(Object.prototype, value)) problems.push(`${label} uses a reserved name.`); };
  const keys = (value: UntrustedObject, allowed: readonly string[], label: string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${label} has an unknown key \`${key}\`.`);
  };
  const defaultKeys = (value: Untrusted, label: string) => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) problems.push(`${label} default uses a reserved key \`${key}\`.`);
      defaultKeys(nested, label);
    }
  };
  const fields = (value: Untrusted, label: string, input: boolean) => {
    if (!object(value)) { problems.push(`${label} must be an object.`); return; }
    for (const [name, field] of Object.entries(value)) {
      const at = `${label} field \`${name}\``;
      checkName(name, at);
      if (!FIELD_NAME.test(name)) problems.push(`${at} has an invalid name; use snake_case.`);
      if (!input && ['event', 'text'].includes(name)) problems.push(`${at} is reserved for the runner.`);
      if (!object(field)) { problems.push(`${at} must be an object.`); continue; }
      keys(field, ['type', 'required', 'description', ...(input ? ['default'] : [])], at);
      if (!oneOf(types, field.type)) problems.push(`${at} needs a valid type.`);
      if (field.required !== undefined && typeof field.required !== 'boolean') problems.push(`${at} required must be a boolean.`);
      if (field.description !== undefined && typeof field.description !== 'string') problems.push(`${at} description must be a string.`);
      if (input && Object.hasOwn(field, 'default')) {
        defaultKeys(field.default, at);
        const valid = field.type === 'array' ? Array.isArray(field.default) : field.type === 'object' ? object(field.default) : typeof field.default === field.type && (field.type !== 'number' || Number.isFinite(field.default));
        if (!valid) problems.push(`${at} default must match its type.`);
      }
    }
  };
  if (!object(machine)) return { problems: ['Machine must be an object.'], warnings };
  keys(machine, ['id', 'name', 'description', 'whenToUse', 'inputs', 'initial', 'states'], 'Machine');
  if (typeof machine.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(machine.id)) problems.push('Machine id must use lowercase letters, digits, and hyphens.');
  if (fileName !== undefined && machine.id !== fileName.replace(/\.js$/, '')) problems.push(`Machine id must match file name \`${fileName}\`.`);
  for (const key of ['name', 'description', 'initial']) if (!text(machine[key])) problems.push(`Machine needs a non-empty \`${key}\`.`);
  if (machine.whenToUse !== undefined && typeof machine.whenToUse !== 'string') problems.push('Machine whenToUse must be a string.');
  if (machine.inputs !== undefined) fields(machine.inputs, 'Inputs', true);
  if (!object(machine.states)) { problems.push('Machine states must be an object.'); return { problems, warnings }; }
  const states = machine.states, hasState = (id: Untrusted): id is string => typeof id === 'string' && Object.hasOwn(states, id);
  if (!hasState(machine.initial)) problems.push(typeof machine.initial === 'string' ? `Initial state \`${machine.initial}\` does not exist.` : 'Initial state must name a state.');
  if (!Object.values(states).some(s => object(s) && s.kind === 'final')) problems.push('Machine needs at least one final state.');
  const roleNames = roles === null ? null : new Set(roles.map(role => typeof role === 'string' ? role : role.name));
  const role = (value: Untrusted, at: string) => {
    if (!text(value)) problems.push(`${at} needs a role.`);
    else if (roleNames && !roleNames.has(value)) warnings.push(`${at} uses unknown project role \`${value}\`.`);
  };
  for (const [id, state] of Object.entries(states)) {
    const at = `State \`${id}\``;
    checkName(id, at);
    if (!idPattern.test(id)) problems.push(`${at} has an invalid id.`);
    if (!object(state)) { problems.push(`${at} must be an object.`); continue; }
    const extras = { task: ['role', 'prompt', 'output', 'on', 'maxVisits'], decision: ['role', 'prompt', 'output', 'on', 'maxVisits'], fanout: ['branches', 'on', 'maxVisits'], final: ['outcome'] };
    const isKind = (kind: Untrusted): kind is keyof typeof extras => typeof kind === 'string' && Object.hasOwn(extras, kind);
    const validKind = isKind(state.kind);
    keys(state, ['kind', 'title', 'gate', ...(isKind(state.kind) ? extras[state.kind] : [])], at);
    if (Object.hasOwn(state, 'gate')) {
      if (state.kind !== 'task') problems.push(`${at} gate is only allowed on task states.`);
      else if (!text(state.gate)) problems.push(`${at} gate must be a non-empty shell command string.`);
      else problems.push(...gateProblems(state.gate, at));
    }
    if (!validKind) problems.push(`${at} has an unknown kind.`);
    if (!text(state.title)) problems.push(`${at} needs a title.`);
    if (state.maxVisits !== undefined && (!integer(state.maxVisits) || state.maxVisits < 1)) problems.push(`${at} maxVisits must be a positive integer.`);
    if (state.kind === 'final') {
      if (!oneOf(['success', 'failure'], state.outcome)) problems.push(`${at} needs a success or failure outcome.`);
      if (Object.hasOwn(state, 'on')) problems.push(`${at} is final and cannot have events.`);
      continue;
    }
    const events = object(state.on) ? Object.entries(state.on) : [];
    if (!object(state.on) || !events.length) problems.push(`${at} needs at least one event in on.`);
    for (const [event, transition] of events) {
      const where = `${at} event \`${event}\``;
      checkName(event, where);
      if (!idPattern.test(event)) problems.push(`${where} has an invalid name.`);
      if (!object(transition)) { problems.push(`${where} must be an object.`); continue; }
      keys(transition, ['to', 'description'], where);
      if (!hasState(transition.to)) problems.push(typeof transition.to === 'string' ? `${where} targets unknown state \`${transition.to}\`.` : `${where} must target a state id.`);
      if (transition.description !== undefined && typeof transition.description !== 'string') problems.push(`${where} description must be a string.`);
    }
    if (state.kind === 'decision' && events.length === 1) warnings.push(`${at} is a decision with only one event.`);
    if (oneOf(['task', 'decision'], state.kind)) {
      role(state.role, at);
      if (!text(state.prompt)) problems.push(`${at} needs a prompt.`);
      if (state.output !== undefined) fields(state.output, `${at} output`, false);
    }
    if (state.kind === 'fanout') {
      if (events.filter(([event]) => event !== 'failed').length !== 1) problems.push(`${at} is a fanout and needs exactly one event besides optional failed.`);
      if (!Array.isArray(state.branches) || state.branches.length < 2) problems.push(`${at} needs at least two branches.`);
      const seen = new Set();
      for (const branch of Array.isArray(state.branches) ? state.branches : []) {
        if (!object(branch)) { problems.push(`${at} branches must be objects.`); continue; }
        const where = `${at} branch \`${typeof branch.id === 'string' ? branch.id : '?'}\``;
        checkName(branch.id, where);
        keys(branch, ['id', 'role', 'prompt', 'gate'], where);
        if (Object.hasOwn(branch, 'gate')) problems.push(...text(branch.gate) ? gateProblems(branch.gate, where) : [`${where} gate must be a non-empty shell command string.`]);
        if (typeof branch.id !== 'string' || !idPattern.test(branch.id)) problems.push(`${where} has an invalid id.`);
        if (seen.has(branch.id)) problems.push(`${where} duplicates a branch id.`);
        seen.add(branch.id); role(branch.role, where);
        if (!text(branch.prompt)) problems.push(`${where} needs a prompt.`);
      }
    }
  }
  const reachable = new Set(), pending: string[] = hasState(machine.initial) ? [machine.initial] : [];
  while (pending.length) {
    const id = pending.pop(); if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    const state = states[id];
    if (object(state) && state.kind !== 'final' && object(state.on)) for (const t of Object.values(state.on)) if (object(t) && hasState(t.to)) pending.push(t.to);
  }
  for (const id of Object.keys(states)) if (!reachable.has(id)) problems.push(`State \`${id}\` is unreachable from the initial state.`);
  for (const { at, path } of unknownRefs(machine)) {
    const [state, branch] = at.split('.');
    const where = `State \`${state}\`${branch === undefined ? '' : ` branch \`${branch}\``}`;
    warnings.push(`${where} uses unknown placeholder \`{{${path}}}\`.`);
  }
  return { problems, warnings };
}
type Meta = { name: string; description: string; whenToUse?: string; phases: { title: string }[] };

const source = (value: Meta | Machine) => JSON.stringify(value, null, 2).replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, '$1$2:');
export function compile(machine: Machine): string {
  const meta = { name: machine.id, description: machine.description, ...(machine.whenToUse === undefined ? {} : { whenToUse: machine.whenToUse }), phases: Object.values(machine.states).filter(s => s.kind !== 'final').map(s => ({ title: s.title })) };
  return `export const meta = ${source(meta)}\n\n// machine: a state machine the runner below follows. Edit with topology studio or by hand; the\n// studio reads this literal back. Keep it a pure literal.\nconst machine = ${source(machine)}\n\n${runner}`;
}
// The machine literal as read from workflow code. It is not validated yet; validateMachine checks it.
export function extract(code: string): Machine | null {
  try {
    const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
    const declarations = ast.body.filter((n): n is VariableDeclaration => n.type === 'VariableDeclaration' && n.kind === 'const').flatMap(n => n.declarations).filter(n => n.id.type === 'Identifier' && n.id.name === 'machine');
    const found = declarations.length === 1 && declarations[0].init?.type === 'ObjectExpression' ? literal(declarations[0].init) : null;

    return extracted(found) ? found : null;
  } catch { return null; }
}
export function templateMachine(id: string): Machine {
  return { id, name: id, description: 'Describe what this workflow does.', initial: 'start', states: { start: { kind: 'task', title: 'Start', role: 'coder', prompt: 'Describe the task to complete.', on: { done: { to: 'done' } } }, done: { kind: 'final', title: 'Done', outcome: 'success' } } };
}
