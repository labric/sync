/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeInstall, nextInstallRecord, type InstallRecord } from './install-record.ts';

const now = '2026-11-18T15:00:00.000Z';
const earlier: InstallRecord = { version: '0.2.12', since: '2026-11-01T09:00:00.000Z', previous: null, freshInstall: true };

test('keeps the record while the same version runs', () => {
  assert.equal(nextInstallRecord(earlier, '0.2.12', now, false), earlier);
});

test('a new version starts a record that remembers the one before it', () => {
  assert.deepEqual(nextInstallRecord(earlier, '0.2.13', now, false), {
    version: '0.2.13',
    since: now,
    previous: '0.2.12',
    freshInstall: false,
  });
});

test('with no record, a first run counts as a fresh install', () => {
  assert.deepEqual(nextInstallRecord(null, '0.2.13', now, true), {
    version: '0.2.13',
    since: now,
    previous: null,
    freshInstall: true,
  });
});

test('with no record but existing settings, the app was updated from an unknown version', () => {
  assert.deepEqual(nextInstallRecord(null, '0.2.13', now, false), {
    version: '0.2.13',
    since: now,
    previous: null,
    freshInstall: false,
  });
});

const date = (iso: string) => `<${iso}>`;

test('describes an update from a known version', () => {
  const record = { version: '0.2.13', since: now, previous: '0.2.12', freshInstall: false };
  assert.equal(describeInstall(record, date), `Updated <${now}> from 0.2.12`);
});

test('describes a fresh install', () => {
  const record = { version: '0.2.13', since: now, previous: null, freshInstall: true };
  assert.equal(describeInstall(record, date), `Installed <${now}>`);
});

test('describes an update from an unknown version', () => {
  const record = { version: '0.2.13', since: now, previous: null, freshInstall: false };
  assert.equal(describeInstall(record, date), `Updated <${now}>`);
});
