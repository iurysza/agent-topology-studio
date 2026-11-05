import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { allProjectsUrl, defaultTimeoutMs, findInstance, instanceKey, listInstances, openUrl, startInstance, stateDir, stopInstance } from '../bin/instances.ts';

const server = { entry: 'server/main.js', extraArgs: ['--api-only'] };
const mode = async file => (await stat(file)).mode & 0o777;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const deadPid = () => spawnSync('true').pid;

async function setup(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-instances-')));
  const dir = path.join(root, 'state'), project = path.join(root, 'project');
  await cp(new URL('../fixtures/playground', import.meta.url), project, { recursive: true });
  const pids = new Set();
  t.after(async () => {
    for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
    await rm(root, { recursive: true, force: true });
  });
  const start = async (target = project, options = {}) => {
    const result = await startInstance(target, { dir, ...server, timeoutMs: 15_000, ...options });
    pids.add(result.record.pid);
    return result;
  };
  const files = (target = project) => {
    const key = instanceKey(target);
    return { record: path.join(dir, `${key}.json`), log: path.join(dir, `${key}.log`), lock: path.join(dir, `${key}.lock`) };
  };
  return { root, dir, project, start, files };
}

test('stateDir follows XDG_STATE_HOME, else ~/.local/state', () => {
  assert.equal(stateDir({ XDG_STATE_HOME: '/x' }), '/x/topology-studio');
  assert.equal(stateDir({}), path.join(os.homedir(), '.local/state/topology-studio'));
  assert.match(instanceKey('/a'), /^[0-9a-f]{40}$/);
});

test('start writes a private record and log, and the server serves the project', async t => {
  const { dir, project, start, files } = await setup(t);
  const { record, reused } = await start();
  assert.equal(reused, false);
  for (const field of ['pid', 'port', 'token', 'project', 'startedAt']) assert.ok(record[field], field);
  assert.equal(record.project, project);
  assert.equal(await mode(files().record), 0o600);
  assert.equal(await mode(files().log), 0o600);
  assert.equal(await mode(dir), 0o700);
  assert.deepEqual(JSON.parse(await readFile(files().record, 'utf8')), record);
  const response = await fetch(`http://127.0.0.1:${record.port}/api/project`, { headers: { 'X-Studio-Token': record.token } });
  assert.equal(/** @type {{ dir: string }} */ (await response.json()).dir, project);
  assert.deepEqual((await listInstances({ dir })).map(r => r.pid), [record.pid]);
});

test('a pre-existing 0644 log ends up 0600', async t => {
  const { dir, start, files } = await setup(t);
  await mkdir(dir, { recursive: true });
  await writeFile(files().log, 'old', { mode: 0o644 });
  await start();
  assert.equal(await mode(files().log), 0o600);
});

test('a second start reuses the instance', async t => {
  const { start } = await setup(t);
  const first = await start();
  const second = await start();
  assert.equal(second.reused, true);
  assert.equal(second.record.pid, first.record.pid);
});

test('concurrent starts share one server and release the lock', async t => {
  const { start, files } = await setup(t);
  const results = await Promise.all([start(), start()]);
  assert.equal(results[0].record.pid, results[1].record.pid);
  assert.deepEqual(results.map(r => r.reused).sort(), [false, true]);
  assert.equal(existsSync(files().lock), false);
});

test('a record with a dead pid is replaced', async t => {
  const { dir, project, start, files } = await setup(t);
  await mkdir(dir, { recursive: true });
  const pid = deadPid();
  await writeFile(files().record, JSON.stringify({ pid, port: 1, token: 'ab', project, startedAt: 'x', url: 'x', log: files().log }));
  assert.equal(await findInstance(project, { dir }), null);
  assert.equal(existsSync(files().record), false);
  const { record, reused } = await start();
  assert.equal(reused, false);
  assert.notEqual(record.pid, pid);
});

test('a live studio for another project does not count', async t => {
  const { root, dir, start, files } = await setup(t);
  const { record } = await start();
  const other = path.join(root, 'other');
  await mkdir(other);
  await writeFile(files(other).record, JSON.stringify(record));
  assert.equal(await findInstance(other, { dir }), null);
  assert.equal(existsSync(files(other).record), false);
});

test('a configured port is honoured', async t => {
  const { start } = await setup(t);
  assert.equal((await start(undefined, { port: 48931 })).record.port, 48931);
});

test('a busy port fails and leaves no record or lock', async t => {
  const { project, dir, files } = await setup(t);
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(48932, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  await assert.rejects(startInstance(project, { dir, ...server, port: 48932, timeoutMs: 15_000 }), /failed to start/);
  assert.equal(existsSync(files().record), false);
  assert.equal(existsSync(files().lock), false);
});

test('a server that exits at once fails the start and leaves no log, record or lock', async t => {
  const { root, project, dir, files } = await setup(t);
  const entry = path.relative(path.join(import.meta.dirname, '..'), path.join(root, 'exits.js'));
  await writeFile(path.join(root, 'exits.js'), "console.error('boom'); process.exit(3);\n");
  await assert.rejects(startInstance(project, { dir, entry, timeoutMs: 15_000 }), /failed to start: boom/);
  for (const file of ['log', 'record', 'lock']) assert.equal(existsSync(files()[file]), false, file);
});

test('a missing entry fails the start and leaves no log, record or lock', async t => {
  const { project, dir, files } = await setup(t);
  await assert.rejects(startInstance(project, { dir, entry: 'server/no-such-entry.js', timeoutMs: 15_000 }), /No entry/);

  for (const file of ['log', 'record', 'lock']) assert.equal(existsSync(files()[file]), false, file);
});

test('a lock held by a dead pid is cleared at once', async t => {
  const { dir, start, files } = await setup(t);
  await mkdir(dir, { recursive: true });
  await writeFile(files().lock, JSON.stringify({ pid: deadPid(), startedAt: 'x' }));
  const began = Date.now();
  assert.equal((await start()).reused, false);
  assert.ok(Date.now() - began < 2000, `took ${Date.now() - began} ms`);
  assert.equal(existsSync(files().lock), false);
});

test('concurrent starts against a dead-pid lock start exactly one server', async t => {
  const { dir, start, files } = await setup(t);
  await mkdir(dir, { recursive: true });
  await writeFile(files().lock, JSON.stringify({ pid: deadPid(), startedAt: 'x' }));
  const results = await Promise.all(Array.from({ length: 8 }, () => start()));
  assert.deepEqual(results.map(r => r.reused).sort(), [false, ...Array(7).fill(true)]);
  assert.equal(new Set(results.map(r => r.record.pid)).size, 1);
  assert.equal(existsSync(files().lock), false);
  assert.equal(existsSync(`${files().lock}.reclaim`), false);
});

test('a lock with a non-positive pid is treated as unreadable and reclaimed once old', async t => {
  const { dir, start, files } = await setup(t);
  await mkdir(dir, { recursive: true });
  await writeFile(files().lock, JSON.stringify({ pid: 0, startedAt: 'x' }));
  const old = new Date(Date.now() - 60_000);
  await utimes(files().lock, old, old);
  assert.equal((await start()).reused, false);
  assert.equal(existsSync(files().lock), false);
});

for (const [name, failAt] of [['write', 'writeFile'], ['rename', 'rename']]) {
  test(`a failed record ${name} kills the server and leaves no record, temp file, log or lock`, async t => {
    const { dir, project, files } = await setup(t);
    let pid;
    const fsOps = {
      writeFile: async (file, data, options) => {
        pid = JSON.parse(data).pid;
        if (failAt === 'writeFile') await mkdir(file);
        return writeFile(file, data, options);
      },
      rename: async (from, to) => {
        if (failAt === 'rename') throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
        return rename(from, to);
      },
    };
    await assert.rejects(startInstance(project, { dir, ...server, timeoutMs: 15_000, fsOps }), failAt === 'rename' ? /injected rename failure/ : /EISDIR/);
    t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } });
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(pid), false);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(existsSync(files().lock), false);
  });
}

test('a waiter takes over when the holder gives up', async t => {
  const { dir, start, files } = await setup(t);
  await mkdir(dir, { recursive: true });
  await writeFile(files().lock, JSON.stringify({ pid: process.pid, startedAt: 'x' }));
  setTimeout(() => rm(files().lock, { force: true }), 300);
  const began = Date.now();
  assert.equal((await start(undefined, { timeoutMs: 10_000 })).reused, false);
  assert.ok(Date.now() - began < 8000);
});

test('a lock that is never released times out', async t => {
  const { project, dir, files } = await setup(t);
  await mkdir(dir, { recursive: true });
  await writeFile(files().lock, JSON.stringify({ pid: process.pid, startedAt: 'x' }));
  const began = Date.now();
  await assert.rejects(startInstance(project, { dir, ...server, timeoutMs: 1000 }), /holds the lock/);
  const took = Date.now() - began;
  assert.ok(took >= 900 && took < 3000, `took ${took} ms`);
});

test('stop kills the server and removes the record and log', async t => {
  const { dir, project, start, files } = await setup(t);
  const { record } = await start();
  assert.equal(await stopInstance(project, { dir }), true);
  assert.equal(alive(record.pid), false);
  assert.equal(existsSync(files().record), false);
  assert.equal(existsSync(files().log), false);
  assert.equal(await stopInstance(project, { dir }), false);
});

test('a start that overlaps a stop waits for it, and its record and log survive', async t => {
  const { dir, project, start, files } = await setup(t);
  const first = await start();
  const stopping = stopInstance(project, { dir });
  for (let i = 0; i < 400 && !existsSync(files().lock); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(existsSync(files().lock), true, 'stop holds the lock');
  const [stopped, second] = await Promise.all([stopping, start()]);
  assert.equal(stopped, true);
  assert.equal(second.reused, false);
  assert.notEqual(second.record.pid, first.record.pid);
  assert.equal(alive(first.record.pid), false);
  assert.equal(alive(second.record.pid), true);
  assert.deepEqual(JSON.parse(await readFile(files().record, 'utf8')), second.record);
  assert.equal(existsSync(files().log), true);
  assert.equal(existsSync(files().lock), false);
  assert.equal((await findInstance(project, { dir })).pid, second.record.pid);
});

test('malformed records are stale and never signalled', async t => {
  const { dir, project, files } = await setup(t);
  await mkdir(dir, { recursive: true });
  const valid = { pid: process.pid, port: 1, token: 'ab', project, startedAt: 'x', url: 'http://127.0.0.1:1/?token=ab', log: files().log };
  const kill = t.mock.method(process, 'kill', () => true);
  for (const bad of [{ pid: -1 }, { pid: 0 }, { pid: 1.5 }, { port: 0 }, { port: 70000 }, { token: '' }, { token: 'XYZ' }, { url: 'http://evil/' }, { startedAt: 1 }, { log: null }]) {
    await writeFile(files().record, JSON.stringify({ ...valid, ...bad }));
    assert.equal(await findInstance(project, { dir }), null, JSON.stringify(bad));
    assert.equal(existsSync(files().record), false, JSON.stringify(bad));
    await writeFile(files().record, JSON.stringify({ ...valid, ...bad }));
    assert.equal(await stopInstance(project, { dir }), false, JSON.stringify(bad));
    assert.equal(existsSync(files().record), false, JSON.stringify(bad));
  }
  kill.mock.restore();
  assert.deepEqual(kill.mock.calls.map(call => call.arguments), []);
});

test('a missing project is reported', async t => {
  const { dir } = await setup(t);
  await assert.rejects(startInstance('/does/not/exist', { dir, ...server }), /Project not found/);
});

test('default timeout is 30 s installed and 300 s in a source checkout', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(defaultTimeoutMs(root), 30_000);
  await mkdir(path.join(root, 'web/src'), { recursive: true });
  assert.equal(defaultTimeoutMs(root), 300_000);
});

test('openUrl uses the platform opener and falls back to printing the URL', async t => {
  const calls = [];
  const child = new EventEmitter();
  const done = openUrl('http://x/', (command, args) => { calls.push([command, ...args]); return child; });
  assert.deepEqual(calls, [[process.platform === 'darwin' ? 'open' : 'xdg-open', 'http://x/']]);
  const printed = t.mock.method(console, 'error', () => {});
  child.emit('error', new Error('ENOENT'));
  await done;
  assert.match(printed.mock.calls[0].arguments[0], /Open this URL in your browser: http:\/\/x\//);
});

test('openUrl prints the fallback exactly once on any unsuccessful exit, and never on success', async t => {
  const printed = t.mock.method(console, 'error', () => {});
  /** @type {Array<[(child: EventEmitter) => void, number]>} */
  const cases = [
    [child => child.emit('exit', 3, null), 1],
    [child => child.emit('exit', null, 'SIGTERM'), 1],
    [child => { child.emit('error', new Error('ENOENT')); child.emit('exit', -2, null); }, 1],
    [child => child.emit('exit', 0, null), 0],
  ];
  for (const [emit, expected] of cases) {
    printed.mock.resetCalls();
    const child = new EventEmitter();
    const done = openUrl('http://x/', () => child);
    emit(child);
    await done;
    assert.equal(printed.mock.calls.length, expected);
  }
  printed.mock.resetCalls();
  await openUrl('http://x/', () => { throw new Error('spawn failed'); });
  assert.equal(printed.mock.calls.length, 1);
});

// decisions.md D3 amendment: a live pid whose /api/projects answers after the 2 s identity timeout is busy, not stale.
test('a slow all-projects server keeps its record: start and stop refuse instead of replacing it', async t => {
  const { dir } = await setup(t);
  const slow = http.createServer((req, res) => { setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"projects":[],"warnings":[]}'); }, 2500); });
  await new Promise(resolve => slow.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { slow.closeAllConnections(); slow.close(resolve); }));
  const port = /** @type {import('node:net').AddressInfo} */ (slow.address()).port;
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'all.json');
  const record = { pid: process.pid, port, token: 'ab', project: '*', startedAt: 'x', url: `http://127.0.0.1:${port}/?token=ab`, log: path.join(dir, 'all.log') };
  const text = JSON.stringify(record);
  await writeFile(file, text);
  await assert.rejects(startInstance(undefined, { dir, all: true, ...server, timeoutMs: 15_000 }), /all-projects studio is busy.*try again/);
  assert.equal(await readFile(file, 'utf8'), text);
  assert.equal(existsSync(record.log), false, 'no second server was launched');
  assert.equal(existsSync(path.join(dir, 'all.lock')), false);
  await assert.rejects(findInstance(undefined, { dir, all: true }), /busy/);
  await assert.rejects(stopInstance(undefined, { dir, all: true }), /busy/);
  assert.equal(await readFile(file, 'utf8'), text);
  assert.equal(existsSync(path.join(dir, 'all.lock')), false);
});

test('start --all with a missing --project still passes it to the server', async t => {
  const { root, dir } = await setup(t);
  const missing = path.join(root, 'no-such-project');
  const { record } = await startInstance(missing, { dir, all: true, ...server, timeoutMs: 15_000 });
  t.after(() => { try { process.kill(-record.pid, 'SIGKILL'); } catch { /* gone */ } });
  assert.equal(record.project, '*');
  const view = await allProjectsUrl(record, missing);
  assert.equal(view.url, record.url);
  assert.equal(view.warning, `--project ${missing}: not found`);
});
