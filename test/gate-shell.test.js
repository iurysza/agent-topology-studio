// Gate templates are trusted shell code; every placeholder value is untrusted data (ADR-0001).
// These tests run the filled gate in a real `sh -c`, as the Pi host does with `shell: true`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { compile, extract, templateMachine, validateMachine } from '../shared/machine.ts';
import { shellWord } from '../shared/gate.ts';
import { runWorkflow } from './fake-host.js';

/** @typedef {import('../shared/machine.ts').Machine} Machine */

const payloads = [
  'plain', 'two words', "it's", 'a;touch PWNED', 'a && touch PWNED', 'a | touch PWNED', 'line\ntouch PWNED',
  '`touch PWNED`', '$(touch PWNED)', '$HOME', '${HOME}', '"quoted"', '\\', "'; touch PWNED; '", '*', '',
];

async function sandbox(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gate sh it's-"));

  t.after(() => rm(dir, { recursive: true, force: true }));

  return dir;
}

/** Runs the gate like the host and returns its exit code; a non-zero exit is a gate failure. */
function sh(gate, cwd) {
  return spawnSync('/bin/sh', ['-c', gate], { cwd, encoding: 'utf8' }).status;
}

const noPwned = async dir => assert.deepEqual((await readdir(dir)).filter(name => name.includes('PWNED')), [], 'an injected command ran');

/** @param {Record<string, any>} inputs */
function machineWith(inputs) {
  const m = /** @type {Machine} */ (templateMachine('gates'));
  m.inputs = Object.fromEntries(Object.keys(inputs).map(key => [key, { type: 'string' }]));

  return m;
}

/** An agent that runs every gate in sh inside cwd and fails the call on a non-zero exit, as the host does.
 * @param {string} cwd @param {any[]} seen @param {(prompt: string, options: any) => any} [answer] */
function shellAgent(cwd, seen, answer = () => ({ event: 'done', text: 'ok' })) {
  return async (prompt, options) => {
    seen.push({ prompt, gate: options.gate, label: options.label });
    const out = answer(prompt, options);

    if (options.gate !== undefined && sh(options.gate, cwd) !== 0) throw new Error(`Gate failed: ${options.gate}`);

    return out;
  };
}

test('task gate values reach sh as one literal word and inject nothing', async t => {
  for (const value of payloads) {
    const dir = await sandbox(t), seen = [];
    const m = machineWith({ task: value });
    m.states.start.prompt = 'Task: {{inputs.task}}';
    m.states.start.gate = 'printf %s {{inputs.task}} > out.txt';
    const result = await runWorkflow(compile(m), { args: { task: value }, agent: shellAgent(dir, seen) });
    assert.equal(result.outcome, 'success', `${JSON.stringify(value)}: ${result.reason}`);
    assert.equal(await readFile(path.join(dir, 'out.txt'), 'utf8'), value, `gate for ${JSON.stringify(value)} saw other data`);
    assert.equal(seen[0].prompt, `Task: ${value}`, 'prompts keep raw filling');
    await noPwned(dir);
  }
});

test('missing and empty values are one empty word, so the old concatenations still resolve', async t => {
  const dir = await sandbox(t), seen = [];
  const m = machineWith({ missing: undefined });
  m.states.start.gate = 'test -z {{inputs.missing}} && printf %s, {{inputs.missing}} {{results.none.text}} > out.txt';
  const result = await runWorkflow(compile(m), { agent: shellAgent(dir, seen) });
  assert.equal(result.outcome, 'success', result.reason);
  assert.equal(await readFile(path.join(dir, 'out.txt'), 'utf8'), ',,');
});

test('adjacent path parts with spaces and apostrophes form one path; a hostile slug only fails the gate', async t => {
  const root = await sandbox(t), projectDir = path.join(root, "my project's dir");
  await mkdir(path.join(projectDir, 'ai-artifacts/workflows/chip run'), { recursive: true });
  await writeFile(path.join(projectDir, 'ai-artifacts/workflows/chip run/plan.md'), '# plan');
  const gate = 'test -f {{inputs.dir}}/ai-artifacts/workflows/{{inputs.slug}}/plan.md';
  const m = machineWith({ dir: '', slug: '' });
  m.states.start.gate = gate; m.states.start.on.failed = { to: 'done' };
  const passed = await runWorkflow(compile(m), { args: { dir: projectDir, slug: 'chip run' }, agent: shellAgent(root, []) });
  assert.deepEqual(passed.history, ['start → done'], 'the gate should pass on the real path');
  const hostile = await runWorkflow(compile(m), { args: { dir: projectDir, slug: 'x; touch PWNED; echo' }, agent: shellAgent(root, []) });
  assert.deepEqual(hostile.history, ['start → failed']);
  await noPwned(root); await noPwned(projectDir);
});

test('results, visit and run.history are data in gates too', async t => {
  const dir = await sandbox(t), seen = [];
  const m = machineWith({});
  m.states.start.on.done.to = 'check';
  m.states.check = { kind: 'task', title: 'Check', role: 'coder', prompt: 'Check', gate: 'printf %s,%s,%s {{results.start.text}} {{visit}} {{run.history}} > out.txt', on: { done: { to: 'done' } } };
  const hostile = "$(touch PWNED)'`touch PWNED`'\n;touch PWNED";
  const result = await runWorkflow(compile(m), { agent: shellAgent(dir, seen, (_, options) => ({ event: 'done', text: options.label === 'start' ? hostile : 'ok' })) });
  assert.equal(result.outcome, 'success', result.reason);
  assert.equal(await readFile(path.join(dir, 'out.txt'), 'utf8'), `${hostile},1,start → done`);
  await noPwned(dir);
});

test('fanout branch gates quote values the same way', async t => {
  const dir = await sandbox(t), seen = [];
  const m = machineWith({ task: '' });
  m.states.start = { kind: 'fanout', title: 'Review', branches: [
    { id: 'a', role: 'reviewer', prompt: 'A {{inputs.task}}', gate: 'printf %s {{inputs.task}} > a.txt' },
    { id: 'b', role: 'reviewer', prompt: 'B', gate: 'printf %s {{inputs.task}}{{visit}} > b.txt' },
  ], on: { done: { to: 'done' } } };
  const value = "x'; touch PWNED; '$(touch PWNED)";
  const result = await runWorkflow(compile(m), { args: { task: value }, agent: shellAgent(dir, seen, () => 'ok') });
  assert.equal(result.outcome, 'success', result.reason);
  assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), value);
  assert.equal(await readFile(path.join(dir, 'b.txt'), 'utf8'), `${value}1`);
  assert.equal(seen.find(call => call.label === 'start:a').prompt, `A ${value}`);
  await noPwned(dir);
});

// Each would let a value run code if the gate were accepted, or needs a context-aware parser this contract avoids.
const unsafe = [
  ['double quotes', 'test -f "{{inputs.task}}"'],
  ['single quotes', "echo '{{inputs.task}}'"],
  ['a backslash', 'echo \\{{inputs.task}}'],
  ['command substitution', 'echo $({{inputs.task}})'],
  ['backticks', 'echo `cat {{inputs.task}}`'],
  ['parameter expansion', 'echo ${X:-{{inputs.task}}}'],
  ['a here-document', 'cat <<EOF\n{{inputs.task}}\nEOF'],
  ['a comment', 'true # {{inputs.task}}'],
  ['quotes elsewhere in the gate', "grep -q 'ok' {{inputs.task}}"],
  ['bash [[ arithmetic', '[[ {{inputs.task}} -eq 0 ]]'],
  ['bash (( arithmetic', '(( {{inputs.task}} ))'],
  ['a single [ test', '[ -f {{inputs.task}} ]'],
  ['a subshell', '(test -f {{inputs.task}})'],
];

test('gates that put a placeholder where quoting cannot hold are rejected before any agent runs', async t => {
  for (const [label, gate] of unsafe) {
    const dir = await sandbox(t), seen = [];
    const m = machineWith({ task: '' }); m.states.start.gate = gate;
    const problems = validateMachine(m).problems;
    assert.ok(problems.some(problem => problem.startsWith('State `start` gate ')), `${label}: validateMachine accepted ${JSON.stringify(gate)}`);
    const result = await runWorkflow(compile(m), { args: { task: '\ntouch PWNED\n' }, agent: shellAgent(dir, seen) });
    assert.equal(seen.length, 0, `${label}: an agent ran`);
    assert.equal(result.outcome, 'failure');
    assert.match(result.reason, /^start gate /, label);
    await noPwned(dir);
    const branch = machineWith({ task: '' });
    branch.states.start = { kind: 'fanout', title: 'Review', branches: [{ id: 'a', role: 'reviewer', prompt: 'A', gate }, { id: 'b', role: 'reviewer', prompt: 'B' }], on: { done: { to: 'done' } } };
    assert.ok(validateMachine(branch).problems.some(problem => problem.startsWith('State `start` branch `a` gate ')), `${label}: branch gate accepted`);
  }
});

// Review P1: bash evaluates an array subscript as arithmetic, so a single-quoted value inside [ ] still runs $(...).
const subscripts = [
  ['compound array assignment', 'a=([{{inputs.task}}]=1)', '$(touch PWNED)'],
  ['array element assignment', 'a[{{inputs.task}}]=1', 'a[$(touch PWNED)]'],
];

test('array subscript gates are rejected in validation and before any task or fanout agent runs', async t => {
  for (const [label, gate, value] of subscripts) {
    const probe = await sandbox(t);
    // bash, not /bin/sh: Ubuntu's sh is dash, which has no arrays, so the probe would never run there.
    spawnSync('bash', ['-c', gate.replace('{{inputs.task}}', shellWord(value))], { cwd: probe, encoding: 'utf8' });
    assert.deepEqual(await readdir(probe), ['PWNED'], `${label}: the quoted probe should really run in sh, or this test proves nothing`);
    const task = machineWith({ task: '' }); task.states.start.gate = gate;
    const fanout = machineWith({ task: '' });
    fanout.states.start = { kind: 'fanout', title: 'Review', branches: [{ id: 'a', role: 'reviewer', prompt: 'A', gate }, { id: 'b', role: 'reviewer', prompt: 'B' }], on: { done: { to: 'done' } } };
    /** @type {Array<[Machine, string, RegExp]>} */
    const places = [[task, 'State `start` gate ', /^start gate /], [fanout, 'State `start` branch `a` gate ', /^start branch a gate /]];

    for (const [m, at, reason] of places) {
      assert.ok(validateMachine(m).problems.some(problem => problem.startsWith(at)), `${label}: validateMachine accepted ${JSON.stringify(gate)} at ${at}`);
      const dir = await sandbox(t), seen = [];
      const result = await runWorkflow(compile(m), { args: { task: value }, agent: shellAgent(dir, seen, () => 'ok') });
      assert.equal(seen.length, 0, `${label}: an agent ran at ${at}: ${result.outcome}`);
      assert.match(String(result.reason), reason, label);
      await noPwned(dir);
    }
  }
});

test('gates without placeholders keep full shell syntax; bare placeholder gates stay valid', () => {
  for (const gate of ['npm test', 'test "$(git status --porcelain)" = "" # clean', 'test -f {{inputs.task}}/plan.md && npm test -- --grep=gate', 'test {{inputs.task}} = done || exit 1']) {
    const m = machineWith({ task: '' }); m.states.start.gate = gate;
    assert.deepEqual(validateMachine(m).problems, [], gate);
  }
});

test('CLI set refuses an unsafe gate and keeps the file; a bare placeholder gate saves', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-gate-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../fixtures/playground', import.meta.url), dir, { recursive: true });
  const entry = fileURLToPath(new URL('../bin/studio.ts', import.meta.url)), file = path.join(dir, '.pi/workflows/build.js');
  const run = args => spawnSync(process.execPath, [entry, ...args, '--project', dir], { encoding: 'utf8' });
  const before = await readFile(file, 'utf8');
  const refused = run(['set', 'build', 'build', 'gate=test -f "{{inputs.slug}}"']);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /State `build` gate uses \{\{inputs\.slug\}\} with "/);
  assert.equal(await readFile(file, 'utf8'), before);
  const saved = run(['set', 'build', 'build', 'gate=test -f {{inputs.dir}}/ai-artifacts/workflows/{{inputs.slug}}/plan.md']);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(/** @type {Machine} */ (extract(await readFile(file, 'utf8'))).states.build.gate, 'test -f {{inputs.dir}}/ai-artifacts/workflows/{{inputs.slug}}/plan.md');
});
