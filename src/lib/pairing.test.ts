/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepsWatchedFolder, pollPairingBody } from './pairing.ts';

test('poll body carries the secret from get-code', () => {
  assert.deepEqual(pollPairingBody('fingerprint', 'secret'), {
    device_fingerprint: 'fingerprint',
    pairing_secret: 'secret',
  });
});

test('poll body omits the secret when the server returned none', () => {
  assert.deepEqual(pollPairingBody('fingerprint', null), {
    device_fingerprint: 'fingerprint',
  });
});

test('pairing back to the rejected token\'s organization keeps the folder', () => {
  assert.equal(keepsWatchedFolder('org_a', 'org_a'), true);
});

test('pairing to another organization does not keep the folder', () => {
  assert.equal(keepsWatchedFolder('org_a', 'org_b'), false);
});

test('an unknown organization on either side does not keep the folder', () => {
  assert.equal(keepsWatchedFolder(null, 'org_a'), false);
  assert.equal(keepsWatchedFolder('org_a', undefined), false);
  assert.equal(keepsWatchedFolder(null, undefined), false);
});
