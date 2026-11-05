import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { needsBuild, writeStamp } from '../bin/build-stamp.ts';
async function checkout(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-stamp-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['web/src', 'web/dist', 'web/public/fonts', 'shared']) await mkdir(path.join(root, dir), { recursive: true });
  for (const file of ['web/src/App.tsx', 'web/index.html', 'web/vite.config.ts', 'web/tsconfig.json', 'shared/machine.js', 'package-lock.json', 'web/dist/index.html', 'web/public/fonts/a.woff2']) await writeFile(path.join(root, file), '');
  return root;
}
test('build stamp tracks touches, deletions, missing stamp and forced rebuild', async t => {
  const root = await checkout(t);
  assert.equal(await needsBuild(root), true); await writeStamp(root); assert.equal(await needsBuild(root), false);
  assert.equal(await needsBuild(root, { rebuild: true }), true);
  await utimes(path.join(root, 'web/src/App.tsx'), new Date(), new Date(Date.now() + 1000)); assert.equal(await needsBuild(root), true);
  await writeStamp(root); await rm(path.join(root, 'web/src/App.tsx')); assert.equal(await needsBuild(root), true);
});
test('build stamp notices a changed font in web/public', async t => {
  const root = await checkout(t); await writeStamp(root);
  await writeFile(path.join(root, 'web/public/fonts/a.woff2'), 'new font bytes');
  assert.equal(await needsBuild(root), true);
});
test('build stamp notices an edit to an older file that keeps its mtime', async t => {
  const root = await checkout(t), old = new Date(Date.now() - 60_000), file = path.join(root, 'shared/machine.js');
  await utimes(file, old, old); await writeStamp(root);
  await writeFile(file, 'export const changed = true;'); await utimes(file, old, old);
  assert.equal(await needsBuild(root), true);
});
test('build stamp notices a rename that keeps the mtime', async t => {
  const root = await checkout(t); await writeStamp(root);
  await rename(path.join(root, 'web/src/App.tsx'), path.join(root, 'web/src/Main.tsx'));
  assert.equal(await needsBuild(root), true);
  // Known limit: a same-size, same-mtime edit is not detected. --rebuild covers it.
});
