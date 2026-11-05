import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateMachine, validateMachine } from '../shared/machine.ts';
import { slug, addAfter, eventNameFor, connect, retitle, removeState, renameState, addState, setKind, clean, setField, setInput, removeInput, setOutput, removeOutput, setEvent, removeEvent } from '../shared/ops.ts';
const minimal = () => templateMachine('demo');
/** @returns {import('../shared/types.ts').State} */
const fanout = () => ({ kind: 'fanout', title: 'Review', branches: [{ id: 'a', role: 'reviewer', prompt: 'Review A' }, { id: 'b', role: 'reviewer', prompt: 'Review B' }], on: { done: { to: 'done', description: 'Reviewed' } } });

test('slug and event names use stable lowercase identifiers and avoid collisions', () => {
  assert.equal(slug('  QA pass! '), 'qa_pass'); assert.equal(slug('123'), 'next');
  const m = minimal();
  assert.equal(eventNameFor(m, 'start', 'done'), 'done_2');
  m.states.start.on.done_2 = { to: 'done' };
  assert.equal(eventNameFor(m, 'start', 'Done!'), 'done_3');
  assert.equal(eventNameFor(m, 'missing', 'QA pass'), 'qa_pass');
});
test('addAfter adds a task without removing existing events and uses free ids', () => {
  const original = minimal(), before = structuredClone(original);
  const first = addAfter(original, 'start', 'lead');
  assert.equal(first.id, 'step'); assert.equal(first.event, 'done_2');
  assert.deepEqual(first.m.states.start.on, { done: { to: 'done' }, done_2: { to: 'step' } });
  assert.deepEqual(first.m.states.step, { kind: 'task', title: 'New step', role: 'lead', prompt: 'What the agent does.', on: {} });
  const second = addAfter(first.m, 'start');
  assert.equal(second.id, 'step_2'); assert.equal(second.event, 'done_3');
  assert.deepEqual(original, before);
});
test('addAfter fanout re-points its event and preserves its description', () => {
  const m = minimal(); m.states.start = fanout();
  const result = addAfter(m, 'start');
  assert.equal(result.event, 'done');
  assert.deepEqual(result.m.states.start.on, { done: { to: result.id, description: 'Reviewed' } });
  assert.equal(m.states.start.on.done.to, 'done');
});
test('connect replaces fanout events, adds task events and leaves finals alone', () => {
  const m = minimal(), c = connect(m, 'start', 'start', 'Try Again!');
  assert.deepEqual(c.states.start.on, { done: { to: 'done' }, try_again: { to: 'start' } });
  assert.deepEqual(m.states.start.on, { done: { to: 'done' } });
  assert.equal(connect(m, 'missing', 'done', 'next'), m);
  assert.equal(connect(m, 'done', 'start', 'next'), m);
  m.states.start = fanout();
  assert.deepEqual(connect(m, 'start', 'done', 'Reviewed').states.start.on, { reviewed: { to: 'done' } });
});
test('retitle and addState leave their inputs unchanged', () => {
  const m = minimal(), titled = retitle(m, 'start', 'New title');
  assert.equal(titled.states.start.title, 'New title'); assert.equal(m.states.start.title, 'Start');
  assert.deepEqual(retitle(m, 'missing', 'Title'), m);
  const first = addState(m, 'qa'), second = addState(first.m);
  assert.equal(first.id, 'state'); assert.equal(second.id, 'state_2');
  assert.deepEqual(first.m.states.state, { kind: 'task', title: 'New state', role: 'qa', prompt: 'What the agent does.', on: {} });
  assert.ok(!Object.hasOwn(m.states, 'state'));
});
test('removeState removes all incoming events, reports them and chooses a new initial', () => {
  const m = minimal(); m.states.start.on.retry = { to: 'start' };
  m.states.other = { ...m.states.start, on: { again: { to: 'start' }, done: { to: 'done' } } };
  const result = removeState(m, 'start');
  assert.equal(result.m.initial, 'done'); assert.ok(!Object.hasOwn(result.m.states, 'start'));
  assert.deepEqual(result.m.states.other.on, { done: { to: 'done' } });
  assert.deepEqual(result.removed, ['Removed event `again` from `other`: it led to `start`']);
  assert.ok(Object.hasOwn(m.states, 'start'));
  assert.equal(removeState({ ...m, states: { start: m.states.start } }, 'start').m.initial, '');
});
test('renameState preserves state order and redirects initial, self-loops and incoming events', () => {
  const m = minimal(); m.states.start.on.retry = { to: 'start' };
  const renamed = renameState(m, 'start', 'build');
  assert.deepEqual(Object.keys(renamed.states), ['build', 'done']); assert.equal(renamed.initial, 'build');
  assert.equal(renamed.states.build.on.retry.to, 'build');
  assert.equal(m.initial, 'start'); assert.equal(m.states.start.on.retry.to, 'start');
  for (const name of ['', 'start', 'done', 'Bad', 'bad-name']) assert.equal(renameState(m, 'start', name), m);
  assert.equal(renameState(m, 'missing', 'new'), m);
});
test('renameState rewrites downstream task and fanout result references without warnings', () => {
  const m = minimal(); m.states.start.on.done.to = 'review';
  m.states.review = fanout(); m.states.review.on.done.to = 'report';
  m.states.review.branches[0].prompt = '{{results.start.text}}';
  m.states.review.branches[1].prompt = '{{ results.start.event }}';
  m.states.report = { ...minimal().states.start, prompt: '{{results.start.text}} {{results.review.a.text}}', on: { done: { to: 'done' } } };
  const renamed = renameState(m, 'start', 'work');
  assert.equal(renamed.states.report.prompt, '{{results.work.text}} {{results.review.a.text}}');
  assert.equal(renamed.states.review.branches[0].prompt, '{{results.work.text}}');
  assert.equal(renamed.states.review.branches[1].prompt, '{{ results.work.event }}');
  assert.deepEqual(validateMachine(renamed), { problems: [], warnings: [] });
  assert.equal(m.states.review.branches[0].prompt, '{{results.start.text}}');
});
test('setKind keeps applicable fields and supplies defaults for every kind', () => {
  /** @type {import('../shared/types.ts').State} */
  const s = { ...minimal().states.start, maxVisits: 4, output: { summary: { type: 'string' } } };
  assert.deepEqual(setKind(s, 'decision'), { ...s, kind: 'decision' });
  assert.deepEqual(setKind(s, 'final'), { kind: 'final', title: 'Start', outcome: 'success' });
  assert.equal(setKind({ ...s, outcome: 'failure' }, 'final').outcome, 'failure');
  const fan = setKind({ ...s, on: { ...s.on, retry: { to: 'start' } } }, 'fanout');
  assert.equal(fan.maxVisits, 4); assert.deepEqual(Object.keys(fan.on), ['done']);
  assert.deepEqual(fan.branches, [{ id: 'a', role: 'coder', prompt: s.prompt }, { id: 'b', role: 'coder', prompt: s.prompt }]);
  assert.ok(!Object.hasOwn(fan, 'output'));
  const task = setKind(fanout(), 'task');
  assert.equal(task.role, 'reviewer'); assert.equal(task.prompt, 'Review A'); assert.ok(!Object.hasOwn(task, 'branches'));
  assert.deepEqual(setKind({ kind: 'final', title: 'Done', outcome: 'success' }, 'task', 'lead'), { kind: 'task', title: 'Done', role: 'lead', prompt: '', on: {} });
  assert.deepEqual(setKind(fan, 'fanout'), fan);
});
test('clean strips empty optional edit leftovers without changing the source', () => {
  const m = minimal(); m.inputs = {}; m.whenToUse = ''; m.states.start.output = {}; m.states.start.on.done.description = '';
  const c = clean(m);
  assert.ok(!Object.hasOwn(c, 'inputs')); assert.ok(!Object.hasOwn(c, 'whenToUse'));
  assert.ok(!Object.hasOwn(c.states.start, 'output')); assert.deepEqual(c.states.start.on.done, { to: 'done' });
  assert.ok(Object.hasOwn(m, 'inputs')); assert.equal(m.states.start.on.done.description, '');
  m.inputs = { dir: { type: 'string' } }; m.whenToUse = 'When needed'; m.states.start.output = { summary: { type: 'string' } }; m.states.start.on.done.description = 'Ready';
  assert.deepEqual(clean(m), m);
});
test('setField supports inspector fields and converts kind through setKind', () => {
  const m = minimal();
  for (const [key, value] of Object.entries({ title: 'Build', role: 'qa', prompt: 'Test it', maxVisits: 2, outcome: 'failure' })) {
    assert.equal(setField(m, 'start', key, value).states.start[key], value);
    assert.notEqual(m.states.start[key], value);
  }
  assert.deepEqual(setField(m, 'start', 'kind', 'fanout').states.start, setKind(m.states.start, 'fanout'));
  const c = setField(setField(m, 'start', 'maxVisits', 2), 'start', 'maxVisits', undefined);
  assert.ok(!Object.hasOwn(c.states.start, 'maxVisits'));
  assert.equal(setField(m, 'missing', 'title', 'Missing'), m);
  assert.equal(setField(m, 'start', 'on', {}), m);
});
test('input and output row edits add, replace and remove fields immutably', () => {
  const m = minimal();
  /** @type {import('../shared/types.ts').Field} */
  const field = { type: 'string', required: true, description: 'Directory' };
  const input = setInput(m, 'dir', field), output = setOutput(m, 'start', 'summary', field);
  assert.deepEqual(input.inputs, { dir: field }); assert.deepEqual(output.states.start.output, { summary: field });
  assert.ok(!m.inputs); assert.ok(!m.states.start.output);
  assert.deepEqual(setInput(input, 'dir', { type: 'number', default: 1 }).inputs.dir, { type: 'number', default: 1 });
  assert.deepEqual(setOutput(output, 'start', 'summary', { type: 'number' }).states.start.output.summary, { type: 'number' });
  assert.deepEqual(removeInput(input, 'dir').inputs, {}); assert.deepEqual(removeOutput(output, 'start', 'summary').states.start.output, {});
  assert.deepEqual(input.inputs.dir, field); assert.deepEqual(output.states.start.output.summary, field);
  input.inputs.dir.description = 'Changed'; output.states.start.output.summary.description = 'Changed'; assert.equal(field.description, 'Directory');
  assert.deepEqual(removeInput(m, 'missing'), m); assert.deepEqual(removeOutput(m, 'start', 'missing'), m);
  assert.equal(setOutput(m, 'missing', 'summary', field), m); assert.equal(removeOutput(m, 'missing', 'summary'), m);
});
test('event row edits preserve exact names and descriptions for validation', () => {
  const m = minimal(), linked = setEvent(m, 'start', 'retry', { to: 'start', description: 'Try again' });
  assert.deepEqual(linked.states.start.on.retry, { to: 'start', description: 'Try again' });
  assert.deepEqual(removeEvent(linked, 'start', 'done').states.start.on, { retry: { to: 'start', description: 'Try again' } });
  assert.deepEqual(setEvent(linked, 'start', 'retry', { to: 'done' }).states.start.on.retry, { to: 'done' });
  assert.ok(Object.hasOwn(setEvent(m, 'start', 'Bad name', { to: 'done' }).states.start.on, 'Bad name'));
  assert.deepEqual(m.states.start.on, { done: { to: 'done' } });
  assert.equal(setEvent(m, 'done', 'next', { to: 'start' }), m); assert.equal(setEvent(m, 'missing', 'next', { to: 'done' }), m);
  assert.equal(removeEvent(m, 'missing', 'done'), m);
  m.states.start = fanout();
  assert.deepEqual(setEvent(m, 'start', 'settled', { to: 'done', description: 'All ready' }).states.start.on, { settled: { to: 'done', description: 'All ready' } });
});
test('edits accept null-prototype maps and do not read or mutate inherited states', () => {
  const m = minimal(); m.states = Object.assign(Object.create(null), m.states); m.states.start.on = Object.assign(Object.create(null), m.states.start.on);
  assert.equal(addAfter(m, 'start').event, 'done_2');
  assert.equal(renameState(m, 'start', 'build').initial, 'build');
  assert.equal(connect(m, 'constructor', 'done', 'next'), m);
  assert.equal(setField(m, 'constructor', 'title', 'Unsafe'), m);
  assert.equal(renameState(m, 'constructor', 'build'), m);
  assert.equal(setOutput(m, 'constructor', 'x', { type: 'string' }), m);
  assert.equal(eventNameFor(m, 'start', 'constructor'), 'constructor');
  assert.equal(/** @type {{ title?: unknown }} */ (Object.prototype).title, undefined);
});
test('prototype-looking names stay own data properties without changing map prototypes', () => {
  const m = minimal();
  /** @type {import('../shared/types.ts').Field} */
  const field = { type: 'string' };
  const input = setInput(m, '__proto__', field), output = setOutput(m, 'start', '__proto__', field), event = setEvent(m, 'start', '__proto__', { to: 'done' });
  for (const [map, value] of [[input.inputs, field], [output.states.start.output, field], [event.states.start.on, { to: 'done' }]]) {
    assert.equal(Object.getPrototypeOf(map), Object.prototype);
    assert.ok(Object.hasOwn(map, '__proto__')); assert.deepEqual(/** @type {{ __proto__?: unknown }} */ (map).__proto__, value);
  }
  assert.equal(renameState(m, 'start', '__proto__'), m);
  const renamed = renameState(m, 'start', 'constructor');
  assert.ok(Object.hasOwn(renamed.states, 'constructor')); assert.equal(/** @type {{ constructor: import('../shared/types.ts').State }} */ (/** @type {unknown} */ (renamed.states)).constructor.title, 'Start');
  assert.equal(Object.getPrototypeOf(renamed.states), Object.prototype);
  assert.equal(/** @type {{ to?: unknown }} */ (Object.prototype).to, undefined);
});
