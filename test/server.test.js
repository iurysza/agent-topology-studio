import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, cp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openProject } from '../server/project.ts';
import { createServer } from '../server/http.ts';
import { extract } from '../shared/machine.ts';
test('local HTTP machine contract with real filesystem and no agent process', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-http-')); t.after(() => rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project'), webRoot = path.join(root, 'web');
  await cp(new URL('../fixtures/playground', import.meta.url), projectDir, { recursive: true });
  await mkdir(webRoot); await writeFile(path.join(webRoot, 'index.html'), '<h1>Studio</h1>');
  await writeFile(path.join(root, 'secret'), 'private'); await symlink(path.join(root, 'secret'), path.join(webRoot, 'outside'));
  const project = await openProject(projectDir), server = createServer({ project, token: 'token', webRoot });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(undefined)));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  /** @param {string} route @param {unknown} [body] @param {string} [method] @param {Record<string, string>} [headers] @returns {Promise<{ status: number, data: any }>} */
  async function req(route, body, method = 'GET', headers = {}) {
    const response = await fetch(url + route, { method, headers: { 'X-Studio-Token': 'token', 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await req('/api/project', undefined, 'GET', { 'X-Studio-Token': '' })).status, 401);
  assert.equal((await req('/api/project', undefined, 'GET', { 'X-Studio-Token': 'wrong' })).status, 401);
  const badHost = await new Promise(resolve => http.get(url + '/api/project', { headers: { Host: 'evil.test', 'X-Studio-Token': 'token' } }, response => { response.resume(); resolve(response.statusCode); })); assert.equal(badHost, 403);
  const listing = await req('/api/project'); assert.equal(listing.status, 200); assert.equal(listing.data.dir, project.root);
  assert.deepEqual(listing.data.workflows.map(w => w.id), ['build', 'council', 'plan']); assert.equal(listing.data.roles.length, 11);
  assert.ok(listing.data.workflows.every(w => w.editable && w.states > 0));
  const route = '/api/workflows/build';
  const loaded = await req(route); assert.equal(loaded.status, 200); assert.equal(loaded.data.machine.id, 'build');
  assert.deepEqual(loaded.data.problems, []); assert.deepEqual(loaded.data.warnings, []); assert.equal(loaded.data.hash, createHash('sha256').update(await readFile(project.scriptPath('build'))).digest('hex'));
  assert.deepEqual(extract(loaded.data.code), loaded.data.machine);
  const invalid = { ...loaded.data.machine, initial: 'missing' };
  assert.equal((await req(route, { machine: invalid, hash: loaded.data.hash }, 'PUT')).status, 422);
  assert.equal((await project.readScript('build')).code, loaded.data.code);
  assert.equal((await req(route, { machine: loaded.data.machine }, 'PUT')).status, 400);
  const machine = structuredClone(loaded.data.machine); machine.states.build.prompt += '\n{{inputs.unknown}}'; machine.name = 'Edited build';
  const preview = await req('/api/compile', { machine }, 'POST'); assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.problems, []); assert.match(preview.data.warnings.join('\n'), /unknown placeholder/);
  assert.equal((await project.readScript('build')).code, loaded.data.code);
  const badPreview = await req('/api/compile', { machine: invalid }, 'POST'); assert.equal(badPreview.status, 200); assert.ok(badPreview.data.problems.length); assert.equal(badPreview.data.code, null);
  const saved = await req(route, { machine, hash: loaded.data.hash }, 'PUT'); assert.equal(saved.status, 200);
  assert.equal(saved.data.code, preview.data.code); assert.equal(saved.data.warnings.length, 1); assert.notEqual(saved.data.hash, loaded.data.hash);
  assert.deepEqual(extract(await readFile(project.scriptPath('build'), 'utf8')), machine);
  assert.equal((await req(route, { machine, hash: loaded.data.hash }, 'PUT')).status, 409);
  assert.equal((await req(route, { machine, hash: saved.data.hash }, 'PUT')).status, 200);
  await writeFile(project.scriptPath('build'), saved.data.code + '\n// external edit');
  assert.equal((await req(route, { machine, hash: saved.data.hash }, 'PUT')).status, 409);
  assert.match((await project.readScript('build')).code, /external edit/);
  assert.equal((await req(route, { machine: { ...machine, id: 'other' }, hash: saved.data.hash }, 'PUT')).status, 422);
  const created = await req('/api/workflows', { id: 'new-machine' }, 'POST'); assert.equal(created.status, 201);
  assert.equal(created.data.machine.initial, 'start'); assert.equal(created.data.machine.states.done.kind, 'final');
  assert.equal((await req('/api/workflows', { id: 'new-machine' }, 'POST')).status, 409);
  assert.deepEqual((await req('/api/workflows/new-machine')).data, created.data);
  assert.equal((await req('/api/workflows/new-machine', undefined, 'DELETE')).status, 200);
  assert.equal((await req('/api/workflows/new-machine')).status, 404);
  assert.equal((await req('/api/workflows/new-machine', undefined, 'DELETE')).status, 404);
  for (const id of ['../bad', 'Bad', 'bad_name', '', null]) assert.equal((await req('/api/workflows', { id }, 'POST')).status, 400);
  assert.equal((await req('/api/workflows/bad%20name')).status, 400);
  assert.equal((await req('/api/workflows/missing')).status, 404);
  assert.equal((await req(route, undefined, 'POST')).status, 405);
  assert.equal((await req('/api/workflows/build/load', {}, 'POST')).status, 404);
  const handwritten = "export const meta = { name: 'manual', description: 'Manual workflow' }; return {};";
  await project.writeScript('manual', handwritten, null);
  const manual = await req('/api/workflows/manual'); assert.equal(manual.status, 409); assert.equal(manual.data.code, handwritten);
  const manualListing = (await req('/api/project')).data.workflows.find(w => w.id === 'manual'); assert.equal(manualListing.editable, false);
  const manualMachine = { ...machine, id: 'manual' }, manualHash = (await project.readScript('manual')).sha256;
  assert.equal((await req('/api/workflows/manual', { machine: manualMachine, hash: manualHash }, 'PUT')).status, 409);
  assert.equal((await project.readScript('manual')).code, handwritten);
  const index = await fetch(url); assert.equal(index.status, 200); assert.equal(index.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(url + '/outside')).status, 404);
  const traversal = await new Promise(resolve => http.get(url + '/%2e%2e/secret', response => { response.resume(); resolve(response.statusCode); })); assert.equal(traversal, 404);
  assert.equal((await req('/api/compile', { machine: 'x'.repeat(2097153) }, 'POST')).status, 413);
  for (const body of ['{bad', '[]', 'null']) {
    const response = await fetch(url + '/api/compile', { method: 'POST', headers: { 'X-Studio-Token': 'token' }, body });
    assert.equal(response.status, 400);
  }
  assert.deepEqual((await readdir(path.join(projectDir, '.pi'))).sort(), ['agents', 'workflows']);
});
test('HTTP returns 503 Starting when the server address is null', async t => {
  // SAFETY: the 503 path answers before it reads the project, so an empty stub stands in for it.
  const server = createServer({ project: /** @type {import('../server/project.ts').Project} */ (/** @type {unknown} */ ({})), token: 'token', webRoot: '.' });
  assert.equal(server.address(), null);
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/api/runs`;
  t.mock.method(server, 'address', () => null);
  const response = await fetch(url, { headers: { 'X-Studio-Token': 'token' } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), { error: 'Starting' });
});

test('HTTP creates complete roles in field order and rejects invalid fields without writing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-http-role-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = await openProject(root), server = createServer({ project, token: 'token', webRoot: root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/api/roles`, headers = { 'X-Studio-Token': 'token', 'Content-Type': 'application/json' };
  const body = 'Review the complete change.\n\nKeep this body.\n';
  for (const [name, tools, skills] of /** @type {[string, string | string[], string | string[]][]} */ ([
    ['csv-role', 'read, bash,grep, find, ls', ['coding-standards', 'technical-writing']],
    ['array-role', ['read', 'bash', 'grep', 'find', 'ls'], 'coding-standards,technical-writing'],
  ])) {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ name, body, skills, tools, thinking: 'custom-level', model: 'example/model', color: 'purple', description: 'Review changes' }) });
    assert.equal(response.status, 201);
    /** @type {any} */
    const created = await response.json();
    assert.deepEqual(created.role, { name, description: 'Review changes', color: 'purple', model: 'example/model', thinking: 'custom-level', tools: ['read', 'bash', 'grep', 'find', 'ls'], skills: ['coding-standards', 'technical-writing'] });
    assert.equal(created.body, body); assert.match(created.hash, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(path.join(root, '.pi/agents', `${name}.md`), 'utf8'), '---\ndescription: "Review changes"\ncolor: "purple"\nmodel: "example/model"\nthinking: "custom-level"\ntools: "read, bash, grep, find, ls"\nskills: "coding-standards, technical-writing"\n---\n' + body);
    assert.deepEqual(await project.readRole(name), created);
  }
  for (const [name, values, error] of /** @type {[string, object, string][]} */ ([
    ['typo-role', { thinkin: 'high' }, 'Unknown frontmatter field: thinkin'],
    ['bad-thinking', { thinking: 2 }, 'thinking must be a string'],
    ['bad-tools', { tools: ['read', 2] }, 'tools must be an array of names'],
    ['bad-skills', { skills: 'one,skill\nmodel: injected' }, 'skills must be an array of names'],
  ])) {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ name, ...values }) });
    assert.equal(response.status, 422); assert.deepEqual(await response.json(), { error });
    assert.equal(await project.readRole(name), null);
  }
  assert.deepEqual((await readdir(path.join(root, '.pi/agents'))).sort(), ['array-role.md', 'csv-role.md']);
});
test('concurrent HTTP saves with one base hash return 200 and 409', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-http-save-')); t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../fixtures/playground', import.meta.url), root, { recursive: true });
  const project = await openProject(root), server = createServer({ project, token: 'token', webRoot: root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/api/workflows/build`, headers = { 'X-Studio-Token': 'token', 'Content-Type': 'application/json' };
  /** @type {any} */
  const loaded = await (await fetch(url, { headers })).json();
  const responses = await Promise.all(['First save', 'Second save'].map(name => fetch(url, { method: 'PUT', headers, body: JSON.stringify({ machine: { ...loaded.machine, name }, hash: loaded.hash }) })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  /** @type {any} */
  const saved = await responses.find(response => response.status === 200).json();
  /** @type {any} */
  const stale = await responses.find(response => response.status === 409).json();
  assert.equal(stale.hash, saved.hash); assert.equal((await project.readScript('build')).sha256, saved.hash);
});
test('HTTP rejects workflow and role symlink escapes with 422 JSON errors', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-http-symlink-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project'), outside = path.join(root, 'outside');
  await mkdir(path.join(dir, '.pi'), { recursive: true }); await mkdir(outside);
  for (const name of ['workflows', 'agents']) await symlink(outside, path.join(dir, '.pi', name));
  const project = await openProject(dir), server = createServer({ project, token: 'token', webRoot: root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  for (const [route, method, body] of /** @type {[string, string, object?][]} */ ([['/api/project', 'GET'], ['/api/workflows/demo', 'GET'], ['/api/workflows', 'POST', { id: 'demo' }], ['/api/roles/coder', 'GET'], ['/api/roles', 'POST', { name: 'coder' }]])) {
    const response = await fetch(url + route, { method, headers: { 'X-Studio-Token': 'token' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 422); assert.deepEqual(await response.json(), { error: 'Workflow and role paths must stay inside the project' });
  }
  assert.deepEqual(await readdir(outside), []);
});

test('HTTP with token null serves the API without a token header', async t => {
  // SAFETY: this test only calls GET /api/runs, which reads listRuns alone.
  const server = createServer({ project: /** @type {import('../server/project.ts').Project} */ (/** @type {unknown} */ ({ listRuns: async () => [] })), token: null, webRoot: '.' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/api/runs`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { runs: [] });
});
