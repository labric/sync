/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollPairingBody } from './pairing.ts';

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
