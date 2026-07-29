import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

import type { LoadedBindingConfig } from '../src/config/types.js';
import { Logger } from '../src/core/logger.js';
import type { FeishuOpenApiClient } from '../src/feishu/api-client.js';
import {
  extractTenantKey,
  FeishuIdentityContextService,
} from '../src/feishu/identity-context.js';

test('tenant identity is read from the normalized SDK raw sender payload', () => {
  assert.equal(
    extractTenantKey(message({
      raw: { sender: { tenant_key: 'tenant_from_sdk_sender' } },
    })),
    'tenant_from_sdk_sender',
  );
});

test('recent history stays inside the current thread or main chat session', async () => {
  const api = {
    request: async () => ({
      data: {
        items: [
          item('m-main', 'main'),
          item('m-thread-a', 'thread A', 'om_root_a', 'omt_a'),
          item('m-thread-b', 'thread B', 'om_root_b', 'omt_b'),
        ],
      },
    }),
  } as unknown as FeishuOpenApiClient;
  const service = new FeishuIdentityContextService(
    {
      identity: { resolveUserProfile: false, profileCacheTtlSeconds: 900 },
      conversation: {
        recentHistory: {
          enabled: true,
          maxMessages: 20,
          maxCharacters: 30_000,
          currentThreadOnly: true,
        },
      },
    } as LoadedBindingConfig,
    api,
    new Logger({ service: 'identity-context-test' }),
  );

  const threadHistory = await service.currentChatHistory(
    message({ threadId: 'omt_a' }),
  );
  assert.deepEqual(threadHistory.map((entry) => entry.messageId), ['m-thread-a']);

  const mainHistory = await service.currentChatHistory(message());
  assert.deepEqual(mainHistory.map((entry) => entry.messageId), ['m-main']);
});

function item(
  messageId: string,
  text: string,
  rootId?: string,
  threadId?: string,
): unknown {
  return {
    message_id: messageId,
    ...(rootId ? { root_id: rootId } : {}),
    ...(threadId ? { thread_id: threadId } : {}),
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
    sender: { id: 'ou_sender' },
    create_time: '1785310000000',
  };
}

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'm-current',
    chatId: 'oc_chat',
    senderId: 'ou_current',
    content: 'current',
    chatType: 'group',
    rawContentType: 'text',
    ...overrides,
  } as NormalizedMessage;
}
