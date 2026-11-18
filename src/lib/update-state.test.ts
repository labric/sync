/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type UpdateEvent, type UpdateState, initialUpdateState, pendingUpdate, updateReducer } from './update-state.ts';

const run = (...events: UpdateEvent[]): UpdateState =>
  events.reduce(updateReducer, initialUpdateState);

test('a found update downloads, then is ready', () => {
  assert.deepEqual(run({ type: 'found', version: '0.3.0' }), { status: 'downloading', version: '0.3.0' });
  assert.deepEqual(
    run({ type: 'found', version: '0.3.0' }, { type: 'downloaded', version: '0.3.0' }),
    { status: 'ready', version: '0.3.0' }
  );
});

test('dismissing the toast keeps the update reachable', () => {
  const ready = run({ type: 'found', version: '0.3.0' }, { type: 'downloaded', version: '0.3.0' });
  const postponed = updateReducer(ready, { type: 'postponed' });
  assert.deepEqual(postponed, { status: 'postponed', version: '0.3.0' });
  assert.deepEqual(updateReducer(postponed, { type: 'installStarted' }), { status: 'installing', version: '0.3.0' });
});

test('finding the same version again changes nothing, so it is not downloaded twice', () => {
  for (const state of [
    run({ type: 'found', version: '0.3.0' }),
    run({ type: 'found', version: '0.3.0' }, { type: 'downloaded', version: '0.3.0' }),
    run({ type: 'found', version: '0.3.0' }, { type: 'downloaded', version: '0.3.0' }, { type: 'postponed' }),
  ]) {
    assert.equal(updateReducer(state, { type: 'found', version: '0.3.0' }), state);
  }
});

test('a newer version found while one is ready waits for that one to be installed', () => {
  const postponed = run({ type: 'found', version: '0.3.0' }, { type: 'downloaded', version: '0.3.0' }, { type: 'postponed' });
  assert.equal(updateReducer(postponed, { type: 'found', version: '0.3.1' }), postponed);
});

test('a failed check keeps a ready or postponed update', () => {
  const ready = run({ type: 'found', version: '0.3.0' }, { type: 'downloaded', version: '0.3.0' });
  assert.equal(updateReducer(ready, { type: 'checkFailed' }), ready);
  const postponed = updateReducer(ready, { type: 'postponed' });
  assert.equal(updateReducer(postponed, { type: 'checkFailed' }), postponed);
});

test('a failed download is retried at the next check', () => {
  const failed = run({ type: 'found', version: '0.3.0' }, { type: 'downloadFailed', version: '0.3.0' });
  assert.deepEqual(failed, initialUpdateState);
  assert.deepEqual(updateReducer(failed, { type: 'found', version: '0.3.0' }), { status: 'downloading', version: '0.3.0' });
});

test('a failed install stays reachable and can be retried', () => {
  const failed = run(
    { type: 'found', version: '0.3.0' },
    { type: 'downloaded', version: '0.3.0' },
    { type: 'installStarted' },
    { type: 'installFailed' }
  );
  assert.deepEqual(failed, { status: 'failed', version: '0.3.0' });
  assert.equal(updateReducer(failed, { type: 'checkFailed' }), failed);
  assert.deepEqual(updateReducer(failed, { type: 'installStarted' }), { status: 'installing', version: '0.3.0' });
});

test("dismissing the toast or clicking again while installing changes nothing", () => {
  const installing = run({ type: 'found', version: '0.3.0' }, { type: 'downloaded', version: '0.3.0' }, { type: 'installStarted' });
  assert.equal(updateReducer(installing, { type: 'postponed' }), installing);
  assert.equal(updateReducer(installing, { type: 'installStarted' }), installing);
});

test('nothing can be installed before an update is ready', () => {
  assert.equal(updateReducer(initialUpdateState, { type: 'installStarted' }), initialUpdateState);
  const downloading = run({ type: 'found', version: '0.3.0' });
  assert.equal(updateReducer(downloading, { type: 'installStarted' }), downloading);
  assert.equal(updateReducer(downloading, { type: 'postponed' }), downloading);
});

test('the app info button shows a ready, postponed, installing or failed update', () => {
  const ready = run({ type: 'found', version: '0.3.0' }, { type: 'downloaded', version: '0.3.0' });
  assert.equal(pendingUpdate(initialUpdateState), undefined);
  assert.equal(pendingUpdate(run({ type: 'found', version: '0.3.0' })), undefined);
  assert.deepEqual(pendingUpdate(ready), { version: '0.3.0', postponed: false, installing: false });
  assert.deepEqual(pendingUpdate(updateReducer(ready, { type: 'postponed' })), { version: '0.3.0', postponed: true, installing: false });
  const installing = updateReducer(ready, { type: 'installStarted' });
  assert.deepEqual(pendingUpdate(installing), { version: '0.3.0', postponed: false, installing: true });
  assert.deepEqual(pendingUpdate(updateReducer(installing, { type: 'installFailed' })), { version: '0.3.0', postponed: false, installing: false });
});
