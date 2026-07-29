import assert from 'node:assert/strict';
import test from 'node:test';

import { TimeoutError, withTimeout } from '../src/core/timeout.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('timeout rejects even when cleanup callback never resolves', async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      withTimeout(
        new Promise<void>(() => undefined),
        20,
        'turn expired',
        undefined,
        () => new Promise<void>(() => undefined),
      ),
    (error) => error instanceof TimeoutError && error.message === 'turn expired',
  );
  assert.ok(Date.now() - started < 500);
});

test('parent abort is propagated and operation receives an aborted signal', async () => {
  const parent = new AbortController();
  let observed = false;
  const promise = withTimeout(
    async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          observed = true;
          resolve();
        });
      });
    },
    1000,
    undefined,
    parent.signal,
  );
  parent.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  await sleep(0);
  assert.equal(observed, true);
});
