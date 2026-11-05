import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudioExtension, parseStudioArgs, readProjects } from '../pi/studio.ts';
import { findInstance } from '../bin/instances.ts';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Fake pi and ctx. Records every registration and notice; openUrl only records.
async function setup(t, extra = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-pi-ext-')));
  const dir = path.join(root, 'state'), project = path.join(root, 'project'), settingsPath = path.join(root, 'settings.json');
  await cp(new URL('../fixtures/playground', import.meta.url), project, { recursive: true });
  const opened = [], commands = new Map(), listeners = [];
  const pi = {
    registerCommand: (name, command) => { commands.set(name, command); },
    on: (event, fn) => { listeners.push({ event, fn }); },
    events: { on: (event, fn) => { listeners.push({ event, fn }); } },
  };
  createStudioExtension({ dir, port: 0, entry: 'server/main.js', extraArgs: ['--api-only'], timeoutMs: 15_000, settingsPath, openUrl: async url => { opened.push(url); }, ...extra })(pi);
  t.after(async () => {
    for (const name of (await readdir(dir).catch(() => [])).filter(n => n.endsWith('.json'))) {
      try { const { pid } = JSON.parse(await readFile(path.join(dir, name), 'utf8')); process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  const run = async (args, cwd = project, { hasUI = true, select = async () => undefined } = {}) => {
    const notices = [];
    const ctx = { cwd, hasUI, ui: { notify: (message, level) => { notices.push({ message, level }); }, select } };
    await commands.get('studio').handler(args, ctx);
    return notices;
  };
  const collect = (version = 1) => {
    const groups = [];
    for (const l of listeners.filter(l => l.event === 'command-menu:collect:v1')) l.fn({ version, add: group => { groups.push(group); } });
    return groups;
  };
  return { root, dir, project, settingsPath, opened, commands, listeners, run, collect };
}

test('/studio starts a studio, opens it, and reuses it on the second call', async t => {
  const { dir, project, opened, run } = await setup(t);
  const first = await run('');
  const url = first.at(-1).message.match(/^Topology studio: (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)$/)?.[1];
  assert.ok(url, JSON.stringify(first));
  assert.deepEqual(opened, [url]);
  assert.ok(first.some(n => n.message === 'Starting Topology studio for project…' && n.level === 'info'));
  assert.ok(!first.some(n => n.level === 'warning' || n.level === 'error'));
  const record = await findInstance(project, { dir });
  assert.equal(record?.url, url);
  const second = await run('');
  assert.equal(second.at(-1).message, `Topology studio: ${url} (already running)`);
  assert.equal((await findInstance(project, { dir }))?.pid, record.pid);
  assert.equal(opened.length, 2);
});

test('/studio open opens a running studio and starts nothing when none runs', async t => {
  const { dir, project, opened, run } = await setup(t);
  const idle = await run('open');
  assert.deepEqual(idle, [{ message: `Topology studio is not running for ${project}. Run /studio to start it.`, level: 'info' }]);
  assert.equal(opened.length, 0);
  assert.equal(await findInstance(project, { dir }), null);
  await run('');
  const record = await findInstance(project, { dir });
  const notices = await run('open');
  assert.deepEqual(notices, [{ message: `Topology studio: ${record.url}`, level: 'info' }]);
  assert.deepEqual(opened, [record.url, record.url]);
});

test('/studio stop stops the studio, and a second stop reports not running', async t => {
  const { dir, project, run } = await setup(t);
  await run('');
  const { pid } = await findInstance(project, { dir });
  assert.deepEqual(await run('stop'), [{ message: 'Topology studio stopped', level: 'info' }]);
  assert.equal(alive(pid), false);
  assert.deepEqual(await run('stop'), [{ message: `Topology studio is not running for ${project}`, level: 'info' }]);
});

test('/studio warns when .pi/workflows is missing, then starts', async t => {
  const { root, dir, run } = await setup(t);
  const empty = path.join(root, 'empty');
  await mkdir(empty);
  const notices = await run('', empty);
  assert.equal(notices[0].level, 'warning');
  assert.match(notices[0].message, new RegExp(`^No \\.pi/workflows in ${empty}\\. The studio opens with an empty list\\.`));
  assert.match(notices.at(-1).message, /^Topology studio: http:/);
  assert.ok(await findInstance(empty, { dir }));
});

test('/studio on a missing path notifies an error and does not throw', async t => {
  const { run } = await setup(t);
  const notices = await run('/does/not/exist');
  const last = notices.at(-1);
  assert.equal(last.level, 'error');
  assert.match(last.message, /Project not found: \/does\/not\/exist/);
});

test('the studio outlives the session: no session_shutdown handler', async t => {
  const { dir, project, listeners, run } = await setup(t);
  await run('');
  assert.ok(!listeners.some(l => l.event === 'session_shutdown'));
  const { pid } = await findInstance(project, { dir });
  assert.equal(alive(pid), true);
});

test('path rule: subcommand words win, ./name is a path, bare names are errors, ~ expands', async t => {
  const { root, dir, run } = await setup(t);
  const cwd = path.join(root, 'cwd'), named = path.join(cwd, 'stop');
  await mkdir(path.join(named, '.pi/workflows'), { recursive: true });
  // A bare subcommand stops (nothing runs here), it does not open the directory named stop.
  assert.deepEqual(await run('stop', cwd), [{ message: `Topology studio is not running for ${cwd}`, level: 'info' }]);
  assert.equal(await findInstance(named, { dir }), null);
  const started = await run('./stop', cwd);
  assert.match(started.at(-1).message, /^Topology studio: http:/);
  assert.ok(await findInstance(named, { dir }));
  const unknown = await run('foo', cwd);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].level, 'error');
  assert.match(unknown[0].message, /^Unknown argument: foo\. /);
  const home = os.homedir();
  const missing = await run('~/topology-studio-missing-dir-xyz', cwd);
  assert.equal(missing.at(-1).level, 'error');
  assert.equal(missing.at(-1).message, `Project not found: ${path.join(home, 'topology-studio-missing-dir-xyz')}`);
  assert.deepEqual(parseStudioArgs('~/x', '/c', '/h'), { kind: 'ensure', dir: '/h/x' });
  assert.deepEqual(parseStudioArgs('~', '/c', '/h'), { kind: 'ensure', dir: '/h' });
  assert.deepEqual(parseStudioArgs(' ../y ', '/c/d', '/h'), { kind: 'ensure', dir: '/c/y' });
});

test('argument completions', async t => {
  const { commands } = await setup(t);
  const complete = commands.get('studio').getArgumentCompletions;
  assert.deepEqual(complete('s'), [{ value: 'stop', label: 'stop' }]);
  assert.deepEqual(complete('').map(i => i.value), ['open', 'stop', 'pick', 'all']);
  assert.deepEqual(complete('a'), [{ value: 'all', label: 'all' }]);
  assert.deepEqual(complete('p'), [{ value: 'pick', label: 'pick' }]);
  assert.equal(complete('z'), null);
});

const fixedKeys = ['o', 'p', 'x', 'a'];

test('Leader Key menu: fixed items plus valid configured projects with absolute paths', async t => {
  const { settingsPath, collect } = await setup(t);
  await writeFile(settingsPath, JSON.stringify({ topologyStudio: { projects: [
    { key: 'g', label: 'Agents', path: '~/dev/agents2' },
    { key: 'q', label: 'Quality', path: './rel/q' },
    { key: 'o', label: 'Clash', path: '/x' },
    { key: 'a', label: 'Reserved', path: '/y' },
  ] } }));
  const groups = collect();
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group.id, 'topology-studio');
  assert.equal(group.key, 's');
  assert.equal(group.label, 'Studio');
  assert.deepEqual(group.items.map(i => i.key), [...fixedKeys, 'g', 'q']);
  assert.deepEqual(group.items[0].command, { name: 'studio' });
  assert.deepEqual(group.items[1].command, { name: 'studio', args: 'pick' });
  assert.deepEqual(group.items[2].command, { name: 'studio', args: 'stop' });
  assert.deepEqual(group.items[3], { key: 'a', label: 'Open all-projects view', command: { name: 'studio', args: 'all' } });
  assert.deepEqual(group.items[4].command, { name: 'studio', args: path.join(os.homedir(), 'dev/agents2') });
  for (const item of group.items.slice(4)) assert.ok(path.isAbsolute(item.command.args));
});

test('Leader Key menu: wrong version adds nothing; missing or invalid settings give the fixed items', async t => {
  const { settingsPath, collect } = await setup(t);
  assert.equal(collect(2).length, 0);
  assert.deepEqual(collect()[0].items.map(i => i.key), fixedKeys);
  await writeFile(settingsPath, '{ not json');
  assert.deepEqual(collect()[0].items.map(i => i.key), fixedKeys);
});

test('Leader Key menu: settings are read again on every collect, without a Pi reload', async t => {
  const { settingsPath, collect } = await setup(t);
  const write = projects => writeFile(settingsPath, JSON.stringify({ topologyStudio: { projects } }));
  await write([{ key: 'g', label: 'G', path: '/g' }]);
  assert.deepEqual(collect()[0].items.map(i => i.key), [...fixedKeys, 'g']);
  await write([{ key: 'q', label: 'Q', path: '/q' }]);
  assert.deepEqual(collect()[0].items.map(i => i.key), [...fixedKeys, 'q']);
  await write([]);
  assert.deepEqual(collect()[0].items.map(i => i.key), fixedKeys);
});

test('readProjects drops blank labels, newline paths and duplicate keys', async t => {
  const { settingsPath } = await setup(t);
  await writeFile(settingsPath, JSON.stringify({ topologyStudio: { projects: [
    { key: 'b', label: ' ', path: '/a' },
    { key: 'c', label: 'C', path: '/a\n/b' },
    { key: 'd', label: 'D', path: '/d' },
    { key: 'd', label: 'D2', path: '/d2' },
    { key: 'E', label: 'E', path: '/e' },
    { key: 'f', label: 'F', path: '' },
  ] } }));
  assert.deepEqual(readProjects(settingsPath, '/h'), [{ key: 'd', label: 'D', path: '/d' }]);
  assert.deepEqual(readProjects(path.join(settingsPath, 'missing'), '/h'), []);
});

test('/studio pick starts the chosen project, cancels on undefined, and lists without UI', async t => {
  const { root, dir, project, settingsPath, run } = await setup(t);
  const other = path.join(root, 'other');
  await cp(new URL('../fixtures/playground', import.meta.url), other, { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ topologyStudio: { projects: [
    { key: 'g', label: 'Other', path: other },
    { key: 'h', label: 'Same as cwd', path: project },
  ] } }));
  let seen = { title: '', labels: [] };
  const cancelled = await run('pick', project, { select: async (title, labels) => { seen = { title, labels }; return undefined; } });
  assert.deepEqual(cancelled, []);
  assert.equal(seen.title, 'Open Topology studio for');
  assert.deepEqual(seen.labels, [`Same as cwd — ${project}`, `Other — ${other}`]);
  assert.equal(await findInstance(other, { dir }), null);
  const started = await run('pick', project, { select: async (_title, labels) => labels[1] });
  assert.match(started.at(-1).message, /^Topology studio: http:/);
  assert.ok(await findInstance(other, { dir }));
  const listed = await run('pick', project, { hasUI: false });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].message, `Projects:\n${project}\n${other}\nRun /studio <path>`);
  let labels = [];
  await run('pick', project, { select: async (_t, l) => { labels = l; return undefined; } });
  assert.equal(labels[1], `Other — ${other} (running)`);
});

test('/studio pick deduplicates by realpath and lists live-only projects last as running', async t => {
  const { root, project, settingsPath, run } = await setup(t);
  const other = path.join(root, 'other'), alias = path.join(root, 'alias'), third = path.join(root, 'third');
  await cp(new URL('../fixtures/playground', import.meta.url), other, { recursive: true });
  await cp(new URL('../fixtures/playground', import.meta.url), third, { recursive: true });
  await symlink(other, alias);
  await writeFile(settingsPath, JSON.stringify({ topologyStudio: { projects: [
    { key: 'g', label: 'Other', path: other },
    { key: 'i', label: 'Alias', path: alias },
  ] } }));
  let labels = [];
  const capture = async (_t, l) => { labels = l; };

  await run('pick', project, { select: capture });
  assert.deepEqual(labels, [`project — ${project}`, `Other — ${other}`]);
  // Start the configured project, then one that is not in settings.
  assert.match((await run(other)).at(-1).message, /^Topology studio: http:/);
  assert.match((await run(third)).at(-1).message, /^Topology studio: http:/);
  await run('pick', project, { select: capture });
  assert.deepEqual(labels, [`project — ${project}`, `Other — ${other} (running)`, `third — ${third} (running)`]);
});

// A fake HOME whose Pi sessions name one copy of the playground, so an --all server discovers only that project.
// TMPDIR points outside the fake home, because the registry skips projects under the temp folder.
async function fakeAllHome(root) {
  const home = path.join(root, 'home'), tmp = path.join(root, 'tmp'), listed = path.join(home, 'dev/listed');
  await mkdir(tmp, { recursive: true });
  await cp(new URL('../fixtures/playground', import.meta.url), listed, { recursive: true });
  const folder = path.join(home, '.pi/agent/sessions', '--listed--');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, '2026-10-01T00-00-00_a.jsonl'), JSON.stringify({ type: 'session', cwd: listed }) + '\n');
  return { listed, env: { ...process.env, HOME: home, TMPDIR: tmp } };
}

test('/studio all starts the all-projects view preselecting this project, then reuses it', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-pi-all-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { listed, env } = await fakeAllHome(root);
  const { dir, opened, run } = await setup(t, { env });
  assert.deepEqual(parseStudioArgs('all', '/c'), { kind: 'all' });
  const first = await run('all', listed);
  assert.ok(!first.some(n => n.level === 'error'), JSON.stringify(first));
  const record = await findInstance(undefined, { dir, all: true });
  assert.ok(record);
  assert.equal(record.project, '*');
  const url = first.at(-1).message.match(/^Topology studio: (\S+)$/)?.[1];
  assert.match(url, new RegExp(`^${record.url.replace(/[?.]/g, '\\$&')}#/p/listed-[0-9a-f]{8}/$`));
  assert.deepEqual(opened, [url]);
  const second = await run('all', listed);
  assert.equal(second.at(-1).message, `Topology studio: ${url} (already running)`);
  assert.equal((await findInstance(undefined, { dir, all: true }))?.pid, record.pid);
  // The single-project registry is untouched: /studio all never starts a per-project studio.
  assert.equal(await findInstance(listed, { dir }), null);
});

test('/studio all warns with the server reason for an unlisted cwd, and generically on reuse', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-pi-all-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { env } = await fakeAllHome(root);
  const bare = path.join(env.HOME, 'dev/bare'), other = path.join(env.HOME, 'dev/other');
  await mkdir(bare, { recursive: true });
  await mkdir(other, { recursive: true });
  const { dir, opened, run } = await setup(t, { env });
  const first = await run('all', bare);
  const record = await findInstance(undefined, { dir, all: true });
  assert.ok(record);
  assert.deepEqual(first.filter(n => n.level === 'warning').map(n => n.message), [`--project ${bare}: no .pi/workflows/*.js`]);
  assert.equal(first.at(-1).message, `Topology studio: ${record.url}`);
  const second = await run('all', other);
  assert.deepEqual(second.filter(n => n.level === 'warning').map(n => n.message), [`--project ${other}: not listed in the all-projects view`]);
  assert.equal(second.at(-1).message, `Topology studio: ${record.url} (already running)`);
  assert.deepEqual(opened, [record.url, record.url]);
});
