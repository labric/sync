/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pairsElsewhere, pollPairingBody } from './pairing.ts';

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

test('a first pairing has no earlier organization to compare', () => {
  assert.equal(pairsElsewhere('org_b', null, null), false);
});

test('pairing to the organization the device was signed out of keeps the folder', () => {
  assert.equal(pairsElsewhere('org_a', null, { org_id: 'org_a' }), false);
});

test('pairing to another organization after a sign-out drops the folder', () => {
  assert.equal(pairsElsewhere('org_b', null, { org_id: 'org_a' }), true);
});

test('a rejected token is compared as before', () => {
  assert.equal(pairsElsewhere('org_a', { org_id: 'org_a' }, null), false);
  assert.equal(pairsElsewhere('org_b', { org_id: 'org_a' }, null), true);
});

test('an earlier token without an organization never matches', () => {
  assert.equal(pairsElsewhere('org_a', null, { org_id: null }), true);
});

test('a new token without a readable organization never matches', () => {
  assert.equal(pairsElsewhere(undefined, null, { org_id: 'org_a' }), true);
});
