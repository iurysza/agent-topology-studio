import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { errorResponse } from '../server/http-errors.ts';
import { StaleError, RoleError, ProjectPathError, RunIdError, RequestError } from '../server/errors.ts';

test('each tagged error maps to its exact status and body', () => {
  /** @type {Array<[unknown, { status: number, body: unknown }]>} */
  const cases = [
    [new StaleError({ baseSha256: 'a', currentSha256: 'b' }), { status: 409, body: { error: 'The file changed on disk since it was loaded. Reload before saving.', hash: 'b' } }],
    [new StaleError({ baseSha256: 'a', currentSha256: null }), { status: 409, body: { error: 'The file changed on disk since it was loaded. Reload before saving.', hash: null } }],
    [new RoleError({ message: 'Role `coder` already exists' }), { status: 422, body: { error: 'Role `coder` already exists' } }],
    [new ProjectPathError(), { status: 422, body: { error: 'Workflow and role paths must stay inside the project' } }],
    [new RunIdError({ message: 'Invalid run id' }), { status: 400, body: { error: 'Invalid run id' } }],
    [new RequestError({ status: 404, message: 'Run not found' }), { status: 404, body: { error: 'Run not found' } }],
    [new RequestError({ status: 413, message: 'JSON body exceeds 2097152 bytes' }), { status: 413, body: { error: 'JSON body exceeds 2097152 bytes' } }],
  ];
  for (const [error, expected] of cases) assert.deepEqual(errorResponse(error), expected);
});

test('plain errors, raw Node errors and non-errors are not mapped', async () => {
  const raw = await readFile('/nonexistent-studio-path').then(() => null, e => e);
  assert.equal(raw.code, 'ENOENT');
  for (const value of [new Error('Unsafe workflow name'), raw, 'x', null, undefined]) assert.equal(errorResponse(value), null);
});
