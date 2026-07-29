import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bridgeTextDeltas,
  type BridgeEvent,
  type DeltaBridgeSession,
} from '../src/pi/text-delta-bridge.js';

interface FakeSessionControls {
  session: DeltaBridgeSession;
  emit(event: BridgeEvent): void;
  resolvePrompt(): void;
  rejectPrompt(error: unknown): void;
  getAbortCalls(): number;
  getUnsubscribeCalls(): number;
}

function createFakeSession(): FakeSessionControls {
  let listener: ((event: BridgeEvent) => void) | undefined;
  let resolvePrompt!: () => void;
  let rejectPrompt!: (error: unknown) => void;
  let abortCalls = 0;
  let unsubscribeCalls = 0;
  const promptPromise = new Promise<void>((resolve, reject) => {
    resolvePrompt = resolve;
    rejectPrompt = reject;
  });

  return {
    session: {
      subscribe(next) {
        listener = next;
        return () => {
          unsubscribeCalls += 1;
          listener = undefined;
        };
      },
      prompt: () => promptPromise,
      abort: async () => {
        abortCalls += 1;
      },
    },
    emit(event) {
      listener?.(event);
    },
    resolvePrompt,
    rejectPrompt,
    getAbortCalls: () => abortCalls,
    getUnsubscribeCalls: () => unsubscribeCalls,
  };
}

test('text deltas are appended sequentially in event order', async () => {
  const fake = createFakeSession();
  const output: string[] = [];
  let concurrentAppends = 0;
  let maxConcurrentAppends = 0;

  const run = bridgeTextDeltas(fake.session, {
    append: async (chunk) => {
      concurrentAppends += 1;
      maxConcurrentAppends = Math.max(maxConcurrentAppends, concurrentAppends);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      output.push(chunk);
      concurrentAppends -= 1;
    },
  });

  fake.emit({ type: 'text_delta', delta: 'A' });
  fake.emit({ type: 'text_delta', delta: 'B' });
  fake.emit({ type: 'text_delta', delta: 'C' });
  fake.resolvePrompt();

  await run;
  assert.deepEqual(output, ['A', 'B', 'C']);
  assert.equal(maxConcurrentAppends, 1);
  assert.equal(fake.getAbortCalls(), 0);
  assert.equal(fake.getUnsubscribeCalls(), 1);
});

test('stream append failure aborts the Pi run once and rejects', async () => {
  const fake = createFakeSession();
  const expected = new Error('stream append failed');
  const run = bridgeTextDeltas(fake.session, {
    append: async (chunk) => {
      if (chunk === 'bad') throw expected;
    },
  });

  fake.emit({ type: 'text_delta', delta: 'bad' });
  fake.emit({ type: 'text_delta', delta: 'ignored' });
  fake.resolvePrompt();

  await assert.rejects(run, (error) => error === expected);
  // requestAbort starts an async operation without blocking the append chain.
  await Promise.resolve();
  assert.equal(fake.getAbortCalls(), 1);
  assert.equal(fake.getUnsubscribeCalls(), 1);
});

test('prompt failure is propagated after pending deltas are drained', async () => {
  const fake = createFakeSession();
  const output: string[] = [];
  const expected = new Error('model failed');
  const run = bridgeTextDeltas(fake.session, {
    append: async (chunk) => {
      await Promise.resolve();
      output.push(chunk);
    },
  });

  fake.emit({ type: 'text_delta', delta: 'partial' });
  fake.rejectPrompt(expected);

  await assert.rejects(run, (error) => error === expected);
  assert.deepEqual(output, ['partial']);
  assert.equal(fake.getAbortCalls(), 0);
  assert.equal(fake.getUnsubscribeCalls(), 1);
});

test('tool lifecycle hooks are forwarded', async () => {
  const fake = createFakeSession();
  const events: string[] = [];
  const run = bridgeTextDeltas(
    fake.session,
    { append: async () => undefined },
    {
      onToolStart: (name) => events.push(`start:${name}`),
      onToolEnd: (name, isError) => events.push(`end:${name}:${isError}`),
    },
  );

  fake.emit({ type: 'tool_start', toolName: 'read' });
  fake.emit({ type: 'tool_end', toolName: 'read', isError: false });
  fake.resolvePrompt();

  await run;
  assert.deepEqual(events, ['start:read', 'end:read:false']);
});
