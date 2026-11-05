import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-release.js', import.meta.url));

const repository = 'iurysza/agent-topology-studio';

const publicPackage = {
  name: 'agent-topology-studio',
  version: '0.2.0',
  license: 'MIT',
  repository: { type: 'git', url: `git+https://github.com/${repository}.git` },
};

function run(t, pkg, args) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'check-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));

  return spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
}

const release = (t, pkg, tag = 'v0.2.0', repo = repository) => run(t, pkg, ['--tag', tag, '--repository', repo]);

function expectRejected(result, text) {
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes(text), result.stderr);
}

test('a public package whose tag, name and repository match passes', t => {
  const result = release(t, publicPackage);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release ok: agent-topology-studio@0\.2\.0 from iurysza\/agent-topology-studio/);
});

test('the shorthand repository field passes', t => {
  assert.equal(release(t, { ...publicPackage, repository: `github:${repository}` }).status, 0);
});

/** @type {{ name: string, pkg: Record<string, unknown>, tag: string, repo: string, text: string }[]} */
const rejected = [
  { name: 'private package', pkg: { ...publicPackage, private: true }, tag: 'v0.2.0', repo: repository, text: '"private": true' },
  { name: 'UNLICENSED', pkg: { ...publicPackage, license: 'UNLICENSED' }, tag: 'v0.2.0', repo: repository, text: 'licence is "UNLICENSED"' },
  { name: 'missing licence', pkg: { ...publicPackage, license: undefined }, tag: 'v0.2.0', repo: repository, text: 'licence is undefined' },
  { name: 'other name', pkg: { ...publicPackage, name: 'topology-studio' }, tag: 'v0.2.0', repo: repository, text: 'package name is "topology-studio"' },
  { name: 'tag mismatch', pkg: publicPackage, tag: 'v0.3.0', repo: repository, text: 'does not match package version v0.2.0' },
  { name: 'tag without v', pkg: publicPackage, tag: '0.2.0', repo: repository, text: 'does not match package version' },
  { name: 'hostile tag', pkg: publicPackage, tag: 'v0.2.0$(touch pwned)', repo: repository, text: 'does not match package version' },
  { name: 'other repository', pkg: publicPackage, tag: 'v0.2.0', repo: 'someone/fork', text: 'does not match someone/fork' },
  { name: 'no repository field', pkg: { ...publicPackage, repository: undefined }, tag: 'v0.2.0', repo: repository, text: 'package repository null' },
  { name: 'other registry', pkg: { ...publicPackage, publishConfig: { registry: 'https://npm.example.test/' } }, tag: 'v0.2.0', repo: repository, text: 'publishConfig.registry' },
];

for (const { name, pkg, tag, repo, text } of rejected) {
  test(`rejects ${name}`, t => expectRejected(release(t, pkg, tag, repo), text));
}
