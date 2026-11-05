import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { compile, templateMachine } from '../shared/machine.ts';
import { runner } from '../shared/runner.ts';
import { runWorkflow } from './fake-host.js';

// Only the committed fixture copy. scripts/check-runner-copies.js checks the editable playground and .pi copies.
test('every fixture workflow copy embeds the current runner verbatim', async () => {
  const dir = new URL('../fixtures/playground/.pi/workflows/', import.meta.url);
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.js')) continue;
    const code = await readFile(new URL(file, dir), 'utf8');
    assert.ok(code.endsWith(runner), `fixtures/playground/.pi/workflows/${file} has a stale runner`);
  }
});

test('output fields without descriptions cross the fake VM boundary', async () => {
  const m = templateMachine('boundary');
  m.states.start.output = { brief: { type: 'string', required: true } };
  const result = await runWorkflow(compile(m), { agent: async (_, { schema }) => {
    assert.deepEqual(schema.properties.brief, { type: 'string' });
    assert.equal(schema.properties.event.description, 'done: → done');
    return { event: 'done', brief: 'Ready' };
  } });
  assert.equal(result.outcome, 'success');
});

test('fake host rejects undefined options at every nesting level', async () => {
  for (const value of ['{ optional: undefined }', '{ nested: { optional: undefined } }', '{ nested: [undefined] }']) {
    const code = `export const meta = {name: 'boundary'}; return await agent('Task', ${value});`;
    await assert.rejects(runWorkflow(code, { agent: () => assert.fail('Invalid opts reached the host') }), /Cannot pass undefined across the workflow VM boundary/);
  }
});

test('fanout catches preserve branch exception messages in logs', async () => {
  const m = templateMachine('boundary'), logs = [];
  m.states.start = { kind: 'fanout', title: 'Review', branches: ['a', 'b'].map(id => ({ id, role: 'reviewer', prompt: id })), on: { done: { to: 'done' } } };
  const result = await runWorkflow(compile(m), { log: line => logs.push(line), agent: async () => { throw new Error('Connection refused'); } });
  assert.equal(result.reason, 'start: branch a failed');
  assert.deepEqual(logs, ['start:a failed: Connection refused', 'start:b failed: Connection refused']);
});

test('gate commands get the same placeholder filling as prompts, with each value shell-quoted (ADR-0001)', async () => {
  const m = templateMachine('gates');
  m.inputs = { slug: /** @type {import('../shared/machine.ts').Field} compile does not validate; the runner reads only description */ ({ description: 'Plan slug' }) };
  m.states.start.gate = 'test -f ai-artifacts/{{inputs.slug}}/plan.md';
  const gates = [];
  await runWorkflow(compile(m), { args: { slug: 'chip-run-values' }, agent: async (_, { gate }) => { gates.push(gate); return { event: 'done', text: 'ok' }; } });
  assert.deepEqual(gates, ["test -f ai-artifacts/'chip-run-values'/plan.md"]);
});
