import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm, utimes, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openProject } from '../server/project.ts';
import { createServer } from '../server/http.ts';
async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-runs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../fixtures/playground/', import.meta.url), dir, { recursive: true });
  const workflows = path.join(dir, '.pi/workflows');
  for (const name of await readdir(new URL('../fixtures/runs/', import.meta.url))) await cp(new URL(`../fixtures/runs/${name}`, import.meta.url), path.join(workflows, name));
  return { dir, workflows, project: await openProject(dir) };
}

test('project lists matched journals newest first and reads replay details without writes', async t => {
  const { project, workflows } = await setup(t);
  const before = (await readdir(workflows)).sort();
  await utimes(path.join(workflows, 'council-veto.workflow.jsonl'), new Date('2030-01-01'), new Date('2030-01-01'));
  const runs = await project.listRuns();
  assert.equal(runs.length, 5); assert.equal(runs[0].id, 'council-veto');
  assert.ok(runs.every(run => run.workflow === 'council'));
  assert.ok(runs.every(run => run.path === `.pi/workflows/${run.id}.workflow.jsonl`));
  assert.ok(runs.every(run => !Number.isNaN(Date.parse(run.startedAt))));
  assert.deepEqual(await project.listRuns('build'), []); assert.deepEqual(await project.listRuns('council'), runs);
  const detail = await project.readRun('council-split');
  assert.equal(detail.workflow, 'council'); assert.equal(detail.status, 'complete'); assert.equal(detail.outcome, 'success');
  assert.deepEqual(detail.path, ['frame', 'vote', 'tally', 'deliberate', 'tally', 'approved']);
  assert.equal(detail.visits.tally, 2); assert.equal(detail.steps.length, 11);
  assert.equal(await project.readRun('missing'), null);
  assert.deepEqual((await readdir(workflows)).sort(), before);
});

test('runs HTTP rejects traversal and absolute ids without changing workflow files', async t => {
  const { project, workflows, dir } = await setup(t);
  const snapshot = async () => Promise.all((await readdir(workflows)).sort().map(async name => ({
    name, sha256: createHash('sha256').update(await readFile(path.join(workflows, name))).digest('hex'),
  })));
  const before = await snapshot(), token = randomBytes(24).toString('hex');
  const server = createServer({ project, token, webRoot: dir });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  // Pass a raw request path so URL normalization cannot remove dot segments before the server sees them.
  const request = route => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, path: route, headers: { 'X-Studio-Token': token } }, async response => {
      try {
        let body = ''; for await (const chunk of response) body += chunk;
        assert.match(response.headers['content-type'], /^application\/json/);
        resolve({ status: response.statusCode, body: JSON.parse(body) });
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
  for (const route of [
    '/api/runs/..', '/api/runs/%2Fetc%2Fpasswd', '/api/runs/..%2F..%2Fpackage.json',
    `/api/runs/${path.join(workflows, 'council-split.workflow.jsonl')}`,
  ]) {
    const response = await request(route);
    assert.ok([400, 404].includes(response.status), `${route}: ${response.status}`);
    assert.equal(typeof response.body.error, 'string', route); assert.ok(response.body.error.length > 0, route);
  }
  const detail = await request('/api/runs/council-split');
  assert.equal(detail.status, 200); assert.equal(detail.body.outcome, 'success');
  assert.deepEqual(await snapshot(), before);
});
