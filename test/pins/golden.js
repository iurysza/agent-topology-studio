// Golden files for the pins (contract.md "How pins store expected values" and "Normalisation").
// PINS_UPDATE=1 writes values; run it only on the base commit. Without it, every value must equal the stored one.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./golden/', import.meta.url));

const update = process.env.PINS_UPDATE === '1';

// Keys written by this process. A second tree in update mode compares against the first instead of overwriting it.
const written = new Set();

/** @param {string} file @returns {Record<string, any>} */
function load(file) {
  const target = path.join(dir, file);

  return existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
}

/** @param {string} file @param {Record<string, any>} data */
function save(file, data) {
  const sorted = Object.fromEntries(Object.keys(data).sort().map(key => [key, data[key]]));

  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * Compare a value with the golden entry `key` in `test/pins/golden/<file>`, or write it with PINS_UPDATE=1.
 * The value goes through JSON first, so only what the golden file can hold is compared.
 * @param {import('node:test').TestContext} t
 * @param {string} file
 * @param {string} key
 * @param {any} value
 */
export function matchGolden(t, file, key, value) {
  const actual = JSON.parse(JSON.stringify(value) ?? 'null');
  const id = `${file}#${key}`;

  if (update && !written.has(id)) {
    save(file, { ...load(file), [key]: actual });
    written.add(id);
    t.diagnostic(`golden written: ${id}`);

    return;
  }

  const stored = load(file);

  assert.ok(Object.hasOwn(stored, key), `no golden entry ${id}; generate it on the base commit with PINS_UPDATE=1`);
  assert.deepStrictEqual(actual, stored[key], `golden mismatch ${id}`);
}

/** @param {string} text @param {string} from @param {string} to @returns {string} */
function replacePath(text, from, to) {
  const bare = from.replace(/^\/private(?=\/)/, '');

  return text.split(from).join(to).split(bare).join(to);
}

/**
 * Normalise output in the contract's order: paths, then ISO timestamps, then stack frames.
 * Each path also matches without its leading `/private`, because macOS temp directories are symlinks.
 * @param {string} text
 * @param {{ fix?: string, state?: string, pkg?: string, root?: string }} paths
 * @returns {string}
 */
export function normalise(text, { fix, state, pkg, root }) {
  let out = text;

  for (const [from, to] of [[fix, '<FIX>'], [state, '<STATE>'], [pkg, '<PKG>'], [root, '<ROOT>']]) if (from) out = replacePath(out, from, to);

  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>');

  return out.replace(/^\s+at .*$/gm, '<FRAME>');
}
