import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

import type { LoadedBindingConfig } from '../src/config/types.js';
import { TimeoutError } from '../src/core/timeout.js';
import { FeishuOpenApiClient } from '../src/feishu/api-client.js';
import type { FeishuIdentityContextService } from '../src/feishu/identity-context.js';
import { ToolBroker } from '../src/tools/tool-broker.js';
import { TurnContextRef } from '../src/tools/turn-context.js';

test('generic OpenAPI cannot bypass the current-chat boundary', async () => {
  const turn = new TurnContextRef();
  turn.set({
    appKey: 'primary',
    agentId: 'general',
    bindingId: 'primary-general',
    conversationKey: 'test-conversation',
    tenantKey: 'tenant',
    message: {
      messageId: 'om_current',
      chatId: 'oc_current',
      senderId: 'ou_current',
      content: 'test',
      chatType: 'group',
      rawContentType: 'text',
    } as NormalizedMessage,
    identity: { openId: 'ou_current', tenantKey: 'tenant' },
    recentHistory: [],
    workspace: '/tmp/not-used',
    receivedAt: Date.now(),
  });
  let requests = 0;
  const broker = new ToolBroker({
    config: {
      conversation: { toolTimeoutSeconds: 5 },
      agent: {
        feishuTools: ['openapi.get'],
        workspaceTools: [],
        allowCrossChatRead: false,
        defaultToolIdentity: 'app',
        toolGrants: [{
          name: 'openapi.get',
          identity: 'app',
          effect: 'read',
          approval: 'never',
        }],
      },
    } as unknown as LoadedBindingConfig,
    channel: { getChatInfo: async () => ({}) },
    api: {
      request: async () => {
        requests += 1;
        return { ok: true };
      },
    } as unknown as FeishuOpenApiClient,
    identityContext: {} as unknown as FeishuIdentityContextService,
    turn,
  });

  await assert.rejects(
    broker.execute('openapi.get', {
      path: '/open-apis/im/v1/messages',
      query_json: JSON.stringify({ container_id: 'oc_other' }),
    }),
    /current-chat typed tools/,
  );
  assert.equal(requests, 0);

  await broker.execute('openapi.get', {
    path: '/open-apis/docx/v1/documents/doccn_test/raw_content',
  });
  assert.equal(requests, 1);
});

test('typed Feishu write timeout aborts transport before a late side effect', async () => {
  const turn = new TurnContextRef();
  turn.set({
    appKey: 'primary',
    agentId: 'general',
    bindingId: 'primary-general',
    conversationKey: 'test-conversation',
    tenantKey: 'tenant',
    message: {
      messageId: 'om_current',
      chatId: 'oc_current',
      senderId: 'ou_current',
      content: 'test',
      chatType: 'group',
      rawContentType: 'text',
    } as NormalizedMessage,
    identity: { openId: 'ou_current', tenantKey: 'tenant' },
    recentHistory: [],
    workspace: '/tmp/not-used',
    receivedAt: Date.now(),
  });
  const config = {
    appKey: 'primary',
    feishu: { domain: 'feishu' },
    conversation: { toolTimeoutSeconds: 0.01 },
    agent: {
      feishuTools: ['doc.create'],
      workspaceTools: [],
      allowCrossChatRead: false,
      defaultToolIdentity: 'app',
      openApiReadAllowlist: [],
      toolGrants: [{
        name: 'doc.create',
        identity: 'app',
        effect: 'write',
        approval: 'requester',
      }],
    },
  } as unknown as LoadedBindingConfig;
  let transportSignal: AbortSignal | undefined;
  let sideEffect = false;
  const api = new FeishuOpenApiClient(config, {
    request: async (request) => await new Promise((resolve, reject) => {
      transportSignal = request.signal;
      const timer = setTimeout(() => {
        sideEffect = true;
        resolve({ code: 0 });
      }, 80);
      request.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(request.signal?.reason);
      }, { once: true });
    }),
  });
  const broker = new ToolBroker({
    config,
    channel: { getChatInfo: async () => ({}) },
    api,
    identityContext: {} as unknown as FeishuIdentityContextService,
    approvals: { request: async () => undefined } as never,
    turn,
  });

  await assert.rejects(
    broker.execute('doc.create', { title: 'must not be created' }),
    (error) => error instanceof TimeoutError,
  );
  assert.ok(transportSignal, 'the raw SDK request must receive an AbortSignal');
  assert.equal(transportSignal.aborted, true);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(sideEffect, false);
});
