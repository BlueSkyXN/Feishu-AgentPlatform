import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyedQueue, QueueFullError } from '../src/core/keyed-queue.js';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

test('tasks with the same key run serially in submission order', async () => {
  const queue = new KeyedQueue(4);
  const events: string[] = [];

  const first = queue.enqueue('chat-a', async () => {
    events.push('first:start');
    await sleep(20);
    events.push('first:end');
  });
  const second = queue.enqueue('chat-a', async () => {
    events.push('second:start');
    events.push('second:end');
  });

  await Promise.all([first, second]);
  assert.deepEqual(events, [
    'first:start',
    'first:end',
    'second:start',
    'second:end',
  ]);
  assert.equal(queue.pending('chat-a'), 0);
});

test('different keys can run concurrently', async () => {
  const queue = new KeyedQueue(4);
  let running = 0;
  let maxRunning = 0;

  const task = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await sleep(20);
    running -= 1;
  };

  await Promise.all([
    queue.enqueue('chat-a', task),
    queue.enqueue('chat-b', task),
  ]);
  assert.equal(maxRunning, 2);
});

test('one failed task does not poison the next task for the same key', async () => {
  const queue = new KeyedQueue(4);
  await assert.rejects(
    queue.enqueue('chat-a', async () => {
      throw new Error('expected failure');
    }),
  );
  const result = await queue.enqueue('chat-a', async () => 'ok');
  assert.equal(result, 'ok');
});

test('pending-turn limit rejects excess work immediately', async () => {
  const queue = new KeyedQueue(1);
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue('chat-a', async () => blocker);

  assert.throws(
    () => queue.enqueue('chat-a', async () => undefined),
    QueueFullError,
  );
  release();
  await first;
});

test('onIdle waits for all active keys and queued work', async () => {
  const queue = new KeyedQueue(4);
  const events: string[] = [];
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });

  void queue.enqueue('chat-a', async () => {
    events.push('a:start');
    await blocker;
    events.push('a:end');
  });
  void queue.enqueue('chat-a', async () => {
    events.push('a:second');
  });
  void queue.enqueue('chat-b', async () => {
    events.push('b');
  });

  let idle = false;
  const idlePromise = queue.onIdle().then(() => {
    idle = true;
  });
  await sleep(10);
  assert.equal(idle, false);

  release();
  await idlePromise;
  assert.equal(queue.activeKeys(), 0);
  assert.deepEqual(events, ['a:start', 'b', 'a:end', 'a:second']);
});
