// Process pin for contract.md channel G: an installed copy, laid out from the npm pack file list, serves web/dist and the API.
// The golden file comes from the base commit. Never regenerate it from new code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { matchGolden, normalise } from './golden.js';
import { root } from './tree.js';

const GOLDEN = 'installed.json';

const TOKEN = 'pins';

const pkgJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

/** What npm would ship, with its own globs and negations applied. @returns {string[]} */
function packFiles() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', timeout: 120_000 });

  assert.ok(!result.error && result.status === 0, `npm pack failed: ${result.error?.message ?? result.stderr}`);

  return JSON.parse(result.stdout)[0].files.map(/** @param {{ path: string }} file */ file => file.path);
}

/** Every file below `dir`, relative to it, with `/` separators. @param {string} dir @returns {Promise<string[]>} */
async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  return entries.filter(entry => entry.isFile()).map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
}

/** Set every mtime under `dir` to 2020-01-01, as old-vs-new.sh does. @param {string} dir */
async function pinMtimes(dir) {
  const stamp = new Date('2020-01-01T00:00:00');

  for (const rel of await listFiles(dir)) await utimes(path.join(dir, rel), stamp, stamp);
}

/**
 * Lay out <tmp>/node_modules/agent-topology-studio from the pack list, with a stub web/dist and symlinked dependencies.
 * @param {import('node:test').TestContext} t
 */
async function installed(t) {
  // realpath: macOS tmp is a symlink, and the paths in responses must match the normalisation.
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pins-installed-')));

  t.after(() => rm(tmp, { recursive: true, force: true }));

  const pkg = path.join(tmp, 'node_modules', 'agent-topology-studio');

  for (const rel of packFiles()) {
    if (rel.startsWith('web/dist/') || rel.startsWith('reference/')) continue;

    await mkdir(path.dirname(path.join(pkg, rel)), { recursive: true });
    await cp(path.join(root, rel), path.join(pkg, rel));
  }

  await mkdir(path.join(pkg, 'web/dist/assets'), { recursive: true });
  await writeFile(path.join(pkg, 'web/dist/index.html'), '<!doctype html><title>stub</title><script type="module" src="/assets/a.js"></script>\n');
  await writeFile(path.join(pkg, 'web/dist/assets/a.js'), 'console.log("stub");\n');

  for (const name of Object.keys(pkgJson.dependencies ?? {})) {
    const link = path.join(tmp, 'node_modules', name);

    await mkdir(path.dirname(link), { recursive: true });
    await symlink(path.join(root, 'node_modules', name), link, 'dir');
  }

  const fix = path.join(tmp, 'fix');

  await cp(path.join(root, 'fixtures/playground'), fix, { recursive: true });
  await pinMtimes(fix);

  const state = path.join(tmp, 'state');

  await mkdir(path.join(tmp, 'home'), { recursive: true });

  return { tmp, pkg, fix, state };
}

/**
 * Start the bin target and read its URL from stdout. Port 0, so the OS picks a free port.
 * t.after kills the server and waits for it to exit.
 * @param {import('node:test').TestContext} t
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<URL>}
 */
async function start(t, args, env) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 120_000 });

  const exited = new Promise(resolve => { child.once('exit', resolve); });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');

    await exited;
  });

  let stdout = '';

  let stderr = '';

  child.stderr.on('data', chunk => { stderr += chunk; });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no URL in 20 s: ${stdout}${stderr}`)), 20_000);

    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = /Topology studio: (\S+)/.exec(stdout);

      if (match) { clearTimeout(timer); resolve(new URL(match[1])); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
  });
}

/**
 * One GET: status, content-type, cache-control and body text.
 * @param {URL} url
 * @param {Record<string, string>} headers
 * @returns {Promise<{ status: number | undefined, contentType: string | undefined, cacheControl: string | undefined, body: string }>}
 */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: 10_000 }, res => {
      let body = '';

      res.setEncoding('utf8');
      // Reject on every early exit, so a truncated or reset response fails instead of hanging. reject after resolve is a no-op.
      res.on('error', reject);
      res.on('aborted', () => reject(new Error(`GET ${url.pathname}: response aborted`)));
      res.on('close', () => { if (!res.complete) reject(new Error(`GET ${url.pathname}: connection closed before the response finished`)); });
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'],
        cacheControl: res.headers['cache-control'],
        body,
      }));
    });

    req.on('timeout', () => req.destroy(new Error(`GET ${url.pathname} timed out`)));
    req.on('error', reject);
  });
}

test('G: installed copy serves web/dist and the API', async t => {
  const { tmp, pkg, fix, state } = await installed(t);

  const shipped = await listFiles(pkg);

  const strippable = shipped.filter(rel => rel.endsWith('.ts') && !rel.endsWith('.d.ts'));

  assert.deepStrictEqual(strippable, [], 'Node does not strip types under node_modules, so an installed copy must not ship .ts files');

  const env = { ...process.env, HOME: path.join(tmp, 'home'), XDG_STATE_HOME: state };

  const bin = path.join(pkg, pkgJson.bin['agent-topology-studio']);

  const url = await start(t, [bin, '--project', fix, '--no-open', '--port', '0', '--dev-token', TOKEN], env);

  const paths = { fix, state, pkg, root };

  /** @param {string} pathname @param {Record<string, string>} [headers] */
  const probe = async (pathname, headers) => {
    const response = await get(new URL(pathname, url), headers);

    return { ...response, body: normalise(response.body, paths) };
  };

  matchGolden(t, GOLDEN, 'G:startup', { url: normalise(`${url.pathname}${url.search}${url.hash}`, paths) });
  matchGolden(t, GOLDEN, 'G:GET /', await probe('/'));
  matchGolden(t, GOLDEN, 'G:GET /assets/a.js', await probe('/assets/a.js'));
  matchGolden(t, GOLDEN, 'G:GET /nope.js', await probe('/nope.js'));
  matchGolden(t, GOLDEN, 'G:GET /api/project', await probe('/api/project', { 'X-Studio-Token': TOKEN }));
});
