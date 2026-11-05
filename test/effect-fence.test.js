import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set([path.join(root, 'node_modules'), path.join(root, 'web', 'node_modules'), path.join(root, 'web', 'dist')]);

/** @param {string} dir @param {(file: string) => boolean} keep @returns {string[]} */
function walk(dir, keep) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !skip.has(full)) out.push(...walk(full, keep));
    } else if (keep(full)) out.push(full);
  }
  return out;
}

const specifier = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
/** @param {string} spec */
const forbidden = spec => spec === 'effect' || spec.startsWith('effect/') || spec.startsWith('@effect/') || /(^|\/)server(\/|$)/.test(spec);

test('shared/ imports no Node built-ins; shared/ and web/src never import effect or server code', () => {
  const builtins = new Set(builtinModules);
  const sharedFiles = walk(path.join(root, 'shared'), file => /\.(c|m)?[jt]sx?$/.test(file));

  const nodeOffenders = [];

  for (const file of sharedFiles) {
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(specifier)) {
      if (spec.startsWith('node:') || builtins.has(spec)) nodeOffenders.push(`${path.relative(root, file)}: ${spec}`);
    }
  }

  assert.deepEqual(nodeOffenders, []);

  const files = ['shared', path.join('web', 'src')].flatMap(dir => walk(path.join(root, dir), file => /\.(c|m)?[jt]sx?$/.test(file)));
  assert.ok(files.length > 0);
  const offenders = files.flatMap(file => [...readFileSync(file, 'utf8').matchAll(specifier)]
    .map(match => match[1])
    .filter(forbidden)
    .map(spec => `${path.relative(root, file)}: ${spec}`));
  assert.deepEqual(offenders, []);
});

test('the built web bundle contains no effect code', { skip: !existsSync(path.join(root, 'web', 'dist')) }, () => {
  const dist = path.join(root, 'web', 'dist');
  const offenders = walk(dist, () => true).filter(file => {
    const text = readFileSync(file, 'utf8');
    return text.includes('~effect/') || text.includes('effect/Effect');
  }).map(file => path.relative(root, file));
  assert.deepEqual(offenders, []);
});
