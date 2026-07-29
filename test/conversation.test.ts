import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConversationKey,
  conversationBelongsTo,
  conversationStorageId,
  parseConversationKey,
  shouldReplyInThread,
} from '../src/core/conversation.js';

const message = { chatId: 'oc:chat/含中文', threadId: 'omt_thread_1' };

test('V2 conversation key isolates app, agent, tenant, chat and topic', () => {
  const base = buildConversationKey('app-a', 'agent-a', 'tenant-a', message, 'thread');
  assert.notEqual(base, buildConversationKey('app-b', 'agent-a', 'tenant-a', message, 'thread'));
  assert.notEqual(base, buildConversationKey('app-a', 'agent-b', 'tenant-a', message, 'thread'));
  assert.notEqual(base, buildConversationKey('app-a', 'agent-a', 'tenant-b', message, 'thread'));
  assert.notEqual(
    base,
    buildConversationKey('app-a', 'agent-a', 'tenant-a', { ...message, chatId: 'oc_other' }, 'thread'),
  );
  assert.notEqual(
    base,
    buildConversationKey('app-a', 'agent-a', 'tenant-a', { ...message, threadId: 'omt_thread_2' }, 'thread'),
  );
});

test('V2 conversation key round-trips arbitrary Feishu identifiers', () => {
  const key = buildConversationKey('app-a', 'agent-a', 'tenant:a', message, 'thread');
  assert.deepEqual(parseConversationKey(key), {
    appKey: 'app-a',
    agentId: 'agent-a',
    tenantKey: 'tenant:a',
    chatId: 'oc:chat/含中文',
    topicKey: 'omt_thread_1',
  });
  assert.equal(conversationBelongsTo(key, 'app-a', 'agent-a', 'oc:chat/含中文'), true);
  assert.equal(conversationBelongsTo(key, 'app-a', 'agent-b'), false);
});

test('thread scope uses rootId and chat scope merges topics', () => {
  const root = buildConversationKey(
    'app-a',
    'agent-a',
    'tenant-a',
    { chatId: 'oc_chat', rootId: 'om_root' },
    'thread',
  );
  assert.equal(parseConversationKey(root).topicKey, 'om_root');
  const first = buildConversationKey(
    'app-a',
    'agent-a',
    'tenant-a',
    { chatId: 'oc_chat', threadId: 'thread-1' },
    'chat',
  );
  const second = buildConversationKey(
    'app-a',
    'agent-a',
    'tenant-a',
    { chatId: 'oc_chat', threadId: 'thread-2' },
    'chat',
  );
  assert.equal(first, second);
  assert.equal(parseConversationKey(first).topicKey, 'main');
});

test('V1, malformed and non-canonical conversation keys are rejected', () => {
  for (const key of ['', 'v1:a:b:c', 'v2:@@:Yg:Yw:ZA:ZQ', 'v2:YQ:Yg:Yw:ZA:ZQ']) {
    assert.throws(() => parseConversationKey(key));
  }
});

test('reply-in-thread recognizes threadId and rootId', () => {
  assert.equal(shouldReplyInThread({ chatId: 'oc', threadId: 'thread' }), true);
  assert.equal(shouldReplyInThread({ chatId: 'oc', rootId: 'root' }), true);
  assert.equal(shouldReplyInThread({ chatId: 'oc' }), false);
});

test('storage id is deterministic and path-safe', () => {
  const key = buildConversationKey('app', 'agent', 'tenant', { chatId: 'chat' }, 'chat');
  const id = conversationStorageId(key);
  assert.equal(id, conversationStorageId(key));
  assert.match(id, /^[a-f0-9]{32}$/);
});
