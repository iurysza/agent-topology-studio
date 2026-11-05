// Pins behaviour the Effect refactor must keep: raw Node errors, error shapes and rejection timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, rm, chmod, mkdir, symlink, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { openProject, StaleError } from '../server/project.ts';
import { RoleError } from '../server/roles.ts';
import { RunIdError } from '../server/runs.ts';
import { createServer } from '../server/http.ts';
import { hashText } from '../server/check.ts';
import { compile, extract } from '../shared/machine.ts';

const entry = fileURLToPath(new URL('../bin/studio.ts', import.meta.url));
const asRoot = process.getuid?.() === 0;

async function playground(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-parity-'));
  // Removing a mode 000 file needs only write access to its directory, so no chmod restore is needed.
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../fixtures/playground', import.meta.url), dir, { recursive: true });
  return dir;
}

async function serve(t, project) {
  const server = createServer({ project, token: 'token', webRoot: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.close(() => resolve(undefined)); server.closeAllConnections(); }));
  // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name or null.
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  /** @param {string} route @param {string} [method] @param {string} [body] */
  return async (route, method = 'GET', body = undefined) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'X-Studio-Token': 'token' }, ...(body === undefined ? {} : { body }) });
    // SAFETY: every /api route answers with a JSON object.
    return { status: response.status, data: /** @type {Record<string, string>} */ (await response.json()) };
  };
}

test('an unreadable workflow gives HTTP 500 with the raw EACCES message', { skip: asRoot }, async t => {
  t.mock.method(console, 'error', () => {});
  const dir = await playground(t);
  await chmod(path.join(dir, '.pi/workflows/build.js'), 0o000);
  const request = await serve(t, await openProject(dir));
  const result = await request('/api/workflows/build');

  assert.equal(result.status, 500);
  assert.deepEqual(Object.keys(result.data).sort(), ['detail', 'error']);
  assert.equal(result.data.error, 'Server error');
  assert.match(result.data.detail, /^EACCES: permission denied, open '.*build\.js'$/);
});

test('an unreadable workflow makes the CLI print the raw EACCES message and exit 1', { skip: asRoot }, async t => {
  const dir = await playground(t);
  await chmod(path.join(dir, '.pi/workflows/build.js'), 0o000);
  const result = spawnSync(process.execPath, [entry, 'get', 'build', '--project', dir], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^EACCES: permission denied, open '.*build\.js'\n$/);
});

test('a stale write rejects with StaleError carrying both hashes', async t => {
  const project = await openProject(await playground(t));
  const { code, sha256 } = await project.readScript('build');
  const error = await project.writeScript('build', 'x', 'wrong').then(() => null, e => e);

  assert.ok(error instanceof StaleError);
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'The file changed on disk since it was loaded. Reload before saving.');
  assert.equal(error.baseSha256, 'wrong');
  assert.equal(error.currentSha256, sha256);
  assert.equal(sha256, hashText(code));
});

test('unsafe names reject the returned promise instead of throwing synchronously', async t => {
  const project = await openProject(await playground(t));
  const unsafeWorkflow = error => error.constructor === Error && error.message === 'Unsafe workflow name';
  const badRole = error => error instanceof RoleError && error.message === 'Role name must use lowercase letters, digits, and hyphens, starting with a letter';
  /** @type {Array<[string, () => Promise<unknown>, (error: any) => boolean]>} */
  const calls = [
    ['readScript', () => project.readScript('../x'), unsafeWorkflow],
    ['writeScript', () => project.writeScript('../x', 'x', null), unsafeWorkflow],
    ['deleteScript', () => project.deleteScript('../x'), unsafeWorkflow],
    ['readRole', () => project.readRole('Bad'), badRole],
    ['writeRole', () => project.writeRole('../x', { color: 'blue' }, '', null), badRole],
    ['createRole', () => project.createRole({ name: 'Bad' }), badRole],
  ];

  for (const [name, call, expected] of calls) {
    const pending = call();
    assert.ok(pending instanceof Promise, name);
    await assert.rejects(pending, expected, name);
  }
});

test('an unreadable run journal gives HTTP 500 with the raw EACCES message', { skip: asRoot }, async t => {
  t.mock.method(console, 'error', () => {});
  const dir = await playground(t), journal = path.join(dir, '.pi/workflows/council-split.workflow.jsonl');
  await cp(new URL('../fixtures/runs/council-split.workflow.jsonl', import.meta.url), journal);
  await chmod(journal, 0o000);
  const request = await serve(t, await openProject(dir));
  const result = await request('/api/runs');

  assert.equal(result.status, 500);
  assert.deepEqual(Object.keys(result.data).sort(), ['detail', 'error']);
  assert.equal(result.data.error, 'Server error');
  assert.match(result.data.detail, /^EACCES: permission denied, open '.*council-split\.workflow\.jsonl'$/);
});

test('unsafe run and workflow ids reject the returned promise instead of throwing synchronously', async t => {
  const project = await openProject(await playground(t));
  /** @type {Array<[string, () => Promise<unknown>, string]>} */
  const calls = [
    ['readRun', () => project.readRun('../x'), 'Invalid run id'],
    ['listRuns', () => project.listRuns('../x'), 'Invalid workflow id'],
  ];

  for (const [name, call, message] of calls) {
    const pending = call();
    assert.ok(pending instanceof Promise, name);
    await assert.rejects(pending, error => error instanceof RunIdError && error instanceof Error && error.message === message, name);
  }
});

test('every mapped HTTP error keeps its exact status and body', async t => {
  const dir = await playground(t), project = await openProject(dir), request = await serve(t, project);
  const { sha256 } = await project.readScript('build');
  const machine = JSON.stringify({ machine: (await request('/api/workflows/build')).data.machine, hash: 'wrong' });
  /** @type {Array<[string, string, string | undefined, number, unknown]>} */
  const cases = [
    ['/api/workflows/build', 'PUT', machine, 409, { error: 'The file changed on disk since it was loaded. Reload before saving.', hash: sha256 }],
    ['/api/roles/Bad', 'GET', undefined, 422, { error: 'Role name must use lowercase letters, digits, and hyphens, starting with a letter' }],
    ['/api/roles', 'POST', JSON.stringify({ name: 'coder' }), 422, { error: 'Role `coder` already exists' }],
    ['/api/runs/..%2Fx', 'GET', undefined, 400, { error: 'Invalid run id' }],
    ['/api/runs?workflow=..%2Fx', 'GET', undefined, 400, { error: 'Invalid workflow id' }],
    ['/api/%E0', 'GET', undefined, 400, { error: 'Invalid URL' }],
    ['/api/compile', 'POST', '[]', 400, { error: 'Expected a JSON object' }],
    ['/api/compile', 'POST', 'x'.repeat(2097153), 413, { error: 'JSON body exceeds 2097152 bytes' }],
    ['/api/runs/nope', 'GET', undefined, 404, { error: 'Run not found' }],
    ['/api/roles/nope', 'GET', undefined, 404, { error: 'Role not found' }],
    ['/api/roles/coder', 'PUT', '{}', 400, { error: 'baseHash is required' }],
    ['/api/workflows', 'POST', JSON.stringify({ id: 'Bad' }), 400, { error: 'Invalid workflow id' }],
    ['/api/workflows/a%20b', 'GET', undefined, 400, { error: 'Invalid workflow id' }],
    ['/api/workflows/nope', 'GET', undefined, 404, { error: 'Workflow not found' }],
    ['/api/workflows/nope', 'DELETE', undefined, 404, { error: 'Workflow not found' }],
    ['/api/workflows/build', 'PUT', JSON.stringify({ machine: JSON.parse(machine).machine }), 400, { error: 'hash is required' }],
  ];

  for (const [route, method, body, status, data] of cases) {
    const result = await request(route, method, body);
    assert.deepEqual(result, { status, data }, `${method} ${route}`);
  }
});

test('a workflow directory outside the project gives HTTP 422 with the path message', async t => {
  const dir = await playground(t), outside = await mkdtemp(path.join(os.tmpdir(), 'studio-parity-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await rm(path.join(dir, '.pi/workflows'), { recursive: true });
  await mkdir(path.join(outside, 'workflows'));
  await symlink(path.join(outside, 'workflows'), path.join(dir, '.pi/workflows'));
  const request = await serve(t, await openProject(dir));

  assert.deepEqual(await request('/api/project'), { status: 422, data: { error: 'Workflow and role paths must stay inside the project' } });
});

test('creating an existing role rejects with RoleError', async t => {
  const project = await openProject(await playground(t));

  await assert.rejects(project.createRole({ name: 'coder' }), error => error instanceof RoleError && error.message === 'Role `coder` already exists');
});

test('CLI check on an invalid workflow keeps its exact stderr, with and without --json', async t => {
  const dir = await playground(t), file = path.join(dir, '.pi/workflows/build.js');
  const machine = /** @type {import('../shared/machine.ts').Machine} a valid playground workflow */ (extract(await readFile(file, 'utf8')));
  machine.initial = 'missing'; machine.states.qa.prompt += ' {{inputs.nope}}';
  await writeFile(file, compile(machine));
  const problems = ['build: Initial state `missing` does not exist.',
    ...['build', 'review', 'agree', 'fix', 'qa', 'report', 'shipped', 'gave_up'].map(id => `build: State \`${id}\` is unreachable from the initial state.`)];
  const warnings = ['build: State `qa` uses unknown placeholder `{{inputs.nope}}`.'];
  const cli = (...args) => spawnSync(process.execPath, [entry, 'check', 'build', '--project', dir, ...args], { encoding: 'utf8' });

  const text = cli(), json = cli('--json');
  assert.deepEqual({ status: text.status, stdout: text.stdout, stderr: text.stderr },
    { status: 1, stdout: '', stderr: `${[...problems, ...warnings.map(w => `Warning: ${w}`)].join('\n')}\n` });
  assert.deepEqual({ status: json.status, stdout: json.stdout, stderr: json.stderr },
    { status: 1, stdout: '', stderr: `${JSON.stringify({ problems, warnings }, null, 2)}\n` });
});

test('CLI new with an invalid id prints Invalid workflow id and exits 1', async t => {
  const dir = await playground(t);
  const cli = (...args) => spawnSync(process.execPath, [entry, 'new', 'bad_id', '--project', dir, ...args], { encoding: 'utf8' });

  const text = cli(), json = cli('--json');
  assert.deepEqual({ status: text.status, stdout: text.stdout, stderr: text.stderr }, { status: 1, stdout: '', stderr: 'Invalid workflow id\n' });
  assert.deepEqual({ status: json.status, stdout: json.stdout, stderr: json.stderr },
    { status: 1, stdout: '', stderr: `${JSON.stringify({ problems: ['Invalid workflow id'], warnings: [] }, null, 2)}\n` });
});
