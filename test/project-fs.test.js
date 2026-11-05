import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Effect from 'effect/Effect';
import { FsError, ProjectPathError } from '../server/errors.ts';
import { ProjectFs } from '../server/services.ts';
import { optionalRead, list, atomicWrite, removeFile, guarded } from '../server/project-fs.ts';
import { runEdge } from '../server/edge.ts';

const real = { readFile: fsp.readFile, readdir: fsp.readdir, stat: fsp.stat, mkdir: fsp.mkdir, open: fsp.open, rename: fsp.rename, rm: fsp.rm };
/** @param {string} code */
const fsError = code => Object.assign(new Error(`${code}: fake`), { code });
/** @param {Partial<typeof real>} overrides */
const run = (effect, overrides = {}) => Effect.runPromise(effect.pipe(Effect.provideService(ProjectFs, { ...real, ...overrides })));

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-project-fs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const temps = async dir => (await readdir(dir)).filter(name => name.endsWith('.tmp'));

test('optionalRead gives null for a missing file', async t => {
  const dir = await tempDir(t);
  assert.equal(await run(optionalRead(path.join(dir, 'missing'))), null);
});

test('optionalRead fails with FsError holding the raw EACCES error', async t => {
  const dir = await tempDir(t), file = path.join(dir, 'x'), cause = fsError('EACCES');
  const error = await run(Effect.flip(optionalRead(file)), { readFile: async () => { throw cause; } });
  assert.ok(error instanceof FsError);
  assert.equal(error.op, 'read');
  assert.equal(error.path, file);
  assert.equal(error.cause, cause);
});

test('list gives [] for a missing directory', async t => {
  const dir = await tempDir(t);
  assert.deepEqual(await run(list(path.join(dir, 'missing'))), []);
});

test('atomicWrite removes the temp file when rename fails', async t => {
  const dir = await tempDir(t), cause = fsError('EACCES');
  const error = await run(Effect.flip(atomicWrite(path.join(dir, 'x.js'), 'code')), { rename: async () => { throw cause; } });
  assert.ok(error instanceof FsError);
  assert.equal(error.op, 'rename');
  assert.equal(error.cause, cause);
  assert.deepEqual(await readdir(dir), []);
});

test('atomicWrite fails and creates nothing when open fails', async t => {
  const dir = await tempDir(t), cause = fsError('EEXIST');
  const error = await run(Effect.flip(atomicWrite(path.join(dir, 'x.js'), 'code')), { open: async () => { throw cause; } });
  assert.ok(error instanceof FsError);
  assert.equal(error.op, 'open');
  assert.deepEqual(await readdir(dir), []);
});

// The original try/finally closed again, which threw again and skipped the cleanup rm.
test('atomicWrite rejects with the raw close error and leaves the temp file when close keeps failing', async t => {
  const dir = await tempDir(t), cause = fsError('EIO');
  /** @type {typeof fsp.open} */
  const open = async (file, flags) => { const handle = await fsp.open(file, flags); const close = handle.close.bind(handle); return Object.assign(handle, { close: async () => { await close(); throw cause; } }); };
  const effect = Effect.gen(function* () {
    const fs = yield* ProjectFs;
    return yield* atomicWrite(path.join(dir, 'x.js'), 'code').pipe(Effect.provideService(ProjectFs, { ...fs, open }));
  });
  await assert.rejects(runEdge(effect), rejected => rejected === cause);
  assert.equal((await temps(dir)).length, 1);
});

/**
 * @template A, E
 * @param {Effect.Effect<A, E, ProjectFs>} effect
 * @param {Partial<typeof real>} overrides
 * @returns {Effect.Effect<A, E, ProjectFs>}
 */
const withFs = (effect, overrides) => Effect.gen(function* () {
  const fs = yield* ProjectFs;
  return yield* effect.pipe(Effect.provideService(ProjectFs, { ...fs, ...overrides }));
});

// Matches the original try/finally atomicWrite: a cleanup failure replaces the earlier error,
// a handle whose close failed is closed again, and a failed close skips the cleanup rm.
const atomicWriteCases = [
  { fail: [], rejects: null, calls: 'open,write,sync,close,rename,rm' },
  { fail: ['rm'], rejects: 'rm', calls: 'open,write,sync,close,rename,rm' },
  { fail: ['rename'], rejects: 'rename', calls: 'open,write,sync,close,rename,rm' },
  { fail: ['rename', 'rm'], rejects: 'rm', calls: 'open,write,sync,close,rename,rm' },
  { fail: ['close'], rejects: 'close', calls: 'open,write,sync,close,close' },
  { fail: ['close', 'rm'], rejects: 'close', calls: 'open,write,sync,close,close' },
  { fail: ['write'], rejects: 'write', calls: 'open,write,close,rm' },
  { fail: ['write', 'rm'], rejects: 'rm', calls: 'open,write,close,rm' },
  { fail: ['write', 'rename'], rejects: 'write', calls: 'open,write,close,rm' },
  { fail: ['write', 'close'], rejects: 'close', calls: 'open,write,close' },
  { fail: ['write', 'close', 'rm'], rejects: 'close', calls: 'open,write,close' },
];

for (const { fail, rejects, calls } of atomicWriteCases) {
  test(`atomicWrite with ${fail.join(' + ') || 'no'} failure ${rejects ? `rejects with the raw ${rejects} error` : 'succeeds'} after ${calls}`, async t => {
    const dir = await tempDir(t), file = path.join(dir, 'x.js');
    /** @type {Record<string, Error>} */
    const errors = Object.fromEntries(fail.map(op => [op, fsError(`E_${op.toUpperCase()}`)]));
    /** @type {string[]} */
    const log = [];
    /** @param {string} op */
    const step = op => { log.push(op); if (errors[op]) throw errors[op]; };
    /** @type {typeof fsp.open} */
    const open = async (target, flags) => {
      log.push('open');
      const handle = await fsp.open(target, flags); const close = handle.close.bind(handle), writeFile = handle.writeFile.bind(handle), sync = handle.sync.bind(handle);
      return Object.assign(handle, {
        writeFile: async (/** @type {string} */ data) => { step('write'); return writeFile(data); },
        sync: async () => { step('sync'); return sync(); },
        close: async () => { log.push('close'); await close(); if (errors.close) throw errors.close; },
      });
    };
    /** @type {typeof fsp.rename} */
    const rename = async (from, to) => { step('rename'); return fsp.rename(from, to); };
    /** @type {typeof fsp.rm} */
    const rmFake = async (target, options) => { step('rm'); assert.match(String(target), /\.tmp$/); assert.deepEqual(options, { force: true }); return fsp.rm(target, options); };
    const written = runEdge(withFs(atomicWrite(file, 'code'), { open, rename, rm: rmFake }));
    if (rejects) await assert.rejects(written, rejected => rejected === errors[rejects]);
    else { await written; assert.equal(await readFile(file, 'utf8'), 'code'); }
    assert.equal(log.join(','), calls);
  });
}

test('atomicWrite writes the content and leaves no temp file', async t => {
  const dir = await tempDir(t), file = path.join(dir, 'nested/x.js');
  await run(atomicWrite(file, 'code'));
  assert.equal(await readFile(file, 'utf8'), 'code');
  assert.deepEqual(await temps(path.dirname(file)), []);
});

test('removeFile gives true, then false once the file is gone', async t => {
  const dir = await tempDir(t), file = path.join(dir, 'x');
  await writeFile(file, 'x');
  assert.equal(await run(removeFile(file)), true);
  assert.equal(await run(removeFile(file)), false);
});

test('runEdge rejects with the raw cause of an FsError', async () => {
  const cause = fsError('EACCES');
  await assert.rejects(runEdge(Effect.fail(new FsError({ op: 'read', path: '/x', cause }))), rejected => rejected === cause);
});

test('guarded keeps ProjectPathError as a tagged failure', async () => {
  const error = await run(Effect.flip(guarded(() => { throw new ProjectPathError(); }, '/x')));
  assert.ok(error instanceof ProjectPathError);
});

test('guarded turns any other throw into FsError', async () => {
  const cause = fsError('EACCES');
  const error = await run(Effect.flip(guarded(() => { throw cause; }, '/x')));
  assert.ok(error instanceof FsError);
  assert.equal(error.op, 'realpath');
  assert.equal(error.path, '/x');
  assert.equal(error.cause, cause);
});
