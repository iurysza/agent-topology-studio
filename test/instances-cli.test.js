import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../bin/cli.ts';

const entry = fileURLToPath(new URL('../bin/studio.ts', import.meta.url));

async function setup(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-instances-cli-')));
  const dir = path.join(root, 'state'), project = path.join(root, 'project');
  await cp(new URL('../fixtures/playground', import.meta.url), project, { recursive: true });
  const opened = [];
  const deps = { dir, entry: 'server/main.js', extraArgs: ['--api-only'], timeoutMs: 15_000, openUrl: async url => { opened.push(url); } };
  t.after(async () => {
    const names = await readdir(dir).catch(() => []);
    for (const name of names.filter(n => n.endsWith('.json'))) {
      try { const { pid } = JSON.parse(await readFile(path.join(dir, name), 'utf8')); process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  // Runs main in process and captures console output and the exit code.
  const run = async args => {
    const out = [], err = [];
    const log = t.mock.method(console, 'log', (...a) => { out.push(a.join(' ')); });
    const error = t.mock.method(console, 'error', (...a) => { err.push(a.join(' ')); });
    const before = process.exitCode;
    process.exitCode = undefined;
    try { await main(args, deps); } finally { log.mock.restore(); error.mock.restore(); }
    const code = process.exitCode ?? 0;
    process.exitCode = before;
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  };
  return { root, dir, project, opened, run, deps };
}

test('open starts a studio, then reuses it and opens the browser', async t => {
  const { project, opened, run } = await setup(t);
  const first = await run(['open', '--project', project, '--no-open']);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^Topology studio: http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+$/);
  assert.equal(opened.length, 0);
  const second = await run(['open', '--project', project]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /\(already running\)$/);
  assert.equal(opened.length, 1);
  assert.equal(second.stdout, `${first.stdout} (already running)`);
});

test('open --json prints the persisted record with its token', async t => {
  const { dir, project, run } = await setup(t);
  const result = await run(['open', '--project', project, '--json', '--no-open']);
  assert.equal(result.code, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  const files = (await readdir(dir)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const persisted = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'));
  assert.deepEqual(record, { ...persisted, reused: false });
  assert.equal(new URL(record.url).searchParams.get('token'), record.token);
});

test('open --port honours a named port', async t => {
  const { project, run } = await setup(t);
  const result = await run(['open', '--project', project, '--port', '48933', '--no-open']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Topology studio: http:\/\/127\.0\.0\.1:48933\//);
});

test('open rejects bad ports, unknown flags and positionals', async t => {
  const { project, run } = await setup(t);
  const port = await run(['open', '--project', project, '--port', '70000']);
  assert.equal(port.code, 1); assert.match(port.stderr, /Port must be 0 to 65535/);
  for (const args of [['--bogus'], ['extra-positional']]) {
    const result = await run(['open', '--project', project, ...args]);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, /Invalid arguments/);
  }
});

test('open on a project without .pi/workflows starts and prints a hint', async t => {
  const { root, run } = await setup(t);
  const empty = path.join(root, 'empty');
  await mkdir(empty);
  const result = await run(['open', '--project', empty, '--no-open']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Topology studio: /);
  assert.match(result.stderr, new RegExp(`No \\.pi/workflows in ${empty}\\. .*agent-topology-studio new <id> --project ${empty}`));
});

test('stop stops a running studio, and a second stop reports not running', async t => {
  const { project, run } = await setup(t);
  const started = JSON.parse((await run(['open', '--project', project, '--json', '--no-open'])).stdout);
  const stopped = await run(['stop', '--project', project]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(stopped.stdout, `Stopped Topology studio for ${project}`);
  assert.throws(() => process.kill(started.pid, 0));
  const again = await run(['stop', '--project', project]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, `Topology studio is not running for ${project}`);
});

test('the real binary routes open --help and stop', async t => {
  const { root, project } = await setup(t);
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'xdg') };
  const help = spawnSync(process.execPath, [entry, 'open', '--help'], { encoding: 'utf8', env, timeout: 10_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: studio/);
  assert.match(help.stdout, /open \[--project <dir>\]/);
  const stop = spawnSync(process.execPath, [entry, 'stop', '--project', project], { encoding: 'utf8', env, timeout: 10_000 });
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /not running/);
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

test('open --all starts one all-projects studio, reuses it, preselects --project, and stop --all stops it', async t => {
  const { root, dir, opened, run, deps } = await setup(t);
  const { listed, env } = await fakeAllHome(root);
  deps.env = env;
  const first = await run(['open', '--all', '--json', '--no-open', '--port', '48934']);
  assert.equal(first.code, 0, first.stderr);
  const record = JSON.parse(first.stdout);
  assert.equal(record.project, '*');
  assert.equal(record.port, 48934);
  assert.equal(record.reused, false);
  assert.ok(existsSync(path.join(dir, 'all.json')));
  const projects = /** @type {{ projects: { id: string, root: string }[] }} */ (await (await fetch(`http://127.0.0.1:${record.port}/api/projects`, { headers: { 'X-Studio-Token': record.token } })).json());
  assert.deepEqual(projects.projects.map(p => p.root), [listed]);
  const again = await run(['open', '--all', '--project', listed]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, `Topology studio: ${record.url}#/p/${projects.projects[0].id}/ (already running)`);
  assert.deepEqual(opened, [`${record.url}#/p/${projects.projects[0].id}/`]);
  const stopped = await run(['stop', '--all']);
  assert.equal(stopped.stdout, 'Stopped Topology studio for all projects');
  assert.throws(() => process.kill(record.pid, 0));
  assert.equal((await run(['stop', '--all'])).stdout, 'Topology studio is not running for all projects');
  assert.equal((await run(['stop', '--all', '--project', listed])).code, 1);
});

test('open --all --project <missing> still starts, prints the base URL and warns', async t => {
  const { root, run } = await setup(t);
  const missing = path.join(root, 'no-such-project');
  const result = await run(['open', '--all', '--project', missing, '--no-open']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Topology studio: http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+$/);
  assert.equal(result.stderr, `--project ${missing}: not found`);
});
