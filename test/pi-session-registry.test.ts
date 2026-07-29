import assert from 'node:assert/strict';
import test from 'node:test';

import type { LoadedBindingConfig } from '../src/config/types.js';
import { Logger } from '../src/core/logger.js';
import {
  PiSessionRegistry,
  type ManagedSession,
  type ManagedSessionFactoryInput,
} from '../src/pi/session-registry.js';
import {
  ConcurrentWorkerStartLimiter,
  GlobalResidentRuntimeCoordinator,
} from '../src/pi/runtime-capacity.js';
import { TurnContextRef } from '../src/tools/turn-context.js';

test('same-key acquires share one startup while different cold sessions start in parallel', async () => {
  const starts: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  let disposeCount = 0;
  const registry = makeRegistry(async (input) => {
    starts.push(input.conversationKey);
    const gate = deferred<void>();
    gates.set(input.conversationKey, gate);
    await gate.promise;
    return managed(input, () => {
      disposeCount += 1;
    });
  });

  const firstA = registry.acquireForTurn('conversation-a', 'chat-a');
  const secondA = registry.acquireForTurn('conversation-a', 'chat-a');
  const firstB = registry.acquireForTurn('conversation-b', 'chat-b');

  await waitFor(() => starts.length === 2);
  assert.equal(starts.filter((key) => key === 'conversation-a').length, 1);
  assert.equal(starts.filter((key) => key === 'conversation-b').length, 1);
  gates.get('conversation-a')?.resolve();
  gates.get('conversation-b')?.resolve();

  const [managedA, sharedA, managedB] = await Promise.all([
    firstA,
    secondA,
    firstB,
  ]);
  assert.equal(managedA, sharedA);
  assert.notEqual(managedA, managedB);
  registry.endTurn(managedA);
  registry.endTurn(sharedA);
  registry.endTurn(managedB);
  await registry.disposeAll();
  assert.equal(disposeCount, 2);
});

test('an injected worker-start limiter bounds initialization without merging keys', async () => {
  const limiter = new ConcurrentWorkerStartLimiter(1);
  const starts: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const registry = makeRegistry(
    async (input) => {
      starts.push(input.conversationKey);
      const gate = deferred<void>();
      gates.set(input.conversationKey, gate);
      await gate.promise;
      return managed(input);
    },
    { workerStartLimiter: limiter },
  );

  const first = registry.acquireForTurn('conversation-a', 'chat-a');
  const second = registry.acquireForTurn('conversation-b', 'chat-b');
  await waitFor(() => starts.length === 1);
  assert.equal(limiter.inUse, 1);
  assert.equal(limiter.waiting, 1);

  gates.get(starts[0] as string)?.resolve();
  const firstManaged = await first;
  await waitFor(() => starts.length === 2);
  gates.get(starts[1] as string)?.resolve();
  const secondManaged = await second;
  registry.endTurn(firstManaged);
  registry.endTurn(secondManaged);
  await registry.disposeAll();
  assert.equal(limiter.inUse, 0);
  assert.equal(limiter.waiting, 0);
});

test('a shared resident coordinator gates registries and releases capacity on eviction', async () => {
  const residents = new GlobalResidentRuntimeCoordinator(1);
  const starts: string[] = [];
  const registry = makeRegistry(
    async (input) => {
      starts.push(input.conversationKey);
      return managed(input);
    },
    { residentCoordinator: residents },
  );

  const firstManaged = await registry.acquireForTurn(
    'conversation-a',
    'chat-a',
  );
  assert.equal(residents.residentCount, 1);
  assert.equal(residents.list()[0]?.bindingId, 'binding');

  const second = registry.acquireForTurn('conversation-b', 'chat-b');
  await waitFor(() => residents.waitingCount === 1);
  assert.deepEqual(starts, ['conversation-a']);

  assert.equal(
    await registry.evictRuntime('conversation-a', firstManaged),
    true,
  );
  const secondManaged = await second;
  assert.deepEqual(starts, ['conversation-a', 'conversation-b']);
  assert.equal(residents.residentCount, 1);
  assert.equal(
    await registry.evictRuntime('conversation-b', secondManaged),
    true,
  );
  assert.equal(residents.residentCount, 0);
});

test('the Host-wide resident budget evicts the least-recently-used idle runtime across bindings', async () => {
  const residents = new GlobalResidentRuntimeCoordinator(1);
  let firstDisposed = 0;
  const first = makeRegistry(
    async (input) => managed(input, () => { firstDisposed += 1; }),
    { residentCoordinator: residents },
    { bindingId: 'binding-a', agentId: 'agent-a' },
  );
  const second = makeRegistry(
    async (input) => managed(input),
    { residentCoordinator: residents },
    { bindingId: 'binding-b', agentId: 'agent-b' },
  );

  const firstManaged = await first.acquireForTurn('conversation-a', 'chat-a');
  first.endTurn(firstManaged);
  const secondManaged = await second.acquireForTurn('conversation-b', 'chat-b');

  assert.equal(firstDisposed, 1);
  assert.equal(first.residentCount, 0);
  assert.equal(second.residentCount, 1);
  assert.equal(residents.list()[0]?.bindingId, 'binding-b');
  second.endTurn(secondManaged);
  await second.disposeAll();
});

test('turn abort validates the active turn and evicts the runtime capability owner', async () => {
  let aborted = 0;
  let disposed = 0;
  const registry = makeRegistry(async (input) => managed(
    input,
    () => { disposed += 1; },
    {
      streaming: true,
      onAbort: () => { aborted += 1; },
    },
  ));
  const active = await registry.acquireForTurn('conversation-a', 'chat-a');
  active.turn.set({} as never);

  assert.equal(await registry.abort('conversation-a'), true);
  assert.equal(aborted, 1);
  assert.equal(disposed, 1);
  assert.equal(registry.residentCount, 0);
  registry.endTurn(active);

  const idle = await registry.acquireForTurn('conversation-b', 'chat-b');
  assert.equal(await registry.abort('conversation-b'), false);
  registry.endTurn(idle);
  await registry.disposeAll();
});

function makeRegistry(
  sessionFactory: (
    input: ManagedSessionFactoryInput,
  ) => Promise<ManagedSession>,
  capacity: {
    workerStartLimiter?: ConcurrentWorkerStartLimiter;
    residentCoordinator?: GlobalResidentRuntimeCoordinator;
  } = {},
  identity: { appKey?: string; agentId?: string; bindingId?: string } = {},
): PiSessionRegistry {
  const config = {
    id: identity.bindingId ?? 'binding',
    appKey: identity.appKey ?? 'app',
    agentId: identity.agentId ?? 'agent',
    conversation: {
      maxResidentSessions: 8,
      idleTtlSeconds: 1_800,
    },
    agent: {
      workspaceRoot: '/tmp/workspaces',
      sessionRoot: '/tmp/sessions',
    },
  } as LoadedBindingConfig;
  return new PiSessionRegistry(
    config,
    {} as never,
    undefined,
    {} as never,
    new Logger({ service: 'pi-session-registry-test' }),
    {} as never,
    undefined,
    { ...capacity, sessionFactory },
  );
}

function managed(
  input: ManagedSessionFactoryInput,
  onDispose: () => void = () => undefined,
  options: { streaming?: boolean; onAbort?: () => void } = {},
): ManagedSession {
  let available = true;
  let streaming = options.streaming ?? false;
  const now = Date.now();
  return {
    appKey: 'app',
    agentId: 'agent',
    bindingId: 'binding',
    storageId: input.storageId,
    workspace: `/tmp/workspaces/${input.storageId}`,
    sessionDir: `/tmp/sessions/${input.storageId}`,
    conversationKey: input.conversationKey,
    chatId: input.chatId,
    turn: new TurnContextRef(),
    workspaceGuard: {
      dispose: async () => undefined,
    } as never,
    createdAt: now,
    lastUsedAt: now,
    handle: {
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => {
        options.onAbort?.();
        streaming = false;
      },
      snapshot: () => ({
        sessionId: input.storageId,
        model: 'test-model',
        messageCount: 0,
        streaming,
        supportsImages: false,
        available,
        isolation: 'in-process',
      }),
      dispose: async () => {
        if (!available) return;
        available = false;
        onDispose();
      },
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
