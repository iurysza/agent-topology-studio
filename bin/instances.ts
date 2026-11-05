// Finds, starts and stops one detached studio per project. The CLI and the Pi extension are thin shells over it.
// Registry: <stateDir>/<sha1 of realpath>.json (record), .log (server output), .lock (start in progress).
// The launcher writes the record. Readers delete stale records, so the server never touches the registry (decisions.md D3).
// Every registry mutation (launch, stop, stale cleanup) happens while holding the lock (decisions.md D14).
// The all-projects instance (server --all) uses the key `all` and the record project `*` (plan.md S5).
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, openSync } from 'node:fs';
import { chmod, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { SpawnOptions } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Json, JsonObject } from '../shared/replay.ts';
import { isSourceCheckout } from './build-stamp.ts';
import { isErrno, messageOf } from '../server/narrow.ts';
import { resolveEntry, toolRoot } from '../server/tool-root.ts';

export type InstanceRecord = { pid: number; port: number; token: string; project: string; startedAt: string; url: string; log: string };

type RegistryPaths = { record: string; log: string; lock: string };

type LockOp = 'start' | 'stop' | 'clean';

type Liveness = 'live' | 'stale' | 'unknown';

type Inspection = { live: InstanceRecord | null; text: string | null; unknown: boolean };

type Lock = { state: 'missing'; op?: undefined } | { state: 'held'; pid: number; op: Json | undefined; text: string } | { state: 'invalid'; mtimeMs: number; text: string; op?: undefined };

type Acquired = { nonce: string; live?: undefined } | { live: InstanceRecord; nonce?: undefined };

type FsOps = { writeFile: (file: string, data: string, options: { mode: number }) => Promise<void>; rename: (from: string, to: string) => Promise<void> };

type LaunchOptions = { port: number; entry: string; extraArgs: string[]; timeoutMs: number; fsOps: FsOps; preselect: string | undefined; env: NodeJS.ProcessEnv };

type FindOptions = { dir?: string; all?: boolean };

type StartOptions = FindOptions & { port?: number; entry?: string; extraArgs?: string[]; timeoutMs?: number; fsOps?: FsOps; env?: NodeJS.ProcessEnv };

type StopOptions = FindOptions & { timeoutMs?: number };

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => EventEmitter;

type InstanceDeps = { usage?: string; dir?: string; entry?: string; extraArgs?: string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv; openUrl?: (url: string) => Promise<void> | void };

const pollMs = 100, identityTimeoutMs = 2000, stopWaitMs = 5000, invalidLockAgeMs = 10_000, maxAcquireAttempts = 3;
// In --all mode with --project the server appends a #/p/<id>/ preselect hash. The record keeps the base URL.
const urlLine = /^Topology studio: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+))(#\/p\/[a-z0-9-]+\/)?$/m;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const lockError = (verb: LockOp = 'start') => new Error(`Topology studio failed to ${verb}: another launcher holds the lock`);
const isPid = (pid: Json | undefined): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0;

const isJsonObject = (value: Json): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

// The old `value.key` on parsed JSON: null throws V8's TypeError, and a primitive or an array gives undefined.
function field(value: Json, key: string): Json | undefined {
  if (value === null) throw new TypeError(`Cannot read properties of null (reading '${key}')`);

  return isJsonObject(value) ? value[key] : undefined;
}

// error?.name, which never crashed. Functions count, because the old read included them (decisions.md D16).
const isNamed = (cause: unknown): cause is { readonly name: unknown } => (typeof cause === 'object' || typeof cause === 'function') && cause !== null && 'name' in cause;

// Record project and registry key of the all-projects instance.
export const allProjects = '*';
const allKey = 'all';

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'topology-studio');
}
export function instanceKey(realProject: string): string {
  return createHash('sha1').update(realProject).digest('hex');
}
// A source checkout may run npm install and vite build on first start. An installed copy never builds.
export function defaultTimeoutMs(root: string = toolRoot): number {
  return isSourceCheckout(root) ? 300_000 : 30_000;
}
function registryPaths(dir: string, key: string): RegistryPaths {
  return { record: path.join(dir, `${key}.json`), log: path.join(dir, `${key}.log`), lock: path.join(dir, `${key}.lock`) };
}
// EPERM means the pid exists but belongs to someone else, which still counts as alive.
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return isErrno(e) && e.code === 'EPERM'; }
}
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  // pid 0 or -1 would signal our own group or every process we own.
  if (!isPid(pid)) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
}
// An array fails as before: it has no pid.
const isRecord = (r: Json): r is InstanceRecord => r !== null && typeof r === 'object' && !Array.isArray(r) && isPid(r.pid) && typeof r.port === 'number' && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535
  && typeof r.token === 'string' && /^[0-9a-f]+$/.test(r.token) && typeof r.project === 'string' && typeof r.startedAt === 'string'
  && typeof r.log === 'string' && r.url === `http://127.0.0.1:${r.port}/?token=${r.token}`;

function parseRecord(text: string): InstanceRecord | null {
  let r: Json;
  try { r = JSON.parse(text); } catch { return null; }
  return isRecord(r) ? r : null;
}
// Live means the pid exists and the server on the port answers with this token for this project.
// The identity check guards against a reused pid or port. An --all server has no single dir, so /api/projects answering 200 proves it.
// Unknown means the pid exists but the request timed out: /api/projects may be running a slow discovery, so the record
// is neither reused nor deleted (decisions.md D3 amendment). Anything else is stale.
async function isLive(record: InstanceRecord): Promise<Liveness> {
  if (!alive(record.pid)) return 'stale';
  const all = record.project === allProjects;
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/${all ? 'projects' : 'project'}`, { headers: { 'X-Studio-Token': record.token }, signal: AbortSignal.timeout(identityTimeoutMs) });
    if (response.status !== 200) { await response.body?.cancel(); return 'stale'; }
    // SAFETY: response.json() returns what JSON.parse returns.
    const body = (await response.json()) as Json;
    return (all ? Array.isArray(field(body, 'projects')) : field(body, 'dir') === record.project) ? 'live' : 'stale';
  } catch (error) { return isNamed(error) && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'unknown' : 'stale'; }
}
const busyError = (real: string) => new Error(`${real === allProjects ? 'The all-projects studio' : `The studio for ${real}`} is busy (no answer within ${identityTimeoutMs} ms), try again`);
async function removeRecord(paths: RegistryPaths): Promise<void> {
  await rm(paths.record, { force: true }); await rm(paths.log, { force: true });
}
// realpath rejects undefined, which gave null before too.
async function resolveProject(project: string | undefined): Promise<string | null> {
  if (project === undefined) return null;
  try { return await realpath(project); } catch { return null; }
}
// Reads the record for one key. `text` is the raw file (null when unreadable), so cleanup can tell whether it changed since.
// `unknown` is true when the record's server is alive but did not answer in time; callers must then leave the record alone.
async function inspect(paths: RegistryPaths, matches: (record: InstanceRecord) => boolean): Promise<Inspection> {
  let text: string;
  try { text = await readFile(paths.record, 'utf8'); } catch { return { live: null, text: null, unknown: false }; }
  const record = parseRecord(text);
  const state = record !== null && matches(record) ? await isLive(record) : 'stale';
  return { live: state === 'live' ? record : null, text, unknown: state === 'unknown' };
}
// Deletes a stale record only if no launcher or stop holds the lock and the record is the one we judged stale.
async function removeStale(paths: RegistryPaths, text: string): Promise<void> {
  const nonce = await tryLock(paths.lock, 'clean').catch(() => null);
  if (nonce === null) return;
  try {
    if (await readFile(paths.record, 'utf8').catch(() => null) === text) await removeRecord(paths);
  } finally { await releaseLock(paths.lock, nonce); }
}

// With all: true, project is ignored and the all-projects instance is looked up.
// Throws when the server is alive but busy, so no caller mistakes it for stopped and launches a second one.
export async function findInstance(project: string | undefined, { dir = stateDir(), all = false }: FindOptions = {}): Promise<InstanceRecord | null> {
  const real = all ? allProjects : await resolveProject(project);
  if (real === null) return null;
  const paths = registryPaths(dir, all ? allKey : instanceKey(real));
  const { live, text, unknown } = await inspect(paths, record => record.project === real);
  if (unknown) throw busyError(real);
  if (live === null && text !== null) await removeStale(paths, text);
  return live;
}

export async function listInstances({ dir = stateDir() }: FindOptions = {}): Promise<InstanceRecord[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const live: InstanceRecord[] = [];
  for (const name of names.filter(n => /^[0-9a-f]{40}\.json$/.test(n)).sort()) {
    const key = name.slice(0, -5), paths = registryPaths(dir, key);
    const found = await inspect(paths, record => instanceKey(record.project) === key);
    if (found.live !== null) live.push(found.live);
    else if (found.text !== null && !found.unknown) await removeStale(paths, found.text);
  }
  return live;
}

// The lock holds { pid, startedAt, nonce, op }. The nonce proves ownership, so a caller only ever releases its own lock.
// op is 'start', 'stop' or 'clean'. Waiters do not reuse a live record while a stop holds the lock.
/** @returns the nonce, or null when the lock is held */
async function tryLock(file: string, op: LockOp): Promise<string | null> {
  const nonce = randomUUID();
  let handle;
  try { handle = await open(file, 'wx', 0o600); } catch (e) { if (isErrno(e) && e.code === 'EEXIST') return null; throw e; }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce, op })); } finally { await handle.close(); }
  return nonce;
}
// Safe without a gate: only a reclaim deletes a foreign lock, and only when its pid is dead, so ours cannot be swapped under us.
async function releaseLock(file: string, nonce: string | undefined): Promise<void> {
  const text = await readFile(file, 'utf8').catch(() => null);
  try { if (text !== null && field(JSON.parse(text), 'nonce') === nonce) await rm(file, { force: true }); } catch { /* not ours */ }
}
// Missing, held by a pid, or unreadable (a holder may be between create and write, so its age decides).
async function readLock(file: string): Promise<Lock> {
  let text: string, mtimeMs: number;
  try { [text, { mtimeMs }] = await Promise.all([readFile(file, 'utf8'), stat(file)]); } catch (e) { if (isErrno(e) && e.code === 'ENOENT') return { state: 'missing' }; throw e; }
  try { const lock: Json = JSON.parse(text), pid = field(lock, 'pid'), op = field(lock, 'op'); if (isPid(pid)) return { state: 'held', pid, op, text }; } catch { /* fall through */ }
  return { state: 'invalid', mtimeMs, text };
}
// Deletes a stale lock only if it still has the content we judged stale. Reclaimers take a gate file first,
// so two waiters can never both delete: the second re-reads under the gate and sees the winner's fresh lock.
// A gate older than invalidLockAgeMs belongs to a crashed reclaimer and is cleared. Returns true when it deleted the lock.
async function reclaimStale(file: string, staleText: string): Promise<boolean> {
  const gate = `${file}.reclaim`;
  let handle;
  try { handle = await open(gate, 'wx', 0o600); } catch (e) {
    if (!isErrno(e) || e.code !== 'EEXIST') throw e;
    const { mtimeMs } = await stat(gate).catch(() => ({ mtimeMs: Date.now() }));
    if (Date.now() - mtimeMs > invalidLockAgeMs) await rm(gate, { force: true });
    return false;
  }
  try {
    await handle.close();
    if (await readFile(file, 'utf8').catch(() => null) !== staleText) return false;
    await rm(file, { force: true });
    return true;
  } finally { await rm(gate, { force: true }); }
}
// Waits while someone else holds the lock. Returns a live record (only when `reuse` is given and the holder is not a stop),
// or null when the caller should try to acquire again.
async function waitForHolder(paths: RegistryPaths, deadline: number, reuse: (() => Promise<InstanceRecord | null>) | null, verb: LockOp): Promise<InstanceRecord | null> {
  for (;;) {
    const lock = await readLock(paths.lock);
    if (reuse !== null && lock.op !== 'stop') {
      const live = await reuse();
      if (live !== null) return live;
    }
    if (lock.state === 'missing') return null;
    if ((lock.state === 'held' && !alive(lock.pid)) || (lock.state === 'invalid' && Date.now() - lock.mtimeMs > invalidLockAgeMs)) {
      if (await reclaimStale(paths.lock, lock.text)) return null;
    }
    if (Date.now() >= deadline) throw lockError(verb);
    await sleep(pollMs);
  }
}
async function acquireLock(paths: RegistryPaths, op: LockOp, deadline: number, reuse: (() => Promise<InstanceRecord | null>) | null): Promise<Acquired> {
  for (let attempt = 0; attempt < maxAcquireAttempts; attempt++) {
    const nonce = await tryLock(paths.lock, op);
    if (nonce !== null) return { nonce };
    const live = await waitForHolder(paths, deadline, reuse, op);
    if (live !== null) return { live };
  }
  throw lockError(op);
}

async function tailLog(file: string): Promise<string> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').map(line => line.trim()).filter(Boolean).slice(-3).join(' | ') || 'no output';
}
async function launch(real: string, paths: RegistryPaths, { port, entry, extraArgs, timeoutMs, fsOps, preselect, env }: LaunchOptions): Promise<InstanceRecord> {
  const file = resolveEntry(entry);
  const fd = openSync(paths.log, 'w', 0o600);
  const target = real === allProjects ? ['--all', ...(preselect === undefined ? [] : ['--project', preselect])] : ['--project', real];
  let child;
  try {
    fchmodSync(fd, 0o600);
    child = spawn(process.execPath, [file, ...target, '--port', String(port), '--no-open', ...extraArgs], { cwd: toolRoot, detached: true, stdio: ['ignore', fd, fd], env });
  } finally { closeSync(fd); }
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.once('error', () => { exited = true; });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = urlLine.exec(await readFile(paths.log, 'utf8').catch(() => ''));
    if (match) {
      // SAFETY: the server wrote its URL line, so the spawn succeeded and the child has a pid.
      const record: InstanceRecord = { pid: child.pid as number, port: Number(match[2]), token: match[3], project: real, startedAt: new Date().toISOString(), url: match[1], log: paths.log };
      const temp = `${paths.record}.${randomUUID()}.tmp`;
      try {
        await fsOps.writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
        await fsOps.rename(temp, paths.record);
      } catch (error) {
        // An unregistered server is unreachable by stop, so it must not outlive a failed start.
        signalGroup(child.pid, 'SIGKILL');
        await rm(temp, { force: true, recursive: true }).catch(() => {});
        await rm(paths.log, { force: true }).catch(() => {});
        throw error;
      }
      return record;
    }
    if (exited || Date.now() >= deadline) {
      if (!exited && child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
      const tail = await tailLog(paths.log);
      // The caller's finally releases the lock; the log is ours to remove.
      await rm(paths.log, { force: true }).catch(() => {});
      throw new Error(`Topology studio failed to start: ${exited ? '' : `timed out after ${timeoutMs} ms. `}${tail}`);
    }
    await sleep(pollMs);
  }
}

// fsOps and env are test seams (persist failures, a fake HOME for --all). Leave them out of the CLI.
// With all: true it starts or reuses the all-projects instance. project is then optional: when given, a fresh
// server gets --project to list and preselect it, even when it does not exist: the server then warns and serves
// the project list (all-projects D5). Use allProjectsUrl for the preselect hash and that warning.
export async function startInstance(project: string | undefined, { port = 0, dir = stateDir(), entry = 'bin/studio', extraArgs = [], timeoutMs = defaultTimeoutMs(), fsOps = { writeFile, rename }, all = false, env = process.env }: StartOptions = {}): Promise<{ record: InstanceRecord; reused: boolean }> {
  let real: string = allProjects, preselect: string | undefined;
  if (all && project !== undefined) preselect = await resolveProject(project) ?? path.resolve(project);
  else if (!all) {
    const resolved = await resolveProject(project);
    if (resolved === null || !(await stat(resolved)).isDirectory()) throw new Error(`Project not found: ${project}`);
    real = resolved;
  }
  const paths = registryPaths(dir, all ? allKey : instanceKey(real));
  const find = () => findInstance(real, { dir, all });
  // A record that a stop is tearing down is not reusable, so wait for the stop instead.
  if ((await readLock(paths.lock)).op !== 'stop') {
    const existing = await find();
    if (existing !== null) return { record: existing, reused: true };
  }
  await ensureDir(dir);
  const lock = await acquireLock(paths, 'start', Date.now() + timeoutMs, find);
  if (lock.live !== undefined) return { record: lock.live, reused: true };
  try {
    // Another launcher may have finished between our first check and the lock.
    const { live, text, unknown } = await inspect(paths, record => record.project === real);
    if (live !== null) return { record: live, reused: true };
    if (unknown) throw busyError(real);
    if (text !== null) await removeRecord(paths);
    return { record: await launch(real, paths, { port, entry, extraArgs, timeoutMs, fsOps, preselect, env }), reused: false };
  } finally { await releaseLock(paths.lock, lock.nonce); }
}

// Returns true when it stopped a live instance. Otherwise removes that instance's record and log.
// Throws, and keeps the record, when the server is alive but did not answer in time.
// Stop holds the start lock throughout, so a following start cannot launch until cleanup is done.
// A stop that meets a start in progress waits for it (up to timeoutMs) and then stops the result.
// With all: true, project is ignored and the all-projects instance is stopped.
export async function stopInstance(project: string | undefined, { dir = stateDir(), timeoutMs = defaultTimeoutMs(), all = false }: StopOptions = {}): Promise<boolean> {
  // SAFETY: callers pass a project unless all is set. path.resolve throws its own TypeError for undefined, as before.
  const real = all ? allProjects : await resolveProject(project) ?? path.resolve(project as string);
  const paths = registryPaths(dir, all ? allKey : instanceKey(real));
  if (!(await stat(dir).then(s => s.isDirectory(), () => false))) return false;
  const lock = await acquireLock(paths, 'stop', Date.now() + timeoutMs, null);
  try {
    const { live, unknown } = await inspect(paths, record => record.project === real);
    if (unknown) throw busyError(real);
    if (live !== null) {
      signalGroup(live.pid, 'SIGTERM');
      const deadline = Date.now() + stopWaitMs;
      while (alive(live.pid) && Date.now() < deadline) await sleep(pollMs);
      if (alive(live.pid)) signalGroup(live.pid, 'SIGKILL');
    }
    await removeRecord(paths);
    return live !== null;
  } finally { await releaseLock(paths.lock, lock.nonce); }
}

// The URL that opens an all-projects record on one project: the base URL plus #/p/<id>/ when the server lists it.
// Otherwise the base URL and a warning: the server's own `--project <dir>: <reason>` when it has one for this dir,
// a generic one (for example a reused server started without that project), or "could not check" when the request fails.
export async function allProjectsUrl(record: InstanceRecord, project: string): Promise<{ url: string; warning: string | null }> {
  const real = await resolveProject(project), given = real ?? path.resolve(project);
  let projects: Json[], warnings: Json | undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/projects`, { headers: { 'X-Studio-Token': record.token }, signal: AbortSignal.timeout(identityTimeoutMs) });
    // SAFETY: response.json() returns what JSON.parse returns.
    const body = (await response.json()) as Json, listed = body === null ? undefined : field(body, 'projects');
    if (response.status !== 200 || !Array.isArray(listed)) throw new Error('unexpected answer');
    projects = listed; warnings = field(body, 'warnings');
  } catch {
    return { url: record.url, warning: `--project ${project}: could not check whether the all-projects view lists it` };
  }
  // The regex and the URL read the id through ToString, as String() does.
  const entry = projects.find(p => field(p, 'root') === real);
  if (entry && /^[a-z0-9-]+$/.test(String(field(entry, 'id')))) return { url: `${record.url}#/p/${field(entry, 'id')}/`, warning: null };
  const names = new Set([project, given].map(dir => `--project ${dir}: `));
  const list: Json[] = Array.isArray(warnings) ? warnings : [];
  const own = list.find((w): w is string => typeof w === 'string' && [...names].some(name => w.startsWith(name)));
  return { url: record.url, warning: own === undefined ? `--project ${project}: not listed in the all-projects view` : own.replace(/\s*\n\s*/g, ' ') };
}

// Resolves once the opener exits or fails. It prints the fallback at most once, on a spawn error, a nonzero exit or a signal.
// The child stays referenced so a CLI that awaits this sees the result before it exits (decisions.md D14).
export function openUrl(url: string, spawnFn: SpawnFn = spawn): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      if (failed) console.error(`Open this URL in your browser: ${url}`);
      resolve();
    };
    let child;
    try { child = spawnFn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }); } catch { finish(true); return; }
    child.on('error', () => finish(true));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => finish(code !== 0 || signal !== null));
  });
}

// CLI shell for `open` and `stop`. argv starts with the command. deps is a test seam: dir, entry, extraArgs, timeoutMs, openUrl, env.
// cli.ts passes its usage text in deps.usage, so this module does not import cli.ts.
export async function instanceMain(argv: string[], deps: InstanceDeps = {}): Promise<void> {
  const [command, ...rest] = argv;
  let json = rest.includes('--json');
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: rest, allowPositionals: false, strict: true, options: { project: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' }, all: { type: 'boolean' } } });
    } catch { throw new Error('Invalid arguments. Use <command> --help for usage.'); }
    const { values } = parsed;
    json = values.json ?? false;
    if (values.help) { console.log(deps.usage ?? ''); return; }
    const all = values.all ?? false;
    // --all --project <dir> preselects that project in the all-projects view.
    const project = all && values.project === undefined ? undefined : path.resolve(values.project ?? process.cwd());
    const { dir = stateDir(), entry, extraArgs, timeoutMs, env } = deps;
    const options = { dir, all, ...(entry === undefined ? {} : { entry }), ...(extraArgs === undefined ? {} : { extraArgs }), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
    if (command === 'stop') {
      for (const key of ['port', 'no-open'] as const) if (values[key] !== undefined) throw new Error(`--${key} does not apply to stop`);
      if (all && values.project !== undefined) throw new Error('--project does not apply to stop --all');
      const stopped = await stopInstance(project, options);
      const label = all ? 'all projects' : project;
      const text = stopped ? `Stopped Topology studio for ${label}` : `Topology studio is not running for ${label}`;
      console.log(json ? JSON.stringify(all ? { all, stopped } : { project, stopped }, null, 2) : text);
      return;
    }
    let port = 0;
    if (values.port !== undefined) {
      port = /^\d+$/.test(values.port) ? Number(values.port) : NaN;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0 to 65535');
    }
    const { record, reused } = await startInstance(project, { ...options, port, ...(env === undefined ? {} : { env }) });
    const view = all && project !== undefined ? await allProjectsUrl(record, project) : { url: record.url, warning: null };
    // --json prints the whole record, token included: the url carries it anyway (decisions.md D11). view is the preselect URL.
    console.log(json ? JSON.stringify({ ...record, reused, ...(view.url === record.url ? {} : { view: view.url }) }, null, 2) : `Topology studio: ${view.url}${reused ? ' (already running)' : ''}`);
    if (view.warning !== null) console.error(view.warning);
    if (!values['no-open']) await (deps.openUrl ?? openUrl)(view.url);
    if (!all && !existsSync(path.join(record.project, '.pi/workflows'))) {
      console.error(`No .pi/workflows in ${record.project}. The studio opens with an empty list; create a workflow there or run: agent-topology-studio new <id> --project ${record.project}`);
    }
  } catch (error) {
    console.error(json ? JSON.stringify({ problems: [messageOf(error)], warnings: [] }, null, 2) : messageOf(error));
    process.exitCode = 1;
  }
}
