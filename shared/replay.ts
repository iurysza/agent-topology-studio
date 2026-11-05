import { runner } from './runner.ts';
import type { FieldType, Kind, Machine } from './types.ts';

/** A value JSON.parse can return. Journal lines are untrusted, so fields are narrowed before use. */
export type Json = string | number | boolean | null | Json[] | JsonObject;

export type JsonObject = { readonly [key: string]: Json };

/** The first `kind: 'run'` line of a journal. */
export type JournalHeader = JsonObject & { readonly kind: 'run'; readonly script: string };

/** One agent call, as readJournal checks it. Other fields, such as `at`, `durationMs` and `gate`, are not checked. */
export type JournalEntry = JsonObject & { readonly index: number; readonly key: string; readonly ok: boolean; readonly text?: string };

/** One replayed agent call or collected fanout. `text`, `at`, `durationMs` and `gate` are copied from the journal entry as they are. */
export type ReplayStep = {
  n: number; state: string; branch?: string; kind: Kind; role: string | null; prompt: string; template?: string; ok: boolean; result: Json;
  text?: string; at?: Json; durationMs?: Json; gate?: Json; event?: string; to?: string;
};

export type ReplayDetail = {
  id: string; workflow: string; path: string[]; startedAt: Json; updatedAt: Json; calls: number;
  status: 'partial' | 'complete'; outcome?: 'success' | 'failed'; signal?: 'success' | 'failed'; at?: string;
  reason?: string; steps: ReplayStep[]; visits: Record<string, number>;
};

/** What readJournal returns: the checked entries in index order and the first header line. */
export type Journal = { entries: JournalEntry[]; header: JournalHeader | null };

export type ReplayMatch = { detail: ReplayDetail; fits: boolean; mismatch?: string };

/** The output schema the runner passes to `agent` for a task or decision. */
type SchemaField = { type: FieldType; enum?: readonly Json[]; description?: string };

type Schema = { type: 'object'; properties: Record<string, SchemaField>; required: string[] };

type AgentOptions = { agentType?: string; label: string; phase?: string; schema?: Schema; gate?: string };

type Snapshot = { at: string; visits: Record<string, number> };

type LogTransition = { at: string; event: string; to: string; result: Json };

type RunResult = { outcome: string; reason: string | null; at: string; history: string[]; results: Record<string, Json>; visits?: Record<string, number> };

/** The runner's free variables, in the order `new AsyncFunction` names them. */
type Execute = (
  machine: Machine, args: Readonly<Record<string, string>>,
  agent: (prompt: string, options: AgentOptions) => Promise<Json | undefined>,
  parallel: <T>(thunks: (() => Promise<T>)[]) => Promise<T[]>,
  phase: (title: string, snapshot: Snapshot) => void,
  log: (message: string, transition?: LogTransition) => void,
) => Promise<RunResult>;

// SAFETY: the constructor of an async function is AsyncFunction. Called with these six names and the runner body, it builds an Execute.
const AsyncFunction = (async function () {}).constructor as new (...params: string[]) => Execute;
const execute = new AsyncFunction('machine', 'args', 'agent', 'parallel', 'phase', 'log', runner);
const object = <T>(value: T): value is T & JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);

const isHeader = (value: JsonObject): value is JournalHeader => value.kind === 'run' && typeof value.script === 'string';

const isEntry = (value: JsonObject): value is JournalEntry => !(typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0 || typeof value.key !== 'string' || typeof value.ok !== 'boolean' || (value.text !== undefined && typeof value.text !== 'string'));

// Pi appends in settlement order, but index records call order. A torn last line is normal.
export function readJournal(text: string): Journal {
  const entries: JournalEntry[] = [];
  let header: JournalHeader | null = null;
  for (const line of text.split('\n')) {
    let value: Json;
    try { value = JSON.parse(line); } catch { continue; }
    if (!object(value)) continue;
    if (isHeader(value)) { header ??= value; continue; }
    if (!isEntry(value)) continue;
    entries.push(value);
  }
  entries.sort((a, b) => a.index - b.index);
  return { entries, header };
}

function valid(value: Json, schema: Schema): boolean {
  if (!object(value)) return false;
  if (schema.required.some(key => !Object.hasOwn(value, key))) return false;
  return Object.entries(schema.properties).every(([key, field]) => {
    if (!Object.hasOwn(value, key)) return true;
    const item = value[key];
    const typeOK = field.type === 'object' ? object(item) : field.type === 'array' ? Array.isArray(item) : typeof item === field.type && (field.type !== 'number' || Number.isFinite(item));
    return typeOK && (!field.enum || field.enum.includes(item));
  });
}

// Execute only our fixed runner, never code from the journal or a workflow file.
export async function replay(machine: Machine, entries: readonly JournalEntry[]): Promise<ReplayDetail> {
  return (await replayMatch(machine, entries)).detail;
}

export async function replayMatch(machine: Machine, entries: readonly JournalEntry[]): Promise<ReplayMatch> {
  const ordered = [...entries].sort((a, b) => a.index - b.index);
  const byIndex = new Map(ordered.map(entry => [entry.index, entry]));
  const steps: ReplayStep[] = [], path = [machine.initial], stop = Symbol('journal ended');
  let visits: Record<string, number> = {}, state = machine.initial, n = 0, partial = false, mismatch: string | undefined;
  const reject = (reason: string) => { mismatch ??= reason; };
  let pending: ReplayStep[] = [], run: RunResult | undefined;
  const args = Object.fromEntries(Object.keys(machine.inputs ?? {}).map(key => [key, `{{inputs.${key}}}`]));
  // Actual inputs, including defaults, were not journaled. Preserve placeholders of every type.
  const model: Machine = { ...machine, inputs: Object.fromEntries(Object.keys(args).map(key => [key, { type: 'string' }])) };
  const agent = async (prompt: string, options: AgentOptions): Promise<Json | undefined> => {
    const index = n++, entry = byIndex.get(index);
    if (!entry) { partial = true; return null; }
    const s = machine.states[state], branch = s.kind === 'fanout' ? options.label.slice(state.length + 1) : undefined;
    if (entry.label !== undefined && entry.label !== options.label) reject(`${state}: label ${entry.label}, expected ${options.label}`);
    if (entry.agentType !== undefined && entry.agentType !== options.agentType) reject(`${state}: agentType ${entry.agentType}, expected ${options.agentType}`);
    const answer = entry.ok && typeof entry.text === 'string' ? entry.text : undefined;
    let result: Json = null, ok = answer !== undefined;
    if (answer !== undefined && options.schema) {
      try { result = JSON.parse(answer); } catch { ok = false; }
      // The runner built options.schema from s.on, so s.on is set here and `?? {}` never applies.
      if (object(result) && typeof result.event === 'string' && !Object.hasOwn(s.on ?? {}, result.event)) reject(`${state}: unknown event ${result.event}`);
      if (ok && !valid(result, options.schema)) ok = false;
    } else if (answer !== undefined) result = { text: answer };
    if (entry.ok && options.schema && !ok) reject(`${state}: result does not match output schema`);
    if (!ok) result = null;
    if (object(entry.gate) && entry.gate.ok === false) { ok = false; result = null; }

    const found = branch === undefined ? undefined : s.branches?.find(b => b.id === branch);
    // The runner builds a branch label from s.branches, so `found` is set. The JS read `.prompt` of the missing branch here.
    if (branch !== undefined && found === undefined) throw new TypeError("Cannot read properties of undefined (reading 'prompt')");
    const template = found === undefined ? s.prompt : found.prompt;
    const step: ReplayStep = { n: steps.length + 1, state, ...(branch === undefined ? {} : { branch }), kind: s.kind, role: options.agentType ?? null, prompt, template, ok, result };
    if (entry.text !== undefined) step.text = entry.text;
    if (entry.at !== undefined) step.at = entry.at;
    if (entry.durationMs !== undefined) step.durationMs = entry.durationMs;
    if (entry.gate !== undefined) step.gate = entry.gate;
    steps.push(step); pending.push(step);
    return ok ? options.schema ? result : entry.text : null;
  };
  const phase = (_: string, snapshot: Snapshot) => {
    state = snapshot.at; visits = snapshot.visits; pending = [];
    if (!byIndex.has(n) && !ordered.some(entry => entry.index > n)) { partial = true; throw stop; }
  };
  const log = (_: string, transition?: LogTransition) => {
    if (!transition) return;
    if (machine.states[state].kind === 'fanout') {
      const step: ReplayStep = { n: steps.length + 1, state, kind: 'fanout', role: null, prompt: '', template: '', ok: true, result: transition.result };
      steps.push(step); pending = [step];
    }
    const last = pending.at(-1);

    // The JS called Object.assign(undefined, ...) here, which throws this error. Callers treat it as a machine that cannot be replayed.
    if (last === undefined) throw new TypeError('Cannot convert undefined or null to object');
    Object.assign(last, { event: transition.event, to: transition.to });
    path.push(transition.to);
  };
  const parallel = async <T>(thunks: (() => Promise<T>)[]): Promise<T[]> => {
    const values = await Promise.all(thunks.map(thunk => thunk()));
    if (partial) throw stop;
    return values;
  };
  try { run = await execute(model, args, agent, parallel, phase, log); }
  catch (error) { if (error !== stop) throw error; }
  // `stop` is thrown only after `partial` is set, so a run that is not partial has a result.
  const complete = partial ? undefined : run;
  if (complete && machine.states[state].kind === 'fanout' && !pending.some(step => !step.branch)) {
    steps.push({ n: steps.length + 1, state, kind: 'fanout', role: null, prompt: '', template: '', ok: false, result: complete.results[state] ?? null });
  }
  if (run?.reason?.includes(': unknown event ')) reject(run.reason);
  if (ordered.some(entry => entry.index >= n)) reject(`${state}: journal has calls after the workflow stopped`);
  const detail: ReplayDetail = {
    id: '', workflow: machine.id, path, startedAt: ordered.find(entry => entry.at)?.at ?? null,
    updatedAt: ordered.findLast(entry => entry.at)?.at ?? '', calls: ordered.length,
    status: partial ? 'partial' : 'complete',
    ...(complete ? { outcome: complete.outcome === 'success' ? 'success' : 'failed', signal: complete.outcome === 'success' ? 'success' : 'failed', at: complete.at } : {}),
    ...(run?.reason ? { reason: run.reason } : {}), steps, visits: run?.visits ?? visits,
  };
  return { detail, fits: mismatch === undefined, ...(mismatch === undefined ? {} : { mismatch }) };
}
