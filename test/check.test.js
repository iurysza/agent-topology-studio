import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkWorkflowCode, extractMeta, isSafeName } from '../server/check.ts';
const good = "export const meta = { name: 'demo', description: 'Demo' };\nawait agent('x'); return {ok: true};";
test('accepts fixtures and async body, literal walker', async () => {
  assert.deepEqual(checkWorkflowCode(good).errors, []);
  for (const name of ['plan', 'build', 'council']) assert.deepEqual(checkWorkflowCode(await readFile(new URL(`../fixtures/playground/.pi/workflows/${name}.js`, import.meta.url), 'utf8')).errors, []);
  assert.equal(extractMeta(good).name, 'demo'); assert.ok(checkWorkflowCode(good, { fileName: 'x.js' }).warnings.length);
});
for (const [label, code] of [
  ['syntax line', good + '\nconst ='], ['no meta', 'await agent("x");'], ['variable', 'const v = {}; export const meta = v;'],
  ['call', "export const meta = {name: make(), description: 'x'}"], ['spread', 'export const meta = {...v}'],
  ['computed', "export const meta = {['name']: 'x'}"], ['template', 'export const meta = {name: `a${v}`}'],
  ['missing name', "export const meta = {description: 'x'}"], ['missing description', "export const meta = {name: 'x'}"],
  ['non-string name', "export const meta = {name: 2, description: 'x'}"], ['import', "import fs from 'fs';" + good],
  ['second export', good + '\nexport const extra = 1'], ['control', good + '\0'], ['size', good + ' '.repeat(524288)],
  ['Date wrapper', good + '\nconst Date = 1;'], ['args wrapper', good + '\nconst args = {};'],
]) test(`reject ${label}`, () => assert.ok(checkWorkflowCode(code).errors.length));
test('compile errors map to file line and safe names reject paths', () => {
  assert.match(checkWorkflowCode(good + '\nconst Date = 1;', { fileName: 'demo.js' }).errors.join('\n'), /demo.js:3/);
  for (const name of ['build', 'a.b-c_1']) assert.equal(isSafeName(name), true);
  for (const name of ['', '.', '..', '../x', 'a/b', 'a b', 'a'.repeat(101)]) assert.equal(isSafeName(name), false);
});
