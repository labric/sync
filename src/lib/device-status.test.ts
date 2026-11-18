/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceStatusDisplay, syncProgressDisplay } from './device-status.ts';

test('online and watching is green', () => {
  assert.deepEqual(deviceStatusDisplay('online', true), {
    label: 'Online',
    dotClass: 'bg-success',
  });
});

test('online but not watching a folder is yellow', () => {
  assert.deepEqual(deviceStatusDisplay('online', false), {
    label: 'Not watching a folder',
    dotClass: 'bg-warning',
    tooltip: 'Online, not watching a folder',
  });
});

test('offline is red whether or not a folder is watched', () => {
  for (const isWatching of [true, false]) {
    assert.deepEqual(deviceStatusDisplay('offline', isWatching), {
      label: 'Offline',
      dotClass: 'bg-destructive',
    });
  }
  assert.equal(deviceStatusDisplay(undefined, true).label, 'Offline');
});

test('watching with nothing pending is up to date', () => {
  assert.deepEqual(syncProgressDisplay(0, true), { kind: 'up_to_date' });
});

test('watching with files pending is syncing', () => {
  assert.deepEqual(syncProgressDisplay(3, true), { kind: 'syncing', pending: 3 });
});

test('not watching with nothing pending shows nothing', () => {
  assert.equal(syncProgressDisplay(0, false), null);
});

test('not watching with files still pending is syncing', () => {
  assert.deepEqual(syncProgressDisplay(2, false), { kind: 'syncing', pending: 2 });
});
