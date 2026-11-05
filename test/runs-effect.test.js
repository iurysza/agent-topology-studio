import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { mkdtemp, cp, rm, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Effect from 'effect/Effect';
import { ProjectFs } from '../server/services.ts';
import { RunIdError, projectRuns, runsProgram } from '../server/runs.ts';
import { runEdge } from '../server/edge.ts';

const real = { readFile: fsp.readFile, readdir: fsp.readdir, stat: fsp.stat, mkdir: fsp.mkdir, open: fsp.open, rename: fsp.rename, rm: fsp.rm };
/** @param {string} code */
const fsError = code => Object.assign(new Error(`${code}: fake`), { code });
/** @param {string} target */
const isJournal = target => String(target).endsWith('.workflow.jsonl');

/**
 * @template A, E
 * @param {Effect.Effect<A, E, ProjectFs>} effect
 * @param {Record<string, (target: unknown, ...rest: any[]) => Promise<unknown>>} overrides
 */
const withFs = (effect, overrides) => Effect.gen(function* () {
  const fs = yield* ProjectFs;
  // SAFETY: each fake forwards to the real method with the same arguments, so it keeps the overloads it replaces.
  return yield* effect.pipe(Effect.provideService(ProjectFs, /** @type {typeof fs} */ ({ ...fs, ...overrides })));
});

async function setup(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-runs-effect-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../fixtures/playground/', import.meta.url), dir, { recursive: true });
  const workflows = path.join(dir, '.pi/workflows');
  for (const name of await readdir(new URL('../fixtures/runs/', import.meta.url))) await cp(new URL(`../fixtures/runs/${name}`, import.meta.url), path.join(workflows, name));
  // Containment is covered by the project tests; here the guard only passes paths through.
  return runsProgram(workflows, target => target);
}

test('the facade rejects unsafe ids with RunIdError before any IO', async () => {
  const runs = projectRuns('/does/not/exist', () => { throw new Error('no IO expected'); });
  await assert.rejects(runs.readRun('../x'), error => error instanceof RunIdError && error.message === 'Invalid run id');
  await assert.rejects(runs.listRuns('../x'), error => error instanceof RunIdError && error.message === 'Invalid workflow id');
});

test('a journal that vanishes before stat is skipped and the others still list', async t => {
  const program = await setup(t);
  const stat = async (target, ...rest) => {
    if (String(target).endsWith('council-veto.workflow.jsonl')) throw fsError('ENOENT');
    return real.stat(target, ...rest);
  };
  const runs = await runEdge(withFs(program.listRuns(), { stat }));
  assert.equal(runs.length, 4);
  assert.ok(!runs.some(run => run.id === 'council-veto'));
});

test('an unreadable journal rejects with the raw EACCES error', async t => {
  const program = await setup(t), cause = fsError('EACCES');
  const readFile = async (target, ...rest) => {
    if (isJournal(target)) throw cause;
    return real.readFile(target, ...rest);
  };
  await assert.rejects(runEdge(withFs(program.listRuns(), { readFile })), rejected => rejected === cause);
});

test('a second listing reads no journal again while signatures are unchanged', async t => {
  const program = await setup(t);
  let reads = 0;
  const readFile = async (target, ...rest) => {
    if (isJournal(target)) reads++;
    return real.readFile(target, ...rest);
  };
  const first = await runEdge(withFs(program.listRuns(), { readFile }));
  assert.equal(reads, 5);
  const second = await runEdge(withFs(program.listRuns(), { readFile }));
  assert.equal(reads, 5);
  assert.deepEqual(second, first);
});
