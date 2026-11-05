import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, realpath, readdir, symlink, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openProject, ProjectPathError } from '../server/project.ts';
import { RunIdError } from '../server/runs.ts';
import { createServer } from '../server/http.ts';
import { sessionRunsRoot } from '../server/session-paths.ts';
import { compile, templateMachine } from '../shared/machine.ts';

async function setup(t) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'studio-session-runs-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  const dir = path.join(tmp, 'project');
  await cp(new URL('../fixtures/playground/', import.meta.url), dir, { recursive: true });
  await cp(new URL('../fixtures/runs/council-approve.workflow.jsonl', import.meta.url), path.join(dir, '.pi/workflows/project-run.workflow.jsonl'));
  const project = await openProject(dir);
  const sessions = sessionRunsRoot(project.root, await realpath(tmp), process.getuid?.() ?? 'default');
  const tasks = path.join(sessions, 'session-one', 'tasks');
  const journal = JSON.stringify({ index: 0, key: 'call', ok: true, text: '{"event":"done"}', workflow: 'recorded-id' }) + '\n';
  return { tmp, dir, project, sessions, tasks, journal };
}

test('runs combine all sessions with project precedence, recorded workflow ids and read-only detail', async t => {
  const { project, sessions, tasks, journal } = await setup(t);
  const other = path.join(sessions, 'session-two', 'tasks');
  await mkdir(tasks, { recursive: true }); await mkdir(other, { recursive: true });
  await writeFile(path.join(tasks, 'wf_recorded.workflow.jsonl'), journal);
  await writeFile(path.join(tasks, 'project-run.workflow.jsonl'), journal);
  await writeFile(path.join(other, 'wf_other.workflow.jsonl'), journal);
  await writeFile(path.join(tasks, 'bad id.workflow.jsonl'), journal);
  const before = await readdir(tasks);
  const runs = await project.listRuns();
  assert.equal(runs.length, 3);
  assert.equal(runs.find(run => run.id === 'project-run').source, 'project');
  assert.equal(runs.find(run => run.id === 'project-run').session, undefined);
  const run = runs.find(run => run.id === 'wf_recorded');
  assert.equal(run.source, 'session'); assert.equal(run.session, 'session-one'); assert.equal(run.workflow, 'recorded-id');
  assert.equal((await project.readRun(run.id)).session, 'session-one');
  assert.equal((await project.readRun('project-run')).workflow, 'council');
  assert.equal((await project.listRuns('recorded-id')).length, 2);
  process.env.TMPDIR = path.join(sessions, 'not-a-new-root');
  assert.deepEqual(await project.listRuns(), runs);
  assert.deepEqual(await readdir(tasks), before);
  assert.equal(await readFile(path.join(tasks, 'wf_recorded.workflow.jsonl'), 'utf8'), journal);
});

test('runs-from selects another directory session root without changing project journals or containment', async t => {
  const { tmp, dir, project: original, tasks, journal } = await setup(t);
  await mkdir(tasks, { recursive: true });
  await writeFile(path.join(tasks, 'wf_default.workflow.jsonl'), journal);
  const alias = path.join(tmp, 'runs-alias'); await symlink(tmp, alias, 'dir');
  const project = await openProject(dir, { toolRoot: tmp, runsFrom: alias });
  const sessions = sessionRunsRoot(await realpath(tmp), await realpath(tmp), process.getuid?.() ?? 'default');
  const selected = path.join(sessions, 'selected-session', 'tasks');
  await mkdir(selected, { recursive: true });
  await writeFile(path.join(selected, 'wf_selected.workflow.jsonl'), journal);
  await writeFile(path.join(selected, 'wf_selected.workflow.js'), 'export const meta = { name: "sibling-id" }; throw new Error("must not execute");');
  await writeFile(path.join(selected, 'ignored.jsonl'), journal);
  assert.deepEqual((await project.listRuns()).map(run => run.id).sort(), ['project-run', 'wf_selected']);
  assert.equal((await project.readRun('wf_selected')).session, 'selected-session');
  assert.equal((await project.readRun('project-run')).workflow, 'council');
  assert.equal(await project.readRun('wf_default'), null);
  assert.equal(await original.readRun('wf_selected'), null);
  assert.deepEqual((await project.listWorkflows()).map(workflow => workflow.id), ['build', 'council', 'plan']);
  await rm(path.join(selected, 'wf_selected.workflow.js'));
  await symlink(path.join(dir, '.pi/workflows/build.js'), path.join(selected, 'wf_selected.workflow.js'));
  await assert.rejects(project.readRun('wf_selected'), ProjectPathError);
  await rm(path.join(selected, 'wf_selected.workflow.js'));
  await symlink(path.join(tasks, 'wf_default.workflow.jsonl'), path.join(selected, 'escaped.workflow.jsonl'));
  await assert.rejects(project.listRuns(), ProjectPathError);
});

test('session workflow resolution prefers journal metadata then sibling meta or machine id, never executes scripts', async t => {
  const { project, tasks, journal } = await setup(t);
  await mkdir(tasks, { recursive: true });
  const emptyJournal = JSON.stringify({ index: 0, key: 'call', ok: true, text: '{"event":"done","text":"report"}' });
  for (const id of ['wf_meta', 'wf_machine', 'wf_unknown', 'wf_recorded']) await writeFile(path.join(tasks, `${id}.workflow.jsonl`), id === 'wf_recorded' ? journal : emptyJournal);
  const script = path.join(tasks, 'wf_meta.workflow.js');
  await writeFile(script, 'export const meta = { name: "meta-id" }; throw new Error("must not execute");');
  const machine = templateMachine('machine-id');
  await writeFile(path.join(tasks, 'wf_machine.workflow.js'), `const machine = ${JSON.stringify(machine)};`);
  await writeFile(path.join(tasks, 'wf_recorded.workflow.js'), compile(templateMachine('wrong-id')));
  assert.equal((await project.readRun('wf_meta')).workflow, 'meta-id');
  const detail = await project.readRun('wf_machine');
  assert.equal(detail.workflow, 'machine-id'); assert.equal(detail.status, 'complete'); assert.equal(detail.outcome, 'success');
  assert.equal((await project.readRun('wf_recorded')).workflow, 'recorded-id');
  assert.equal((await project.readRun('wf_unknown')).workflow, null);
  await writeFile(script, compile(templateMachine('updated-id')));
  await utimes(script, new Date('2031-01-01'), new Date('2031-01-01'));
  assert.equal((await project.readRun('wf_meta')).workflow, 'updated-id');
});

test('sibling runs expose the first mismatch without inventing a replay', async t => {
  const { project, tasks } = await setup(t);
  await mkdir(tasks, { recursive: true });
  const machine = templateMachine('demo');
  for (const [id, extra, text, mismatch] of /** @type {[string, { label?: string, agentType?: string }, string, string][]} */ ([
    ['wf_label', { label: 'other', agentType: 'other' }, '{"event":"unknown"}', 'start: label other, expected start'],
    ['wf_role', { agentType: 'other' }, '{"event":"done","text":"report"}', 'start: agentType other, expected coder'],
    ['wf_event', {}, '{"event":"unknown","text":"report"}', 'start: unknown event unknown'],
    ['wf_schema', {}, 'not JSON', 'start: result does not match output schema'],
  ])) {
    await writeFile(path.join(tasks, `${id}.workflow.js`), compile(machine));
    await writeFile(path.join(tasks, `${id}.workflow.jsonl`), JSON.stringify({ index: 0, key: 'call', ok: true, text, ...extra }));
    const detail = await project.readRun(id);
    assert.equal(detail.workflow, 'demo'); assert.equal(detail.fits, false); assert.equal(detail.mismatch, mismatch);
    assert.deepEqual(detail.steps, []); assert.deepEqual(detail.path, []);
    const summary = (await project.listRuns('demo')).find(run => run.id === id);
    assert.equal(summary.fits, false); assert.equal(summary.mismatch, mismatch);
  }
  await writeFile(path.join(tasks, 'wf_failed.workflow.js'), compile(machine));
  await writeFile(path.join(tasks, 'wf_failed.workflow.jsonl'), JSON.stringify({ index: 0, key: 'call', ok: false, text: '' }));
  const failed = await project.readRun('wf_failed');
  assert.equal(failed.fits, true); assert.equal(failed.mismatch, undefined);
  assert.equal(failed.status, 'complete'); assert.equal(failed.signal, 'failed'); assert.equal(failed.at, 'start');
  assert.equal(failed.steps.length, 1); assert.equal(failed.steps[0].ok, false);
});

test('missing session root returns only project runs and unsafe ids are rejected', async t => {
  const { project } = await setup(t);
  const runs = await project.listRuns();
  assert.equal(runs.length, 1); assert.equal(runs[0].source, 'project');
  for (const id of ['..', '../secret', '/tmp/secret', 'bad id', 'x'.repeat(101)]) {
    await assert.rejects(project.readRun(id), RunIdError);
    await assert.rejects(project.listRuns(id), RunIdError);
  }
});

test('session task and journal symlinks cannot escape the fixed session root', async t => {
  const { project, sessions, tasks, tmp, journal } = await setup(t);
  await mkdir(path.dirname(tasks), { recursive: true });
  const outside = path.join(tmp, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'escaped.workflow.jsonl'), journal);
  await symlink(outside, tasks, 'dir');
  await assert.rejects(project.listRuns(), ProjectPathError);
  await rm(tasks); await mkdir(tasks);
  await symlink(path.join(outside, 'escaped.workflow.jsonl'), path.join(tasks, 'escaped.workflow.jsonl'));
  await assert.rejects(project.readRun('escaped'), ProjectPathError);
  await rm(path.join(tasks, 'escaped.workflow.jsonl'));
  const unsafeSession = path.join(sessions, 'bad session', 'tasks'); await mkdir(unsafeSession, { recursive: true });
  await writeFile(path.join(unsafeSession, 'ignored.workflow.jsonl'), journal);
  assert.equal((await project.listRuns()).length, 1);
});

test('a session script without a machine is never replayed against a same-named project workflow', async t => {
  const { tmp, dir } = await setup(t);
  const project = await openProject(dir, { toolRoot: tmp, runsFrom: tmp });
  const sessions = sessionRunsRoot(await realpath(tmp), await realpath(tmp), process.getuid?.() ?? 'default');
  const tasks = path.join(sessions, 'build-session', 'tasks');
  await mkdir(tasks, { recursive: true });
  await writeFile(path.join(tasks, 'wf_x.workflow.js'), 'export const meta = { name: "build" }; throw new Error("must not execute");');
  await writeFile(path.join(tasks, 'wf_x.workflow.jsonl'), [
    { index: 0, key: 'call', ok: true, text: '{"event":"done"}', label: 'coder:a1', agentType: 'coder' },
    { index: 1, key: 'call', ok: true, text: '{"event":"done"}', label: 'reviewer:a1', agentType: 'reviewer' },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  assert.ok((await project.listWorkflows()).some(workflow => workflow.id === 'build'));
  const server = createServer({ project, token: 'token', webRoot: tmp });
  await new Promise(resolve => server.listen(4947, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  /** @param {string} route @returns {Promise<any>} */
  const get = async route => (await fetch(`http://127.0.0.1:4947${route}`, { headers: { 'X-Studio-Token': 'token' } })).json();
  const detail = await get('/api/runs/wf_x');
  assert.equal(detail.workflow, 'build'); assert.equal(detail.fits, false); assert.equal(detail.mismatch, 'script has no machine');
  assert.deepEqual(detail.steps, []); assert.equal(detail.status, 'partial');
  const summary = (await get('/api/runs?workflow=build')).runs.find(run => run.id === 'wf_x');
  assert.equal(summary.fits, false); assert.equal(summary.mismatch, 'script has no machine');
});
