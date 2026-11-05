// server/narrow (decisions.md D16): each guard keeps the value the old direct property read gave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { isAddressInfo, isErrno, isHinted, messageOf } from '../server/narrow.ts';

test('isErrno is true only for an Error that has a code', () => {
  assert.equal(isErrno(Object.assign(new Error('gone'), { code: 'ENOENT' })), true);
  assert.equal(isErrno(new Error('plain')), false);
  assert.equal(isErrno({ code: 'ENOENT' }), false);
  assert.equal(isErrno(null), false);
});

test('isHinted is true only for an Error with a string hint', () => {
  assert.equal(isHinted(Object.assign(new Error('bad'), { hint: 'try this' })), true);
  assert.equal(isHinted(Object.assign(new Error('bad'), { hint: 1 })), false);
  assert.equal(isHinted({ hint: 'try this' }), false);
  assert.equal(isHinted(undefined), false);
});

test('messageOf gives the message string, else undefined', () => {
  assert.equal(messageOf(new Error('boom')), 'boom');
  assert.equal(messageOf({ message: 'plain object' }), 'plain object');
  assert.equal(messageOf(null), undefined);
  assert.equal(messageOf(undefined), undefined);
  assert.equal(messageOf('x'), undefined);
  assert.equal(messageOf({ message: 1 }), undefined);
  assert.equal(messageOf({}), undefined);
});

test('isAddressInfo is true for a listening TCP address, false for null and a pipe name', async t => {
  const server = createServer();

  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(isAddressInfo(server.address()), false);
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));

  const address = server.address();

  assert.equal(isAddressInfo(address), true);
  assert.equal(isAddressInfo('/tmp/studio.sock'), false);
});
