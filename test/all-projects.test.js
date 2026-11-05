// All projects mode: scoped /api/p/<id>/ routes, the --all process and its arguments. Ports 4931 (HTTP) and 4932 (process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, cp, rm, writeFile, readFile, symlink, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/http.ts';
import { createRegistry, projectId } from '../server/registry.ts';
import { openProject } from '../server/project.ts';
import { parseServerArgs } from '../server/args.ts';
import { extract } from '../shared/machine.ts';

const mainEntry = fileURLToPath(new URL('../server/main.ts', import.meta.url));
const httpPort = 4931, processPort = 4932;

/** A fake home under mkdtemp, passed unresolved, holding two playground copies A and B and a session folder for each. */
async function fakeHome(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'studio-all-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), tmpDir = path.join(base, 'tmp');
  const a = path.join(home, 'dev/alpha'), b = path.join(home, 'dev/beta'), empty = path.join(home, 'dev/empty');
  await mkdir(tmpDir, { recursive: true });
  await mkdir(empty, { recursive: true });
  for (const [index, dir] of [a, b].entries()) {
    await cp(new URL('../fixtures/playground', import.meta.url), dir, { recursive: true });
    const folder = path.join(home, '.pi/agent/sessions', `--folder-${index}--`);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, '2026-10-01T00-00-00_a.jsonl'), JSON.stringify({ type: 'session', cwd: dir }) + '\n');
  }
  return { base, home, tmpDir, a, b, empty, idA: projectId(await realpath(a)), idB: projectId(await realpath(b)) };
}

const registryFor = (env, extra = {}) => createRegistry({
  ...extra,
  home: env.home,
  sessionsDir: path.join(env.home, '.pi/agent/sessions'),
  configFile: path.join(env.home, '.config/topology-studio/projects.json'),
  tmpDir: env.tmpDir,
  uid: 'test',
});

/** Listens on the named port. A busy port fails the test; it never falls back. */
async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(new Error(`Port ${port} is busy or unavailable: ${error.message}`)));
    server.listen(port, '127.0.0.1', () => resolve(undefined));
  });
}

async function serve(t, env, registry = registryFor(env)) {
  const server = createServer({ project: null, token: 'token', webRoot: null, registry });
  await listen(server, httpPort);
  t.after(() => new Promise(resolve => { server.close(() => resolve(undefined)); server.closeAllConnections(); }));
  /** @param {string} route @param {{ method?: string, body?: unknown, token?: string | null, host?: string }} [init] */
  return async (route, { method = 'GET', body, token = 'token' } = {}) => {
    const headers = token === null ? {} : { 'X-Studio-Token': token };
    const response = await fetch(`http://127.0.0.1:${httpPort}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    // SAFETY: every /api route answers with a JSON object; the tests read the fields they expect.
    return { status: response.status, data: /** @type {any} */ (await response.json()) };
  };
}

test('scoped routes serve each project through the registry', async t => {
  const env = await fakeHome(t);
  const request = await serve(t, env);

  assert.equal((await request('/api/projects', { token: null })).status, 401);
  const listed = await request('/api/projects');
  assert.equal(listed.status, 200);
  assert.equal(listed.data.projects.length, 2);
  assert.deepEqual(listed.data.warnings, []);
  for (const entry of listed.data.projects) {
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'lastRunAt', 'name', 'root', 'source', 'workflows']);
    assert.equal(entry.workflows, 3);
    assert.equal(entry.source, 'session');
  }
  assert.deepEqual(listed.data.projects.map(p => p.id).sort(), [env.idA, env.idB].sort());
  assert.equal((await request('/api/projects', { method: 'POST' })).status, 405);

  const project = await request(`/api/p/${env.idA}/project`);
  assert.equal(project.status, 200);
  assert.equal(project.data.dir, await realpath(env.a));
  assert.equal((await request(`/api/p/${env.idA}/project`, { token: null })).status, 401);

  assert.equal((await request(`/api/p/${env.idA}/workflows/build`)).status, 200);
  assert.equal((await request(`/api/p/${env.idB}/runs`)).status, 200);
  assert.equal((await request(`/api/p/${env.idB}/roles/coder`)).status, 200);

  assert.deepEqual(await request('/api/p/unknown-00000000/project'), { status: 404, data: { error: 'Project not found' } });
  assert.deepEqual(await request('/api/p/BAD/project'), { status: 400, data: { error: 'Invalid project id' } });
  assert.deepEqual(await request('/api/p/x/project'), { status: 400, data: { error: 'Invalid project id' } });
  assert.equal((await request('/api/project')).status, 404);
  assert.equal((await request('/api/runs')).status, 404);
});

test('20 interleaved concurrent requests each reach their own project', async t => {
  const env = await fakeHome(t);
  const request = await serve(t, env);
  const dirs = { [env.idA]: await realpath(env.a), [env.idB]: await realpath(env.b) };
  const ids = Array.from({ length: 20 }, (_, index) => index % 2 ? env.idB : env.idA);
  const responses = await Promise.all(ids.map(id => request(`/api/p/${id}/project`)));
  responses.forEach((response, index) => {
    assert.equal(response.status, 200);
    assert.equal(response.data.dir, dirs[ids[index]]);
  });
});

test('a request blocked inside the handler keeps its own project while another completes', async t => {
  const env = await fakeHome(t);
  // B loses a role, so a response that mixed in B's project would show it.
  await rm(path.join(env.b, '.pi/agents/scribe.md'));
  const realA = await realpath(env.a);
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise(resolve => { release = () => resolve(undefined); });
  /** @type {() => void} */
  let entered = () => {};
  const blocked = new Promise(resolve => { entered = () => resolve(undefined); });
  const registry = registryFor(env, {
    openProject: async (root, options) => {
      const project = await openProject(root, options);
      if (root !== realA) return project;
      return { ...project, listWorkflows: async () => { entered(); await gate; return project.listWorkflows(); } };
    },
  });
  const request = await serve(t, env, registry);
  const pendingA = request(`/api/p/${env.idA}/project`);
  await blocked;
  const b = await request(`/api/p/${env.idB}/project`);
  release();
  const a = await pendingA;
  assert.equal(b.status, 200);
  assert.equal(a.status, 200);
  assert.equal(a.data.dir, realA);
  assert.equal(b.data.dir, await realpath(env.b));
  const names = data => data.roles.map(role => role.name).sort();
  assert.ok(names(a.data).includes('scribe'), 'A keeps its own roles');
  assert.ok(!names(b.data).includes('scribe'));
  assert.equal(names(a.data).length, names(b.data).length + 1);
});

test('a write to A with a slow body lands in A while B is served', async t => {
  const env = await fakeHome(t);
  const request = await serve(t, env);
  const before = await readFile(path.join(env.b, '.pi/workflows/build.js'), 'utf8');
  const loaded = await request(`/api/p/${env.idA}/workflows/build`);
  const body = JSON.stringify({ machine: { ...loaded.data.machine, description: 'slow A' }, hash: loaded.data.hash });
  const response = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: httpPort, method: 'PUT', path: `/api/p/${env.idA}/workflows/build`, headers: { 'X-Studio-Token': 'token', 'Content-Type': 'application/json' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject);
    req.write(body.slice(0, 10));
    request(`/api/p/${env.idB}/project`).then(() => req.end(body.slice(10)), reject);
  });
  assert.equal(await response, 200);
  assert.equal(extract(await readFile(path.join(env.a, '.pi/workflows/build.js'), 'utf8'))?.description, 'slow A');
  assert.equal(await readFile(path.join(env.b, '.pi/workflows/build.js'), 'utf8'), before);
});

test('a save to project A never touches project B', async t => {
  const env = await fakeHome(t);
  const request = await serve(t, env);
  const before = await readFile(path.join(env.b, '.pi/workflows/build.js'), 'utf8');
  const loaded = await request(`/api/p/${env.idA}/workflows/build`);
  const loadedB = await request(`/api/p/${env.idB}/workflows/build`);
  assert.equal(loaded.data.hash, loadedB.data.hash);

  const stale = await request(`/api/p/${env.idA}/workflows/build`, { method: 'PUT', body: { machine: loaded.data.machine, hash: 'stale' } });
  assert.equal(stale.status, 409);

  const machine = { ...loaded.data.machine, description: 'changed in A' };
  const saved = await request(`/api/p/${env.idA}/workflows/build`, { method: 'PUT', body: { machine, hash: loaded.data.hash } });
  assert.equal(saved.status, 200);
  assert.equal(extract(await readFile(path.join(env.a, '.pi/workflows/build.js'), 'utf8'))?.description, 'changed in A');
  assert.equal(await readFile(path.join(env.b, '.pi/workflows/build.js'), 'utf8'), before);
});

test('containment holds per project and the host check still applies', async t => {
  const env = await fakeHome(t);
  const outside = path.join(env.base, 'outside.md');
  await writeFile(outside, '---\nname: escape\n---\nbody\n');
  await symlink(outside, path.join(env.a, '.pi/agents/escape.md'));
  const request = await serve(t, env);
  assert.deepEqual(await request(`/api/p/${env.idA}/roles/escape`), { status: 422, data: { error: 'Workflow and role paths must stay inside the project' } });

  // fetch drops a custom Host header, so this uses node:http as test/server.test.js does.
  const badHost = await new Promise(resolve => http.get(`http://127.0.0.1:${httpPort}/api/projects`, { headers: { Host: 'evil.test', 'X-Studio-Token': 'token' } }, response => { response.resume(); resolve(response.statusCode); }));
  assert.equal(badHost, 403);
});

/** Spawns server/main.js --all on port 4932 with HOME pointed at the fake home and waits for the URL line. */
async function spawnAll(t, env, extra = []) {
  const child = spawn(process.execPath, [mainEntry, '--all', '--api-only', '--no-open', '--dev-token', 't', '--port', String(processPort), ...extra], {
    env: { ...process.env, HOME: env.home, TMPDIR: env.tmpDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } });
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No URL after 10 s. stderr: ${stderr}`)), 10000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/Topology studio: (\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Exited with ${code}. stderr: ${stderr}`)); });
  });
  return { url, stderr: () => stderr };
}

test('--all serves every project from the fake home', async t => {
  const env = await fakeHome(t);
  const { url } = await spawnAll(t, env);
  assert.doesNotMatch(url, /#/);
  const response = await fetch(`http://127.0.0.1:${processPort}/api/projects`, { headers: { 'X-Studio-Token': 't' } });
  assert.equal(response.status, 200);
  const body = /** @type {any} */ (await response.json());
  assert.deepEqual(body.projects.map(p => p.id).sort(), [env.idA, env.idB].sort());
});

test('--all --project preselects a listed project', async t => {
  const env = await fakeHome(t);
  const { url, stderr } = await spawnAll(t, env, ['--project', env.a]);
  assert.ok(url.endsWith(`#/p/${env.idA}/`), url);
  assert.equal(stderr(), '');
});

test('--all --project with no workflows prints a plain URL and one warning line', async t => {
  const env = await fakeHome(t);
  const { url, stderr } = await spawnAll(t, env, ['--project', env.empty]);
  assert.doesNotMatch(url, /#/);
  const lines = stderr().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, stderr());
  assert.ok(lines[0].startsWith('--project '), lines[0]);
  assert.match(lines[0], /no \.pi\/workflows\/\*\.js$/);
});

test('args: --all rules', () => {
  assert.throws(() => parseServerArgs(['--all', '--runs-from', 'x']), /--runs-from cannot be used with --all/);
  assert.equal(parseServerArgs(['--all']).all, true);
  assert.throws(() => parseServerArgs([]), /--project <dir> is required/);
});
