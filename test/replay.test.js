import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extract, templateMachine } from '../shared/machine.ts';
import { replay, replayMatch, readJournal } from '../shared/replay.ts';
const council = extract(await readFile(new URL('../fixtures/playground/.pi/workflows/council.js', import.meta.url), 'utf8'));
const journal = async name => readJournal(await readFile(new URL(`../fixtures/runs/council-${name}.workflow.jsonl`, import.meta.url), 'utf8')).entries;
const entry = (index, value, extra = {}) => ({ index, key: `call-${index}`, ok: value !== null, ...(value !== null ? { text: typeof value === 'string' ? value : JSON.stringify(value) } : {}), ...extra });
for (const name of ['approve', 'veto', 'split', 'quorum']) test(`replay council ${name} preserves path, visits and outcome`, async () => {
  const run = await replay(council, await journal(name));
  const split = name === 'split', end = name === 'veto' ? 'blocked' : 'approved';
  assert.deepEqual(run.path, split ? ['frame', 'vote', 'tally', 'deliberate', 'tally', end] : ['frame', 'vote', 'tally', end]);
  assert.deepEqual({ ...run.visits }, split ? { frame: 1, vote: 1, tally: 2, deliberate: 1 } : { frame: 1, vote: 1, tally: 1 });
  assert.equal(run.outcome, name === 'veto' ? 'failed' : 'success');
  assert.equal(run.status, 'complete'); assert.equal(run.calls, split ? 9 : 5);
  assert.equal(run.steps.length, split ? 11 : 6);
  assert.deepEqual(run.steps.map(step => step.n), run.steps.map((_, index) => index + 1));
  const branches = run.steps.filter(step => step.branch);
  assert.deepEqual(branches.slice(0, 3).map(step => step.branch), ['skeptic', 'auditor', 'pragmatist']);
  assert.ok(branches.every(step => !step.event && !step.to));
  const collected = run.steps.find(step => step.kind === 'fanout' && !step.branch);
  assert.equal(collected.event, name === 'quorum' ? 'failed' : 'voted');
  assert.equal(collected.to, 'tally'); assert.equal(collected.ok, true);
  if (name === 'quorum') { assert.equal(/** @type {import('../shared/replay.ts').JsonObject} */ (collected.result).auditor, null); assert.equal(branches[1].ok, false); }
  assert.match(run.steps[0].prompt, /\{\{inputs.question\}\}/);
  assert.match(run.steps.at(-1).prompt, /\{\{inputs.slug\}\}/);
  assert.ok(!Object.hasOwn(run, 'reason'));
});

test('replay preserves prompt templates alongside filled prompts', async () => {
  const run = await replay(council, await journal('approve'));
  const frame = run.steps.find(step => step.state === 'frame');
  assert.equal(frame.template, council.states.frame.prompt);
  for (const vote of run.steps.filter(step => step.state === 'vote' && step.branch)) {
    assert.equal(vote.template, council.states.vote.branches.find(branch => branch.id === vote.branch).prompt);
    assert.match(vote.template, /\{\{results.frame.brief\}\}/);
    assert.ok(vote.prompt.includes(/** @type {string} */ (/** @type {import('../shared/replay.ts').JsonObject} */ (frame.result).brief)));
    assert.doesNotMatch(vote.prompt, /\{\{results.frame.brief\}\}/);
  }
  assert.equal(run.steps.find(step => step.state === 'tally').template, council.states.tally.prompt);
  assert.equal(run.steps.find(step => step.state === 'vote' && !step.branch).template, '');
});

test('partial journals stop before a fanout resolves, including out-of-order settlement', async () => {
  const entries = await journal('partial');
  const run = await replay(council, entries.reverse());
  assert.equal(run.status, 'partial'); assert.equal(run.outcome, undefined);
  assert.deepEqual(run.path, ['frame', 'vote']); assert.deepEqual(run.visits, { frame: 1, vote: 1 });
  assert.equal(run.steps.length, 3); assert.ok(!run.steps.some(step => step.state === 'vote' && !step.branch));
  const empty = await replay(council, []);
  assert.equal(empty.status, 'partial'); assert.deepEqual(empty.steps, []);
  const gap = await replay(council, [(await journal('approve'))[0], (await journal('approve'))[2]]);
  assert.equal(gap.status, 'partial'); assert.equal(gap.steps.at(-1).branch, 'auditor');
});

for (const variant of ['old-format', 'torn final line', 'shuffled']) test(`readJournal replays ${variant} council journals`, async () => {
  const machine = JSON.parse(await readFile(new URL('../fixtures/machines/council.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../fixtures/runs/council-split.workflow.jsonl', import.meta.url), 'utf8');
  const entries = source.trim().split('\n').map(line => {
    const { index, key, ok, text } = JSON.parse(line);
    return { index, key, ok, text };
  });
  const ordered = variant === 'shuffled' ? [...entries].reverse() : entries;
  let text = ordered.map(value => JSON.stringify(value)).join('\n') + '\n';
  if (variant === 'torn final line') text += `{"index":${entries.length},"key":"unfinished","ok":true,"text":`;
  /** @type {import('../shared/replay.ts').Journal} */
  let parsed;
  assert.doesNotThrow(() => { parsed = readJournal(text); });
  assert.equal(parsed.header, null);
  assert.deepEqual(parsed.entries, entries);
  assert.deepEqual(parsed.entries.map(value => value.index), entries.map((_, index) => index));
  const run = await replay(machine, parsed.entries);
  assert.equal(run.status, 'complete'); assert.equal(run.outcome, 'success');
  assert.equal(run.calls, 9); assert.equal(run.steps.length, 11);
  assert.deepEqual(run.path, ['frame', 'vote', 'tally', 'deliberate', 'tally', 'approved']);
  assert.deepEqual({ ...run.visits }, { frame: 1, vote: 1, tally: 2, deliberate: 1 });
  assert.deepEqual(run.steps.filter(step => step.text !== undefined).map(step => step.text), entries.map(value => value.text));
});

test('schema failures become null host answers and fail closed', async () => {
  for (const text of ['not JSON', 'null', '[]', '{"event":"done","text":3}', '{"event":"unknown","text":"report"}', '{"event":"done"}']) {
    const run = await replay(templateMachine('demo'), [entry(0, text)]);
    assert.equal(run.status, 'complete'); assert.equal(run.outcome, 'failed');
    assert.equal(run.steps[0].ok, false); assert.equal(run.steps[0].result, null);
    assert.match(run.reason, /agent failed/); assert.equal(run.steps[0].event, undefined);
    assert.equal((await replayMatch(templateMachine('demo'), [entry(0, text)])).fits, false);
  }
});

test('failed agents preserve preceding steps and still fit the workflow', async () => {
  const entries = (await journal('approve')).slice(0, 4);
  entries.push(entry(4, null, { text: '', label: 'tally', agentType: council.states.tally.role }));
  const { detail: run, fits, mismatch } = await replayMatch(council, entries);
  assert.equal(fits, true); assert.equal(mismatch, undefined);
  assert.equal(run.status, 'complete'); assert.equal(run.signal, 'failed'); assert.equal(run.outcome, 'failed');
  assert.equal(run.at, 'tally'); assert.equal(run.reason, 'tally: agent failed');
  assert.equal(run.steps.length, 6); assert.equal(run.steps.at(-1).ok, false);
  assert.equal(run.steps[0].event, 'framed'); assert.equal(run.steps[4].event, 'voted');
});

test('matching reports the first label, agentType, event or schema mismatch', async () => {
  const machine = templateMachine('demo');
  for (const [extra, value, reason] of [
    [{ label: 'other', agentType: 'other' }, { event: 'unknown' }, 'start: label other, expected start'],
    [{ agentType: 'other' }, { event: 'unknown' }, 'start: agentType other, expected coder'],
    [{}, { event: 'unknown', text: 'report' }, 'start: unknown event unknown'],
    [{}, 'not JSON', 'start: result does not match output schema'],
  ]) {
    const result = await replayMatch(machine, [entry(0, value, extra)]);
    assert.equal(result.fits, false); assert.equal(result.mismatch, reason);
  }
});

test('output types and optional metadata survive replay', async () => {
  const m = templateMachine('demo');
  m.inputs = { count: { type: 'number', default: 2 }, enabled: { type: 'boolean', required: true } };
  m.states.start.prompt = '{{inputs.count}} {{inputs.enabled}}';
  m.states.start.output = { report: { type: 'object', required: true }, scores: { type: 'array' }, valid: { type: 'boolean' } };
  const value = { event: 'done', report: {}, scores: [1], valid: true };
  const run = await replay(m, [entry(0, value, { at: '2026-01-01T00:00:00Z', durationMs: 10, gate: { ok: true, output: 'passed' } })]);
  assert.equal(run.outcome, 'success'); assert.equal(run.steps[0].prompt, '{{inputs.count}} {{inputs.enabled}}');
  assert.deepEqual(run.steps[0].result, value); assert.equal(run.steps[0].durationMs, 10);
  assert.equal(run.steps[0].at, run.startedAt); assert.deepEqual(run.steps[0].gate, { ok: true, output: 'passed' });
});

test('visit caps come from the runner, rather than journal length', async () => {
  const m = templateMachine('loop'); m.states.start.on.done.to = 'start'; m.states.start.maxVisits = 2;
  const run = await replay(m, [entry(0, { event: 'done', text: 'Again' }), entry(1, { event: 'done', text: 'Again' })]);
  assert.equal(run.status, 'complete'); assert.equal(run.outcome, 'failed');
  assert.match(run.reason, /start ran 2 times/); assert.equal(run.visits.start, 3);
  assert.deepEqual(run.path, ['start', 'start', 'start']);
});

test('failed fanouts without a failure transition have an unresolved synthetic step', async () => {
  const m = templateMachine('fanout');
  m.states.start = { kind: 'fanout', title: 'Review', branches: ['a', 'b'].map(id => ({ id, role: 'reviewer', prompt: id })), on: { done: { to: 'done' } } };
  const run = await replay(m, [entry(0, null), entry(1, 'Review B')]);
  assert.equal(run.outcome, 'failed'); assert.equal(run.steps.length, 3);
  assert.equal(run.steps[2].ok, false); assert.equal(run.steps[2].event, undefined); assert.equal(run.steps[2].template, '');
  assert.deepEqual(run.steps[2].result, { a: null, b: { text: 'Review B' } });
});

test('council answers fit council, not build or plan', async () => {
  for (const name of ['approve', 'veto', 'split', 'quorum', 'partial']) {
    const entries = await journal(name);
    assert.equal((await replayMatch(council, entries)).fits, true);
    for (const id of ['build', 'plan']) {
      const machine = extract(await readFile(new URL(`../fixtures/playground/.pi/workflows/${id}.js`, import.meta.url), 'utf8'));
      assert.equal((await replayMatch(machine, entries)).fits, false);
    }
  }
});
