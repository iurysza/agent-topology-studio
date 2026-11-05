// server/tool-root (ADR-0006): toolRoot walks up to package.json, resolveEntry picks .ts before .js in the running tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, sourceFile } from './pins/tree.js';

const own = () => import(pathToFileURL(sourceFile('server/tool-root')).href);

// Copy only a .js build: Node refuses to strip types under node_modules (decisions.md D1).
function jsSource() {
  const candidates = [path.join(root, 'dist/server/tool-root.js'), path.join(root, 'server/tool-root.js')];
  const found = candidates.find(file => existsSync(file));

  if (!found) throw new Error(`No .js build of tool-root: ${candidates.join(' or ')}`);

  return found;
}

/** Copy the module to <tmp>/<rel>/tool-root.js, write package.json at <tmp>/<pkg>, import the copy and remove the temp dir. */
async function fromCopy(t, rel, pkg) {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tool-root-')));

  t.after(() => rm(tmp, { recursive: true, force: true }));
  await mkdir(path.join(tmp, rel), { recursive: true });
  await copyFile(jsSource(), path.join(tmp, rel, 'tool-root.js'));
  await writeFile(path.join(tmp, pkg, 'package.json'), '{"type":"module"}\n');

  return { tmp, module: await import(pathToFileURL(path.join(tmp, rel, 'tool-root.js')).href) };
}

test('toolRoot is the repository root', async () => {
  assert.equal((await own()).toolRoot, root);
});

test('toolRoot from a renamed installed dist/ copy is the installed package dir', async t => {
  const { tmp, module } = await fromCopy(t, 'node_modules/renamed-pkg/dist/server', 'node_modules/renamed-pkg');

  assert.equal(module.toolRoot, path.join(tmp, 'node_modules/renamed-pkg'));
});

test('toolRoot from dist/server/ is the dir that holds package.json', async t => {
  const { tmp, module } = await fromCopy(t, 'dist/server', '.');

  assert.equal(module.toolRoot, tmp);
});

test('resolveEntry returns the entry file that exists', async () => {
  assert.equal((await own()).resolveEntry('server/main.js'), sourceFile('server/main'));
});

test('resolveEntry prefers .ts when both files exist', async t => {
  const { tmp, module } = await fromCopy(t, 'server', '.');

  await mkdir(path.join(tmp, 'bin'));
  await writeFile(path.join(tmp, 'bin/entry.js'), '');
  await writeFile(path.join(tmp, 'bin/entry.ts'), '');
  assert.equal(module.resolveEntry('bin/entry.js'), path.join(tmp, 'bin/entry.ts'));
  assert.equal(module.resolveEntry('bin/entry'), path.join(tmp, 'bin/entry.ts'));
});

test('resolveEntry throws for a missing entry', async () => {
  const { resolveEntry } = await own();

  assert.throws(() => resolveEntry('bin/nope.js'), { message: 'No entry bin/nope.js' });
});
