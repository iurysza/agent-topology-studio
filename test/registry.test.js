import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { mkdtemp, mkdir, rm, writeFile, symlink, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Effect from 'effect/Effect';
import { ProjectFs } from '../server/services.ts';
import { discoverProjects, createRegistry, projectId, isProjectId } from '../server/registry.ts';
import { sessionRunsRoot } from '../server/session-paths.ts';
import { runEdge } from '../server/edge.ts';

const real = { readFile: fsp.readFile, readdir: fsp.readdir, stat: fsp.stat, mkdir: fsp.mkdir, open: fsp.open, rename: fsp.rename, rm: fsp.rm };
const run = (effect, overrides = {}) => Effect.runPromise(effect.pipe(Effect.provideService(ProjectFs, { ...real, ...overrides })));
const uid = 'test';

/** A fake home under mkdtemp, passed unresolved. */
async function fakeHome(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'studio-registry-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), tmpDir = path.join(base, 'tmp');
  await mkdir(path.join(home, '.pi/agent/sessions'), { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  return {
    base, home, tmpDir,
    sessionsDir: path.join(home, '.pi/agent/sessions'),
    configFile: path.join(home, '.config/topology-studio/projects.json'),
  };
}
const options = env => ({ home: env.home, sessionsDir: env.sessionsDir, configFile: env.configFile, tmpDir: env.tmpDir, uid });

async function makeProject(dir, workflows = ['a.js']) {
  await mkdir(path.join(dir, '.pi/workflows'), { recursive: true });
  for (const name of workflows) await writeFile(path.join(dir, '.pi/workflows', name), 'export const meta = {};\n');
  return dir;
}
let folderCount = 0;
async function session(env, cwd, line) {
  const folder = path.join(env.sessionsDir, `--folder-${folderCount++}--`);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, '2026-10-02T00-00-00_b.jsonl'), JSON.stringify({ type: 'session', cwd: '/nowhere' }) + '\n');
  await writeFile(path.join(folder, '2026-10-01T00-00-00_a.jsonl'), (line ?? JSON.stringify({ type: 'session', id: 'x', cwd })) + '\n{"type":"message"}\n');
  return folder;
}
const writeConfig = async (env, text) => { await mkdir(path.dirname(env.configFile), { recursive: true }); await writeFile(env.configFile, text); };
const roots = result => result.projects.map(project => project.root);
const realOf = dir => fsp.realpath(dir);

test('discovery lists session projects and skips bad candidates', async t => {
  const env = await fakeHome(t);
  const a = await makeProject(path.join(env.home, 'dev/alpha'));
  const b = await makeProject(path.join(env.home, 'dev/beta'));
  const noJs = await makeProject(path.join(env.home, 'dev/nojs'), ['notes.md']);
  await session(env, a);
  await session(env, b);
  await session(env, noJs);
  await session(env, null, '{broken');
  await session(env, path.join(env.home, 'dev/missing'));
  // A symlink inside home that points outside it.
  const outside = await mkdtemp(path.join(os.tmpdir(), 'studio-registry-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await makeProject(outside);
  await symlink(outside, path.join(env.home, 'escape'));
  await session(env, path.join(env.home, 'escape'));
  // A .pi/workflows that is a symlink pointing outside the project.
  const sneaky = path.join(env.home, 'dev/sneaky');
  await mkdir(path.join(sneaky, '.pi'), { recursive: true });
  await symlink(path.join(outside, '.pi/workflows'), path.join(sneaky, '.pi/workflows'));
  await session(env, sneaky);

  const result = await run(discoverProjects(options(env)));
  assert.deepEqual(roots(result).sort(), [await realOf(a), await realOf(b)].sort());
  assert.deepEqual(result.warnings, []);
  for (const project of result.projects) {
    assert.equal(project.source, 'session');
    assert.equal(project.workflows, 1);
    assert.equal(project.lastRunAt, null);
    assert.equal(project.id, projectId(project.root));
    assert.equal(project.name, path.basename(project.root));
  }
});

test('config entries expand ~/ and dedupe with sessions; bad config warns', async t => {
  const env = await fakeHome(t);
  const a = await makeProject(path.join(env.home, 'dev/alpha'));
  await makeProject(path.join(env.home, 'dev/gamma'));
  await session(env, a);
  await writeConfig(env, JSON.stringify({ projects: ['~/dev/gamma', a] }));
  const result = await run(discoverProjects(options(env)));
  assert.equal(result.projects.length, 2);
  assert.equal(result.projects.find(p => p.name === 'gamma').source, 'config');
  assert.equal(result.projects.find(p => p.name === 'alpha').source, 'config');

  await writeConfig(env, '{not json');
  const bad = await run(discoverProjects(options(env)));
  assert.deepEqual(roots(bad), [await realOf(a)]);
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /^projects\.json: /);

  await writeConfig(env, JSON.stringify({ projects: 'nope' }));
  assert.match((await run(discoverProjects(options(env)))).warnings[0], /^projects\.json: /);
});

test('extra --project candidates warn with the failed check', async t => {
  const env = await fakeHome(t);
  const empty = path.join(env.home, 'dev/empty');
  await mkdir(empty, { recursive: true });
  const outside = await mkdtemp(path.join(os.tmpdir(), 'studio-registry-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await makeProject(outside);
  const good = await makeProject(path.join(env.home, 'dev/good'));
  const tool = await makeProject(path.join(env.home, 'dev/studio'));
  const result = await run(discoverProjects({ ...options(env), extra: [empty, outside, good, tool], toolRoot: tool }));
  assert.deepEqual(roots(result), [await realOf(good)]);
  assert.equal(result.projects[0].source, 'cli');
  assert.deepEqual(result.warnings, [
    `--project ${empty}: no .pi/workflows/*.js`,
    `--project ${outside}: outside your home folder`,
    `--project ${tool}: the studio's own repo`,
  ]);
});

test('the tool root and its fixtures are excluded', async t => {
  const env = await fakeHome(t);
  const tool = await makeProject(path.join(env.home, 'dev/studio'));
  const fixture = await makeProject(path.join(tool, 'fixtures/playground'));
  const other = await makeProject(path.join(env.home, 'dev/other'));
  for (const dir of [tool, fixture, other]) await session(env, dir);
  const result = await run(discoverProjects({ ...options(env), toolRoot: tool }));
  assert.deepEqual(roots(result), [await realOf(other)]);
});

test('lastRunAt is the newest journal mtime and the list sorts by it', async t => {
  const env = await fakeHome(t);
  const old = await makeProject(path.join(env.home, 'dev/old'));
  const recent = await makeProject(path.join(env.home, 'dev/recent'));
  const never = await makeProject(path.join(env.home, 'dev/aaa-never'));
  const never2 = await makeProject(path.join(env.home, 'dev/zzz-never'));
  for (const dir of [never2, old, never, recent]) await session(env, dir);
  const t1 = new Date('2026-01-01T00:00:00Z'), t2 = new Date('2026-03-01T00:00:00Z'), t3 = new Date('2026-05-01T00:00:00Z');
  const journal = async (file, time) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '{}\n'); await utimes(file, time, time); };
  await journal(path.join(old, '.pi/workflows/x.workflow.jsonl'), t1);
  await journal(path.join(recent, '.pi/workflows/x.workflow.jsonl'), t1);
  // The newest journal for `recent` is in the session tasks folder under the injected tmpDir.
  const sessions = sessionRunsRoot(await realOf(recent), await realOf(env.tmpDir), uid);
  await journal(path.join(sessions, 'sess-1/tasks/y.workflow.jsonl'), t3);
  await journal(path.join(sessions, 'sess-2/tasks/z.workflow.jsonl'), t2);
  const result = await run(discoverProjects(options(env)));
  assert.deepEqual(result.projects.map(p => p.name), ['recent', 'old', 'aaa-never', 'zzz-never']);
  assert.equal(result.projects[0].lastRunAt, t3.toISOString());
  assert.equal(result.projects[1].lastRunAt, t1.toISOString());
  assert.equal(result.projects[2].lastRunAt, null);
});

test('projectId is stable, valid and differs for same-named roots; names disambiguate', async t => {
  assert.equal(projectId('/x/quality'), 'quality-4423e203');
  assert.match(projectId('/x/quality'), /^quality-[0-9a-f]{8}$/);
  assert.ok(isProjectId(projectId('/x/quality')));
  assert.ok(isProjectId(projectId('/x/My Project_2.0')));
  assert.ok(isProjectId(projectId('/x/' + 'a'.repeat(100))));
  assert.notEqual(projectId('/a/quality'), projectId('/b/quality'));
  assert.ok(!isProjectId('BAD'));
  assert.ok(!isProjectId('../x'));
  assert.ok(!isProjectId(''));

  const env = await fakeHome(t);
  const one = await makeProject(path.join(env.home, 'one/quality'));
  const two = await makeProject(path.join(env.home, 'two/quality'));
  await session(env, one);
  await session(env, two);
  const result = await run(discoverProjects(options(env)));
  assert.deepEqual(result.projects.map(p => p.name).sort(), ['one/quality', 'two/quality']);
  assert.notEqual(result.projects[0].id, result.projects[1].id);
});

test('an EACCES on one session folder still lists the others', async t => {
  const env = await fakeHome(t);
  const a = await makeProject(path.join(env.home, 'dev/alpha'));
  const b = await makeProject(path.join(env.home, 'dev/beta'));
  await session(env, a);
  const blocked = await realOf(await session(env, b));
  const open = async (file, flags) => {
    if (file.startsWith(blocked + path.sep)) throw Object.assign(new Error('EACCES: fake'), { code: 'EACCES' });
    return fsp.open(file, flags);
  };
  const result = await run(discoverProjects(options(env)), { open });
  assert.deepEqual(roots(result), [await realOf(a)]);
});

test('an unresolvable home gives an empty list with a warning', async t => {
  const env = await fakeHome(t);
  const result = await run(discoverProjects({ ...options(env), home: path.join(env.base, 'nope') }));
  assert.deepEqual(result.projects, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^home: /);
});

test('open resolves null on failure and retries on the next call', async t => {
  const env = await fakeHome(t);
  const a = await makeProject(path.join(env.home, 'dev/alpha'));
  await session(env, a);
  let calls = 0, fail = true;
  const errors = t.mock.method(console, 'error', () => {});
  const registry = createRegistry({ ...options(env), openProject: async root => { calls++; if (fail) throw new Error('stat race'); return { root }; } });
  const [{ id }] = (await registry.list()).projects;
  assert.equal(await registry.open(id), null);
  assert.equal(errors.mock.callCount(), 1);
  fail = false;
  assert.deepEqual(await registry.open(id), { root: await realOf(a) });
  assert.equal(calls, 2);
  assert.equal(await registry.open(id), await registry.open(id));
  assert.equal(calls, 2);
  assert.equal(await registry.open('unknown-00000000'), null);
});

test('open with the real openProject resolves null when the root vanished after discovery', async t => {
  const env = await fakeHome(t);
  const a = await makeProject(path.join(env.home, 'dev/alpha'));
  await session(env, a);
  t.mock.method(console, 'error', () => {});
  const registry = createRegistry(options(env));
  const [{ id }] = (await registry.list()).projects;
  await rm(a, { recursive: true, force: true });
  assert.equal(await registry.open(id), null);
});

test('the facade caches discovery for 5 seconds and evicts vanished projects', async t => {
  const env = await fakeHome(t);
  const a = await makeProject(path.join(env.home, 'dev/alpha'));
  await session(env, a);
  let clock = 1000, discoveries = 0;
  const registry = createRegistry({
    ...options(env),
    now: () => clock,
    discover: input => { discoveries++; return runEdge(discoverProjects(input)); },
    openProject: async root => ({ root }),
  });
  await Promise.all(Array.from({ length: 10 }, () => registry.resolve('unknown-00000000')));
  for (let i = 0; i < 10; i++) assert.equal(await registry.resolve('unknown-00000000'), null);
  assert.equal(discoveries, 1);
  const [{ id }] = (await registry.list()).projects;
  assert.ok(await registry.open(id));
  await rm(a, { recursive: true, force: true });
  clock += 4999;
  assert.ok(await registry.open(id), 'still cached inside 5 seconds');
  clock += 2;
  assert.equal(await registry.open(id), null);
  assert.equal(discoveries, 2);
});

test('100 session folders finish quickly', async t => {
  const env = await fakeHome(t);
  const realTmp = await realOf(env.tmpDir);
  for (let i = 0; i < 100; i++) {
    const dir = await makeProject(path.join(env.home, `dev/p${i}`));
    await session(env, dir);
    const journals = 2 + (i % 2);
    for (let j = 0; j < journals; j++) await writeFile(path.join(dir, `.pi/workflows/r${j}.workflow.jsonl`), '{}\n');
    const tasks = path.join(sessionRunsRoot(await realOf(dir), realTmp, uid), 'sess/tasks');
    await mkdir(tasks, { recursive: true });
    for (let j = 0; j < journals; j++) await writeFile(path.join(tasks, `s${j}.workflow.jsonl`), '{}\n');
  }
  const start = performance.now();
  const result = await run(discoverProjects(options(env)));
  const elapsed = performance.now() - start;
  t.diagnostic(`discovery of 100 projects took ${elapsed.toFixed(1)} ms`);
  assert.equal(result.projects.length, 100);
  assert.ok(result.projects.every(p => p.lastRunAt !== null));
  if (!process.env.CI) assert.ok(elapsed < 300, `took ${elapsed.toFixed(1)} ms`);
});

test('RF-all: open rechecks the root and refuses one swapped for a symlink out of home', async t => {
  const env = await fakeHome(t);
  const a = await makeProject(path.join(env.home, 'dev/alpha'));
  await session(env, a);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'studio-registry-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await makeProject(outside);
  t.mock.method(console, 'error', () => {});
  let opens = 0;
  const registry = createRegistry({ ...options(env), openProject: async root => { opens++; return { root }; } });
  const [{ id, root }] = (await registry.list()).projects;
  await rm(a, { recursive: true, force: true });
  await symlink(outside, a);
  assert.equal(await registry.open(id), null);
  assert.equal(opens, 0);
  const { warnings } = await registry.list();
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].startsWith(`project ${root}: `), warnings[0]);
});

test('RF-all: two roots with the same id are both dropped with one warning', async t => {
  const env = await fakeHome(t);
  const one = await makeProject(path.join(env.home, 'one/quality'));
  const two = await makeProject(path.join(env.home, 'two/quality'));
  const other = await makeProject(path.join(env.home, 'dev/other'));
  for (const dir of [one, two, other]) await session(env, dir);
  const idOf = root => path.basename(root) === 'quality' ? 'quality-00000000' : projectId(root);
  const result = await run(discoverProjects({ ...options(env), idOf }));
  assert.deepEqual(roots(result), [await realOf(other)]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /quality-00000000/);
  assert.ok(result.warnings[0].includes(await realOf(one)) && result.warnings[0].includes(await realOf(two)));
});

test('RF-all: an id that moves to another root after a refresh never serves the old root', async () => {
  let clock = 0, root = '/home/one/quality';
  const entry = () => ({ id: 'quality-00000000', root, name: 'quality', workflows: 1, lastRunAt: null, source: /** @type {const} */ ('session') });
  const registry = createRegistry({
    home: '/home', now: () => clock,
    discover: async () => ({ projects: [entry()], warnings: [] }),
    check: async r => ({ root: r, workflows: 1 }),
    openProject: async r => ({ root: r }),
  });
  assert.deepEqual(await registry.open('quality-00000000'), { root: '/home/one/quality' });
  root = '/home/two/quality';
  clock += 5001;
  assert.deepEqual(await registry.open('quality-00000000'), { root: '/home/two/quality' });
});

test('RF-all: nothing outside home is statted and journal symlinks out of the project are skipped', async t => {
  const env = await fakeHome(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'studio-registry-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await makeProject(outside);
  const realOutside = await realOf(outside);
  const a = await makeProject(path.join(env.home, 'dev/alpha'));
  await session(env, a);
  const journal = path.join(realOutside, 'x.workflow.jsonl');
  await writeFile(journal, '{}\n');
  await symlink(journal, path.join(a, '.pi/workflows/x.workflow.jsonl'));
  const statted = [];
  const stat = async file => { statted.push(file); return fsp.stat(file); };
  const result = await run(discoverProjects({ ...options(env), extra: [outside] }), { stat });
  assert.deepEqual(roots(result), [await realOf(a)]);
  assert.equal(result.projects[0].lastRunAt, null);
  assert.deepEqual(statted.filter(file => file.startsWith(realOutside) || file.startsWith(outside)), []);
  assert.deepEqual(result.warnings, [`--project ${outside}: outside your home folder`]);
});

test('RF-all: a slow discovery is shared until it settles, then the 5 second cache starts', async () => {
  let clock = 0, discoveries = 0, finish = () => {};
  const registry = createRegistry({
    home: '/home', now: () => clock,
    discover: () => { discoveries++; return new Promise(resolve => { finish = () => resolve({ projects: [], warnings: [] }); }); },
  });
  const first = registry.list();
  clock += 6000;
  const second = registry.list();
  assert.equal(first, second);
  assert.equal(discoveries, 1);
  finish();
  await first;
  clock += 4999;
  assert.equal(registry.list(), first);
  assert.equal(discoveries, 1);
  clock += 2;
  const third = registry.list();
  assert.notEqual(third, first);
  assert.equal(discoveries, 2);
  finish();
  await third;
});

/** A ProjectFs override that records the real path of every readdir, stat and open target. */
const recordTargets = touched => {
  const record = async file => { touched.push(await fsp.realpath(file).catch(() => file)); };
  return {
    readdir: async (dir, ...rest) => { await record(dir); return fsp.readdir(dir, ...rest); },
    stat: async (file, ...rest) => { await record(file); return fsp.stat(file, ...rest); },
    open: async (file, ...rest) => { await record(file); return fsp.open(file, ...rest); },
  };
};

test('RF-all: a session runs folder that is a symlink out of tmpDir is skipped and never read', async t => {
  const env = await fakeHome(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'studio-registry-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const realOutside = await realOf(outside);
  await mkdir(path.join(realOutside, 'sess-1/tasks'), { recursive: true });
  await writeFile(path.join(realOutside, 'sess-1/tasks/x.workflow.jsonl'), '{}\n');
  const a = await makeProject(path.join(env.home, 'dev/alpha'));
  await session(env, a);
  const runs = sessionRunsRoot(await realOf(a), await realOf(env.tmpDir), uid);
  await mkdir(path.dirname(runs), { recursive: true });
  await symlink(realOutside, runs);
  const touched = [];
  const result = await run(discoverProjects(options(env)), recordTargets(touched));
  assert.deepEqual(roots(result), [await realOf(a)]);
  assert.equal(result.projects[0].lastRunAt, null);
  assert.deepEqual(touched.filter(file => file.startsWith(realOutside)), []);
});

test('RF-all: a session folder that is a symlink out of the sessions folder is never listed or read', async t => {
  const env = await fakeHome(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'studio-registry-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const realOutside = await realOf(outside);
  // The outside header names a valid project in home that no other session points at.
  const hidden = await makeProject(path.join(env.home, 'dev/hidden'));
  await writeFile(path.join(realOutside, '2026-10-01T00-00-00_a.jsonl'), JSON.stringify({ type: 'session', cwd: hidden }) + '\n');
  await symlink(realOutside, path.join(env.sessionsDir, '--escape--'));
  const a = await makeProject(path.join(env.home, 'dev/alpha'));
  await session(env, a);
  const touched = [];
  const result = await run(discoverProjects(options(env)), recordTargets(touched));
  assert.deepEqual(roots(result), [await realOf(a)]);
  assert.deepEqual(touched.filter(file => file.startsWith(realOutside)), []);
});

test('RF-all: isProjectId requires a slug and an 8 hex suffix', () => {
  for (const id of ['x', '123', 'abc-nothex', 'abc-1234567', 'abc-123456789', '-abc-12345678', 'ABC-12345678', 'a'.repeat(41) + '-12345678']) assert.ok(!isProjectId(id), id);
  for (const id of ['a-12345678', 'quality-3fa29c1b', 'a'.repeat(40) + '-deadbeef']) assert.ok(isProjectId(id), id);
});
