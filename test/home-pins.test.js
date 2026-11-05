// Home-screen S1 pins: the /api/project and /api/runs payloads as they are on ce48164.
// Later slices may only append keys, so these tests pick the old keys and check they stay first, in order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, utimes, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openProject } from '../server/project.ts';
import { createServer } from '../server/http.ts';

const PORT = 4941;
const DATES = {
  'council-veto': '2030-01-05', 'council-split': '2030-01-04', 'council-quorum': '2030-01-03',
  'council-partial': '2030-01-02', 'council-approve': '2030-01-01',
};
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-home-pins-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../fixtures/playground/', import.meta.url), dir, { recursive: true });
  const workflows = path.join(dir, '.pi/workflows');
  for (const name of await readdir(new URL('../fixtures/runs/', import.meta.url))) await cp(new URL(`../fixtures/runs/${name}`, import.meta.url), path.join(workflows, name));
  for (const [id, day] of Object.entries(DATES)) await utimes(path.join(workflows, `${id}.workflow.jsonl`), new Date(day), new Date(day));
  const project = await openProject(dir);
  const server = createServer({ project, token: 'token', webRoot: null });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', () => resolve(undefined)); });
  // A fresh socket per request (agent: false): a pooled keep-alive socket must never reach a replaced server on this port.
  const get = route => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: route, agent: false, headers: { 'X-Studio-Token': 'token' } }, res => {
      let text = '';
      res.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('end', () => resolve({
        status: res.statusCode, type: res.headers['content-type'], cache: res.headers['cache-control'], body: JSON.parse(text),
      }));
    }).on('error', reject);
  });
  return { project, get };
}

const WORKFLOWS = [
  { id: 'build', name: 'Build an approved plan', description: 'Coder builds an approved plan, two reviewers and the oracle agree fixes, a fresh coder applies them, QA proves it; reruns on QA failure', editable: true, states: 8 },
  { id: 'council', name: 'Council', description: 'Three distinct models vote on a high-stakes question; a judge tallies, one deliberation round if split', editable: true, states: 6 },
  { id: 'plan', name: 'Plan and challenge a task', description: 'Lead writes the Markdown plan, oracle challenges it until approved, scribe writes the HTML explainer', editable: true, states: 5 },
];

// Roles of fixtures/playground/.pi/agents, as ce48164 returns them: sorted by name, keys in this order.
const ROLE_KEYS = ['name', 'description', 'color', 'model', 'thinking', 'tools', 'skills'];
const READ = ['read', 'bash', 'grep', 'find', 'ls'];
const WRITING = ['coding-standards', 'technical-writing', 'unslop'];
const ROLES = [
  { name: 'auditor', description: 'Check evidence, test coverage and whether the diff matches its description', color: 'orange', model: 'openai-codex/gpt-6-astra', thinking: 'high', tools: READ, skills: WRITING },
  { name: 'coder', description: 'Implements scoped code changes and verifies them', color: 'green', model: 'openai-codex/gpt-6.1-sol', thinking: 'high', tools: [...READ, 'edit', 'write'], skills: ['coding-standards'] },
  { name: 'judge', description: 'Tally council ballots and write the decision ledger', color: 'purple', model: 'claude-code/claude-opus-5-5', thinking: 'high', tools: [...READ, 'write', 'edit'], skills: WRITING },
  { name: 'lead', description: 'Technical lead who turns a task into a concrete Markdown plan', color: 'blue', model: 'claude-code/claude-opus-5-5', thinking: 'medium', tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'], skills: [] },
  { name: 'oracle', description: 'High-context second opinion that checks decisions for drift and hidden assumptions', color: 'purple', model: 'claude-code/claude-opus-5-5', thinking: 'high', tools: READ, skills: [] },
  { name: 'pragmatist', description: 'Check scope, simplicity, ownership cost and user impact', color: 'cyan', model: 'openai-codex/gpt-6.1-sol', thinking: 'high', tools: READ, skills: WRITING },
  { name: 'qa', description: 'Proves a change works by running checks and testing by hand', color: 'orange', model: 'openai-codex/gpt-6-luna', thinking: 'high', tools: READ, skills: ['agent-browser'] },
  { name: 'researcher', description: 'Fast read-only researcher for code and web questions', color: 'cyan', model: 'openai-codex/gpt-6-luna', thinking: 'high', tools: READ, skills: [] },
  { name: 'reviewer', description: 'Adversarial read-only code reviewer for diffs and changed files', color: 'red', model: 'openai-codex/gpt-6-astra', thinking: 'medium', tools: READ, skills: WRITING },
  { name: 'scribe', description: 'Turns plans and runs into creative HTML explainers, docs and run reports', color: 'yellow', model: 'claude-code/claude-sonnet-5-5', thinking: 'medium', tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'], skills: ['show-me', 'technical-writing', 'unslop'] },
  { name: 'skeptic', description: 'Check correctness and safety; veto only concrete safety or data-loss issues', color: 'red', model: 'claude-code/claude-opus-5-5', thinking: 'high', tools: READ, skills: WRITING },
];

// Keys each run summary has today, in order. startedAt and updatedAt must be ISO timestamps.
const COMPLETE_KEYS = ['id', 'source', 'workflow', 'path', 'startedAt', 'updatedAt', 'calls', 'status', 'outcome', 'signal', 'at'];
const PARTIAL_KEYS = ['id', 'source', 'workflow', 'path', 'startedAt', 'updatedAt', 'calls', 'status'];
const TIME_KEYS = new Set(['startedAt', 'updatedAt']);
const RUNS = [
  { keys: COMPLETE_KEYS, value: { id: 'council-veto', source: 'project', workflow: 'council', path: '.pi/workflows/council-veto.workflow.jsonl', calls: 5, status: 'complete', outcome: 'failed', signal: 'failed', at: 'blocked' } },
  { keys: COMPLETE_KEYS, value: { id: 'council-split', source: 'project', workflow: 'council', path: '.pi/workflows/council-split.workflow.jsonl', calls: 9, status: 'complete', outcome: 'success', signal: 'success', at: 'approved' } },
  { keys: COMPLETE_KEYS, value: { id: 'council-quorum', source: 'project', workflow: 'council', path: '.pi/workflows/council-quorum.workflow.jsonl', calls: 5, status: 'complete', outcome: 'success', signal: 'success', at: 'approved' } },
  { keys: PARTIAL_KEYS, value: { id: 'council-partial', source: 'project', workflow: 'council', path: '.pi/workflows/council-partial.workflow.jsonl', calls: 3, status: 'partial' } },
  { keys: COMPLETE_KEYS, value: { id: 'council-approve', source: 'project', workflow: 'council', path: '.pi/workflows/council-approve.workflow.jsonl', calls: 5, status: 'complete', outcome: 'success', signal: 'success', at: 'approved' } },
];

function assertRun(run, keys, expected, label, skip = new Set()) {
  assert.deepEqual(Object.keys(run).slice(0, keys.length), keys, `${label}: old keys first, in order`);
  for (const k of TIME_KEYS) assert.equal(new Date(run[k]).toISOString(), run[k], `${label}: ${k}`);
  assert.deepEqual(pick(run, keys.filter(k => !TIME_KEYS.has(k) && !skip.has(k))), expected, label);
}

test('GET /api/project keeps dir, workflows and roles first', async t => {
  const { project, get } = await setup(t);
  const res = await get('/api/project');
  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/json');
  assert.equal(res.cache, 'no-store');
  assert.deepEqual(Object.keys(res.body).slice(0, 3), ['dir', 'workflows', 'roles']);
  assert.equal(res.body.dir, project.root);
  assert.deepEqual(res.body.workflows, WORKFLOWS);
  assert.deepEqual(res.body.roles.map(role => role.name), ROLES.map(role => role.name));
  res.body.roles.forEach((role, i) => {
    assert.deepEqual(Object.keys(role).slice(0, ROLE_KEYS.length), ROLE_KEYS, `${role.name}: old keys first, in order`);
    assert.deepEqual(pick(role, ROLE_KEYS), ROLES[i], role.name);
  });
});

test('GET /api/runs keeps order, old keys and values', async t => {
  const { get } = await setup(t);
  const res = await get('/api/runs');
  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/json');
  assert.equal(res.cache, 'no-store');
  assert.deepEqual(Object.keys(res.body).slice(0, 1), ['runs']);
  const runs = res.body.runs;
  assert.deepEqual(runs.map(r => r.id), RUNS.map(r => r.value.id));
  runs.forEach((run, i) => assertRun(run, RUNS[i].keys, RUNS[i].value, run.id));
  assert.equal(runs.find(r => r.id === 'council-veto').updatedAt, '2030-01-05T00:00:00.000Z');
});

// Each step as [n, state, branch, kind, role, ok, event, to], plus its key order.
const SPLIT_STEPS = [
  [1, 'frame', null, 'task', 'lead', true, 'framed', 'vote'],
  [2, 'vote', 'skeptic', 'fanout', 'skeptic', true, null, null],
  [3, 'vote', 'auditor', 'fanout', 'auditor', true, null, null],
  [4, 'vote', 'pragmatist', 'fanout', 'pragmatist', true, null, null],
  [5, 'vote', null, 'fanout', null, true, 'voted', 'tally'],
  [6, 'tally', null, 'decision', 'judge', true, 'split', 'deliberate'],
  [7, 'deliberate', 'skeptic', 'fanout', 'skeptic', true, null, null],
  [8, 'deliberate', 'auditor', 'fanout', 'auditor', true, null, null],
  [9, 'deliberate', 'pragmatist', 'fanout', 'pragmatist', true, null, null],
  [10, 'deliberate', null, 'fanout', null, true, 'voted', 'tally'],
  [11, 'tally', null, 'decision', 'judge', true, 'approved', 'approved'],
];

// Old key order per step kind. Later slices may append step keys (H8), so only this prefix is pinned.
const STEP_KEYS = {
  task: 'n,state,kind,role,prompt,template,ok,result,text,event,to',
  branch: 'n,state,branch,kind,role,prompt,template,ok,result,text',
  join: 'n,state,kind,role,prompt,template,ok,result,event,to',
  decision: 'n,state,kind,role,prompt,template,ok,result,text,event,to',
};

const SPLIT_STEP_KEYS = ['task', 'branch', 'branch', 'branch', 'join', 'decision', 'branch', 'branch', 'branch', 'join', 'decision'];

test('GET /api/runs/council-split keeps old keys, steps, visits and path', async t => {
  const { get } = await setup(t);
  const res = await get('/api/runs/council-split');
  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/json');
  assert.equal(res.cache, 'no-store');
  const keys = [...COMPLETE_KEYS, 'steps', 'visits'];
  assertRun(res.body, keys, {
    id: 'council-split', source: 'project', workflow: 'council',
    path: ['frame', 'vote', 'tally', 'deliberate', 'tally', 'approved'],
    calls: 9, status: 'complete', outcome: 'success', signal: 'success', at: 'approved',
    visits: { frame: 1, vote: 1, tally: 2, deliberate: 1 },
  }, 'council-split', new Set(['steps']));
  assert.equal(res.body.updatedAt, '2030-01-04T00:00:00.000Z');
  assert.deepEqual(res.body.steps.map(s => [s.n, s.state, s.branch ?? null, s.kind, s.role, s.ok, s.event ?? null, s.to ?? null]), SPLIT_STEPS);
  res.body.steps.forEach((step, i) => {
    const keys = STEP_KEYS[SPLIT_STEP_KEYS[i]].split(',');
    assert.deepEqual(Object.keys(step).slice(0, keys.length), keys, `step ${step.n}: old keys first, in order`);
  });
  // prompt, template, text and result of every step, as ce48164 rendered them from fixtures/runs/council-split.workflow.jsonl.
  const golden = JSON.parse(await readFile(new URL('./home-pins.split-steps.json', import.meta.url), 'utf8'));
  assert.equal(golden.length, SPLIT_STEPS.length);
  res.body.steps.forEach((step, i) => {
    const fields = ['n', 'prompt', 'template', 'text', 'result'].filter(k => k in golden[i]);
    assert.deepEqual(pick(step, fields), golden[i], `step ${step.n}`);
    assert.equal('text' in step, 'text' in golden[i], `step ${step.n}: text presence`);
  });
  assert.deepEqual(res.body.steps[0].result, { event: 'framed', brief: 'Check safety, tests and user impact against example.js:1.' });
});
