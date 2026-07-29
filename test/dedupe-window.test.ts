import assert from 'node:assert/strict';
import test from 'node:test';

import { DedupeWindow } from '../src/core/dedupe-window.js';

test('dedupe window rejects duplicate WS/HTTP delivery until expiry', () => {
  const window = new DedupeWindow(100, 10);
  assert.equal(window.accept('event-1', 1000), true);
  assert.equal(window.accept('event-1', 1050), false);
  assert.equal(window.accept('event-1', 1100), true);
});

test('dedupe window remains bounded', () => {
  const window = new DedupeWindow(10_000, 2);
  window.accept('a', 0);
  window.accept('b', 0);
  window.accept('c', 0);
  assert.ok(window.size <= 2);
});

test('failed handlers can release a provisional dedupe key for retry', () => {
  const window = new DedupeWindow(10_000, 10);
  assert.equal(window.accept('card-1', 1000), true);
  assert.equal(window.accept('card-1', 1001), false);
  assert.equal(window.forget('card-1'), true);
  assert.equal(window.accept('card-1', 1002), true);
});
