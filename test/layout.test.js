import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, mkdir, writeFile, rm, symlink, realpath, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
const repo = fileURLToPath(new URL('..', import.meta.url));
const { dependencies } = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));

// Lays out <tmp>/node_modules/agent-topology-studio with no web/src and no node_modules of its own.
async function installed(t) {
  // realpath: server/main.js only runs main() when argv[1] equals its real path, and macOS tmp is a symlink.
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-layout-'))); t.after(() => rm(tmp, { recursive: true, force: true }));
  const pkg = path.join(tmp, 'node_modules/agent-topology-studio');
  for (const entry of ['dist', 'package.json']) await cp(path.join(repo, entry), path.join(pkg, entry), { recursive: true });
  for (const name of Object.keys(dependencies)) await symlink(path.join(repo, 'node_modules', name), path.join(tmp, 'node_modules', name), 'dir');
  const project = path.join(tmp, 'project');
  await cp(path.join(repo, 'fixtures/playground'), project, { recursive: true });
  return { pkg, project };
}

async function start(t, args) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { stdout += chunk; const match = /Topology studio: (\S+)/.exec(stdout); if (match) resolve(new URL(match[1])); });
    child.on('exit', code => reject(new Error(`server exited ${code}: ${stderr}`)));
  });
  return { url, output: () => stdout };
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => http.get(url, { headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
}

test('an installed copy starts without installing or building', async t => {
  const { pkg, project } = await installed(t);
  await mkdir(path.join(pkg, 'web/dist'), { recursive: true });
  await writeFile(path.join(pkg, 'web/dist/index.html'), '<!doctype html><title>stub</title>');
  const { url, output } = await start(t, [path.join(pkg, 'dist/bin/studio.js'), '--project', project, '--no-open', '--port', '0']);
  assert.doesNotMatch(output(), /Installing|Building/);
  assert.equal(await get(url), 200);
});

test('api-only serves the API without a built app', async t => {
  const { pkg, project } = await installed(t);
  const { url } = await start(t, [path.join(pkg, 'dist/server/main.js'), '--project', project, '--api-only', '--no-open', '--dev-token', 't', '--port', '0']);
  assert.equal(await get(new URL('/api/project', url), { 'X-Studio-Token': 't' }), 200);
  assert.equal(await get(new URL('/', url)), 404);
});
