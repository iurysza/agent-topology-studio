// Home-screen S2: name and branch on GET /api/project (decision H3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as Effect from 'effect/Effect';
import { ProjectFs } from '../server/services.ts';
import { readBranch } from '../server/git.ts';
import { openProject } from '../server/project.ts';
import { createServer } from '../server/http.ts';

const PORT = 4942;
const real = { readFile: fsp.readFile, readdir: fsp.readdir, stat: fsp.stat, mkdir: fsp.mkdir, open: fsp.open, rename: fsp.rename, rm: fsp.rm };
const branchOf = (root, overrides = {}) => Effect.runPromise(readBranch(root).pipe(Effect.provideService(ProjectFs, { ...real, ...overrides })));

async function tempDir(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-identity-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function serve(t, project) {
  const server = createServer({ project, token: 'token', webRoot: null });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', () => resolve(undefined)); });
  // A fresh socket per request: a pooled keep-alive socket to the previous test's server would reset.
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/project', agent: false, headers: { 'X-Studio-Token': 'token' } }, res => {
      let text = '';
      res.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }).on('error', reject);
  });
}

test('a .git directory gives the branch and the folder name', async t => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, '.git'));
  await writeFile(path.join(dir, '.git/HEAD'), 'ref: refs/heads/feature/x\n');
  const project = await openProject(dir);
  assert.equal(project.name, path.basename(dir));
  assert.equal(await project.branch(), 'feature/x');
});

test('a .git worktree file follows gitdir to HEAD', async t => {
  const dir = await tempDir(t), project = path.join(dir, 'w'), gitDir = path.join(dir, 'real/.git/worktrees/w');
  await mkdir(project); await mkdir(gitDir, { recursive: true });
  await writeFile(path.join(project, '.git'), 'gitdir: ../real/.git/worktrees/w\n');
  await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature/x\n');
  assert.equal(await branchOf(project), 'feature/x');
});

test('a detached HEAD gives null', async t => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, '.git'));
  await writeFile(path.join(dir, '.git/HEAD'), 'a'.repeat(40) + '\n');
  assert.equal(await branchOf(dir), null);
});

test('no .git gives null', async t => {
  assert.equal(await branchOf(await tempDir(t)), null);
});

test('an unreadable HEAD gives null', async t => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, '.git'));
  await writeFile(path.join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');
  const readFile = async () => { throw Object.assign(new Error('EACCES: fake'), { code: 'EACCES' }); };
  assert.equal(await branchOf(dir, { readFile }), null);
});

test('GET /api/project appends name and branch after dir, workflows and roles', async t => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, '.git'));
  await writeFile(path.join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');
  const { status, body } = await serve(t, await openProject(dir));
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ['dir', 'workflows', 'roles', 'name', 'branch']);
  assert.equal(body.name, path.basename(dir));
  assert.equal(body.branch, 'main');
});

test('GET /api/project gives branch null for a project without a branch method', async t => {
  const { status, body } = await serve(t, { root: '/x', listWorkflows: async () => [], listRoles: async () => [] });
  assert.equal(status, 200);
  assert.equal(body.branch, null);
  assert.equal('name' in body, false);
});
