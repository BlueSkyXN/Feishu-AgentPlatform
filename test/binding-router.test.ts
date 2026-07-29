import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

import type { LoadedAppAgentBinding } from '../src/config/types.js';
import {
  AmbiguousBindingRouteError,
  BindingRouter,
} from '../src/runtime/binding-router.js';

test('binding router uses command route and strips the Pi-facing prefix', () => {
  const router = new BindingRouter([
    binding('default', 'general', { default: true }),
    binding('office', 'office', { commandPrefixes: ['/office'], priority: 100 }),
  ]);
  const result = router.resolve(message('/office 读取这份文档'));
  assert.equal(result.binding.id, 'office');
  assert.equal(result.message.content, '读取这份文档');
  assert.equal(result.commandPrefix, '/office');
});

test('binding router falls back to the one default binding', () => {
  const router = new BindingRouter([
    binding('default', 'general', { default: true }),
    binding('office', 'office', { commandPrefixes: ['/office'], priority: 100 }),
  ]);
  assert.equal(router.resolve(message('普通问题')).binding.id, 'default');
});

test('command routing honors Unicode whitespace and rejects non-boundary prefixes', () => {
  const router = new BindingRouter([
    binding('default', 'general', { default: true }),
    binding('office', 'office', { commandPrefixes: ['/office'], priority: 100 }),
  ]);
  const unicode = router.resolve(message('\u3000/OFFICE\u3000读取文档'));
  assert.equal(unicode.binding.id, 'office');
  assert.equal(unicode.message.content, '读取文档');
  assert.equal(router.resolve(message('/office业务')).binding.id, 'default');
});

test('binding router applies chat/user/topic filters with AND semantics', () => {
  const router = new BindingRouter([
    binding('default', 'general', { default: true }),
    binding('restricted', 'office', {
      priority: 10,
      chatAllowlist: ['oc_allowed'],
      userAllowlist: ['ou_allowed'],
      threadAllowlist: ['om_thread'],
    }),
  ]);
  assert.equal(
    router.resolve(message('test', 'oc_allowed', 'ou_allowed', 'om_thread')).binding.id,
    'restricted',
  );
  assert.equal(router.resolve(message('test', 'oc_other', 'ou_allowed', 'om_thread')).binding.id, 'default');
});

test('equal-precedence dynamic route overlap fails instead of silently picking an Agent', () => {
  const router = new BindingRouter([
    binding('default', 'general', { default: true }),
    binding('a', 'a', { priority: 10, chatAllowlist: ['oc'] }),
    binding('b', 'b', { priority: 10, userAllowlist: ['ou'] }),
  ]);
  assert.throws(() => router.resolve(message('test')), AmbiguousBindingRouteError);
});

function binding(
  id: string,
  agent: string,
  route: Partial<LoadedAppAgentBinding['route']>,
): LoadedAppAgentBinding {
  return {
    id,
    app: 'app',
    agent,
    route: {
      default: false,
      priority: 0,
      commandPrefixes: [],
      chatAllowlist: [],
      userAllowlist: [],
      threadAllowlist: [],
      ...route,
    },
  } as LoadedAppAgentBinding;
}

function message(
  content: string,
  chatId = 'oc',
  senderId = 'ou',
  rootId?: string,
): NormalizedMessage {
  return {
    messageId: 'om',
    chatId,
    chatType: 'group',
    content,
    senderId,
    createTime: Date.now(),
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    ...(rootId ? { rootId } : {}),
  };
}
