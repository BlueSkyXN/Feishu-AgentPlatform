import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  AdminAuthService,
  AdminServer,
  StaticFeishuAdminAllowlist,
  type AdminBackend,
  type AdminRequestContext,
  type AdminRevisionDetail,
} from '../src/admin/index.js';

const ADMIN_TOKEN = 'admin-token-at-least-sixteen-characters';

test('AdminServer serves Chinese UI and protects read/write API with cookie session and CSRF', async () => {
  const calls: Array<{ operation: string; actor: string; input?: unknown }> = [];
  const backend = fakeBackend(calls);
  const server = new AdminServer({
    host: '127.0.0.1',
    port: 0,
    bodyLimitBytes: 64 * 1024,
    staticRoot: resolve('web'),
    auth: new AdminAuthService({ bootstrapToken: ADMIN_TOKEN }),
    backend,
  });
  await server.start();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${baseUrl}/admin/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /平台控制台/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);

    const anonymous = await fetch(`${baseUrl}/api/admin/v1/overview`);
    assert.equal(anonymous.status, 401);

    const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0];
    const loginBody = await login.json() as { csrfToken: string };
    assert.ok(cookie);
    assert.ok(loginBody.csrfToken);

    const restored = await requestJson(`${baseUrl}/api/admin/v1/auth/session`, {
      headers: { cookie },
    });
    assert.equal(restored.response.status, 200);
    const csrfToken = (restored.body as { csrfToken: string }).csrfToken;
    assert.equal(csrfToken, loginBody.csrfToken);

    const overview = await requestJson(`${baseUrl}/api/admin/v1/overview`, {
      headers: { cookie },
    });
    assert.equal(overview.response.status, 200);
    assert.equal((overview.body as { appCount: number }).appCount, 1);

    const noCsrf = await requestJson(`${baseUrl}/api/admin/v1/config/draft`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ document: { version: 2 } }),
    });
    assert.equal(noCsrf.response.status, 403);

    const draft = await requestJson(`${baseUrl}/api/admin/v1/config/draft`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({
        document: { version: 2 },
        expectedDraftRevisionId: null,
        note: 'api test',
      }),
    });
    assert.equal(draft.response.status, 201);
    assert.equal((draft.body as { id: number }).id, 2);
    assert.equal(calls.at(-1)?.actor, 'admin-token');

    const secret = 'never-echo-this-app-secret';
    const credential = await requestJson(
      `${baseUrl}/api/admin/v1/credentials/${encodeURIComponent('apps/primary/app-secret')}`,
      {
        method: 'PUT',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ kind: 'feishu-app-secret', value: secret }),
      },
    );
    assert.equal(credential.response.status, 200);
    assert.equal(JSON.stringify(credential.body).includes(secret), false);
    assert.equal(JSON.stringify(calls.at(-1)?.input).includes(secret), true);

    const audit = await requestJson(`${baseUrl}/api/admin/v1/audit?limit=20`, {
      headers: { cookie },
    });
    assert.equal(audit.response.status, 200);
    assert.equal(Array.isArray((audit.body as { items: unknown[] }).items), true);

    const approval = await requestJson(
      `${baseUrl}/api/admin/v1/approvals/approval-admin/approve`,
      {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': csrfToken },
      },
    );
    assert.equal(approval.response.status, 200);
    assert.equal((approval.body as { state: string }).state, 'approved');
    assert.equal(calls.at(-1)?.operation, 'resolveApproval');
  } finally {
    await server.stop();
  }
});

test('AdminServer completes verified Feishu SSO through the exact administrator allowlist', async () => {
  const backend = fakeBackend([]);
  backend.startAdminSso = async ({ appKey }) => `https://accounts.feishu.cn/authorize?app=${appKey}`;
  backend.completeAdminSso = async () => ({ openId: 'ou_admin', returnTo: '/admin' });
  const server = new AdminServer({
    host: '127.0.0.1',
    port: 0,
    bodyLimitBytes: 64 * 1024,
    staticRoot: resolve('web'),
    auth: new AdminAuthService({ bootstrapToken: ADMIN_TOKEN }),
    ssoAllowlist: new StaticFeishuAdminAllowlist({ openIds: ['ou_admin'] }),
    backend,
  });
  await server.start();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const start = await fetch(
      `${baseUrl}/api/admin/v1/auth/sso/start?appKey=primary`,
      { redirect: 'manual' },
    );
    assert.equal(start.status, 302);
    assert.equal(
      start.headers.get('location'),
      'https://accounts.feishu.cn/authorize?app=primary',
    );

    const encoded = Buffer.from(JSON.stringify({ appKey: 'primary' }), 'utf8').toString('base64url');
    const callback = await fetch(
      `${baseUrl}/api/admin/v1/auth/sso/callback?code=verified&state=${encoded}.signature`,
      { redirect: 'manual' },
    );
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/admin');
    assert.match(callback.headers.get('set-cookie') ?? '', /HttpOnly; Secure; SameSite=Strict/);
  } finally {
    await server.stop();
  }
});

test('bootstrap login rate limits use forwarded IP only from an explicitly trusted proxy', async () => {
  const server = new AdminServer({
    host: '127.0.0.1',
    port: 0,
    bodyLimitBytes: 64 * 1024,
    staticRoot: resolve('web'),
    trustedProxyAddresses: ['127.0.0.1'],
    auth: new AdminAuthService({
      bootstrapToken: ADMIN_TOKEN,
      maxLoginAttempts: 2,
    }),
    backend: fakeBackend([]),
  });
  await server.start();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = async (token: string, forwardedFor: string) => await fetch(
    `${baseUrl}/api/admin/v1/auth/login`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': forwardedFor,
      },
      body: JSON.stringify({ token }),
    },
  );
  try {
    assert.equal((await login('wrong-token-one', '203.0.113.10')).status, 401);
    assert.equal((await login('wrong-token-two', '203.0.113.10')).status, 401);
    assert.equal((await login(ADMIN_TOKEN, '203.0.113.10')).status, 429);
    assert.equal((await login(ADMIN_TOKEN, '203.0.113.11')).status, 200);
  } finally {
    await server.stop();
  }
});

function fakeBackend(
  calls: Array<{ operation: string; actor: string; input?: unknown }>,
): AdminBackend {
  const revision = (id: number, document: Record<string, unknown>): AdminRevisionDetail => ({
    id,
    document,
    contentSha256: 'a'.repeat(64),
    createdAt: '2026-07-29T00:00:00.000Z',
    createdBy: 'seed-loader',
    publishedAt: '2026-07-29T00:00:00.000Z',
    publishedBy: 'seed-loader',
    slots: id === 1 ? ['active'] : ['draft'],
  });
  const record = (operation: string, context: AdminRequestContext, input?: unknown): void => {
    calls.push({ operation, actor: context.actor, ...(input === undefined ? {} : { input }) });
  };
  return {
    getOverview: () => ({
      status: 'ready',
      version: '0.1.0',
      activeRevisionId: 1,
      appCount: 1,
      agentCount: 1,
      bindingCount: 1,
      configuredCredentialCount: 1,
      warnings: [],
      runtime: {
        activeApps: 1,
        failedApps: 0,
        residentWorkers: 0,
        residentWorkerLimit: 24,
        workerStartsInUse: 0,
        workerStartLimit: 4,
        activeTurns: 0,
        waitingTurns: 0,
        modelBrokerStarted: true,
        activeModelCapabilities: 0,
      },
    }),
    listApps: () => [{
      id: 'primary',
      enabled: true,
      domain: 'feishu',
      eventsTransport: 'websocket',
      callbacksTransport: 'http',
      credentials: [{ name: 'apps/primary/app-secret', configured: true, fingerprint: '0123456789abcdef' }],
    }],
    listAgents: () => [{
      id: 'general',
      enabled: true,
      provider: 'host-broker',
      model: 'test',
      modelApi: 'openai-responses',
      runtimeIsolation: 'process',
      workspaceMode: 'read-only',
    }],
    listBindings: () => [{
      id: 'primary-general',
      enabled: true,
      app: 'primary',
      agent: 'general',
      isDefault: true,
      priority: 0,
    }],
    getConfigState: () => ({ active: revision(1, { version: 1 }) }),
    saveDraft: (input, context) => {
      record('saveDraft', context, input);
      return revision(2, input.document);
    },
    publishDraft: (input, context) => {
      record('publishDraft', context, input);
      return { ...revision(2, { version: 2 }), slots: ['active'] };
    },
    rollbackRevision: (input, context) => {
      record('rollbackRevision', context, input);
      return { ...revision(3, { version: 1 }), slots: ['active'], sourceRevisionId: input.revisionId };
    },
    listRevisions: () => [revision(1, { version: 1 })],
    getRevision: (id) => id === 1 ? revision(1, { version: 1 }) : undefined,
    listCredentials: () => [{
      name: 'apps/primary/app-secret',
      kind: 'feishu-app-secret',
      configured: true,
      fingerprint: '0123456789abcdef',
    }],
    setCredential: (input, context) => {
      record('setCredential', context, input);
      return {
        name: input.name,
        kind: input.kind,
        configured: true,
        fingerprint: 'fedcba9876543210',
      };
    },
    deleteCredential: (name, context) => {
      record('deleteCredential', context, { name });
      return true;
    },
    listAudit: () => [{
      id: 1,
      occurredAt: '2026-07-29T00:00:00.000Z',
      actor: 'seed-loader',
      action: 'config.seed_imported',
      entityType: 'config_revision',
      entityId: '1',
      details: {},
    }],
    resolveApproval: (input, context) => {
      record('resolveApproval', context, input);
      return {
        id: input.id,
        appKey: 'primary',
        agentId: 'general',
        bindingId: 'primary-general',
        conversationKey: 'conversation',
        messageId: 'message',
        requesterOpenId: 'ou_requester',
        operation: 'base.records.delete',
        effect: 'high-risk-write',
        approval: 'admin',
        argumentsHash: 'a'.repeat(64),
        state: input.decision === 'approve' ? 'approved' : 'denied',
        approverOpenId: context.actor,
        createdAt: 1,
        expiresAt: 2,
        resolvedAt: 1,
      };
    },
  };
}

async function requestJson(
  url: string,
  init?: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}
