import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { LarkChannel } from '@larksuiteoapi/node-sdk';

import type {
  LoadedAgentDefinition,
  LoadedAppAgentBinding,
  LoadedFeishuApp,
  HostConfig,
  PlatformConfig,
} from '../src/config/types.js';
import { resolveBindingConfig } from '../src/config/types.js';
import { buildConversationKey, conversationStorageId } from '../src/core/conversation.js';
import { Logger } from '../src/core/logger.js';
import { MetricsRegistry } from '../src/core/metrics.js';
import { Semaphore } from '../src/core/semaphore.js';
import { PlatformHost } from '../src/app/host.js';
import { FeishuAppRuntime } from '../src/feishu/app-runtime.js';

test('one Feishu App opens one shared Channel for two Agent bindings', async () => {
  const app = loadedApp('primary', 'cli_primary', 'secret-primary');
  const general = loadedAgent('general');
  const office = loadedAgent('office');
  const bindings = [
    loadedBinding('primary-general', app, general, true),
    loadedBinding('primary-office', app, office, false, '/office'),
  ];
  let channelCreations = 0;
  let connects = 0;
  let disconnects = 0;
  const channel = fakeChannel(
    () => { connects += 1; },
    () => { disconnects += 1; },
  );
  const runtime = new FeishuAppRuntime(
    app,
    bindings,
    new Logger({ service: 'app-runtime-test' }),
    new MetricsRegistry(),
    new Semaphore(16),
    {} as never,
    {
      channelFactory: (_transport, receivedApp, receivedBindings) => {
        channelCreations += 1;
        assert.equal(receivedApp, app);
        assert.equal(receivedBindings, bindings);
        return channel;
      },
    },
  );

  assert.equal(channelCreations, 1);
  assert.deepEqual(
    runtime.listBindings().map((binding) => binding.config.agentId).sort(),
    ['general', 'office'],
  );
  await runtime.start();
  assert.equal(connects, 1);
  assert.equal(runtime.snapshot().bindingCount, 2);
  await runtime.stop();
  assert.equal(disconnects, 1);
});

test('HTTP ingress keeps socket headers authoritative and rejects prototype keys', async () => {
  const app = {
    ...loadedApp('http-app', 'cli_http', 'secret-http'),
    events: { transport: 'http' as const, path: '/public/feishu/http-app/events' },
  };
  const agent = loadedAgent('general');
  const received: Array<Record<string, unknown>> = [];
  const channel = {
    ...fakeChannel(() => undefined, () => undefined),
    dispatcher: {
      invoke: async (value: Record<string, unknown>) => {
        received.push(value);
        return { accepted: true };
      },
    },
  } as unknown as LarkChannel;
  const runtime = new FeishuAppRuntime(
    app,
    [loadedBinding('http-general', app, agent, true)],
    new Logger({ service: 'app-runtime-http-test' }),
    new MetricsRegistry(),
    new Semaphore(16),
    {} as never,
    { channelFactory: () => channel },
  );
  try {
    await runtime.start();
    assert.deepEqual(
      await runtime.invokeHttp('events', { 'X-Lark-Signature': 'trusted' }, { schema: '2.0' }),
      { accepted: true },
    );
    assert.equal(received.length, 1);
    assert.deepEqual(received[0]?.headers, { 'x-lark-signature': 'trusted' });
    assert.equal(Object.getPrototypeOf(received[0]), null);
    assert.equal(Object.keys(received[0] ?? {}).includes('headers'), false);

    await assert.rejects(
      () => runtime.invokeHttp('events', {}, { headers: { forged: 'yes' } }),
      /reserved property "headers"/,
    );
    const polluted = JSON.parse('{"__proto__":{"forged":true},"schema":"2.0"}') as unknown;
    await assert.rejects(
      () => runtime.invokeHttp('events', {}, polluted),
      /reserved property "__proto__"/,
    );
    assert.equal(received.length, 1);
  } finally {
    await runtime.stop();
  }
});

test('one Agent definition reused by two Apps keeps credentials and storage namespaces isolated', () => {
  const agent = loadedAgent('office');
  const primary = loadedApp('primary', 'cli_primary', 'secret-primary');
  const secondary = loadedApp('secondary', 'cli_secondary', 'secret-secondary');
  const primaryConfig = resolveBindingConfig(
    loadedBinding('primary-office', primary, agent, true),
  );
  const secondaryConfig = resolveBindingConfig(
    loadedBinding('secondary-office', secondary, agent, true),
  );

  assert.equal(primaryConfig.agentId, secondaryConfig.agentId);
  assert.notEqual(primaryConfig.appId, secondaryConfig.appId);
  assert.notEqual(primaryConfig.appSecret, secondaryConfig.appSecret);
  const primaryKey = buildConversationKey(
    'primary',
    'office',
    'tenant',
    { chatId: 'chat' },
    'thread',
  );
  const secondaryKey = buildConversationKey(
    'secondary',
    'office',
    'tenant',
    { chatId: 'chat' },
    'thread',
  );
  const primaryStorage = conversationStorageId(primaryKey);
  const secondaryStorage = conversationStorageId(secondaryKey);
  assert.notEqual(primaryStorage, secondaryStorage);
  assert.notEqual(
    join(primaryConfig.agent.workspaceRoot, primaryConfig.appKey, primaryConfig.agentId, primaryStorage),
    join(secondaryConfig.agent.workspaceRoot, secondaryConfig.appKey, secondaryConfig.agentId, secondaryStorage),
  );
  assert.notEqual(
    join(primaryConfig.agent.sessionRoot, primaryConfig.appKey, primaryConfig.agentId, primaryStorage),
    join(secondaryConfig.agent.sessionRoot, secondaryConfig.appKey, secondaryConfig.agentId, secondaryStorage),
  );
});

test('published configuration restarts only affected App runtimes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-host-hot-reload-'));
  const primary = loadedApp('primary', 'cli_primary', 'secret-primary');
  const secondary = loadedApp('secondary', 'cli_secondary', 'secret-secondary');
  const general = loadedAgent('general');
  const office = loadedAgent('office');
  const initial = platform(
    [primary, secondary],
    [general, office],
    [
      loadedBinding('primary-general', primary, general, true),
      loadedBinding('secondary-office', secondary, office, true),
    ],
  );
  const counters = new Map<string, { created: number; connected: number; disconnected: number }>();
  const host = new PlatformHost(hostConfig(root), {
    channelFactory: (_transport, app) => {
      const counter = counters.get(app.id) ?? { created: 0, connected: 0, disconnected: 0 };
      counter.created += 1;
      counters.set(app.id, counter);
      return fakeChannel(
        () => { counter.connected += 1; },
        () => { counter.disconnected += 1; },
      );
    },
  });
  try {
    await host.start(initial, 1);
    assert.equal(host.snapshot().ready, true);

    const changedGeneral = { ...general, systemPrompt: 'changed prompt' };
    await host.applyPlatformConfig(platform(
      [primary, secondary],
      [changedGeneral, office],
      [
        loadedBinding('primary-general', primary, changedGeneral, true),
        loadedBinding('secondary-office', secondary, office, true),
      ],
    ), 2);

    assert.deepEqual(counters.get('primary'), {
      created: 2,
      connected: 2,
      disconnected: 1,
    });
    assert.deepEqual(counters.get('secondary'), {
      created: 1,
      connected: 1,
      disconnected: 0,
    });
    assert.equal(host.snapshot().activeRevisionId, 2);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('one failed App remains isolated from another running App', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-host-failed-app-'));
  const healthy = loadedApp('healthy', 'cli_healthy', 'secret-healthy');
  const broken = loadedApp('broken', 'cli_broken', 'secret-broken');
  const agent = loadedAgent('general');
  const host = new PlatformHost(hostConfig(root), {
    channelFactory: (_transport, app) => fakeChannel(
      () => {
        if (app.id === 'broken') throw new Error('simulated channel failure');
      },
      () => undefined,
    ),
  });
  try {
    await host.start(platform(
      [healthy, broken],
      [agent],
      [
        loadedBinding('healthy-general', healthy, agent, true),
        loadedBinding('broken-general', broken, agent, true),
      ],
    ), 1);
    const snapshot = host.snapshot();
    assert.equal(snapshot.activeApps, 1);
    assert.equal(snapshot.failedApps, 1);
    assert.equal(snapshot.ready, false);
    assert.equal(host.getApp('healthy')?.snapshot().ready, true);
    assert.equal(host.getApp('broken'), undefined);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('two Hosts sharing the platform database activate only one runtime per App', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-host-sqlite-lease-'));
  const app = loadedApp('primary', 'cli_primary', 'secret-primary');
  const agent = loadedAgent('general');
  const configured = platform(
    [app],
    [agent],
    [loadedBinding('primary-general', app, agent, true)],
  );
  let connections = 0;
  const createHost = (): PlatformHost => new PlatformHost(hostConfig(root), {
    channelFactory: () => fakeChannel(
      () => { connections += 1; },
      () => undefined,
    ),
  });
  const first = createHost();
  const second = createHost();
  try {
    await Promise.all([first.start(configured, 1), second.start(configured, 1)]);
    const snapshots = [first.snapshot(), second.snapshot()];
    assert.equal(snapshots.reduce((sum, item) => sum + item.activeApps, 0), 1);
    assert.equal(snapshots.reduce((sum, item) => sum + item.waitingForLease, 0), 1);
    assert.equal(connections, 1);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('hot configuration apply reports a changed App runtime startup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-host-failed-hot-apply-'));
  const healthy = loadedApp('healthy', 'cli_healthy', 'secret-healthy');
  const broken = loadedApp('broken', 'cli_broken', 'secret-broken');
  const agent = loadedAgent('general');
  const host = new PlatformHost(hostConfig(root), {
    channelFactory: (_transport, app) => fakeChannel(
      () => {
        if (app.id === 'broken') throw new Error('simulated channel failure');
      },
      () => undefined,
    ),
  });
  try {
    await host.start(platform(
      [healthy],
      [agent],
      [loadedBinding('healthy-general', healthy, agent, true)],
    ), 1);
    await assert.rejects(
      () => host.applyPlatformConfig(platform(
        [healthy, broken],
        [agent],
        [
          loadedBinding('healthy-general', healthy, agent, true),
          loadedBinding('broken-general', broken, agent, true),
        ],
      ), 2),
      /could not start changed App runtimes: broken/,
    );
    const snapshot = host.snapshot();
    assert.equal(snapshot.activeRevisionId, 2);
    assert.equal(snapshot.activeApps, 1);
    assert.equal(snapshot.failedApps, 1);
    assert.equal(host.getApp('healthy')?.snapshot().ready, true);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('configuration apply, maintenance and later apply are serialized as one Host lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-host-serialized-apply-'));
  const agent = loadedAgent('general');
  const appV1 = loadedApp('primary', 'cli_primary', 'secret-v1');
  const appV2 = loadedApp('primary', 'cli_primary', 'secret-v2');
  const appV3 = loadedApp('primary', 'cli_primary', 'secret-v3');
  const configuration = (app: LoadedFeishuApp): PlatformConfig => platform(
    [app],
    [agent],
    [loadedBinding('primary-general', app, agent, true)],
  );
  const createdSecrets: string[] = [];
  let initialDisconnectStarted!: () => void;
  const disconnectStarted = new Promise<void>((resolve) => {
    initialDisconnectStarted = resolve;
  });
  let releaseInitialDisconnect!: () => void;
  const disconnectGate = new Promise<void>((resolve) => {
    releaseInitialDisconnect = resolve;
  });
  let blockInitialDisconnect = true;
  const host = new PlatformHost(hostConfig(root), {
    channelFactory: (_transport, app) => {
      createdSecrets.push(app.appSecret);
      return {
        ...fakeChannel(() => undefined, () => undefined),
        disconnect: async () => {
          if (app.appSecret === 'secret-v1' && blockInitialDisconnect) {
            blockInitialDisconnect = false;
            initialDisconnectStarted();
            await disconnectGate;
          }
        },
      } as unknown as LarkChannel;
    },
  });
  try {
    await host.start(configuration(appV1), 1);
    const applyV2 = host.applyPlatformConfig(configuration(appV2), 2);
    await disconnectStarted;
    const maintenance = (host as unknown as { runMaintenance(): Promise<void> })
      .runMaintenance();
    const applyV3 = host.applyPlatformConfig(configuration(appV3), 3);
    releaseInitialDisconnect();
    await Promise.all([applyV2, maintenance, applyV3]);
    assert.deepEqual(createdSecrets, ['secret-v1', 'secret-v2', 'secret-v3']);
    assert.equal(host.snapshot().activeRevisionId, 3);
    assert.equal(host.snapshot().activeApps, 1);
  } finally {
    releaseInitialDisconnect();
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

function loadedApp(id: string, appId: string, appSecret: string): LoadedFeishuApp {
  return {
    id,
    enabled: true,
    configFile: `${id}.yaml`,
    appIdEnv: `${id.toUpperCase()}_APP_ID`,
    appSecretEnv: `${id.toUpperCase()}_APP_SECRET`,
    appId,
    appSecret,
    domain: 'feishu',
    events: { transport: 'websocket', path: `/public/feishu/${id}/events` },
    callbacks: { transport: 'disabled', path: `/public/feishu/${id}/callbacks` },
    policy: {
      requireMention: true,
      dmMode: 'open',
      dmAllowlist: [],
      groupAllowlist: [],
      respondToMentionAll: false,
    },
    attachments: {
      enabled: true,
      maxItems: 4,
      maxBytesPerItem: 1_000_000,
      maxTotalBytes: 2_000_000,
      passImagesToModel: true,
      persistFiles: true,
    },
    identity: { resolveUserProfile: false, profileCacheTtlSeconds: 900 },
    oauth: {
      enabled: false,
      publicBaseUrlEnv: `${id.toUpperCase()}_PUBLIC_BASE_URL`,
      redirectPath: `/public/feishu/${id}/oauth/callback`,
      scopes: [],
      tokenRoot: `/tmp/${id}/oauth/tokens`,
      stateRoot: `/tmp/${id}/oauth/states`,
      stateTtlSeconds: 600,
      encryptionKeyEnv: `${id.toUpperCase()}_OAUTH_KEY`,
    },
  };
}

function loadedAgent(id: string): LoadedAgentDefinition {
  return {
    id,
    enabled: true,
    configFile: `${id}.yaml`,
    systemPromptFile: `prompts/${id}.md`,
    systemPrompt: `${id} prompt`,
    provider: 'host-broker',
    model: 'test-model',
    modelApi: 'openai-responses',
    upstreamPath: '/openai',
    modelOptions: {
      reasoning: false,
      input: ['text'],
      contextWindow: 128_000,
      maxTokens: 4_096,
    },
    thinkingLevel: 'medium',
    runtime: { isolation: 'process', workerShutdownGraceSeconds: 5 },
    workspace: {
      mode: 'read-only',
      root: '/tmp/feishu-platform/workspaces',
      sessionRoot: '/tmp/feishu-platform/sessions',
      maxReadBytes: 1_000_000,
      maxWriteBytes: 1_000_000,
      maxTotalBytes: 256_000_000,
      maxFiles: 10_000,
    },
    tools: {
      feishu: ['chat.info'],
      workspace: ['workspace.list', 'workspace.read'],
      grants: [
        { name: 'chat.info', identity: 'app', effect: 'read', approval: 'never' },
        { name: 'workspace.list', identity: 'app', effect: 'read', approval: 'never' },
        { name: 'workspace.read', identity: 'app', effect: 'read', approval: 'never' },
      ],
      defaultIdentity: 'app',
      allowCrossChatRead: false,
      openApiReadAllowlist: [],
    },
    skillPaths: [],
    larkCli: {
      enabled: false,
      executable: 'lark-cli',
      expectedVersion: '1.0.79',
      root: '/tmp/feishu-platform/lark-cli',
      timeoutMs: 30_000,
      operations: [],
      skills: [],
    },
  };
}

function loadedBinding(
  id: string,
  app: LoadedFeishuApp,
  agent: LoadedAgentDefinition,
  isDefault: boolean,
  command?: string,
): LoadedAppAgentBinding {
  return {
    id,
    enabled: true,
    configFile: `${id}.yaml`,
    app: app.id,
    agent: agent.id,
    appDefinition: app,
    agentDefinition: agent,
    route: {
      default: isDefault,
      priority: isDefault ? 0 : 100,
      commandPrefixes: command ? [command] : [],
      chatAllowlist: [],
      userAllowlist: [],
      threadAllowlist: [],
    },
    conversation: {
      scope: 'thread',
      maxPendingTurns: 8,
      idleTtlSeconds: 1_800,
      turnTimeoutSeconds: 300,
      toolTimeoutSeconds: 60,
      queuedTurnTtlSeconds: 300,
      maxResidentSessions: 8,
      maxConcurrentTurns: 4,
      recentHistory: {
        enabled: true,
        maxMessages: 20,
        maxCharacters: 20_000,
        currentThreadOnly: true,
      },
    },
  };
}

function fakeChannel(onConnect: () => void, onDisconnect: () => void): LarkChannel {
  return {
    rawClient: { request: async () => ({}) },
    botIdentity: { name: 'test-bot', openId: 'ou_bot' },
    connect: async () => { onConnect(); },
    disconnect: async () => { onDisconnect(); },
    on: () => () => undefined,
    updatePolicy: () => undefined,
    send: async () => ({ messageId: 'message' }),
    updateCard: async () => ({}),
  } as unknown as LarkChannel;
}

function platform(
  apps: LoadedFeishuApp[],
  agents: LoadedAgentDefinition[],
  bindings: LoadedAppAgentBinding[],
): PlatformConfig {
  return { apps, agents, bindings };
}

function hostConfig(root: string): HostConfig {
  return {
    projectRoot: root,
    configRoot: join(root, 'config'),
    instanceId: `test-${Math.random().toString(36).slice(2)}`,
    dataRoot: join(root, 'data'),
    databasePath: join(root, 'data', 'platform.db'),
    shard: { index: 0, count: 1 },
    lease: { ttlMs: 45_000, heartbeatMs: 15_000 },
    publicHttp: { enabled: false, host: '127.0.0.1', port: 0, bodyLimitBytes: 65_536 },
    internalHttp: { enabled: false, host: '127.0.0.1', port: 0, bodyLimitBytes: 65_536 },
    adminOpenIds: ['ou_admin'],
    approvalTtlMs: 300_000,
    modelBroker: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'http://127.0.0.1:0/v1',
      upstreamBaseUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
      upstreamApiKey: 'test-gateway-key',
      requestTimeoutMs: 5_000,
      maxBodyBytes: 1_000_000,
      capabilityTtlMs: 900_000,
      capabilityMaxLifetimeMs: 21_600_000,
      allowNonCloudflareUpstream: false,
    },
    modelProviderPolicy: 'host-broker-only',
    maxConcurrentTurnsGlobal: 16,
    maxResidentPiWorkers: 24,
    maxConcurrentWorkerStarts: 4,
    maintenanceIntervalMs: 3_600_000,
    isHuggingFaceSpace: false,
  };
}
