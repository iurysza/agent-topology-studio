import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { supervise } from '../bin/supervise.ts';
const node = code => ({ command: process.execPath, args: ['-e', code] });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a failing child stops the rest and its code wins', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-supervise-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'pid');
  const slow = { command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);', pidFile] };
  assert.equal(await supervise([node('setTimeout(() => process.exit(3), 500)'), slow]), 3);
  assert.equal(alive(Number(await readFile(pidFile, 'utf8'))), false);
});

test('a missing command resolves 1', async () => {
  assert.equal(await supervise([{ command: '/nonexistent/vite', args: [] }, node('setInterval(() => {}, 1000)')]), 1);
});

test('two clean exits resolve 0', async () => {
  assert.equal(await supervise([node('process.exit(0)'), node('process.exit(0)')]), 0);
});

test('a signal-style exit is not hidden by a later clean sibling exit', async () => {
  assert.equal(await supervise([node('setTimeout(() => process.exit(130), 20)'), node('setTimeout(() => process.exit(0), 100)')]), 130);
});

test('a child killed by a signal resolves 1 despite a clean sibling exit', async () => {
  assert.equal(await supervise([node('process.kill(process.pid, "SIGTERM")'), node('setTimeout(() => process.exit(0), 100)')]), 1);
});

test('Ctrl-C to the process group exits 0, every time', { timeout: 120_000 }, async () => {
  const harness = fileURLToPath(new URL('./fixtures-supervise/harness.js', import.meta.url));
  for (let i = 0; i < 20; i++) {
    const child = spawn(process.execPath, [harness], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const exit = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; if (output.split('up').length > 2) resolve(); });
      exit.then(result => reject(new Error(`harness exited before ready: ${JSON.stringify(result)}`)));
    });
    process.kill(-child.pid, 'SIGINT');
    assert.deepEqual(await exit, { code: 0, signal: null }, `run ${i + 1}`);
  }
});
