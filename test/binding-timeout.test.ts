import assert from 'node:assert/strict';
import test from 'node:test';

import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';

import type { LoadedBindingConfig } from '../src/config/types.js';
import { Logger } from '../src/core/logger.js';
import { MetricsRegistry } from '../src/core/metrics.js';
import { Semaphore } from '../src/core/semaphore.js';
import type {
  ManagedSession,
  ManagedSessionFactoryInput,
} from '../src/pi/session-registry.js';
import { AppAgentBindingRuntime } from '../src/runtime/binding-runtime.js';
import { TurnContextRef } from '../src/tools/turn-context.js';

test('turn deadline aborts a hanging recent-history request before session startup', async () => {
  let requestStarted = false;
  let requestSignal: AbortSignal | undefined;
  let sessionStarts = 0;
  const channel = hangingChannel((signal) => {
    requestStarted = true;
    requestSignal = signal;
  });
  const runtime = makeRuntime(
    {
      ...runtimeConfig(),
      conversation: {
        ...runtimeConfig().conversation,
        recentHistory: {
          enabled: true,
          maxMessages: 20,
          maxCharacters: 20_000,
          currentThreadOnly: true,
        },
      },
    },
    channel,
    async (input) => {
      sessionStarts += 1;
      return managed(input);
    },
  );
  await runtime.prepare();
  runtime.start();

  runtime.enqueue(message([]), 'websocket');
  await waitFor(() => requestStarted);
  await waitFor(() => requestSignal?.aborted === true);
  await waitFor(() => runtime.snapshot().activeConversationQueues === 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.ok(requestSignal);
  assert.equal(requestSignal.aborted, true);
  assert.equal(sessionStarts, 0);
  assert.equal(runtime.snapshot().activeTurns, 0);
  await runtime.stop();
});

test('turn deadline aborts a hanging attachment download before prompting', async () => {
  let downloadStarted = false;
  let downloadSignal: AbortSignal | undefined;
  let prompts = 0;
  const channel = hangingChannel((signal) => {
    downloadStarted = true;
    downloadSignal = signal;
  });
  const runtime = makeRuntime(
    runtimeConfig(),
    channel,
    async (input) => managed(input, {
      onPrompt: () => { prompts += 1; },
    }),
  );
  await runtime.prepare();
  runtime.start();

  runtime.enqueue(message([
    { fileKey: 'file_key', fileName: 'hanging.txt', type: 'file' },
  ]), 'websocket');
  await waitFor(() => downloadStarted);
  await waitFor(() => downloadSignal?.aborted === true);
  await waitFor(() => runtime.snapshot().activeConversationQueues === 0);

  assert.ok(downloadSignal);
  assert.equal(downloadSignal.aborted, true);
  assert.equal(prompts, 0);
  assert.equal(runtime.snapshot().activeTurns, 0);
  await runtime.stop();
});

test('stop aborts a hanging attachment and remains bounded when disposal hangs', async () => {
  let downloadStarted = false;
  let downloadSignal: AbortSignal | undefined;
  let disposeCalled = false;
  const channel = hangingChannel((signal) => {
    downloadStarted = true;
    downloadSignal = signal;
  });
  const runtime = makeRuntime(
    runtimeConfig(),
    channel,
    async (input) => managed(input, {
      onDispose: () => {
        disposeCalled = true;
        return new Promise<void>(() => undefined);
      },
    }),
  );
  await runtime.prepare();
  runtime.start();
  runtime.enqueue(message([
    { fileKey: 'file_key', fileName: 'hanging.txt', type: 'file' },
  ]), 'websocket');
  await waitFor(() => downloadStarted);

  const startedAt = Date.now();
  await bounded(runtime.stop(), 500, 'Binding stop did not return within 500 ms.');
  const elapsedMs = Date.now() - startedAt;

  assert.ok(downloadSignal);
  assert.equal(downloadSignal.aborted, true);
  assert.equal(disposeCalled, true);
  assert.ok(elapsedMs < 500, `stop took ${elapsedMs} ms`);
  assert.equal(runtime.snapshot().activeTurns, 0);
  assert.equal(runtime.snapshot().activeConversationQueues, 0);
});

function makeRuntime(
  config: LoadedBindingConfig,
  channel: LarkChannel,
  sessionFactory: (input: ManagedSessionFactoryInput) => Promise<ManagedSession>,
): AppAgentBindingRuntime {
  return new AppAgentBindingRuntime(
    config,
    channel,
    undefined,
    new Logger({ service: 'binding-timeout-test' }),
    new MetricsRegistry(),
    new Semaphore(4),
    {} as never,
    undefined,
    { sessionFactory },
  );
}

function runtimeConfig(): LoadedBindingConfig {
  return {
    id: 'primary-general',
    appKey: 'primary',
    agentId: 'general',
    configFile: 'test.yaml',
    appId: 'cli_test',
    appSecret: 'test-secret',
    systemPrompt: 'test prompt',
    feishu: {
      domain: 'feishu',
      events: { transport: 'websocket', path: '/events' },
      callbacks: { transport: 'disabled', path: '/callbacks' },
      requireMention: false,
      dmMode: 'open',
      dmAllowlist: [],
      groupAllowlist: [],
      respondToMentionAll: false,
      attachments: {
        enabled: true,
        maxItems: 2,
        maxBytesPerItem: 1_024,
        maxTotalBytes: 2_048,
        passImagesToModel: true,
        persistFiles: true,
      },
    },
    conversation: {
      scope: 'thread',
      maxPendingTurns: 4,
      idleTtlSeconds: 60,
      turnTimeoutSeconds: 0.03,
      toolTimeoutSeconds: 1,
      queuedTurnTtlSeconds: 1,
      maxResidentSessions: 4,
      maxConcurrentTurns: 2,
      recentHistory: {
        enabled: false,
        maxMessages: 20,
        maxCharacters: 20_000,
        currentThreadOnly: true,
      },
    },
    identity: { resolveUserProfile: false, profileCacheTtlSeconds: 60 },
    runtime: { isolation: 'in-process', workerShutdownGraceSeconds: 1 },
    sandbox: {
      mode: 'read-only',
      maxReadBytes: 4_096,
      maxWriteBytes: 4_096,
      maxTotalBytes: 8_192,
      maxFiles: 32,
    },
    agent: {
      systemPromptFile: 'prompts/general.md',
      provider: 'host-broker',
      model: 'test-model',
      modelApi: 'openai-responses',
      upstreamPath: '/openai',
      modelOptions: {
        reasoning: false,
        input: ['text'],
        contextWindow: 8_192,
        maxTokens: 1_024,
      },
      thinkingLevel: 'medium',
      feishuTools: [],
      workspaceTools: [],
      toolGrants: [],
      defaultToolIdentity: 'app',
      allowCrossChatRead: false,
      openApiReadAllowlist: [],
      skillPaths: [],
      workspaceRoot: '/tmp/binding-timeout/workspaces',
      sessionRoot: '/tmp/binding-timeout/sessions',
      larkCli: {
        enabled: false,
        executable: 'lark-cli',
        expectedVersion: '1.0.79',
        root: '/tmp/binding-timeout/lark-cli',
        timeoutMs: 1_000,
        operations: [],
        skills: [],
      },
    },
    oauth: {
      enabled: false,
      publicBaseUrlEnv: 'TEST_PUBLIC_BASE_URL',
      redirectPath: '/oauth/callback',
      scopes: [],
      tokenRoot: '/tmp/binding-timeout/oauth/tokens',
      stateRoot: '/tmp/binding-timeout/oauth/states',
      stateTtlSeconds: 60,
      encryptionKeyEnv: 'TEST_OAUTH_KEY',
    },
    route: {
      default: true,
      priority: 0,
      commandPrefixes: [],
      chatAllowlist: [],
      userAllowlist: [],
      threadAllowlist: [],
    },
  };
}

function hangingChannel(onDownload: (signal?: AbortSignal) => void): LarkChannel {
  const hang = (signal?: AbortSignal): Promise<never> => {
    onDownload(signal);
    return new Promise<never>(() => undefined);
  };
  return {
    rawClient: {
      request: async (request: { signal?: AbortSignal }) => await hang(request.signal),
      im: {
        v1: {
          file: { get: async () => await hang() },
          image: { get: async () => await hang() },
        },
      },
    },
    downloadResource: async () => await hang(),
    getChatInfo: async () => ({}),
    send: async () => ({ messageId: 'error-reply' }),
    stream: async () => {
      throw new Error('prompt stream must not start');
    },
  } as unknown as LarkChannel;
}

function managed(
  input: ManagedSessionFactoryInput,
  options: {
    onPrompt?: () => void;
    onDispose?: () => Promise<void> | void;
  } = {},
): ManagedSession {
  let available = true;
  const now = Date.now();
  return {
    appKey: 'primary',
    agentId: 'general',
    bindingId: 'primary-general',
    storageId: input.storageId,
    workspace: `/tmp/binding-timeout/workspaces/${input.storageId}`,
    sessionDir: `/tmp/binding-timeout/sessions/${input.storageId}`,
    conversationKey: input.conversationKey,
    chatId: input.chatId,
    turn: new TurnContextRef(),
    workspaceGuard: {
      writeHostFile: async (path: string, content: Uint8Array) => ({
        path,
        bytes: content.byteLength,
      }),
      dispose: async () => undefined,
    } as never,
    createdAt: now,
    lastUsedAt: now,
    handle: {
      subscribe: () => () => undefined,
      prompt: async () => { options.onPrompt?.(); },
      abort: async () => undefined,
      snapshot: () => ({
        sessionId: input.storageId,
        model: 'test-model',
        messageCount: 0,
        streaming: false,
        supportsImages: false,
        available,
        isolation: 'in-process',
      }),
      dispose: async () => {
        available = false;
        await options.onDispose?.();
      },
    },
  };
}

function message(resources: NormalizedMessage['resources']): NormalizedMessage {
  return {
    messageId: `om_${Math.random().toString(36).slice(2)}`,
    chatId: 'oc_test',
    chatType: 'group',
    content: '分析附件',
    senderId: 'ou_test',
    senderName: 'Test User',
    createTime: Date.now(),
    rawContentType: resources.length > 0 ? 'file' : 'text',
    resources,
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
