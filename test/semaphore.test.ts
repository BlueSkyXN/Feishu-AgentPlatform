import assert from 'node:assert/strict';
import test from 'node:test';

import { Semaphore } from '../src/core/semaphore.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('semaphore bounds concurrent operations and transfers slots FIFO', async () => {
  const semaphore = new Semaphore(2);
  let running = 0;
  let maxRunning = 0;
  const order: number[] = [];
  await Promise.all(
    [0, 1, 2, 3].map((id) =>
      semaphore.run(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        order.push(id);
        await sleep(10);
        running -= 1;
      }),
    ),
  );
  assert.equal(maxRunning, 2);
  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.equal(semaphore.inUse, 0);
  assert.equal(semaphore.waiting, 0);
});

test('aborted semaphore waiter is removed without leaking capacity', async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire();
  const controller = new AbortController();
  const pending = semaphore.acquire(controller.signal);
  assert.equal(semaphore.waiting, 1);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(semaphore.waiting, 0);
  release();
  const nextRelease = await semaphore.acquire();
  nextRelease();
  assert.equal(semaphore.inUse, 0);
});
