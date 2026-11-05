import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

const read = file => readFileSync(path.join(root, file), 'utf8');

const lock = JSON.parse(read('package-lock.json'));

const noticePaths = ['web/dist/THIRD_PARTY_NOTICES.txt', 'web/dist/fonts/Inter-LICENSE.txt'];

// Code that ships in web/dist or installs as a runtime dependency, and the font package whose files Vite copies into web/dist/assets.
const packages = [
  ['react', 'MIT'], ['react-dom', 'MIT'], ['scheduler', 'MIT'],
  ['@dagrejs/dagre', 'MIT'], ['@dagrejs/graphlib', 'MIT'],
  ['acorn', 'MIT'], ['effect', 'MIT'],
  ['@fontsource-variable/inter', 'OFL-1.1'],
];

const section = (heading, license, source, text) => `${'='.repeat(72)}\n${heading}\nLicense: ${license}\nSource: ${source}\n${'='.repeat(72)}\n\n${text}`;

test('the notices carry each package licence verbatim under its locked version', () => {
  const notices = read('web/public/THIRD_PARTY_NOTICES.txt');

  for (const [name, license] of packages) {
    const { version, license: declared } = lock.packages[`node_modules/${name}`];

    assert.equal(declared, license, `${name} declares ${declared}, update its notice`);

    const text = read(`node_modules/${name}/LICENSE`);

    assert.ok(notices.includes(section(`${name} ${version}`, license, `${name}/LICENSE`, text)), `${name} ${version} licence is missing or altered`);
  }
});

test('the notices carry the IoskeleyMono licence, and Inter has its licence next to the fonts', () => {
  const notices = read('web/public/THIRD_PARTY_NOTICES.txt');

  const ioskeley = read('web/public/fonts/IoskeleyMono-LICENSE.txt');

  assert.ok(notices.includes(section('IoskeleyMono (web/dist/fonts/IoskeleyMono-*.woff2)', 'OFL-1.1', 'web/public/fonts/IoskeleyMono-LICENSE.txt', ioskeley)), 'IoskeleyMono licence is missing or altered');

  assert.equal(read('web/public/fonts/Inter-LICENSE.txt'), read('node_modules/@fontsource-variable/inter/LICENSE'));
});

// Runs the real check-pack.js against a small fixture package, so npm pack sees a handful of files.
function checkPack(fixture) {
  return spawnSync(process.execPath, [path.join(fixture, 'scripts/check-pack.js')], { cwd: fixture, encoding: 'utf8', timeout: 120_000 });
}

function touch(fixture, file) {
  mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });

  writeFileSync(path.join(fixture, file), '\n');
}

test('check:pack fails when the pack lacks the notices, and passes once they ship', t => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'check-pack-'));

  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  touch(fixture, 'scripts/check-pack.js');

  copyFileSync(path.join(root, 'scripts/check-pack.js'), path.join(fixture, 'scripts/check-pack.js'));

  writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', files: ['dist/', 'web/dist/', 'reference/'] }));

  for (const file of ['dist/bin/studio.js', 'web/dist/index.html']) touch(fixture, file);

  const first = checkPack(fixture);

  assert.equal(first.status, 1, first.stderr);

  const missing = [...first.stderr.matchAll(/^(?:check-pack: )?missing (\S+)$/gm)].map(match => match[1]);

  for (const file of noticePaths) assert.ok(missing.includes(file), `check-pack does not require ${file}`);

  for (const file of missing.filter(file => !noticePaths.includes(file) && file !== 'package.json')) touch(fixture, file);

  const without = checkPack(fixture);

  assert.equal(without.status, 1, without.stderr);

  assert.deepEqual([...without.stderr.matchAll(/^(?:check-pack: )?missing (\S+)$/gm)].map(match => match[1]).sort(), [...noticePaths].sort());

  for (const file of noticePaths) touch(fixture, file);

  const shipped = checkPack(fixture);

  assert.equal(shipped.status, 0, shipped.stderr);

  assert.match(shipped.stdout, /^pack ok: /);
});
