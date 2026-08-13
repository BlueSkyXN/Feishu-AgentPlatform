import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PlatformHost } from '../src/app/host.js';
import { PlatformAdminBackend } from '../src/admin/platform-backend.js';
import type { AdminRequestContext } from '../src/admin/contracts.js';
import type {
  HostConfig,
  PlatformConfig,
  PlatformConfigDocument,
} from '../src/config/types.js';
import {
  buildConversationKey,
  conversationStorageId,
} from '../src/core/conversation.js';
import { validatePlatformConfigDocument } from '../src/config/load-platform.js';
import { ConfigDocumentStore } from '../src/storage/config-store.js';
import { CredentialVault } from '../src/storage/credential-vault.js';
import { PlatformDatabase } from '../src/storage/database.js';
import { PersistentSessionIndex } from '../src/storage/session-index.js';

test('empty configuration reports setup_required even when the HTTP host is healthy', () => {
  const database = new PlatformDatabase(':memory:');
  const vault = new CredentialVault(database, 'platform-master-key-for-tests');
  const store = new ConfigDocumentStore<PlatformConfigDocument>(
    database,
    validatePlatformConfigDocument,
  );
  const snapshot = {
    ...runtimeSnapshot(),
    ready: true,
    setupRequired: true,
    configuredApps: 0,
    configuredAgents: 0,
    configuredBindings: 0,
    assignedApps: 0,
    activeApps: 0,
  };
  const host = {
    snapshot: () => snapshot,
    listApps: () => [],
    getApp: () => undefined,
  } as unknown as PlatformHost;
  const backend = new PlatformAdminBackend(
    host,
    hostConfig('/tmp/project', ':memory:'),
    database,
    store,
    vault,
  );
  try {
    const overview = backend.getOverview(adminContext());
    assert.equal(overview.status, 'setup_required');
    assert.equal(overview.appCount, 0);
    assert.match(overview.warnings.join('\n'), /尚未发布配置/);
  } finally {
    database.close();
  }
});

test('credential rotation reloads only referenced active configuration without exposing plaintext', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-admin-backend-'));
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts/general.md'), 'General prompt', 'utf8');
  const databasePath = join(root, 'data/platform.db');
  const database = new PlatformDatabase(databasePath);
  const vault = new CredentialVault(database, 'platform-master-key-for-tests');
  const store = new ConfigDocumentStore<PlatformConfigDocument>(
    database,
    validatePlatformConfigDocument,
  );
  vault.setCredential({
    name: 'PRIMARY_APP_ID',
    kind: 'feishu-app-id',
    value: 'cli_primary',
    actor: 'test',
  });
  vault.setCredential({
    name: 'PRIMARY_APP_SECRET',
    kind: 'feishu-app-secret',
    value: 'old-secret',
    actor: 'test',
  });
  store.importSeed(document(root), { actor: 'test' });
  const applied: Array<{ platform: PlatformConfig; revisionId?: number }> = [];
  const host = {
    snapshot: () => runtimeSnapshot(),
    listApps: () => [],
    getApp: () => undefined,
    applyPlatformConfig: async (platform: PlatformConfig, revisionId?: number) => {
      applied.push({ platform, ...(revisionId === undefined ? {} : { revisionId }) });
    },
  } as unknown as PlatformHost;
  const backend = new PlatformAdminBackend(
    host,
    hostConfig(root, databasePath),
    database,
    store,
    vault,
  );
  try {
    const response = await backend.setCredential({
      name: 'PRIMARY_APP_SECRET',
      kind: 'feishu-app-secret',
      value: 'rotated-secret',
    }, adminContext());
    assert.equal(response.configured, true);
    assert.equal(JSON.stringify(response).includes('rotated-secret'), false);
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.platform.apps[0]?.appSecret, 'rotated-secret');
    assert.equal(applied[0]?.revisionId, 1);
    assert.equal((await readFile(databasePath)).includes(Buffer.from('rotated-secret')), false);

    await backend.setCredential({
      name: 'UNREFERENCED_VALUE',
      kind: 'test',
      value: 'not-used-by-active-config',
    }, adminContext());
    assert.equal(applied.length, 1);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('draft entity deletion requires the exact entity ID confirmation', async () => {
  const database = new PlatformDatabase(':memory:');
  const vault = new CredentialVault(database, 'platform-master-key-for-tests');
  const store = new ConfigDocumentStore<PlatformConfigDocument>(
    database,
    validatePlatformConfigDocument,
  );
  store.importSeed(document('/tmp/project'), { actor: 'test' });
  const host = {
    snapshot: () => runtimeSnapshot(),
    listApps: () => [],
    getApp: () => undefined,
  } as unknown as PlatformHost;
  const backend = new PlatformAdminBackend(
    host,
    hostConfig('/tmp/project', ':memory:'),
    database,
    store,
    vault,
  );
  try {
    assert.throws(
      () => backend.mutateDraftEntity({
        kind: 'apps',
        action: 'delete',
        id: 'primary',
        confirmation: 'wrong',
      }, adminContext()),
      /二次确认/,
    );
    const draft = backend.mutateDraftEntity({
      kind: 'apps',
      action: 'delete',
      id: 'primary',
      confirmation: 'primary',
    }, adminContext());
    assert.deepEqual(draft.document.apps, []);
    assert.equal(draft.slots.includes('draft'), true);
  } finally {
    database.close();
  }
});

test('publish always compare-and-swaps the exact Draft that was validated', async () => {
  const database = new PlatformDatabase(':memory:');
  const vault = new CredentialVault(database, 'platform-master-key-for-tests');
  const store = new ConfigDocumentStore<PlatformConfigDocument>(
    database,
    validatePlatformConfigDocument,
  );
  const original = document('/tmp/project');
  store.importSeed(original, { actor: 'test' });
  const draftA = structuredClone(original);
  draftA.agents[0]!.model = 'draft-a';
  const revisionA = store.saveDraft(draftA, {
    actor: 'admin-a',
    expectedDraftRevisionId: null,
  });
  const applied: number[] = [];
  const host = {
    snapshot: () => runtimeSnapshot(),
    listApps: () => [],
    getApp: () => undefined,
    applyPlatformConfig: async (_platform: PlatformConfig, revisionId?: number) => {
      if (revisionId !== undefined) applied.push(revisionId);
    },
  } as unknown as PlatformHost;
  const backend = new PlatformAdminBackend(
    host,
    hostConfig('/tmp/project', ':memory:'),
    database,
    store,
    vault,
  );
  let validationStarted!: () => void;
  const started = new Promise<void>((resolve) => { validationStarted = resolve; });
  let releaseValidation!: () => void;
  const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
  (backend as unknown as {
    loadRuntimeConfig(document: PlatformConfigDocument): Promise<PlatformConfig>;
  }).loadRuntimeConfig = async () => {
    validationStarted();
    await validationGate;
    return { apps: [], agents: [], bindings: [] };
  };
  try {
    const publishing = backend.publishDraft({}, adminContext());
    await started;
    const draftB = structuredClone(original);
    draftB.agents[0]!.model = 'draft-b';
    const revisionB = store.saveDraft(draftB, {
      actor: 'admin-b',
      expectedDraftRevisionId: revisionA.id,
    });
    releaseValidation();
    await assert.rejects(
      () => publishing,
      (error: unknown) => Boolean(
        error && typeof error === 'object' &&
        (error as { status?: number }).status === 409 &&
        (error as { code?: string }).code === 'config_conflict',
      ),
    );
    assert.equal(store.getState().active?.id, 1);
    assert.equal(store.getState().draft?.id, revisionB.id);
    assert.deepEqual(applied, []);
  } finally {
    releaseValidation();
    database.close();
  }
});

test('Admin validation and publish reject a Draft with Feishu write capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-admin-readonly-policy-'));
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts/general.md'), 'General prompt', 'utf8');
  const database = new PlatformDatabase(join(root, 'platform.db'));
  const vault = new CredentialVault(database, 'platform-master-key-for-tests');
  for (const credential of [
    { name: 'PRIMARY_APP_ID', kind: 'feishu-app-id', value: 'cli_primary' },
    { name: 'PRIMARY_APP_SECRET', kind: 'feishu-app-secret', value: 'secret' },
  ]) vault.setCredential({ ...credential, actor: 'test' });
  const store = new ConfigDocumentStore<PlatformConfigDocument>(
    database,
    validatePlatformConfigDocument,
  );
  const active = store.importSeed(document(root), { actor: 'test' });
  const draftDocument = document(root);
  draftDocument.agents[0]!.tools.feishu.push('doc.create');
  draftDocument.agents[0]!.tools.grants.push({
    name: 'doc.create',
    identity: 'app',
    effect: 'write',
    approval: 'requester',
  });
  const draft = store.saveDraft(draftDocument, {
    actor: 'test',
    expectedDraftRevisionId: null,
  });
  const backend = new PlatformAdminBackend(
    {
      snapshot: () => runtimeSnapshot(),
      listApps: () => [],
      getApp: () => undefined,
      applyPlatformConfig: async () => undefined,
    } as unknown as PlatformHost,
    hostConfig(root, join(root, 'platform.db')),
    database,
    store,
    vault,
  );
  try {
    assert.deepEqual(await backend.validateDraft(adminContext()), {
      valid: false,
      errors: [
        'platform.db#agents[0]: V0.1 Feishu policy is read-only; write tool "doc.create" is prohibited.',
      ],
      warnings: [],
    });
    await assert.rejects(
      () => backend.publishDraft({ expectedDraftRevisionId: draft.id }, adminContext()),
      (error: unknown) => Boolean(
        error && typeof error === 'object' &&
        (error as { status?: number }).status === 400 &&
        (error as { code?: string }).code === 'config_invalid',
      ),
    );
    assert.equal(store.getState().active?.id, active.id);
    assert.equal(store.getState().draft?.id, draft.id);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Admin rollback rejects a historical Feishu write revision without changing Active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-admin-readonly-rollback-'));
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts/general.md'), 'General prompt', 'utf8');
  const database = new PlatformDatabase(join(root, 'platform.db'));
  const vault = new CredentialVault(database, 'platform-master-key-for-tests');
  for (const credential of [
    { name: 'PRIMARY_APP_ID', kind: 'feishu-app-id', value: 'cli_primary' },
    { name: 'PRIMARY_APP_SECRET', kind: 'feishu-app-secret', value: 'secret' },
  ]) vault.setCredential({ ...credential, actor: 'test' });
  const store = new ConfigDocumentStore<PlatformConfigDocument>(
    database,
    validatePlatformConfigDocument,
  );
  const writeDocument = document(root);
  writeDocument.agents[0]!.tools.feishu.push('doc.create');
  writeDocument.agents[0]!.tools.grants.push({
    name: 'doc.create',
    identity: 'app',
    effect: 'write',
    approval: 'requester',
  });
  const writeRevision = store.importSeed(writeDocument, { actor: 'test' });
  const cleanDraft = store.saveDraft(document(root), {
    actor: 'test',
    expectedDraftRevisionId: null,
    sourceRevisionId: writeRevision.id,
  });
  const cleanRevision = store.publishDraft({
    actor: 'test',
    expectedDraftRevisionId: cleanDraft.id,
  });
  const applied: number[] = [];
  const backend = new PlatformAdminBackend(
    {
      snapshot: () => runtimeSnapshot(),
      listApps: () => [],
      getApp: () => undefined,
      applyPlatformConfig: async (_platform: PlatformConfig, revisionId?: number) => {
        if (revisionId !== undefined) applied.push(revisionId);
      },
    } as unknown as PlatformHost,
    hostConfig(root, join(root, 'platform.db')),
    database,
    store,
    vault,
  );
  try {
    const revisionCount = store.listRevisions().length;
    await assert.rejects(
      () => backend.rollbackRevision({ revisionId: writeRevision.id }, adminContext()),
      (error: unknown) => Boolean(
        error && typeof error === 'object' &&
        (error as { status?: number }).status === 400 &&
        (error as { code?: string }).code === 'config_invalid' &&
        String((error as { message?: string }).message).includes(
          'V0.1 Feishu policy is read-only',
        ),
      ),
    );
    assert.equal(store.getState().active?.id, cleanRevision.id);
    assert.equal(store.getState().draft, undefined);
    assert.equal(store.listRevisions().length, revisionCount);
    assert.deepEqual(applied, []);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('rollback reports and audits runtime apply failure after the Active revision changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-admin-rollback-'));
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts/general.md'), 'General prompt', 'utf8');
  const database = new PlatformDatabase(join(root, 'platform.db'));
  const vault = new CredentialVault(database, 'platform-master-key-for-tests');
  for (const credential of [
    { name: 'PRIMARY_APP_ID', kind: 'feishu-app-id', value: 'cli_primary' },
    { name: 'PRIMARY_APP_SECRET', kind: 'feishu-app-secret', value: 'secret' },
  ]) vault.setCredential({ ...credential, actor: 'test' });
  const store = new ConfigDocumentStore<PlatformConfigDocument>(
    database,
    validatePlatformConfigDocument,
  );
  const revisionOne = store.importSeed(document(root), { actor: 'test' });
  const changed = document(root);
  changed.agents[0]!.model = 'changed-model';
  const draft = store.saveDraft(changed, { actor: 'test', expectedDraftRevisionId: null });
  store.publishDraft({ actor: 'test', expectedDraftRevisionId: draft.id });
  const host = {
    snapshot: () => runtimeSnapshot(),
    listApps: () => [],
    getApp: () => undefined,
    applyPlatformConfig: async () => { throw new Error('simulated runtime failure'); },
  } as unknown as PlatformHost;
  const backend = new PlatformAdminBackend(
    host,
    hostConfig(root, join(root, 'platform.db')),
    database,
    store,
    vault,
  );
  try {
    await assert.rejects(
      () => backend.rollbackRevision({ revisionId: revisionOne.id }, adminContext()),
      (error: unknown) => Boolean(
        error && typeof error === 'object' &&
        (error as { status?: number }).status === 503 &&
        (error as { code?: string }).code === 'runtime_apply_failed',
      ),
    );
    const active = store.getState().active;
    assert.ok(active);
    assert.equal(active.sourceRevisionId, revisionOne.id);
    const audit = database.listAudit({ action: 'config.runtime_apply_failed' });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.entityId, String(active.id));
    assert.deepEqual(audit[0]?.details, {
      operation: 'rollback',
      targetRevisionId: revisionOne.id,
      error: 'simulated runtime failure',
    });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent orphan Sessions remain safely deletable after their Agent is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-admin-orphan-session-'));
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts/general.md'), 'General prompt', 'utf8');
  const database = new PlatformDatabase(join(root, 'data/platform.db'));
  const vault = new CredentialVault(database, 'platform-master-key-for-tests');
  const store = new ConfigDocumentStore<PlatformConfigDocument>(
    database,
    validatePlatformConfigDocument,
  );
  store.importSeed(document(root), { actor: 'test' });
  const index = new PersistentSessionIndex(database);
  const conversationKey = buildConversationKey(
    'primary',
    'removed-agent',
    'tenant',
    { chatId: 'oc_orphan' },
    'thread',
  );
  const storageId = conversationStorageId(conversationKey);
  const workspacePath = join(root, 'data/workspaces/primary/removed-agent', storageId);
  const sessionPath = join(root, 'data/sessions/primary/removed-agent', storageId);
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(sessionPath, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspacePath, 'attachment.txt'), 'workspace'),
    writeFile(join(sessionPath, 'session.jsonl'), 'session'),
  ]);
  index.touch({
    storageId,
    conversationKey,
    appKey: 'primary',
    agentId: 'removed-agent',
    bindingId: 'removed-binding',
    chatId: 'oc_orphan',
    workspacePath,
    sessionPath,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  });
  const backend = new PlatformAdminBackend(
    {
      snapshot: () => runtimeSnapshot(),
      listApps: () => [],
      getApp: () => undefined,
    } as unknown as PlatformHost,
    hostConfig(root, join(root, 'data/platform.db')),
    database,
    store,
    vault,
  );
  try {
    assert.deepEqual(
      await backend.operateSession({
        storageId,
        action: 'delete',
        confirmation: storageId,
      }, adminContext()),
      { operated: true },
    );
    assert.equal(index.get(storageId), undefined);
    await assert.rejects(() => readFile(join(workspacePath, 'attachment.txt')), /ENOENT/);
    await assert.rejects(() => readFile(join(sessionPath, 'session.jsonl')), /ENOENT/);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

function document(root: string): PlatformConfigDocument {
  return {
    schemaVersion: 1,
    apps: [{
      id: 'primary',
      enabled: true,
      appIdEnv: 'PRIMARY_APP_ID',
      appSecretEnv: 'PRIMARY_APP_SECRET',
      domain: 'feishu',
      events: { transport: 'websocket', path: '/public/feishu/primary/events' },
      callbacks: { transport: 'disabled', path: '/public/feishu/primary/callbacks' },
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
        publicBaseUrlEnv: 'PRIMARY_PUBLIC_BASE_URL',
        redirectPath: '/public/feishu/primary/oauth/callback',
        scopes: [],
        tokenRoot: join(root, 'data/oauth/tokens'),
        stateRoot: join(root, 'data/oauth/states'),
        stateTtlSeconds: 600,
        encryptionKeyEnv: 'PRIMARY_OAUTH_KEY',
      },
    }],
    agents: [{
      id: 'general',
      enabled: true,
      systemPromptFile: 'prompts/general.md',
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
        root: join(root, 'data/workspaces'),
        sessionRoot: join(root, 'data/sessions'),
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
        root: join(root, 'data/lark-cli'),
        timeoutMs: 30_000,
        operations: [],
        skills: [],
      },
    }],
    bindings: [{
      id: 'primary-general',
      enabled: true,
      app: 'primary',
      agent: 'general',
      route: {
        default: true,
        priority: 0,
        commandPrefixes: [],
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
    }],
  };
}

function adminContext(): AdminRequestContext {
  return {
    actor: 'admin-token',
    session: {
      actor: { type: 'bootstrap-token', id: 'admin-token', displayName: '平台管理员' },
      createdAt: '2026-07-29T00:00:00.000Z',
      expiresAt: '2026-07-29T08:00:00.000Z',
    },
  };
}

function hostConfig(root: string, databasePath: string): HostConfig {
  return {
    projectRoot: root,
    configRoot: join(root, 'config'),
    instanceId: 'test',
    dataRoot: join(root, 'data'),
    databasePath,
    shard: { index: 0, count: 1 },
    lease: { ttlMs: 45_000, heartbeatMs: 15_000 },
    publicHttp: { enabled: true, host: '127.0.0.1', port: 7860, bodyLimitBytes: 65_536 },
    internalHttp: { enabled: false, host: '127.0.0.1', port: 8788, bodyLimitBytes: 65_536 },
    adminOpenIds: ['ou_admin'],
    approvalTtlMs: 300_000,
    modelBroker: {
      enabled: true,
      host: '127.0.0.1',
      port: 8790,
      publicBaseUrl: 'http://127.0.0.1:8790/v1',
      upstreamBaseUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
      upstreamApiKey: 'test',
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
    maintenanceIntervalMs: 30_000,
    isHuggingFaceSpace: false,
  };
}

function runtimeSnapshot() {
  return {
    version: '0.1.0',
    instanceId: 'test',
    startedAt: Date.now(),
    ready: true,
    setupRequired: false,
    configuredApps: 1,
    configuredAgents: 1,
    configuredBindings: 1,
    assignedApps: 1,
    activeApps: 1,
    skippedByShard: 0,
    waitingForLease: 0,
    failedApps: 0,
    shard: { index: 0, count: 1 },
    globalConcurrency: { capacity: 16, inUse: 0, waiting: 0 },
    runtimeCapacity: {
      residentWorkers: 0,
      residentWorkerLimit: 24,
      pendingResidentWorkers: 0,
      workerStartsInUse: 0,
      workerStartLimit: 4,
      workerStartsWaiting: 0,
    },
    modelBroker: {
      enabled: true,
      started: true,
      activeCapabilities: 0,
      upstreamConfigured: true,
    },
    assignments: [],
    apps: [],
    agents: [],
    bindings: [],
  };
}
