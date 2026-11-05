import * as Effect from 'effect/Effect';
import path from 'node:path';
import { extract } from '../shared/machine.ts';
import type { Machine } from '../shared/machine.ts';
import { readJournal, replayMatch } from '../shared/replay.ts';
import type { JournalEntry, ReplayDetail } from '../shared/replay.ts';
import type { LiteralValue } from '../shared/literal.ts';
import { isSafeName, hashText, extractMeta } from './check.ts';
import { RunIdError } from './errors.ts';
import { ProjectFs } from './services.ts';
import { attempt, guarded, isMissing } from './project-fs.ts';
import { runEdge } from './edge.ts';

export { RunIdError } from './errors.ts';
const suffix = '.workflow.jsonl';

type Guard = (target: string) => string;

/** A sessions folder requires its guard; a guard without a folder is ignored. */
type SessionOptions = { readonly sessions?: undefined; readonly sessionContained?: Guard } | { readonly sessions: string; readonly sessionContained: Guard };

type JournalRecord = { id: string; target: string; guard: Guard; source: string; session?: string };

type Model = { id: string; machine: Machine; hash: string };

type Script = { id: LiteralValue; machine: Machine | null; hash: string };

type ScriptedScript = Script & { machine: Machine };

type RunFields = {
  id: string; source: string; session?: string; workflow: string | null; fits?: boolean; mismatch?: string; candidates?: (string | null)[];
  startedAt: string | null; updatedAt: string; calls: number; status: ReplayDetail['status'];
  outcome?: ReplayDetail['outcome']; signal?: ReplayDetail['signal']; at?: string; reason?: string;
  title?: string; current?: { state: string; visit: number };
};

type RunSummary = RunFields & { path: string };

type RunDetail = RunFields & { steps: ReplayDetail['steps']; visits: ReplayDetail['visits']; path: string[] };

type RunRecord = { summary: RunSummary; detail: RunDetail };

/** A journal entry that records its start time. */
const hasAt = (entry: JournalEntry): entry is JournalEntry & { readonly at: string } => typeof entry.at === 'string';

/** A sibling script whose machine has its initial state. */
const isScripted = (script: Script | null): script is ScriptedScript => Boolean(script?.machine?.states?.[script.machine.initial]);

/** null when the file does not exist. */
const orNullWhenMissing = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | null, E, R> => Effect.catchIf(effect, isMissing, () => Effect.succeed(null));

/** The run scanner as Effects. Every IO call goes through ProjectFs; the caches live in this closure. */
export function runsProgram(workflows: string, contained: Guard, { sessions, sessionContained }: SessionOptions = {}) {
  const cache = new Map<string, { signature: string; value: RunRecord }>(), scripts = new Map<string, { signature: string; value: Script }>();
  const names = (dir: string = workflows, guard: Guard = contained) => Effect.gen(function* () {
    const fs = yield* ProjectFs;
    const entries = yield* orNullWhenMissing(Effect.gen(function* () {
      const target = yield* guarded(guard, dir);
      return yield* attempt('readdir', target, () => fs.readdir(target, { withFileTypes: true }));
    }));
    return entries ?? [];
  });
  const journals = () => Effect.gen(function* () {
    const runs = new Map<string, JournalRecord>();
    const add = (dir: string, guard: Guard, source: string, session?: string) => Effect.gen(function* () {
      for (const entry of yield* names(dir, guard)) {
        const id = entry.name.slice(0, -suffix.length);
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!entry.name.endsWith(suffix) || !isSafeName(id) || runs.has(id)) continue;
        runs.set(id, { id, target: yield* guarded(guard, path.join(dir, entry.name)), guard, source, ...(session ? { session } : {}) });
      }
    });
    yield* add(workflows, contained, 'project');
    if (sessions) for (const entry of (yield* names(sessions, sessionContained)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !isSafeName(entry.name)) continue;
      yield* add(path.join(sessions, entry.name, 'tasks'), sessionContained, 'session', entry.name);
    }
    return runs;
  });
  const sibling = (target: string, guard: Guard) => Effect.gen(function* () {
    const fs = yield* ProjectFs;
    const script = target.slice(0, -suffix.length) + '.workflow.js';
    const info = yield* orNullWhenMissing(Effect.gen(function* () {
      const checked = yield* guarded(guard, script);
      return yield* attempt('stat', checked, () => fs.stat(checked));
    }));
    if (info === null) return null;
    const signature = `${info.mtimeMs}:${info.size}`;
    const known = scripts.get(script);
    if (known?.signature === signature) return known.value;
    const checked = yield* guarded(guard, script);
    const code = yield* attempt('read', checked, () => fs.readFile(checked, 'utf8')), machine = extract(code), meta = extractMeta(code);
    const value: Script = { id: meta?.name ?? machine?.id, machine, hash: hashText(code) };
    scripts.set(script, { signature, value });
    return value;
  });
  const machines = () => Effect.gen(function* () {
    const fs = yield* ProjectFs;
    const result: Model[] = [];
    for (const name of (yield* names()).map(entry => entry.name).sort()) {
      if (!name.endsWith('.js') || !isSafeName(name.slice(0, -3))) continue;
      const target = yield* guarded(contained, path.join(workflows, name));
      const code = yield* attempt('read', target, () => fs.readFile(target, 'utf8'));
      const machine = extract(code);
      if (machine?.states && machine.states[machine.initial]) result.push({ id: name.slice(0, -3), machine, hash: hashText(code) });
    }
    return result;
  });
  const read = (record: JournalRecord, models: Model[]) => Effect.gen(function* () {
    const fs = yield* ProjectFs;
    const { id, target, guard, source, session } = record;
    const info = yield* orNullWhenMissing(attempt('stat', target, () => fs.stat(target)));
    if (info === null) return null;
    const script = source === 'session' ? yield* sibling(target, guard) : null;
    const signature = JSON.stringify([info.mtimeMs, info.size, script?.hash, models.map(model => [model.id, model.hash])]);
    const cached = cache.get(target);
    if (cached?.signature === signature) return cached.value;
    const journal = yield* guarded(guard, target);
    const { entries, header } = readJournal(yield* attempt('read', journal, () => fs.readFile(journal, 'utf8')));
    const recorded = [header?.workflow, ...entries.map(entry => entry.workflow)].find(isSafeName);
    const workflow = source === 'session' ? recorded ?? (isSafeName(script?.id) ? script.id : null) : null;
    const scripted = isScripted(script);
    // Only journals without a sibling script fall back to a same-named project model.
    const sessionModel = scripted ? { ...script, id: workflow } : script ? null : models.find(model => model.id === workflow);
    const matches: { id: string | null; detail: ReplayDetail; name: string }[] = [];
    let mismatch: string | undefined = script && !scripted ? 'script has no machine' : undefined;
    for (const model of source === 'session' ? sessionModel ? [sessionModel] : [] : models) {
      // A malformed machine literal must not prevent reading unrelated journals.
      const replayed = yield* Effect.promise(() => replayMatch(model.machine, entries).catch(() => null));
      if (replayed === null) mismatch ??= 'Workflow machine cannot be replayed';
      else if (replayed.fits) matches.push({ id: model.id, detail: replayed.detail, name: model.machine.name });
      else mismatch ??= replayed.mismatch;
    }
    const preferred = header && path.basename(header.script).replace(/\.js$/, '');
    const match = matches.length === 1 ? matches[0] : matches.find(model => model.id === preferred);
    const base = {
      id, source, ...(session ? { session } : {}), workflow: source === 'session' ? workflow : match?.id ?? null,
      ...(script ? { fits: Boolean(match), ...(!match ? { mismatch: mismatch ?? 'Workflow machine cannot be replayed' } : {}) } : {}),
      ...(!match && source === 'project' ? { candidates: matches.map(model => model.id) } : {}),
      path: path.relative(path.dirname(path.dirname(workflows)), target).split(path.sep).join('/'),
      startedAt: entries.find(hasAt)?.at ?? (info.birthtimeMs > 0 ? info.birthtime.toISOString() : null),
      updatedAt: info.mtime.toISOString(), calls: entries.length,
      status: match?.detail.status ?? 'partial',
      ...(match?.detail.outcome ? { outcome: match.detail.outcome, signal: match.detail.signal, at: match.detail.at } : {}),
      ...(match?.detail.reason ? { reason: match.detail.reason } : {}),
    };
    // H7: new keys go after every existing key, in both payloads, so `extra` is spread last.
    const last = match?.detail.path.at(-1);
    const extra = {
      ...(typeof match?.name === 'string' && match.name ? { title: match.name } : {}),
      ...(match?.detail.status === 'partial' && last !== undefined ? { current: { state: last, visit: match.detail.visits?.[last] ?? 1 } } : {}),
    };
    const summary = { ...base, ...extra };
    const detail = { ...base, steps: match?.detail.steps ?? [], visits: match?.detail.visits ?? {}, path: match?.detail.path ?? [], ...extra };
    const value: RunRecord = { summary, detail };
    cache.set(target, { signature, value });
    return value;
  });
  return {
    listRuns: (workflow?: string) => Effect.gen(function* () {
      if (workflow !== undefined && !isSafeName(workflow)) return yield* Effect.fail(new RunIdError({ message: 'Invalid workflow id' }));
      const models = yield* machines(), runs: RunSummary[] = [];
      for (const journal of (yield* journals()).values()) {
        const record = yield* read(journal, models);
        if (record && (workflow === undefined || record.summary.workflow === workflow)) runs.push(record.summary);
      }
      return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    }),
    readRun: (id: string) => Effect.gen(function* () {
      if (!isSafeName(id)) return yield* Effect.fail(new RunIdError({ message: 'Invalid run id' }));
      yield* guarded(contained, path.join(yield* guarded(contained, workflows), id + suffix));
      const record = (yield* journals()).get(id);
      return record ? (yield* read(record, yield* machines()))?.detail ?? null : null;
    }),
  };
}

/** The async facade spread into openProject. Methods are async so no sync throw can escape. */
export function projectRuns(workflows: string, contained: Guard, options: SessionOptions = {}) {
  const program = runsProgram(workflows, contained, options);
  return {
    listRuns: async (workflow?: string) => runEdge(program.listRuns(workflow)),
    readRun: async (id: string) => runEdge(program.readRun(id)),
  };
}
