import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { compile, extract } from '../shared/machine.ts';
const entry = fileURLToPath(new URL('../bin/studio.ts', import.meta.url));
async function project(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../fixtures/playground', import.meta.url), dir, { recursive: true });
  return dir;
}
function run(dir, args, input) {
  return spawnSync(process.execPath, [entry, ...args, '--project', dir], { encoding: 'utf8', input });
}
function ok(result) { assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout; }
function json(dir, args, input) { return JSON.parse(ok(run(dir, [...args, '--json'], input))); }
const script = (dir, id) => path.join(dir, '.pi/workflows', `${id}.js`);
/** @typedef {import('../shared/machine.ts').Machine} Machine */
/** @returns {Promise<Machine>} a stored playground workflow, which validateMachine accepts */
async function machine(dir, id) { return /** @type {Machine} */ (extract(await readFile(script(dir, id), 'utf8'))); }

test('CLI refusals of the tool repo and fixtures/ add the --project playground hint', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  for (const [dir, message] of [[repo, "This is the tool's own repo"], [path.join(repo, 'fixtures/playground'), 'fixtures/ is read only']]) {
    const result = run(dir, ['list']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), `${message} (try --project playground)`);
  }
});

test('CLI help and unknown flags print usage without building the app', () => {
  for (const flag of ['--help', '-h', '--unknown', '-x']) {
    const result = spawnSync(process.execPath, [entry, flag, '--rebuild'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, ['--help', '-h'].includes(flag) ? 0 : 1, result.stderr || result.error?.message);
    assert.match(result.stdout, /^Usage:/);
    assert.doesNotMatch(result.stdout, /Installing dependencies|Building web app|Topology studio:/);
  }
});

// D13 option B: the temporary bin/studio.js shim must behave exactly like bin/studio.ts until it is removed.
test('the temporary bin/studio.js shim matches bin/studio.ts byte for byte', async t => {
  const shim = fileURLToPath(new URL('../bin/studio.js', import.meta.url));
  assert.equal(await readFile(shim, 'utf8'), "#!/usr/bin/env node\nimport './studio.ts';\n");
  const dir = await project(t);

  for (const args of [['--help'], ['--bogus'], ['list', '--project', dir], ['list', '--project', dir, '--json'], ['show', 'nope', '--project', dir], ['bogus', '--project', dir]]) {
    const [viaShim, direct] = [shim, entry].map(file => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 10_000 }));
    assert.deepEqual({ status: viaShim.status, stdout: viaShim.stdout, stderr: viaShim.stderr }, { status: direct.status, stdout: direct.stdout, stderr: direct.stderr }, args.join(' '));
  }
});

test('studio rejects bad server arguments before installing or building', async t => {
  const dir = await project(t);
  const port = spawnSync(process.execPath, [entry, '--port', 'abc', '--rebuild', '--project', dir], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(port.status, 1); assert.match(port.stderr, /Port must be 0 to 65535/);
  assert.doesNotMatch(port.stdout, /Installing dependencies|Building web app/);
  const missing = spawnSync(process.execPath, [entry, '--port', 'abc', '--rebuild'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /--project <dir> is required/);
  assert.doesNotMatch(missing.stdout, /Installing dependencies|Building web app/);
});

test('server help runs without a project and flags are read left to right', () => {
  const main = fileURLToPath(new URL('../server/main.ts', import.meta.url));
  const help = spawnSync(process.execPath, [main, '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /^Usage:/); assert.match(help.stdout, /--api-only/);
  const bogus = spawnSync(process.execPath, [main, '--bogus', '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(bogus.status, 1); assert.match(bogus.stderr, /Invalid or missing argument: --bogus/);
  const late = spawnSync(process.execPath, [main, '--port', 'abc', '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(late.status, 0, late.stderr);
});

test('server entrypoints document runs-from and reject its missing value', () => {
  for (const file of [entry, fileURLToPath(new URL('../server/main.ts', import.meta.url))]) {
    const help = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /\[--runs-from <dir>\]/);
    const missing = spawnSync(process.execPath, [file, '--runs-from'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /Invalid or missing argument: --runs-from/);
  }
});

test('CLI list, show, get, refs, check and roles read the project without building the app', async t => {
  const dir = await project(t), listing = json(dir, ['list']);
  assert.deepEqual(listing.map(w => w.id), ['build', 'council', 'plan']); assert.ok(listing.every(w => w.editable && w.states > 0));
  assert.match(ok(run(dir, ['list'])), /build.*Build an approved plan.*states/);
  const shown = ok(run(dir, ['show', 'build']));
  assert.match(shown, /build \[task\].*role: coder/); assert.match(shown, /review \[fanout\]/); assert.match(shown, /a \(role: reviewer\)/); assert.match(shown, /fail -> build/);
  assert.deepEqual(json(dir, ['show', 'build']), await machine(dir, 'build'));
  assert.deepEqual(JSON.parse(ok(run(dir, ['get', 'build']))), await machine(dir, 'build'));
  const refs = json(dir, ['refs', 'build', 'qa']); assert.ok(refs.some(ref => ref.path === 'inputs.dir')); assert.ok(!refs.some(ref => ref.path.startsWith('results.qa.')));
  assert.ok(!json(dir, ['refs', 'build', 'review.a']).some(ref => ref.path.startsWith('results.review.')));
  assert.ok(json(dir, ['refs', 'build']).some(ref => ref.path === 'results.qa.report'));
  assert.match(ok(run(dir, ['refs', 'build', 'qa'])), /inputs.dir.*input/);
  assert.deepEqual(json(dir, ['check']).map(r => r.id), ['build', 'council', 'plan']); assert.deepEqual(json(dir, ['check', 'plan'])[0].problems, []);
  assert.match(ok(run(dir, ['check', 'build'])), /build: OK/);
  const roles = json(dir, ['roles']); assert.ok(roles.some(role => role.name === 'coder' && role.color === 'green'));
  assert.match(ok(run(dir, ['roles'])), /coder.*green.*gpt-6.1-sol/);
  const role = json(dir, ['role', 'coder']); assert.equal(role.role.name, 'coder'); assert.match(role.body, /coder subagent/);
  assert.match(ok(run(dir, ['role', 'coder'])), /color: green/);
  const cwd = spawnSync(process.execPath, [entry, 'list', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(ok(cwd)), listing);
});
test('CLI catalog exposes sorted deduplicated tool and skill names', async t => {
  const dir = await project(t), catalog = json(dir, ['catalog']);
  assert.ok(catalog.tools.includes('Agent')); assert.ok(catalog.tools.includes('SubagentWorkflow'));
  assert.ok(catalog.skills.includes('coding-standards'));
  assert.deepEqual(catalog.tools, [...new Set(catalog.tools)].sort());
  assert.deepEqual(catalog.skills, [...new Set(catalog.skills)].sort());
  assert.match(ok(run(dir, ['catalog'])), /^Tools: .*\nSkills: /);
  assert.notEqual(run(dir, ['catalog', 'unexpected']).status, 0);
});
test('CLI new and put validate file, explicit stdin and default stdin before writing', async t => {
  const dir = await project(t), created = json(dir, ['new', 'demo', '--name', 'Demo workflow']);
  assert.equal(created.machine.name, 'Demo workflow'); assert.equal(created.hash, createHash('sha256').update(await readFile(script(dir, 'demo'))).digest('hex')); assert.deepEqual(created.warnings, []);
  const m = await machine(dir, 'demo'); m.description = 'Changed through stdin';
  assert.equal(json(dir, ['put', 'demo', '-'], JSON.stringify(m)).machine.description, m.description);
  m.name = 'Changed through default stdin'; ok(run(dir, ['put', 'demo'], JSON.stringify(m)));
  assert.equal((await machine(dir, 'demo')).name, m.name);
  m.description = 'Changed through a file'; const file = path.join(dir, 'machine.json'); await writeFile(file, JSON.stringify(m));
  assert.match(ok(run(dir, ['put', 'demo', file])), /Saved demo/);
  assert.deepEqual(await machine(dir, 'demo'), m);
  assert.deepEqual(json(dir, ['get', 'demo']), m);
  assert.ok(!(await readdir(path.dirname(script(dir, 'demo')))).some(name => name.endsWith('.tmp')));
});
test('CLI set, link, unlink, rename and rm apply shared edits', async t => {
  const dir = await project(t);
  const saved = json(dir, ['set', 'build', 'qa', 'title=QA gate', 'role=reviewer', 'prompt=Check {{inputs.dir}} = project', 'maxVisits=5']);
  assert.equal(saved.machine.states.qa.title, 'QA gate'); assert.equal(saved.machine.states.qa.role, 'reviewer');
  assert.equal(saved.machine.states.qa.maxVisits, 5); assert.equal(saved.machine.states.qa.prompt, 'Check {{inputs.dir}} = project');
  ok(run(dir, ['set', 'build', 'build', 'kind=decision'])); assert.equal((await machine(dir, 'build')).states.build.kind, 'decision');
  ok(run(dir, ['set', 'build', 'qa', 'maxVisits='])); assert.ok(!Object.hasOwn((await machine(dir, 'build')).states.qa, 'maxVisits'));
  ok(run(dir, ['set', 'build', 'gave_up', 'outcome=success'])); assert.equal((await machine(dir, 'build')).states.gave_up.outcome, 'success');
  json(dir, ['link', 'build', 'build', 'implemented', 'review', '--description', 'Ready to review']);
  assert.deepEqual((await machine(dir, 'build')).states.build.on.implemented, { to: 'review', description: 'Ready to review' });
  ok(run(dir, ['unlink', 'build', 'build', 'built'])); assert.deepEqual(Object.keys((await machine(dir, 'build')).states.build.on), ['implemented']);
  const renamed = json(dir, ['rename', 'build', 'build', 'implement']).machine;
  assert.equal(renamed.initial, 'implement'); assert.equal(renamed.states.qa.on.fail.to, 'implement'); assert.ok(!Object.hasOwn(renamed.states, 'build'));
  json(dir, ['link', 'build', 'review', 'settled', 'agree', '--description', 'Both reviewed']);
  assert.deepEqual((await machine(dir, 'build')).states.review.on, { settled: { to: 'agree', description: 'Both reviewed' } });
  ok(run(dir, ['new', 'disposable'])); assert.deepEqual(json(dir, ['rm', 'disposable']), { id: 'disposable', removed: true });
  assert.ok(!json(dir, ['list']).some(w => w.id === 'disposable'));
});
test('CLI set stores and clears task gates and rejects unsupported state kinds', async t => {
  const dir = await project(t);
  const saved = json(dir, ['set', 'build', 'build', 'gate=npm test']);
  assert.equal(saved.machine.states.build.gate, 'npm test');
  assert.equal((await machine(dir, 'build')).states.build.gate, 'npm test');
  ok(run(dir, ['set', 'build', 'build', 'kind=task']));
  assert.equal((await machine(dir, 'build')).states.build.gate, 'npm test');
  ok(run(dir, ['set', 'build', 'build', 'gate=']));
  assert.ok(!Object.hasOwn((await machine(dir, 'build')).states.build, 'gate'));
  const original = await readFile(script(dir, 'build'), 'utf8');
  for (const [state, gate] of [['qa', 'npm test'], ['review', 'npm test'], ['shipped', 'npm test'], ['build', '  ']]) {
    const result = run(dir, ['set', 'build', state, `gate=${gate}`]);
    assert.equal(result.status, 1); assert.match(result.stderr, /gate (is only allowed on task states|must be a non-empty shell command string)/);
    assert.equal(await readFile(script(dir, 'build'), 'utf8'), original);
  }
  ok(run(dir, ['set', 'build', 'build', 'gate=npm test']));
  ok(run(dir, ['set', 'build', 'build', 'kind=decision']));
  assert.ok(!Object.hasOwn((await machine(dir, 'build')).states.build, 'gate'));
  assert.match(ok(run(dir, ['set', '--help'])), /prompt, gate, maxVisits/);
});
test('CLI rename rewrites result references and check has no warnings', async t => {
  const dir = await project(t);
  ok(run(dir, ['new', 'demo'])); ok(run(dir, ['add-state', 'demo', 'report', '--after', 'start']));
  ok(run(dir, ['set', 'demo', 'report', 'prompt={{results.start.text}}']));
  const renamed = json(dir, ['rename', 'demo', 'start', 'work']);
  assert.equal(renamed.machine.states.report.prompt, '{{results.work.text}}');
  assert.deepEqual(json(dir, ['check', 'demo'])[0], { id: 'demo', problems: [], warnings: [] });
});
test('CLI put rejects unsafe defaults and invalid field names without writing', async t => {
  const dir = await project(t), original = await readFile(script(dir, 'build'), 'utf8');
  for (const name of ['bad-name', 'with.dot', 'with space', 'Upper', '1name']) for (const input of [true, false]) {
    const m = extract(original), field = /** @type {Record<string, import('../shared/machine.ts').Field>} */ ({ [name]: { type: 'string' } });
    if (input) m.inputs = field; else m.states.build.output = field;
    const result = run(dir, ['put', 'build', '-'], JSON.stringify(m));
    assert.equal(result.status, 1); assert.match(result.stderr, /invalid name; use snake_case/);
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const m = extract(original); m.inputs = { payload: { type: 'array', default: [{ nested: JSON.parse(`{"${key}": 1}`) }] } };
    const result = run(dir, ['put', 'build', '-'], JSON.stringify(m));
    assert.equal(result.status, 1); assert.match(result.stderr, /default uses a reserved key/);
  }
  assert.equal(await readFile(script(dir, 'build'), 'utf8'), original);
});
test('CLI add-state --after makes a reachable state and keeps a continuation', async t => {
  const dir = await project(t);
  const added = json(dir, ['add-state', 'build', 'audit', '--after', 'fix', '--kind', 'decision', '--role', 'reviewer', '--title', 'Audit changes']);
  assert.equal(added.machine.states.audit.kind, 'decision'); assert.equal(added.machine.states.audit.role, 'reviewer'); assert.equal(added.machine.states.audit.title, 'Audit changes');
  assert.ok(Object.values(added.machine.states.fix.on).some(event => event.to === 'audit'));
  assert.deepEqual(added.machine.states.audit.on, { done: { to: 'qa' } });
  assert.ok(added.warnings.some(warning => warning.includes('only one event')));
  const fanout = json(dir, ['add-state', 'build', 'second_review', '--after', 'review', '--kind', 'fanout']);
  assert.equal(fanout.machine.states.review.on.done.to, 'second_review'); assert.equal(fanout.machine.states.second_review.on.done.to, 'agree');
  assert.equal(fanout.machine.states.second_review.branches.length, 2);
  const final = json(dir, ['add-state', 'build', 'early_exit', '--after', 'qa', '--kind', 'final']);
  assert.equal(final.machine.states.early_exit.outcome, 'success'); assert.ok(!Object.hasOwn(final.machine.states.early_exit, 'on'));
  assert.equal(run(dir, ['check', 'build']).status, 0);
});
test('CLI role new creates frontmatter and refuses duplicates or invalid names', async t => {
  const dir = await project(t), created = json(dir, ['role', 'new', 'new-reviewer', '--description', 'Review the change', '--color', 'purple', '--model', 'example/model']);
  assert.equal(created.role.name, 'new-reviewer'); assert.equal(created.role.description, 'Review the change'); assert.equal(created.role.color, 'purple'); assert.equal(created.role.model, 'example/model');
  assert.deepEqual(json(dir, ['role', 'new-reviewer']), created);
  const file = path.join(dir, '.pi/agents/new-reviewer.md'), original = await readFile(file, 'utf8');
  for (const args of [['role', 'new', 'new-reviewer'], ['role', 'new', 'Bad'], ['role', 'new', '../outside']]) assert.equal(run(dir, args).status, 1);
  assert.equal(await readFile(file, 'utf8'), original);
});
test('CLI role new accepts all fields and body from stdin or a file', async t => {
  const dir = await project(t), body = 'Review the change.\n\nPreserve the prompt exactly.\n';
  const flags = ['--description', 'Review changes', '--color', 'purple', '--model', 'example/model', '--thinking', 'custom-level', '--tools', 'read,bash, grep,find, ls', '--skills', 'coding-standards,technical-writing'];
  const file = path.join(dir, 'prompt.md'); await writeFile(file, body);
  for (const [name, source] of [['stdin-role', '-'], ['file-role', file]]) {
    const created = json(dir, ['role', 'new', name, ...flags, '--body', source], source === '-' ? body : undefined);
    assert.deepEqual(created.role, { name, description: 'Review changes', color: 'purple', model: 'example/model', thinking: 'custom-level', tools: ['read', 'bash', 'grep', 'find', 'ls'], skills: ['coding-standards', 'technical-writing'] });
    assert.equal(created.body, body);
    assert.equal(await readFile(path.join(dir, '.pi/agents', `${name}.md`), 'utf8'), '---\ndescription: "Review changes"\ncolor: "purple"\nmodel: "example/model"\nthinking: "custom-level"\ntools: "read, bash, grep, find, ls"\nskills: "coding-standards, technical-writing"\n---\n' + body);
  }
  const before = (await readdir(path.join(dir, '.pi/agents'))).sort();
  for (const args of [
    ['role', 'new', 'invalid-tools', '--tools', 'read,ba\nsh'],
    ['role', 'new', 'typo-role', '--thinkin', 'high'],
    ['role', 'new', 'missing-body', '--body', path.join(dir, 'missing.md')],
    ['role', 'stdin-role', '--thinking', 'high'],
  ]) {
    const result = run(dir, args); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.ok(result.stderr);
    assert.deepEqual((await readdir(path.join(dir, '.pi/agents'))).sort(), before);
  }
  assert.match(ok(run(dir, ['role', '--help'])), /role new <name> \[--description <text>\] \[--color <color>\] \[--model <model>\] \[--thinking <level>\] \[--tools <csv>\] \[--skills <csv>\] \[--body <file\|->\]/);
});
test('CLI validation failures print problems on stderr and leave scripts untouched', async t => {
  const dir = await project(t), original = await readFile(script(dir, 'build'), 'utf8');
  for (const args of [
    ['set', 'build', 'qa', 'maxVisits=0'], ['set', 'build', 'qa', 'kind=wait'], ['set', 'build', 'qa', 'other=x'],
    ['set', 'build', 'missing', 'title=No'], ['set', 'build', 'qa', 'title'], ['set', 'build', 'qa', 'maxVisits=NaN'],
    ['add-state', 'build', 'detached'], ['add-state', 'build', 'bad-id', '--after', 'fix'], ['add-state', 'build', 'qa', '--after', 'fix'],
    ['add-state', 'build', 'unused', '--after', 'missing'], ['add-state', 'build', 'unused', '--after', 'shipped'],
    ['link', 'build', 'qa', 'broken', 'missing'], ['link', 'build', 'qa', 'Bad Event', 'build'], ['link', 'build', 'shipped', 'again', 'build'],
    ['unlink', 'build', 'fix', 'fixed'], ['unlink', 'build', 'qa', 'missing'], ['rename', 'build', 'qa', 'build'], ['rename', 'build', 'qa', 'Bad'],
    ['new', 'build'], ['new', '../outside'], ['put', 'missing', '-'], ['refs', 'build', 'missing'], ['refs', 'build', 'review.missing'],
  ]) {
    const result = run(dir, args, '{}'); assert.equal(result.status, 1, args.join(' ')); assert.equal(result.stdout, '', args.join(' ')); assert.ok(result.stderr, args.join(' '));
    assert.equal(await readFile(script(dir, 'build'), 'utf8'), original, args.join(' '));
  }
  const invalid = await machine(dir, 'build'); invalid.initial = 'missing';
  const result = run(dir, ['put', 'build', '-', '--json'], JSON.stringify(invalid));
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.ok(JSON.parse(result.stderr).problems.some(problem => problem.includes('Initial state')));
  for (const text of ['{invalid', 'null', JSON.stringify({ ...invalid, id: 'wrong' })]) assert.equal(run(dir, ['put', 'build', '-'], text).status, 1);
  assert.equal(await readFile(script(dir, 'build'), 'utf8'), original);
  assert.deepEqual((await readdir(path.dirname(script(dir, 'build')))).sort(), ['build.js', 'council.js', 'plan.js']);
});
test('CLI check reports stored problems and warnings without changing files', async t => {
  const dir = await project(t), m = await machine(dir, 'build');
  m.initial = 'missing'; await writeFile(script(dir, 'build'), compile(m));
  const before = await readFile(script(dir, 'build'), 'utf8');
  for (const args of [['check'], ['check', 'build']]) {
    const result = run(dir, args); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /build: Initial state `missing`/);
  }
  const failedJson = run(dir, ['check', '--json']); assert.ok(JSON.parse(failedJson.stderr).problems.length);
  assert.equal(await readFile(script(dir, 'build'), 'utf8'), before);
  m.initial = 'build'; m.states.qa.prompt += ' {{inputs.nope}}'; await writeFile(script(dir, 'build'), compile(m));
  const checked = run(dir, ['check', 'build']); assert.equal(checked.status, 0); assert.match(checked.stderr, /unknown placeholder/);
  assert.ok(json(dir, ['check', 'build'])[0].warnings.some(warning => warning.includes('inputs.nope')));
});
test('CLI reference examples run against a temporary fixture copy', async t => {
  const dir = await project(t), doc = await readFile(new URL('../reference/cli.md', import.meta.url), 'utf8');
  const examples = [...doc.matchAll(/```sh\n([\s\S]*?)```/g)].slice(1).map(match => match[1]);
  assert.equal(examples.length, 3);
  for (const example of examples) {
    const shell = `set -euo pipefail\nstudio() { ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@" --project ${JSON.stringify(dir)}; }\n${example}`;
    ok(spawnSync('/bin/bash', ['-c', shell], { encoding: 'utf8' }));
  }
  const qa = await machine(dir, 'checked-build');
  assert.equal(qa.states.qa.on.retry.to, 'start'); assert.equal(qa.states.qa.on.pass.to, 'done');
  assert.ok(Object.values(qa.states.start.on).every(event => event.to === 'qa'));
  const build = await machine(dir, 'build');
  assert.equal(build.states.build.on.implemented.to, 'review'); assert.ok(!Object.hasOwn(build.states.build.on, 'built'));
  assert.equal(build.inputs.target.required, true); assert.match(build.states.build.prompt, /\{\{inputs.target\}\}/);
});
test('CLI handles hand-written workflows, missing names and invalid command arguments', async t => {
  const dir = await project(t), code = "export const meta = { name: 'manual', description: 'Manual' }; return {};";
  await writeFile(script(dir, 'manual'), code);
  assert.equal(json(dir, ['list']).find(w => w.id === 'manual').editable, false);
  assert.equal(json(dir, ['check', 'manual'])[0].problems.length, 0);
  for (const args of [['get', 'manual'], ['put', 'manual', '-'], ['show', 'missing'], ['check', 'missing'], ['rm', 'missing'], ['role', 'missing'], ['role', '../outside'], ['unknown'], ['show'], ['list', 'extra'], ['list', '--unknown'], ['list', '--title', 'ignored']]) {
    const result = run(dir, args, '{}'); assert.equal(result.status, 1, args.join(' ')); assert.ok(result.stderr, args.join(' ')); assert.equal(result.stdout, '');
  }
  assert.equal(await readFile(script(dir, 'manual'), 'utf8'), code);
  assert.match(ok(run(dir, ['list', '--help'])), /Usage: studio/);
  ok(run(dir, ['rm', 'manual'])); assert.ok(!json(dir, ['list']).some(w => w.id === 'manual'));
});
