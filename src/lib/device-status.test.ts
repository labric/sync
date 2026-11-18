/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceStatusDisplay } from './device-status.ts';

test('online and watching is green', () => {
  assert.deepEqual(deviceStatusDisplay('online', true), {
    label: 'Online',
    dotClass: 'bg-success',
  });
});

test('online but not watching a folder is yellow', () => {
  assert.deepEqual(deviceStatusDisplay('online', false), {
    label: 'Connected, but not watching a folder',
    dotClass: 'bg-warning',
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
