import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, cp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openProject } from '../server/project.ts';
import { createServer } from '../server/http.ts';

test('roles API reads metadata and saves atomically with hash guards', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-role-api-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../fixtures/playground', import.meta.url), dir, { recursive: true });
  const project = await openProject(dir), server = createServer({ project, token: 'token', webRoot: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  /** @param {string} route @param {unknown} [body] @param {string} [method] @param {string} [token] @returns {Promise<{ status: number, data: any }>} */
  async function req(route, body, method = 'GET', token = 'token') {
    const response = await fetch(url + route, { method, headers: { 'X-Studio-Token': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const route = '/api/roles/coder', file = path.join(dir, '.pi/agents/coder.md');
  const original = await readFile(file, 'utf8'), loaded = await req(route);
  assert.equal(loaded.status, 200); assert.equal(loaded.data.hash, createHash('sha256').update(original).digest('hex'));
  assert.deepEqual(loaded.data.role, {
    name: 'coder', description: 'Implements scoped code changes and verifies them', color: 'green',
    model: 'openai-codex/gpt-6.1-sol', thinking: 'high', tools: ['read', 'bash', 'grep', 'find', 'ls', 'edit', 'write'], skills: ['coding-standards'],
  });
  assert.match(loaded.data.body, /You are a coder subagent/);
  assert.deepEqual((await req('/api/project')).data.roles.find(role => role.name === 'coder'), loaded.data.role);
  const body = 'Implement the scoped change.\n', frontmatter = { description: 'A "quoted": role', color: 'cyan', model: 'example/model', thinking: 'medium', tools: ['read', 'write'], skills: ['coding-standards', 'technical-writing'] };
  const saved = await req(route, { frontmatter, body, baseHash: loaded.data.hash }, 'PUT');
  assert.equal(saved.status, 200); assert.deepEqual(saved.data.role, { name: 'coder', ...frontmatter }); assert.equal(saved.data.body, body);
  assert.notEqual(saved.data.hash, loaded.data.hash); assert.deepEqual((await req(route)).data, saved.data);
  assert.match(await readFile(file, 'utf8'), /^prompt_mode: append$/m);
  assert.equal((await req(route, { frontmatter, body, baseHash: loaded.data.hash }, 'PUT')).status, 409);
  assert.equal((await req(route, { frontmatter, body }, 'PUT')).status, 400);
  await writeFile(file, (await readFile(file, 'utf8')) + '\nExternal edit\n');
  const external = await readFile(file, 'utf8');
  assert.equal((await req(route, { frontmatter, body, baseHash: saved.data.hash }, 'PUT')).status, 409);
  assert.equal(await readFile(file, 'utf8'), external);
  for (const invalid of [null, [], { unknown: 'x' }, { tools: 'read, write' }, { skills: [2] }, { description: 2 }, { tools: ['read\nmodel: injected'] }]) {
    assert.equal((await req(route, { frontmatter: invalid, body, baseHash: (await req(route)).data.hash }, 'PUT')).status, 422);
    assert.equal(await readFile(file, 'utf8'), external);
  }
  assert.equal((await req(route, { frontmatter, body: {}, baseHash: (await req(route)).data.hash }, 'PUT')).status, 422);
  assert.equal((await req(route, undefined, 'GET', '')).status, 401);
  assert.equal((await req(route, { frontmatter, body, baseHash: loaded.data.hash }, 'PUT', 'wrong')).status, 401);
  assert.equal((await req('/api/roles/missing')).status, 404);
  assert.equal((await req('/api/roles/missing', { frontmatter, body, baseHash: 'x' }, 'PUT')).status, 404);
  assert.equal((await req(route, {}, 'POST')).status, 405);
  const created = await req('/api/roles', { name: 'new-reviewer', description: 'Review changes', color: 'purple', model: 'example/model', body: 'Review this.\n' }, 'POST');
  assert.equal(created.status, 201); assert.equal(created.data.role.name, 'new-reviewer'); assert.equal(created.data.body, 'Review this.\n');
  assert.deepEqual(created.data.role.tools, []); assert.deepEqual(created.data.role.skills, []); assert.equal(created.data.role.thinking, null);
  assert.deepEqual((await req('/api/roles/new-reviewer')).data, created.data);
  const createdFile = path.join(dir, '.pi/agents/new-reviewer.md'), createdCode = await readFile(createdFile, 'utf8');
  assert.equal((await req('/api/roles', { name: 'new-reviewer', body: 'Overwrite' }, 'POST')).status, 422);
  assert.equal(await readFile(createdFile, 'utf8'), createdCode);
  for (const name of ['Bad', 'bad_name', '1bad', '../bad', '', null]) assert.equal((await req('/api/roles', { name }, 'POST')).status, 422);
  assert.equal((await req('/api/roles/bad%20name')).status, 422);
  assert.equal((await req('/api/roles', { name: 'bad-body', body: [] }, 'POST')).status, 422);
  assert.equal((await project.readRole('bad-body')), null);
  assert.ok(!(await readdir(path.dirname(file))).some(name => name.endsWith('.tmp')));
  assert.notEqual(await readFile(file, 'utf8'), original);
});

test('role saves preserve multiline metadata, unknown settings and bodies without frontmatter', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-role-fields-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../fixtures/playground', import.meta.url), dir, { recursive: true });
  const project = await openProject(dir), file = path.join(dir, '.pi/agents/custom.md');
  await writeFile(file, '---\r\ndescription: >\r\n  First line\r\n  second line\r\ncolor: \'orange\'\r\nmodel: "example/model"\r\nthinking: high # comment\r\ntools: read, bash\r\nskills: one, two\r\nprompt_mode: replace\r\ninherit_context: true\r\n---\r\n\r\nKeep this body.\r\n');
  const loaded = await project.readRole('custom');
  assert.equal(loaded.role.description, 'First line second line'); assert.equal(loaded.role.color, 'orange'); assert.equal(loaded.role.thinking, 'high');
  assert.deepEqual(loaded.role.tools, ['read', 'bash']); assert.deepEqual(loaded.role.skills, ['one', 'two']);
  const saved = await project.writeRole('custom', { description: 'New description', color: null, tools: [] }, loaded.body, loaded.hash);
  assert.equal(saved.role.description, 'New description'); assert.equal(saved.role.color, null); assert.deepEqual(saved.role.tools, []);
  assert.deepEqual(saved.role.skills, ['one', 'two']); assert.equal(saved.body, loaded.body);
  const code = await readFile(file, 'utf8'); assert.doesNotMatch(code, /second line/); assert.match(code, /^prompt_mode: replace$/m); assert.match(code, /^inherit_context: true$/m);
  await writeFile(file, 'A role without frontmatter.\n');
  const bare = await project.readRole('custom'); assert.equal(bare.body, 'A role without frontmatter.\n');
  assert.equal((await project.writeRole('custom', { color: 'blue' }, bare.body, bare.hash)).body, bare.body);
});
