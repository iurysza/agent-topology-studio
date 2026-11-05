// Home-screen S3: run summaries and details gain `title` and `current`, appended after every existing key (H7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, rm, realpath, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openProject } from '../server/project.ts';
import { createServer } from '../server/http.ts';
import { sessionRunsRoot } from '../server/session-paths.ts';
import { compile, templateMachine } from '../shared/machine.ts';

const PORT = 4949;

async function fixtures(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-run-fields-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../fixtures/playground/', import.meta.url), dir, { recursive: true });
  for (const name of await readdir(new URL('../fixtures/runs/', import.meta.url))) {
    await cp(new URL(`../fixtures/runs/${name}`, import.meta.url), path.join(dir, '.pi/workflows', name));
  }
  return { dir, project: await openProject(dir) };
}

test('matched runs carry the machine name as title; only partial runs carry current', async t => {
  const { project } = await fixtures(t);
  const runs = await project.listRuns();
  assert.deepEqual(runs.map(run => run.id).sort(), ['council-approve', 'council-partial', 'council-quorum', 'council-split', 'council-veto']);
  for (const run of runs) {
    assert.equal(run.workflow, 'council');
    assert.equal(run.title, 'Council');
    if (run.status === 'complete') assert.equal('current' in run, false, run.id);
  }
  const partial = runs.find(run => run.id === 'council-partial');
  assert.equal(partial.status, 'partial');
  const detail = await project.readRun('council-partial');
  assert.equal(partial.current.state, detail.path.at(-1));
  assert.ok(Number.isInteger(partial.current.visit) && partial.current.visit >= 1);
  assert.deepEqual(detail.current, partial.current);
  assert.equal(detail.title, 'Council');
});

// Truncated copies of council-split. Its 9 journal lines replay as: frame (1), vote (2-4), tally (5), deliberate (6-8), tally (9).
// After 5 lines the tally fired `split`, so the run sits in deliberate, a state with no step yet.
// After 8 lines the deliberation fan-out joined, so the run sits in tally for the second time.
test('current is the state the run sits in, and counts repeat visits', async t => {
  const { dir } = await fixtures(t);
  const lines = (await readFile(new URL('../fixtures/runs/council-split.workflow.jsonl', import.meta.url), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 9);
  for (const n of [5, 8]) await writeFile(path.join(dir, '.pi/workflows', `split-${n}.workflow.jsonl`), lines.slice(0, n).join('\n') + '\n');
  const project = await openProject(dir);
  const runs = await project.listRuns();

  const transition = runs.find(run => run.id === 'split-5');
  const transitionDetail = await project.readRun('split-5');
  assert.equal(transition.status, 'partial');
  assert.equal(transitionDetail.steps.at(-1).state, 'tally', 'last completed step');
  assert.equal(transitionDetail.steps.at(-1).to, 'deliberate');
  assert.deepEqual(transition.current, { state: 'deliberate', visit: 1 });
  assert.deepEqual(transitionDetail.current, { state: 'deliberate', visit: 1 });

  const revisit = runs.find(run => run.id === 'split-8');
  const revisitDetail = await project.readRun('split-8');
  assert.equal(revisit.status, 'partial');
  assert.equal(revisitDetail.steps.at(-1).state, 'deliberate', 'last completed step');
  assert.deepEqual(revisit.current, { state: 'tally', visit: 2 });
  assert.deepEqual(revisitDetail.current, { state: 'tally', visit: 2 });
});

test('a session run that does not fit has neither title nor current', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'studio-run-fields-session-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  const dir = path.join(tmp, 'project');
  await cp(new URL('../fixtures/playground/', import.meta.url), dir, { recursive: true });
  const project = await openProject(dir);
  const tasks = path.join(sessionRunsRoot(project.root, await realpath(tmp), process.getuid?.() ?? 'default'), 'session-one', 'tasks');
  await mkdir(tasks, { recursive: true });
  await writeFile(path.join(tasks, 'wf_label.workflow.js'), compile(templateMachine('demo')));
  await writeFile(path.join(tasks, 'wf_label.workflow.jsonl'), JSON.stringify({ index: 0, key: 'call', ok: true, text: '{"event":"unknown"}', label: 'other', agentType: 'other' }));
  const summary = (await project.listRuns()).find(run => run.id === 'wf_label');
  const detail = await project.readRun('wf_label');
  for (const run of [summary, detail]) {
    assert.equal(run.fits, false);
    assert.equal('title' in run, false);
    assert.equal('current' in run, false);
  }
});

test('title and current come last in both payloads over HTTP', async t => {
  const { project } = await fixtures(t);
  const server = createServer({ project, token: 'token', webRoot: null });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', () => resolve(undefined)); });
  /** @returns {Promise<any>} */
  const get = async route => (await fetch(`http://127.0.0.1:${PORT}${route}`, { headers: { 'X-Studio-Token': 'token' } })).json();
  const detail = await get('/api/runs/council-partial');
  // `path` is already a base key (the journal file), so the detail's state path overrides it in place, not at the end.
  assert.deepEqual(Object.keys(detail).slice(-4), ['steps', 'visits', 'title', 'current']);
  assert.ok(Array.isArray(detail.path));
  const { runs } = await get('/api/runs');
  const summary = runs.find(run => run.id === 'council-partial');
  assert.deepEqual(Object.keys(summary).slice(-2), ['title', 'current']);
  for (const run of runs.filter(run => run.status === 'complete')) assert.equal(Object.keys(run).at(-1), 'title');
});
