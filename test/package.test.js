import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

// Contributor tools under dist/bin/ that are not shipped.
const unshipped = new Set(['dist/bin/dev.js', 'dist/bin/check-workflow.js', 'dist/bin/supervise.js']);

// What npm would ship, with its own globs and negations applied. --ignore-scripts keeps prepack from rebuilding dist/.
function packFiles() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', timeout: 120_000 });

  assert.ok(!result.error && result.status === 0, `npm pack failed: ${result.error?.message ?? result.stderr}`);

  return new Set(JSON.parse(result.stdout)[0].files.map(file => file.path));
}

const packed = packFiles();

const covered = file => packed.has(file);

// Relative edges: static (also export ... from), dynamic and side-effect imports.
const relativePatterns = [/\bfrom\s*['"](\.\.?\/[^'"]+)['"]/g, /\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g, /\bimport\s*['"](\.\.?\/[^'"]+)['"]/g];

// Bare specifiers, anchored to statements so string literals such as '--runs-from' do not match.
const barePatterns = [/^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'".][^'"]*)['"]/gm, /\bimport\(\s*['"]([^'".][^'"]*)['"]\s*\)/g, /^\s*import\s*['"]([^'".][^'"]*)['"]/gm];

async function shipped() {
  const files = [];

  for (const dir of ['dist/bin', 'dist/server', 'dist/shared', 'dist/pi']) for (const name of await readdir(path.join(root, dir), { recursive: true })) {
    const file = path.posix.join(dir, ...name.split(path.sep));

    if (file.endsWith('.js') && !unshipped.has(file)) files.push(file);
  }

  return files;
}

async function specifiers(file, patterns) {
  const code = await readFile(path.join(root, file), 'utf8');

  return [...new Set(patterns.flatMap(pattern => [...code.matchAll(pattern)].map(match => match[1])))];
}

const relative = (file, specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));

test('bin, exports and pi.extensions point at dist/ and ship', () => {
  for (const [key, file] of Object.entries(pkg.exports)) {
    if (key === './package.json') continue;

    assert.equal(file, `./dist/shared${key.slice(1)}.js`, key);

    assert.ok(packed.has(path.posix.normalize(file)), `${file} is not in the pack list`);
  }

  assert.deepEqual(pkg.bin, { 'agent-topology-studio': 'dist/bin/studio.js' });

  assert.deepEqual(pkg.pi.extensions, ['./dist/pi/extension.js']);

  for (const file of [...Object.values(pkg.bin), ...pkg.pi.extensions]) assert.ok(packed.has(path.posix.normalize(file)), `${file} is not in the pack list`);
});

test('every export subpath resolves to the declared module namespace', async () => {
  for (const [key, file] of Object.entries(pkg.exports)) {
    if (key === './package.json') continue;

    const module = await import(pkg.name + key.slice(1));

    assert.equal(module, await import(new URL(file, new URL('..', import.meta.url)).href), key);
  }
});

test('every bin target ships and starts with a node shebang', async () => {
  for (const target of Object.values(pkg.bin)) {
    assert.ok(covered(target), `${target} is not in files`);

    assert.equal((await readFile(path.join(root, target), 'utf8')).split('\n')[0], '#!/usr/bin/env node');
  }
});

// D13 option B: bin/studio.js is a source-only shim. It never ships, and the build skips it so dist/bin/studio.js comes from bin/studio.ts.
test('the temporary bin/studio.js shim stays out of the pack and the build', async () => {
  assert.ok(!packed.has('bin/studio.js'), 'bin/studio.js must not ship');

  const build = JSON.parse(await readFile(path.join(root, 'tsconfig.build.json'), 'utf8'));

  assert.ok(build.exclude.includes('bin/studio.js'), 'tsconfig.build.json must exclude bin/studio.js');

  assert.ok(!(await readFile(path.join(root, 'dist/bin/studio.js'), 'utf8')).includes("import './studio.ts'"), 'dist/bin/studio.js must be compiled bin/studio.ts, not the shim');
});

test('every pi extension entry exists, is .js and ships', () => {
  assert.ok(pkg.pi?.extensions?.length > 0, 'pkg.pi.extensions is empty');

  for (const entry of pkg.pi.extensions) {
    const file = path.posix.normalize(entry);

    assert.ok(file.endsWith('.js'), `${entry} is not .js`);

    assert.ok(existsSync(path.join(root, file)), `${entry} does not exist`);

    assert.ok(covered(file), `${entry} is not in files`);
  }
});

test('every relative import in shipped files resolves inside files', async () => {
  const studio = (await specifiers('dist/bin/studio.js', relativePatterns)).map(s => relative('dist/bin/studio.js', s)).sort();

  assert.deepEqual(studio, ['dist/bin/build-stamp.js', 'dist/bin/cli.js', 'dist/server/args.js', 'dist/server/main.js', 'dist/server/narrow.js', 'dist/server/tool-root.js'].sort());

  for (const file of await shipped()) {
    assert.ok(covered(file), `${file} is not in files`);

    for (const specifier of await specifiers(file, relativePatterns)) {
      const target = relative(file, specifier);

      assert.ok(covered(target), `${file} imports ${specifier}, which does not ship`);

      assert.ok(existsSync(path.join(root, target)), `${file} imports ${specifier}, which does not exist`);
    }
  }
});

test('dependencies match the bare imports of shipped files', async () => {
  const bare = new Set();

  for (const file of await shipped()) for (const specifier of await specifiers(file, barePatterns)) {
    if (specifier.startsWith('node:')) continue;

    bare.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
  }

  assert.deepEqual([...bare].sort(), Object.keys(pkg.dependencies).sort());
});
