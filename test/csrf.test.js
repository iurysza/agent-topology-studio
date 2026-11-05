// Tokenless CSRF (audit finding 2, ADR-0004): without a token, writes need an allowed Origin or no browser metadata,
// and body-bearing writes need application/json. --public-origin adds one exact origin for a Host-rewriting gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, cp, rm, readFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/http.ts';
import { parseServerArgs } from '../server/args.ts';
import { openProject } from '../server/project.ts';
import { projectId } from '../server/registry.ts';

const gateway = 'https://studio.example.test';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-csrf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project');
  await cp(new URL('../fixtures/playground', import.meta.url), dir, { recursive: true });

  return dir;
}

/** Snapshot of every workflow and role file, to prove a refused call wrote nothing. */
async function files(dir) {
  const out = {};

  for (const sub of ['.pi/workflows', '.pi/agents']) for (const name of (await readdir(path.join(dir, sub))).sort()) out[`${sub}/${name}`] = await readFile(path.join(dir, sub, name), 'utf8');

  return out;
}

async function start(t, options) {
  const server = createServer({ token: null, webRoot: null, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.close(() => resolve(undefined)); server.closeAllConnections(); }));

  return /** @type {import('node:net').AddressInfo} */ (server.address()).port;
}

/**
 * Raw node:http, so the test sets Host, Origin, Sec-Fetch-* and Content-Type exactly as a browser, gateway or curl would.
 * @param {number} port @param {string} route
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [options]
 * @returns {Promise<{ status: number | undefined, text: string }>}
 */
function send(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', reject); res.on('aborted', () => reject(new Error('aborted')));
      res.on('close', () => { if (!res.complete) reject(new Error('response closed early')); });
    });

    req.on('error', reject);
    req.end(body);
  });
}

/** One write per mutation route: body-bearing ones and DELETE. */
const writes = base => [
  ['POST', `${base}/workflows`, JSON.stringify({ id: 'csrf-made' })],
  ['PUT', `${base}/workflows/build`, JSON.stringify({ machine: {}, hash: 'x' })],
  ['DELETE', `${base}/workflows/build`, undefined],
  ['POST', `${base}/roles`, JSON.stringify({ name: 'csrf-role' })],
  ['PUT', `${base}/roles/coder`, JSON.stringify({ frontmatter: {}, body: '', baseHash: 'x' })],
  ['POST', `${base}/compile`, JSON.stringify({ machine: {} })],
];

/** A single-project or all-projects server on a fixture copy. The registry counts opens to prove refusals come first. */
async function serve(t, mode, extra = {}) {
  const dir = await fixture(t), project = await openProject(dir), id = projectId(await realpath(dir));
  const opens = { count: 0 };
  const registry = { list: async () => ({ projects: [], warnings: [] }), open: async got => ((opens.count += 1), got === id ? project : null) };
  const port = mode === 'single' ? await start(t, { project, ...extra }) : await start(t, { project: null, registry, ...extra });

  return { dir, port, opens, base: mode === 'single' ? '/api' : `/api/p/${id}` };
}

for (const mode of ['single', 'all']) test(`tokenless ${mode}-project mode refuses cross-site writes before project IO`, async t => {
  const { dir, port, base, opens } = await serve(t, mode, { publicOrigin: gateway });
  const before = await files(dir);
  /** @type {[string, Record<string, string>][]} */

  const refused = [
    ['foreign Origin', { Origin: 'https://evil.test', 'Content-Type': 'application/json' }],
    ['null Origin', { Origin: 'null', 'Content-Type': 'application/json' }],
    ['other loopback port', { Origin: 'http://127.0.0.1:1', 'Content-Type': 'application/json' }],
    ['https loopback', { Origin: `https://127.0.0.1:${port}`, 'Content-Type': 'application/json' }],
    ['public origin on another port', { Origin: `${gateway}:8443`, 'Content-Type': 'application/json' }],
    ['public origin over http', { Origin: 'http://studio.example.test', 'Content-Type': 'application/json' }],
    ['public origin subdomain', { Origin: 'https://evil.studio.example.test', 'Content-Type': 'application/json' }],
    ['public origin with a path', { Origin: `${gateway}/`, 'Content-Type': 'application/json' }],
    ['cross-site fetch metadata', { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }],
    ['same-site fetch metadata', { 'Sec-Fetch-Site': 'same-site', 'Content-Type': 'application/json' }],
    ['allowed Origin with cross-site metadata', { Origin: gateway, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }],
    ['forwarded headers do not vouch', { Origin: 'https://evil.test', 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'https', Forwarded: 'host=evil.test;proto=https', 'Content-Type': 'application/json' }],
    ['forwarded headers do not vouch for same-site', { 'Sec-Fetch-Site': 'same-site', 'X-Forwarded-Host': 'studio.example.test', Forwarded: 'host=studio.example.test;proto=https', 'Content-Type': 'application/json' }],
  ];

  for (const [method, route, body] of writes(base)) {
    for (const [label, headers] of refused) {
      const res = await send(port, route, { method, headers, body });
      assert.equal(res.status, 403, `${label}: ${method} ${route} answered ${res.status} ${res.text}`);
    }

    if (body !== undefined) for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'application/json; charset', 'text/plain; x=application/json', undefined]) {
      const res = await send(port, route, { method, headers: type === undefined ? {} : { 'Content-Type': type }, body });
      assert.equal(res.status, 415, `${method} ${route} with ${type ?? 'no'} Content-Type answered ${res.status} ${res.text}`);
    }
  }

  assert.deepEqual(await files(dir), before, 'a refused call changed project files');
  assert.equal(opens.count, 0, 'a refused call reached the registry');
});

for (const mode of ['single', 'all']) test(`tokenless ${mode}-project mode accepts the studio page, the gateway origin and plain clients`, async t => {
  const { dir, port, base } = await serve(t, mode, { publicOrigin: gateway });
  /** @type {[string, Record<string, string>][]} */

  const ok = [
    ['same-origin browser', { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }],
    ['localhost alias', { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json; charset=utf-8' }],
    ['gateway rewrites Host to localhost', { Host: `localhost:${port}`, Origin: gateway, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }],
    ['non-browser client', { 'Content-Type': 'Application/JSON ; charset="utf-8"' }],
    ['user-typed fetch metadata', { 'Sec-Fetch-Site': 'none', 'Content-Type': 'application/json' }],
  ];

  for (const [i, [label, headers]] of ok.entries()) {
    const res = await send(port, `${base}/workflows`, { method: 'POST', headers, body: JSON.stringify({ id: `ok-${i}` }) });
    assert.equal(res.status, 201, `${label}: ${res.status} ${res.text}`);
    assert.ok(existsSync(path.join(dir, '.pi/workflows', `ok-${i}.js`)), `${label}: no file written`);
  }

  const removed = await send(port, `${base}/workflows/ok-0`, { method: 'DELETE', headers: { Host: `localhost:${port}`, Origin: gateway, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(existsSync(path.join(dir, '.pi/workflows/ok-0.js')), false);
  assert.equal((await send(port, `${base}/project`, { headers: { Origin: 'https://evil.test', 'Sec-Fetch-Site': 'cross-site' } })).status, 200, 'reads stay open; the browser keeps their bodies from a foreign page');
  assert.equal((await send(port, `${base}/workflows`, { method: 'POST', headers: { Host: 'studio.example.test', Origin: gateway, 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'the Host check is unchanged');
});

test('without --public-origin the gateway origin is refused; a mismatched one is refused too', async t => {
  for (const publicOrigin of [undefined, null, 'https://other.example.test']) {
    const { dir, port, base } = await serve(t, 'single', publicOrigin === undefined ? {} : { publicOrigin });
    const before = await files(dir);
    const res = await send(port, `${base}/workflows`, { method: 'POST', headers: { Host: `localhost:${port}`, Origin: gateway, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'gw' }) });
    assert.equal(res.status, 403, `${publicOrigin}: ${res.status} ${res.text}`);
    assert.deepEqual(await files(dir), before);
  }
});

test('token mode keeps its behaviour: the token is the guard and bad JSON is still 400', async t => {
  const dir = await fixture(t), project = await openProject(dir);
  const port = await start(t, { project, token: 'token' });
  const headers = { 'X-Studio-Token': 'token', Origin: 'https://evil.test', 'Content-Type': 'text/plain' };
  assert.equal((await send(port, '/api/workflows', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{"id":"x"}' })).status, 401);
  assert.equal((await send(port, '/api/workflows', { method: 'POST', headers, body: 'not json' })).status, 400);
  assert.equal((await send(port, '/api/workflows', { method: 'POST', headers, body: JSON.stringify({ id: 'tok' }) })).status, 201);
});

test('createServer fails closed on a public origin that is not canonical', () => {
  for (const bad of ['https://studio.example.test/', 'https://studio.example.test/x', 'HTTPS://Studio.example.test', '*', 'https://*.example.test', 'null', '']) {
    assert.throws(() => createServer({ project: /** @type {any} */ ({}), token: null, webRoot: null, publicOrigin: bad }), /publicOrigin|--public-origin/, bad);
  }
});

test('args: --public-origin is an exact canonical origin and needs --no-token', () => {
  const parse = value => parseServerArgs(['--project', 'p', '--no-token', '--public-origin', value]).publicOrigin;
  assert.equal(parse('https://studio.example.test'), 'https://studio.example.test');
  assert.equal(parse('https://Studio.Example.Test/'), 'https://studio.example.test');
  assert.equal(parse('https://studio.example.test:443'), 'https://studio.example.test');
  assert.equal(parse('http://studio.example.test:8080'), 'http://studio.example.test:8080');
  assert.equal(parseServerArgs(['--project', 'p', '--no-token']).publicOrigin, undefined);

  for (const bad of ['studio.example.test', 'ftp://studio.example.test', 'https://user:pw@studio.example.test', 'https://studio.example.test/app', 'https://studio.example.test/?q=1', 'https://studio.example.test#x', 'https://*.example.test', 'http://%2A.example.test', '*', 'null', 'https://', 'https://studio.example.test//']) {
    assert.throws(() => parse(bad), /--public-origin must be an origin/, bad);
  }

  assert.throws(() => parseServerArgs(['--project', 'p', '--public-origin', 'https://studio.example.test']), /--public-origin requires --no-token/);
  assert.throws(() => parseServerArgs(['--project', 'p', '--no-token', '--public-origin']), /Invalid or missing argument: --public-origin/);
  assert.deepEqual(parseServerArgs(['--public-origin', 'bad', '--help']), { help: true });
});

const studio = fileURLToPath(new URL('../bin/studio.ts', import.meta.url));

const mains = [fileURLToPath(new URL('../server/main.ts', import.meta.url)), fileURLToPath(new URL('../dist/server/main.js', import.meta.url))];

test('bin/studio rejects a bad --public-origin before installing or building, and documents it', async t => {
  const dir = await fixture(t);

  for (const args of [['--public-origin', 'https://studio.example.test/app', '--no-token'], ['--public-origin', 'http://%2A.example.test', '--no-token'], ['--public-origin', 'https://studio.example.test']]) {
    const result = spawnSync(process.execPath, [studio, '--project', dir, '--rebuild', ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--public-origin (must be an origin|requires --no-token)/);
    assert.doesNotMatch(result.stdout, /Installing dependencies|Building web app|Topology studio:/);
  }

  for (const file of [studio, mains[0]]) {
    const help = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--public-origin https:\/\/studio\.example\.test/);
  }
});

for (const main of mains) test(`${path.relative(fileURLToPath(new URL('..', import.meta.url)), main)} passes --public-origin to the server`, { skip: !existsSync(main) && 'run npm run build:ts first' }, async t => {
  const dir = await fixture(t);
  const child = spawn(process.execPath, [main, '--project', dir, '--api-only', '--no-open', '--no-token', '--public-origin', 'https://Studio.Example.Test/', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } });
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No URL after 10 s. stderr: ${stderr}`)), 10000);
    child.stdout.on('data', chunk => {
      stdout += chunk;

      const match = /Topology studio: (\S+)/.exec(stdout);

      if (match) { clearTimeout(timer); resolve(new URL(match[1])); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Exited with ${code}. stderr: ${stderr}`)); });
  });

  const port = Number(url.port), headers = { Host: `localhost:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  const saved = await send(port, '/api/workflows', { method: 'POST', headers: { ...headers, Origin: gateway }, body: JSON.stringify({ id: 'via-gateway' }) });
  assert.equal(saved.status, 201, saved.text);
  assert.ok(existsSync(path.join(dir, '.pi/workflows/via-gateway.js')));
  const foreign = await send(port, '/api/workflows', { method: 'POST', headers: { ...headers, Origin: 'https://other.example.test' }, body: JSON.stringify({ id: 'foreign' }) });
  assert.equal(foreign.status, 403, foreign.text);
});
