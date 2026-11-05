import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateMachine, compile, extract, templateMachine } from '../shared/machine.ts';
import { runner } from '../shared/runner.ts';
import { checkWorkflowCode, extractMeta } from '../server/check.ts';
import { runWorkflow } from './fake-host.js';
const roles = ['lead', 'oracle', 'scribe', 'coder', 'reviewer', 'qa', 'judge', 'skeptic', 'auditor', 'pragmatist'];
const fixtures = Object.fromEntries(await Promise.all(['plan', 'build', 'council'].map(async id => [id, JSON.parse(await readFile(new URL(`../fixtures/machines/${id}.json`, import.meta.url), 'utf8'))])));
const minimal = () => templateMachine('demo');
/** @returns {import('../shared/types.ts').State} */
const fanout = () => ({ kind: 'fanout', title: 'Review', branches: [{ id: 'a', role: 'reviewer', prompt: 'Review A' }, { id: 'b', role: 'reviewer', prompt: 'Review B' }], on: { done: { to: 'done' } } });
for (const [label, change, message] of /** @type {[string, (m: any) => void, RegExp][]} */ ([
  ['id required', m => delete m.id, /Machine id/],
  ['id pattern', m => m.id = '../Demo', /Machine id/],
  ['name required', m => delete m.name, /name/],
  ['description required', m => delete m.description, /description/],
  ['initial required', m => delete m.initial, /initial/],
  ['states required', m => delete m.states, /states/],
  ['initial exists', m => m.initial = 'missing', /Initial state `missing`/],
  ['reachable states', m => m.states.other = { kind: 'final', title: 'Other', outcome: 'failure' }, /`other` is unreachable/],
  ['final required', m => delete m.states.done, /at least one final/],
  ['final outcome required', m => delete m.states.done.outcome, /`done` needs a success or failure outcome/],
  ['final outcome valid', m => m.states.done.outcome = 'maybe', /outcome/],
  ['final without on', m => m.states.done.on = {}, /`done` is final/],
  ['task events required', m => delete m.states.start.on, /`start` needs at least one event/],
  ['nonempty events', m => m.states.start.on = {}, /at least one event/],
  ['target exists', m => m.states.start.on.done.to = 'missing', /`start` event `done` targets unknown state `missing`/],
  ['transition object', m => m.states.start.on.done = 'done', /event `done` must be an object/],
  ['fanout one event', m => { m.states.start = fanout(); m.states.start.on.again = { to: 'start' }; }, /exactly one event/],
  ['fanout branches count', m => { m.states.start = fanout(); m.states.start.branches.pop(); }, /at least two branches/],
  ['fanout branch unique', m => { m.states.start = fanout(); m.states.start.branches[1].id = 'a'; }, /duplicates a branch id/],
  ['fanout branch role', m => { m.states.start = fanout(); delete m.states.start.branches[0].role; }, /branch `a` needs a role/],
  ['fanout branch prompt', m => { m.states.start = fanout(); delete m.states.start.branches[0].prompt; }, /branch `a` needs a prompt/],
  ['task role', m => delete m.states.start.role, /`start` needs a role/],
  ['task prompt', m => delete m.states.start.prompt, /`start` needs a prompt/],
  ['decision role', m => { m.states.start.kind = 'decision'; delete m.states.start.role; }, /`start` needs a role/],
  ['state id pattern', m => m.states.Bad = { kind: 'final', title: 'Bad', outcome: 'failure' }, /`Bad` has an invalid id/],
  ['event pattern', m => m.states.start.on.BAD = { to: 'done' }, /event `BAD` has an invalid name/],
  ['unknown kind', m => m.states.start.kind = 'wait', /unknown kind/],
  ['state title', m => delete m.states.start.title, /needs a title/],
  ['positive maxVisits', m => m.states.start.maxVisits = 0, /positive integer/],
  ['integer maxVisits', m => m.states.start.maxVisits = 1.5, /positive integer/],
  ['input type', m => m.inputs = { x: { type: 'any' } }, /valid type/],
  ['input required type', m => m.inputs = { x: { type: 'string', required: 'yes' } }, /required must be a boolean/],
  ['input default type', m => m.inputs = { x: { type: 'number', default: 'one' } }, /default must match/],
  ['input description type', m => m.inputs = { x: { type: 'string', description: 2 } }, /description must be a string/],
  ['output type', m => m.states.start.output = { x: { type: 'any' } }, /valid type/],
  ['root unknown key', m => m.oops = true, /unknown key `oops`/],
  ['state unknown key', m => m.states.start.oops = true, /`start` has an unknown key `oops`/],
  ['transition unknown key', m => m.states.start.on.done.oops = true, /event `done` has an unknown key `oops`/],
  ['branch unknown key', m => { m.states.start = fanout(); m.states.start.branches[0].oops = true; }, /branch `a` has an unknown key `oops`/],
  ['input unknown key', m => m.inputs = { x: { type: 'string', oops: true } }, /field `x` has an unknown key `oops`/],
  ['output unknown key', m => m.states.start.output = { x: { type: 'string', oops: true } }, /field `x` has an unknown key `oops`/],
])) test(`validation rejects ${label}`, () => {
  const m = minimal(); change(m);
  const result = validateMachine(m, { roles });
  assert.ok(result.problems.some(problem => message.test(problem)), JSON.stringify(result));
  assert.ok(result.problems.every(problem => typeof problem === 'string'));
});
test('validation accepts optional gates on tasks and fanout branches', () => {
  const m = minimal();
  assert.deepEqual(validateMachine(m).problems, []);
  m.states.start.gate = 'npm test';
  assert.deepEqual(validateMachine(m).problems, []);
  m.states.start = fanout(); m.states.start.branches[0].gate = 'npm test';
  assert.deepEqual(validateMachine(m).problems, []);
});
for (const gate of /** @type {any[]} */ (['', '  ', 1, false, null, undefined, {}, []])) test(`validation rejects invalid gate ${JSON.stringify(gate)}`, () => {
  const m = minimal(); m.states.start.gate = gate;
  assert.ok(validateMachine(m).problems.includes('State `start` gate must be a non-empty shell command string.'));
  m.states.start = fanout(); m.states.start.branches[0].gate = gate;
  assert.ok(validateMachine(m).problems.includes('State `start` branch `a` gate must be a non-empty shell command string.'));
});
for (const kind of /** @type {import('../shared/types.ts').Kind[]} */ (['decision', 'fanout', 'final'])) test(`validation rejects a gate on ${kind} states`, () => {
  const m = minimal();
  const state = kind === 'final' ? m.states.done : kind === 'fanout' ? (m.states.start = fanout()) : (m.states.start.kind = kind, m.states.start);
  state.gate = 'npm test';
  assert.ok(validateMachine(m).problems.some(problem => problem.endsWith('gate is only allowed on task states.')));
});
test('validation rejects every Object.prototype name in named machine fields', () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) for (const category of ['state', 'branch', 'event', 'input', 'output']) {
    const m = minimal();
    if (category === 'state') { m.states = Object.fromEntries([[name, m.states.start], ['done', m.states.done]]); m.initial = name; }
    if (category === 'branch') { m.states.start = fanout(); m.states.start.branches[0].id = name; }
    if (category === 'event') m.states.start.on = Object.fromEntries([[name, { to: 'done' }]]);
    if (category === 'input') m.inputs = Object.fromEntries([[name, { type: 'string' }]]);
    if (category === 'output') m.states.start.output = Object.fromEntries([[name, { type: 'string' }]]);
    assert.ok(validateMachine(m).problems.some(problem => problem.includes(`\`${name}\``) && problem.includes('reserved name')), `${category}: ${name}`);
  }
});
test('validation rejects reserved keys recursively in input defaults', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) for (const nested of [false, true]) for (const type of /** @type {import('../shared/types.ts').FieldType[]} */ (['object', 'array'])) {
    const value = JSON.parse(`{"${key}": "unsafe"}`), m = minimal();
    const payload = nested ? { safe: [{ deeper: value }] } : value;
    m.inputs = { payload: { type, default: type === 'array' ? [payload] : payload } };
    assert.ok(validateMachine(m).problems.some(problem => problem.includes(`default uses a reserved key \`${key}\``)));
  }
  const m = minimal(); m.inputs = { payload: { type: 'object', default: { safe: [{ text: '__proto__ constructor prototype' }] } } };
  assert.deepEqual(validateMachine(m).problems, []);
});
test('validation requires placeholder-safe input and output field names', () => {
  for (const name of ['bad-name', 'with.dot', 'with space', 'Upper', '1name', '', '_name', 'é']) for (const input of [false, true]) {
    const m = minimal(), field = /** @type {Record<string, import('../shared/types.ts').Field>} */ ({ [name]: { type: 'string' } });
    if (input) m.inputs = field; else m.states.start.output = field;
    assert.ok(validateMachine(m).problems.some(problem => problem.includes('invalid name; use snake_case')));
  }
  const m = minimal(); m.inputs = { valid_name2: { type: 'string' } }; m.states.start.output = { valid_name2: { type: 'string' } };
  assert.deepEqual(validateMachine(m).problems, []);
});
for (const name of ['event', 'text']) test(`validation rejects reserved output.${name}`, () => {
  const m = minimal(); m.states.start.output = { [name]: { type: 'string' } };
  assert.ok(validateMachine(m).problems.includes(`State \`start\` output field \`${name}\` is reserved for the runner.`));
});
test('validation checks filename and handles malformed JSON shapes', () => {
  assert.match(validateMachine(minimal(), { fileName: 'different.js' }).problems.join('\n'), /match file name/);
  assert.deepEqual(validateMachine(minimal(), { fileName: 'demo.js', roles }).problems, []);
  for (const value of [null, [], true, { states: { a: null } }, { states: { a: { kind: 'constructor', on: { a: null } } } }, { states: { a: { kind: 'fanout', branches: [null] } } }, { initial: { toString: null }, states: { a: { kind: { toString: null }, on: { event: { to: { toString: null } } } } } }, { states: { a: { kind: 'fanout', branches: [{ id: { toString: null } }] } } }]) assert.doesNotThrow(() => validateMachine(value));
});
test('warnings cover roles, single-event decisions and unknown placeholders, not closed cycles', () => {
  const m = minimal(); m.states.start.kind = 'decision'; m.states.start.role = 'unknown';
  m.states.start.prompt = '{{inputs.nope}} {{results.missing.text}} {{run.nope}} {{visit}} {{run.history}}';
  const result = validateMachine(m, { roles });
  assert.deepEqual(result.problems, []); assert.equal(result.warnings.length, 5);
  assert.match(result.warnings.join('\n'), /`start`.*unknown project role/);
  assert.match(result.warnings.join('\n'), /only one event/);
  m.states.start = fanout(); m.states.start.branches[0].role = 'unknown';
  assert.equal(validateMachine(m, { roles }).warnings.length, 1);
  m.states.start = minimal().states.start;
  m.states.start.on.loop = { to: 'closed' };
  m.states.closed = { ...minimal().states.start, on: { again: { to: 'closed' } } };
  assert.deepEqual(validateMachine(m, { roles }), { problems: [], warnings: [] });
});
test('known prompt paths include output, free text and fanout branches', () => {
  const m = minimal(); m.inputs = { x: { type: 'object', default: { a: true } } };
  m.states.review = fanout(); m.states.start.on.done.to = 'review';
  m.states.start.prompt = '{{inputs.x}} {{results.review.a.text}} {{visit}} {{run.history}}';
  m.states.review.branches[0].prompt = '{{results.start.event}} {{results.start.text}}';
  assert.deepEqual(validateMachine(m, { roles }), { problems: [], warnings: [] });
  m.states.start.output = { summary: { type: 'string' } };
  m.states.review.branches[0].prompt = '{{results.start.summary}}';
  assert.deepEqual(validateMachine(m, { roles }).warnings, []);
});
for (const [id, m] of Object.entries(fixtures)) test(`${id} machine round trips and matches fixture machine literal`, async () => {
  assert.deepEqual(validateMachine(m, { roles, fileName: `${id}.js` }), { problems: [], warnings: [] });
  const code = compile(m); assert.deepEqual(extract(code), m);
  assert.deepEqual(checkWorkflowCode(code, { fileName: `${id}.js` }).errors, []);
  assert.deepEqual(extractMeta(code).phases, Object.values(m.states).filter(s => s.kind !== 'final').map(s => ({ title: s.title })));
  assert.deepEqual(extract(await readFile(new URL(`../fixtures/playground/.pi/workflows/${id}.js`, import.meta.url), 'utf8')), m);
});
test('50 seeded random small machines round trip exactly', () => {
  let seed = 63917;
  const random = n => { seed = (1664525 * seed + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 50; i++) {
    const m = minimal(), count = 1 + random(6); m.states = {};
    m.inputs = { count: { type: 'number', default: -(1 + random(50)) }, nested: { type: 'object', default: { list: [true, null, { 'odd-key': '"looks": like code\nnew line' }] } } };
    for (let j = 0; j < count; j++) {
      const state = { kind: /** @type {import('../shared/types.ts').Kind} */ (random(2) ? 'task' : 'decision'), title: `Step ${j}`, role: roles[random(roles.length)], prompt: 'Quote: "field": and {{visit}}\n{{inputs.nested}}', on: { next: { to: j + 1 === count ? 'done' : `s${j + 1}` } }, maxVisits: 1 + random(4) };
      if (random(2)) state.on.retry = { to: `s${random(j + 1)}` };
      m.states[`s${j}`] = state;
    }
    m.initial = 's0'; m.states.done = { kind: 'final', title: 'Done', outcome: 'success' };
    assert.deepEqual(validateMachine(m).problems, []);
    assert.deepEqual(extract(compile(m)), m);
    assert.deepEqual(checkWorkflowCode(compile(m)).errors, []);
  }
});
test('extract never evaluates expressions and only accepts a top-level const object literal', () => {
  for (const code of ['const =', 'export const meta = {}', 'let machine = {}', 'const machine = make()', 'const machine = { x: call() }', 'const machine = { ...other }', 'const machine = { ["id"]: "x" }', 'const machine = { get id() { return "x" } }', 'function nested() { const machine = {} }', 'const machine = { x: /a/ }', 'const machine = { x: 1n }', 'const machine = { x: [,,] }']) assert.equal(extract(code), null, code);
  assert.deepEqual(extract('const machine = { id: `demo`, value: -3 }'), { id: 'demo', value: -3 });
});
function scripted(events, calls = []) {
  return async (prompt, options) => {
    calls.push({ prompt, ...options });
    if (!options.schema) return `Review ${options.label}`;
    const state = options.label.split(':')[0], queue = events[state], event = Array.isArray(queue) ? queue.shift() : queue ?? options.schema.properties.event.enum[0];
    assert.ok(options.schema.properties.event.enum.includes(event), `${state}: ${event}`);
    const out = { event };
    for (const key of Object.keys(options.schema.properties)) if (key !== 'event') out[key] = `${state} ${key}`;
    return out;
  };
}
test('compiled task gates round trip and only gated agent calls receive the option', async () => {
  const m = minimal(), calls = [];
  assert.doesNotMatch(compile(m), /gate: "npm test"/);
  m.states.start.gate = 'npm test'; m.states.start.on.done.to = 'report';
  m.states.report = { ...minimal().states.start, title: 'Report' };
  const code = compile(m);
  assert.match(code, /gate: "npm test"/); assert.match(code, /gate: fill\(s\.gate/);
  assert.deepEqual(extract(code), m); assert.deepEqual(checkWorkflowCode(code).errors, []);
  const result = await runWorkflow(code, { agent: scripted({}, calls) });
  assert.equal(result.outcome, 'success'); assert.equal(calls[0].gate, 'npm test');
  assert.ok(!Object.hasOwn(calls[1], 'gate'));
});
test('task gate failures route to failed or fail closed after the agent finishes', async () => {
  for (const transition of [false, true]) {
    const m = minimal(), calls = []; m.states.start.gate = 'npm test';
    if (transition) m.states.start.on.failed = { to: 'done' };
    const result = await runWorkflow(compile(m), { agent: scripted({}, calls), gateFails: true });
    assert.equal(calls.length, 1); assert.equal(calls[0].gate, 'npm test');
    assert.equal(result.outcome, transition ? 'success' : 'failure');
    assert.deepEqual(result.history, transition ? ['start → failed'] : []);
    assert.equal(result.at, transition ? 'done' : 'start');
    assert.equal(result.reason, transition ? null : 'start failed: Gate failed: npm test\nTest command exited 1');
  }
  const m = minimal(); m.states.start.gate = 'npm test'; m.states.start.on.failed = { to: 'done' };
  const result = await runWorkflow(compile(m), { agent: async () => null });
  assert.equal(result.outcome, 'success'); assert.deepEqual(result.history, ['start → failed']);
  const malformed = await runWorkflow(compile(m), { agent: async () => ({ event: 'unknown' }), malformed: 'pass' });
  assert.equal(malformed.outcome, 'failure'); assert.match(malformed.reason, /unknown event/);
});
test('fanout branch gates use existing partial-result failure transitions', async () => {
  for (const transition of [false, true]) {
    const m = minimal(), calls = []; m.states.start = fanout();
    m.states.start.branches[0].gate = 'npm test';
    if (transition) m.states.start.on.failed = { to: 'done' };
    const code = compile(m); assert.deepEqual(extract(code), m); assert.deepEqual(checkWorkflowCode(code).errors, []);
    const success = await runWorkflow(code, { agent: scripted({}, calls) });
    assert.equal(success.outcome, 'success'); assert.equal(calls[0].gate, 'npm test'); assert.ok(!Object.hasOwn(calls[1], 'gate'));
    const result = await runWorkflow(code, { agent: scripted({}), gateFails: true });
    assert.deepEqual(result.results.start, { a: null, b: { text: 'Review start:b' } });
    assert.equal(result.outcome, transition ? 'success' : 'failure');
    assert.deepEqual(result.history, transition ? ['start → failed'] : []);
    assert.equal(result.reason, transition ? null : 'start: branch a failed');
  }
});
test('plan runs through changes and approval to success', async () => {
  const calls = [], logs = [];
  const result = await runWorkflow(compile(fixtures.plan), { args: { task: 'Build the thing', slug: 'demo' }, agent: scripted({ challenge: ['changes', 'approved'] }, calls), log: line => logs.push(line) });
  assert.equal(result.outcome, 'success'); assert.equal(result.reason, null); assert.equal(result.at, 'approved');
  assert.deepEqual(result.history, ['draft → drafted', 'challenge → changes', 'revise → revised', 'challenge → approved', 'explain → done']);
  assert.deepEqual(logs, result.history);
  assert.match(calls.find(c => c.label === 'revise').prompt, /challenge feedback/);
  assert.match(calls.find(c => c.label === 'challenge:2').prompt, /revise summary/);
  assert.match(calls[0].prompt, /Project directory: \./); assert.match(calls[0].prompt, /Build the thing/);
});
test('plan stops with a reason when oracle never approves', async () => {
  const calls = [];
  const result = await runWorkflow(compile(fixtures.plan), { args: { task: 'Task', slug: 'demo' }, agent: scripted({ challenge: 'changes' }, calls) });
  assert.equal(result.outcome, 'failure'); assert.equal(result.at, 'challenge');
  assert.equal(result.reason, 'challenge ran 3 times without reaching an end');
  assert.equal(calls.filter(c => c.agentType === 'oracle').length, 3);
  assert.equal(calls.filter(c => c.label.startsWith('revise')).length, 3);
  assert.ok(!calls.some(c => c.agentType === 'scribe'));
});
test('build runs parallel reviews and retries a failed QA attempt to success', async () => {
  const calls = [], phases = [];
  const result = await runWorkflow(compile(fixtures.build), { args: { slug: 'demo', dir: '/project' }, agent: scripted({ qa: ['fail', 'pass'] }, calls), phase: title => phases.push(title) });
  assert.equal(result.outcome, 'success'); assert.equal(result.at, 'shipped'); assert.equal(result.reason, null);
  assert.equal(calls.filter(c => c.agentType === 'reviewer').length, 4);
  assert.deepEqual(result.results.review, { a: { text: 'Review review:a' }, b: { text: 'Review review:b' } });
  assert.match(calls.find(c => c.label === 'agree').prompt, /Review review:a[\s\S]*Review review:b/);
  assert.match(calls.find(c => c.label === 'build:2').prompt, /qa report/);
  assert.match(calls.find(c => c.label === 'report').prompt, /qa → fail[\s\S]*qa → pass/);
  assert.ok(phases.includes('Review'));
});
test('build can give up and a failed agent ends with a reason', async () => {
  const result = await runWorkflow(compile(fixtures.build), { args: { slug: 'demo' }, agent: scripted({ qa: 'give_up' }) });
  assert.equal(result.outcome, 'failure'); assert.equal(result.at, 'gave_up');
  const failed = await runWorkflow(compile(minimal()), { agent: async () => null });
  assert.equal(failed.reason, 'start: agent failed'); assert.deepEqual(failed.history, []);
  const thrown = await runWorkflow(compile(minimal()), { agent: async () => { throw new Error('Unavailable'); } });
  assert.equal(thrown.outcome, 'failure'); assert.equal(thrown.reason, 'start failed: Unavailable'); assert.deepEqual(thrown.history, []);
});
test('runner rejects unknown events and malformed results without throwing', async () => {
  for (const value of [{ event: 'unknown' }, { event: 'constructor' }, {}, { event: null }, { event: [] }, { event: { toString: null } }, null, undefined, 'done', 2, false, []]) {
    const result = await runWorkflow(compile(minimal()), { agent: async () => value, malformed: 'pass' });
    const event = value !== null && typeof value === 'object' && !Array.isArray(value) ? value.event : value;
    assert.equal(result.outcome, 'failure'); assert.equal(result.reason, value === null ? 'start: agent failed' : `start: unknown event ${event !== null && typeof event === 'object' ? JSON.stringify(event) : event}`);
    assert.equal(result.at, 'start'); assert.deepEqual(result.history, []);
  }
});
test('runner validates required inputs, fills defaults and unknown paths, and caps default visits', async () => {
  assert.ok(compile(minimal()).endsWith(runner)); assert.ok(runner.split('\n').length <= 45);
  assert.doesNotMatch(runner, /\bDate\b|Math\.random|\bimport\b|\bFunction\b|\beval\b/);
  const missing = await runWorkflow(compile(fixtures.plan), { args: { slug: 'demo' }, agent: () => assert.fail('Agent must not run') });
  assert.equal(missing.outcome, 'failure'); assert.match(missing.reason, /plan needs args.task/);
  const m = minimal(); m.inputs = { count: { type: 'number', default: 2 }, enabled: { type: 'boolean', default: true } };
  m.states.start.prompt = '{{inputs.count}} {{inputs.enabled}} {{missing.value}} {{visit}}';
  m.states.start.on = { again: { to: 'start' }, done: { to: 'done' } };
  const calls = [];
  const result = await runWorkflow(compile(m), { args: { count: 0, enabled: false }, agent: scripted({ start: 'again' }, calls) });
  assert.equal(calls[0].prompt, '0 false  1'); assert.equal(calls.length, 3); assert.equal(result.reason, 'start ran 3 times without reaching an end');
});
test('runner validates input types before any agent runs', async () => {
  for (const [type, invalid, valid] of /** @type {[import('../shared/types.ts').FieldType, unknown[], unknown][]} */ ([['number', ['3', NaN, Infinity, null], 0], ['boolean', ['false', 0, null], false], ['string', [3, [], null], ''], ['array', ['[]', {}, null], []]])) {
    const m = minimal(); m.inputs = { x: { type, required: true } };
    for (const x of invalid) {
      const result = await runWorkflow(compile(m), { args: { x }, agent: () => assert.fail('Agent must not run') });
      assert.equal(result.outcome, 'failure'); assert.equal(result.reason, `demo args.x must be ${type}`);
      assert.equal(result.at, 'start'); assert.deepEqual(result.history, []); assert.deepEqual(Object.keys(result.results), []);
    }
    assert.equal((await runWorkflow(compile(m), { args: { x: valid }, agent: scripted({}) })).outcome, 'success');
  }
  const m = minimal(); m.inputs = { optional: { type: 'number' } };
  assert.equal((await runWorkflow(compile(m), { agent: scripted({}) })).outcome, 'success');
});
test('runner caps a constructor self-loop and never resolves inherited placeholder properties', async () => {
  const m = minimal(), calls = [];
  m.initial = 'constructor';
  m.inputs = { payload: { type: 'object', default: {} } };
  m.states = { constructor: { ...m.states.start, prompt: '{{visit}}|{{results.constructor.text}}|{{results.toString}}|{{inputs.constructor}}|{{inputs.payload.toString}}|{{results.constructor.toString}}', on: { again: { to: 'constructor' } }, maxVisits: 3 }, done: m.states.done };
  const result = await runWorkflow(compile(m), { agent: async (prompt, options) => {
    calls.push({ prompt, ...options }); assert.ok(calls.length <= 3, 'The runner must stop at the visit cap');
    return { event: 'again', text: 'Previous report' };
  } });
  assert.equal(result.outcome, 'failure'); assert.equal(result.reason, 'constructor ran 3 times without reaching an end');
  assert.equal(result.at, 'constructor'); assert.equal(calls.length, 3);
  assert.equal(calls[0].prompt, '1|||||'); assert.equal(calls[1].prompt, '2|Previous report||||');
  assert.deepEqual(result.results.constructor, { event: 'again', text: 'Previous report' });
  assert.equal(Object.getPrototypeOf(result.results), null);
});
for (const kind of /** @type {import('../shared/types.ts').Kind[]} */ (['task', 'decision'])) for (const output of [undefined, {}]) test(`${kind} with ${output === undefined ? 'absent' : 'empty'} output requires and forwards text`, async () => {
  const m = minimal(); m.states.start.kind = kind;
  if (output !== undefined) m.states.start.output = output;
  m.states.start.on.done.to = 'report';
  m.states.report = { kind: 'task', title: 'Report', role: 'scribe', prompt: '{{results.start.text}}', on: { done: { to: 'done' } } };
  assert.deepEqual(validateMachine(m).warnings.filter(warning => warning.includes('placeholder')), []);
  const result = await runWorkflow(compile(m), { agent: async (prompt, { label, schema }) => {
    assert.deepEqual(schema.properties.text, { type: 'string', description: 'Your report for the next step' });
    assert.ok(schema.required.includes('text')); assert.deepEqual(schema.properties.event.enum, ['done']);
    if (label === 'report') assert.equal(prompt, 'Report from the first step');
    return { event: 'done', text: 'Report from the first step' };
  } });
  assert.equal(result.outcome, 'success'); assert.equal(result.results.start.text, 'Report from the first step');
});
test('fanout failed transition retains partial results for null and thrown branches', async () => {
  const m = minimal(); m.states.start = fanout();
  m.states.start.on = { failed: { to: 'report' }, done: { to: 'done' } };
  m.states.report = { kind: 'task', title: 'Report', role: 'scribe', prompt: '{{results.start.a.text}}|{{results.start.b.text}}', on: { done: { to: 'done' } } };
  assert.deepEqual(validateMachine(m).problems, []);
  for (const throws of [false, true]) {
    const result = await runWorkflow(compile(m), { agent: async (prompt, { label }) => {
      if (label === 'start:a') { if (throws) throw new Error('Unavailable'); return null; }
      if (label === 'start:b') return 'Reviewed';
      assert.equal(prompt, '|Reviewed'); return { event: 'done', text: 'ok' };
    } });
    assert.deepEqual(result.results.start, { a: null, b: { text: 'Reviewed' } });
    assert.equal(result.outcome, 'success'); assert.equal(result.history[0], 'start → failed');
  }
  const result = await runWorkflow(compile(m), { agent: async () => 'Reviewed' });
  assert.equal(result.outcome, 'success'); assert.deepEqual(result.history, ['start → done']);
});
test('runner settles a failed fanout branch and exposes free text result placeholders', async () => {
  const m = minimal(); m.states.start = fanout(); m.states.start.on.done.to = 'report';
  m.states.report = { kind: 'task', title: 'Report', role: 'scribe', prompt: '{{results.start.a.text}} {{results.start.b.text}}', on: { done: { to: 'done' } } };
  let report;
  const result = await runWorkflow(compile(m), { agent: async (prompt, options) => { if (options.label === 'start:a') throw new Error('Failed'); if (options.label === 'start:b') return 'Reviewed'; report = prompt; return { event: 'done', text: 'ok' }; } });
  assert.equal(result.outcome, 'failure'); assert.equal(result.reason, 'start: branch a failed'); assert.equal(report, undefined);
  assert.deepEqual(result.results.start, { a: null, b: { text: 'Reviewed' } });
  m.states.start = { ...minimal().states.start, on: { done: { to: 'report' } } }; m.states.report.prompt = '{{results.start.text}}';
  let freeText;
  const second = await runWorkflow(compile(m), { agent: async (prompt, options) => { if (options.label === 'start') return { event: 'done', text: 'Free text' }; freeText = prompt; return { event: 'done', text: 'ok' }; } });
  assert.equal(freeText, 'Free text'); assert.equal(second.outcome, 'success');
});
