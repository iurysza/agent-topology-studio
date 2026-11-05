import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compile, extract, templateMachine } from '../shared/machine.ts';
import { replay, readJournal } from '../shared/replay.ts';
import { runWorkflow } from './fake-host.js';
const entry = text => ({ index: 0, key: 'call-0', ok: true, text });

test('fake host rejects an answer missing a required output field', async () => {
  const m = templateMachine('demo');
  m.states.start.output = { brief: { type: 'string', required: true } };
  await assert.rejects(runWorkflow(compile(m), { agent: async () => ({ event: 'done' }) }), /Fake host: start answered/);
});

test('fake host rejects an event outside the schema enum', async () => {
  await assert.rejects(runWorkflow(compile(templateMachine('demo')), { agent: async () => ({ event: 'nope', text: 'report' }) }), /Fake host: start answered/);
});

test('an assertion in a callback fails the run even when the runner catches it', async () => {
  const m = templateMachine('demo');
  m.states.start = { kind: 'fanout', title: 'Review', branches: [{ id: 'a', role: 'reviewer', prompt: 'A' }, { id: 'b', role: 'reviewer', prompt: 'B' }], on: { failed: { to: 'done' }, done: { to: 'done' } } };
  await assert.rejects(runWorkflow(compile(m), { agent: async (_, { label }) => { if (label === 'start:a') assert.equal(1, 2); return 'Reviewed'; } }), assert.AssertionError);
});

test('malformed null turns an invalid answer into an agent failure', async () => {
  const result = await runWorkflow(compile(templateMachine('demo')), { agent: async () => ({ event: 'done' }), malformed: 'null' });
  assert.equal(result.outcome, 'failure'); assert.equal(result.reason, 'start: agent failed');
});

test('live and replay agree on valid and invalid answers', async () => {
  const valid = '{"event":"done","text":"report"}';
  const live = await runWorkflow(compile(templateMachine('demo')), { agent: async () => JSON.parse(valid) });
  assert.equal(live.outcome, 'success');
  assert.equal((await replay(templateMachine('demo'), [entry(valid)])).outcome, 'success');
  for (const text of ['null', '[]', '{"event":"done","text":3}', '{"event":"unknown","text":"report"}', '{"event":"done"}']) {
    const run = await runWorkflow(compile(templateMachine('demo')), { agent: async () => JSON.parse(text), malformed: 'null' });
    assert.equal(run.outcome, 'failure', text);
    assert.equal((await replay(templateMachine('demo'), [entry(text)])).outcome, 'failed', text);
  }
});

test('replayed council fixtures match the generator outcomes', async () => {
  // Copied from scripts/generate-run-fixtures.js, which writes files when imported.
  const expected = { approve: 'success', veto: 'failure', split: 'success', quorum: 'success' };
  const council = extract(await readFile(new URL('../fixtures/playground/.pi/workflows/council.js', import.meta.url), 'utf8'));
  for (const [name, outcome] of Object.entries(expected)) {
    const { entries } = readJournal(await readFile(new URL(`../fixtures/runs/council-${name}.workflow.jsonl`, import.meta.url), 'utf8'));
    assert.equal((await replay(council, entries)).outcome, outcome === 'success' ? 'success' : 'failed', name);
  }
});
