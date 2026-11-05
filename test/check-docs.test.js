import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-docs.js', import.meta.url));

const adrDir = 'ai-artifacts/docs/adr';

const adrName = 'ADR-0001-example.md';

const validAdr = '# ADR-0001: Example\n\nKeep it simple.\n';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'check-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  return root;
}

function write(root, name, text) {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function run(root, args = [], input = '') {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, input, encoding: 'utf8' });
}

function expectFailure(result, location, rule) {
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(`${location}: ${rule}:`), result.stderr);
  assert.equal(result.stdout, '');
}

test('broken relative links report the source line', t => {
  const root = fixture(t);
  write(root, 'doc.md', '# Example\n\n[missing](absent.md)\n');
  expectFailure(run(root, ['doc.md']), 'doc.md:3', 'broken-link');
});

for (const [name, text, rule] of [
  ['email', 'a.b@example.com', 'leak-email'],
  ['group email', 'x@g.us', 'leak-email'],
  ['home directory', os.homedir(), 'leak-home'],
  ['username', `account: ${os.userInfo().username}`, 'leak-username'],
  ['embedded username', `service.dev-${os.userInfo().username}-studio`, 'leak-username'],
  ['macOS home path', '/Users/example/project', 'leak-home-path'],
  ['Linux home path', '/home/example/project', 'leak-home-path'],
  ['token', 'token=0123456789abcdef', 'leak-token'],
]) {
  test(`${name} is a documentation leak`, t => {
    const root = fixture(t);
    write(root, 'doc.md', `# Example\n\n${text}\n`);
    expectFailure(run(root, ['doc.md']), 'doc.md:3', rule);
  });
}

test('a home path inside a fenced block is still a leak', t => {
  const root = fixture(t);
  write(root, 'doc.md', '# Example\n\n```sh\ncd /Users/example/project\n```\n');
  expectFailure(run(root, ['doc.md']), 'doc.md:4', 'leak-home-path');
});

test('links after a fenced block keep their line numbers', t => {
  const root = fixture(t);
  write(root, 'doc.md', '# Example\n\n```\n[ok](doc.md)\n```\n\n`code` [missing](absent.md)\n');
  expectFailure(run(root, ['doc.md']), 'doc.md:7', 'broken-link');
});

test('an ADR must appear in INDEX.md', t => {
  const root = fixture(t);
  write(root, `${adrDir}/${adrName}`, validAdr);
  write(root, `${adrDir}/INDEX.md`, '# Decisions\n');
  expectFailure(run(root, [adrDir]), `${adrName}:1`, 'adr-index');
});

test('an ADR needs an index even when checked individually', t => {
  const root = fixture(t);
  write(root, `${adrDir}/${adrName}`, validAdr);
  expectFailure(run(root, [`${adrDir}/${adrName}`]), `${adrName}:1`, 'adr-index');
});

test('every ADR named in the index must exist', t => {
  const root = fixture(t);
  write(root, `${adrDir}/INDEX.md`, '# Decisions\n\nADR-0042\n');
  expectFailure(run(root, [adrDir]), 'INDEX.md:3', 'index-target');
});

test('a passing tree accepts package versions and relative links', t => {
  const root = fixture(t);
  write(root, `${adrDir}/${adrName}`, validAdr);
  write(root, `${adrDir}/INDEX.md`, `[ADR-0001](${adrName})\n`);
  write(root, 'ai-artifacts/notes.md', '# Notes\n');
  write(root, 'ai-artifacts/docs/notes with spaces.md', '# Notes\n');
  write(root, 'ai-artifacts/docs/README.md', [
    'effect@4.0.6, @dagrejs/dagre, @mermaid-js/mermaid-cli@11.4.0',
    '[Notes](notes%20with%20spaces.md#heading)',
    '[Notes](<notes with spaces.md>)',
    '[ADR](adr/ADR-0001-example.md "Decision")',
    '[Anchor](#missing) [Web](https://example.com) [Scheme](custom:example)',
    `prefix${os.userInfo().username}suffix token=short`,
    'Inline example: `[missing](absent.md)`',
    '```markdown',
    '[x](absent.md)',
    '```',
    '~~~',
    '[y](absent.md)',
    '~~~',
  ].join('\n'));
  const result = run(root, ['ai-artifacts']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ok 5 files\n');
  assert.equal(result.stderr, '');
});

test('default mode skips absent paths and scans only existing default roots', t => {
  const root = fixture(t);
  write(root, 'outside.md', '[missing](absent.md)');
  const empty = run(root);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, 'ok 0 files\n');

  for (const name of ['ai-artifacts/docs/example.md', 'ai-artifacts/_index.md', 'AGENTS.md', 'README.md', '.pi/skills/feature-verification/SKILL.md']) {
    write(root, name, '# Safe\n');
  }

  write(root, 'ai-artifacts/docs/ignored.txt', 'token=0123456789abcdef');
  write(root, 'docs/outside.md', 'token=0123456789abcdef');
  const populated = run(root);
  assert.equal(populated.status, 0, populated.stderr);
  assert.equal(populated.stdout, 'ok 5 files\n');
});

for (const [name, input, rule] of [
  ['bare @', '@', 'leak-at'],
  ['short token', 'token=x', 'leak-token'],
  ['home prefix', '/Users/', 'leak-home-path'],
  ['username', os.userInfo().username, 'leak-username'],
  ['home directory', os.homedir(), 'leak-home'],
]) {
  test(`page mode rejects ${name} on stdin`, t => {
    const root = fixture(t);
    expectFailure(run(root, ['--page', '-'], `Safe\n${input}`), 'stdin:2', rule);
  });
}

test('page mode accepts safe stdin', t => {
  const result = run(fixture(t), ['--page', '-'], 'A public project page.\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ok page\n');
});
