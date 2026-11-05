import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { references, PLACEHOLDER, unknownRefs } from '../shared/refs.ts';
import { templateMachine, validateMachine } from '../shared/machine.ts';
const build = JSON.parse(await readFile(new URL('../fixtures/machines/build.json', import.meta.url), 'utf8'));
const paths = (m, at) => references(m, at).map(ref => ref.path);

test('QA references include inputs, other results and meta, never its own results', () => {
  const refs = references(build, 'qa'), available = refs.map(ref => ref.path);
  for (const path of ['inputs.slug', 'inputs.dir', 'inputs.checks', 'results.build.summary', 'results.build.event', 'results.review.a.text', 'results.review.b.text', 'results.agree.fixes', 'results.agree.dropped', 'results.fix.summary', 'visit', 'run.history']) assert.ok(available.includes(path), path);
  assert.ok(!available.some(path => path.startsWith('results.qa.')));
  assert.deepEqual(refs.find(ref => ref.path === 'inputs.dir'), { path: 'inputs.dir', kind: 'input', label: 'dir', description: 'Project directory' });
  assert.deepEqual(refs.find(ref => ref.path === 'results.build.summary'), { path: 'results.build.summary', kind: 'result', label: 'summary', from: 'build', description: 'Files changed and implementation summary' });
  assert.deepEqual(refs.find(ref => ref.path === 'visit'), { path: 'visit', kind: 'meta', label: 'visit' });
  assert.ok(!available.some(path => path.startsWith('results.shipped.') || path.startsWith('results.gave_up.')));
  assert.equal(new Set(available).size, available.length);
});
test('fanout branch references exclude all branches in its own state', () => {
  assert.deepEqual(paths(build, 'review.a'), paths(build, 'review.b'));
  assert.ok(!paths(build, 'review.a').some(path => path.startsWith('results.review.')));
  assert.ok(paths(build, 'review.a').includes('results.build.summary'));
  assert.ok(paths(build, 'qa').includes('results.report.text'));
  assert.ok(!paths(build, 'qa').includes('results.review.event'));
});
for (const output of /** @type {(Record<string, import('../shared/machine.ts').Field> | undefined)[]} */ ([undefined, {}, { summary: { type: 'string' } }])) test(`references expose text only for absent or empty output: ${JSON.stringify(output)}`, () => {
  const m = templateMachine('demo');
  if (output !== undefined) m.states.start.output = output;
  assert.equal(paths(m).includes('results.start.text'), !output || !Object.keys(output).length);
  assert.equal(paths(m).includes('results.start.summary'), !!output?.summary);
  assert.ok(paths(m).includes('results.start.event'));
});
test('unknown refs report state and branch locations and preserve warnings', () => {
  const m = structuredClone(build);
  m.states.qa.prompt = '{{inputs.nope}} {{ inputs.dir }} {{results.qa.report}} {{results.build.nope}}';
  m.states.review.branches[0].prompt = '{{results.review.b.text}} {{results.build.summary}} {{run.nope}}';
  assert.deepEqual(unknownRefs(m), [
    { at: 'review.a', path: 'results.review.b.text' },
    { at: 'review.a', path: 'run.nope' },
    { at: 'qa', path: 'inputs.nope' },
    { at: 'qa', path: 'results.qa.report' },
    { at: 'qa', path: 'results.build.nope' },
  ]);
  const { problems, warnings } = validateMachine(m);
  assert.deepEqual(problems, []);
  assert.equal(warnings.length, unknownRefs(m).length);
  assert.ok(warnings.includes('State `review` branch `a` uses unknown placeholder `{{results.review.b.text}}`.'));
  assert.ok(warnings.includes('State `qa` uses unknown placeholder `{{inputs.nope}}`.'));
});
test('every offered reference is known in state and branch prompts', () => {
  for (const at of ['build', 'review.a', 'qa']) {
    const m = structuredClone(build), prompt = paths(m, at).map(path => `{{${path}}}`).join('\n');
    if (at === 'review.a') m.states.review.branches[0].prompt = prompt;
    else m.states[at].prompt = prompt;
    assert.deepEqual(unknownRefs(m), []);
    assert.deepEqual(validateMachine(m).warnings, []);
  }
});
test('placeholders share the runner syntax including surrounding whitespace', () => {
  assert.deepEqual([...('{{ inputs.dir }} {{results.review.a.text}} {{visit}} {{bad-path}}').matchAll(PLACEHOLDER)].map(match => match[1]), ['inputs.dir', 'results.review.a.text', 'visit']);
});
test('references ignore inherited map entries and tolerate malformed validation input', () => {
  const m = templateMachine('demo');
  m.inputs = Object.assign(Object.create({ inherited: { type: 'string' } }), { real: { type: 'string' } });
  m.states = Object.assign(Object.create({ inherited: m.states.start }), m.states);
  m.states.start.prompt = '{{inputs.constructor}} {{results.toString.text}} {{inputs.inherited}}';
  assert.ok(!paths(m).some(path => path.includes('inherited')));
  assert.deepEqual(unknownRefs(m).map(ref => ref.path), ['inputs.constructor', 'results.toString.text', 'inputs.inherited']);
  m.inputs = Object.assign(Object.create(null), { real: { type: 'string' } });
  m.states = Object.assign(Object.create(null), m.states);
  assert.ok(paths(m).includes('inputs.real'));
  assert.ok(paths(m).includes('results.start.event'));
  for (const value of /** @type {any[]} malformed on purpose */ ([null, {}, { states: { bad: null } }, { states: { bad: { kind: 'fanout', branches: [null, { id: {}, prompt: '{{nope}}' }] } } }])) {
    assert.doesNotThrow(() => references(value, 'bad'));
    assert.doesNotThrow(() => unknownRefs(value));
  }
});
